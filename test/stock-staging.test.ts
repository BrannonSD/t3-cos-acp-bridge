import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Adapter } from "../src/adapter.js";
import {
  approvedDirectory,
  stageStockFile,
  stageStockReference,
} from "../src/stock-staging.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { Control } from "../src/control.js";
import { negotiate } from "../src/compatibility.js";
import type { Health, Session } from "../src/contracts.js";

async function sandbox() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cos-acp-files-"));
  const root = path.join(directory, "approved");
  const t3 = path.join(root, "t3-only-project");
  await mkdir(t3, { recursive: true });
  await writeFile(
    path.join(directory, "config.json"),
    JSON.stringify({ roots: [{ path: root }] }),
  );
  return {
    directory,
    root,
    t3,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("stock staging preserves image bytes inside an approved root without registering CoS projects", async () => {
  const p = await sandbox();
  try {
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    assert.equal(await approvedDirectory(p.directory, p.t3), true);
    const staged = await stageStockFile(p.directory, p.t3, {
      name: "../../screenshot.png",
      mimeType: "image/png",
      data: image.toString("base64"),
    });
    assert.equal(staged.name, "screenshot.png");
    assert.equal(staged.mimeType, "image/png");
    assert.equal(staged.size, image.length);
    assert(
      staged.path
        .toLowerCase()
        .startsWith(
          (path.join(p.root, ".cos-acp-attachments") + path.sep).toLowerCase(),
        ),
    );
    assert(staged.path.endsWith(".png"));
    assert.deepEqual(await readFile(staged.path), image);
    await assert.rejects(
      stageStockFile(p.directory, p.t3, {
        name: "corrupt.png",
        mimeType: "image/png",
        data: "not valid base64",
      }),
      { code: "invalid_attachment" },
    );
    const original = path.join(p.t3, "inside.txt");
    await writeFile(original, "reference payload");
    const ref = await stageStockReference(
      p.directory,
      p.t3,
      pathToFileURL(original).href,
    );
    assert.equal(await readFile(ref.path, "utf8"), "reference payload");
    const outside = path.join(p.directory, "outside.txt");
    await writeFile(outside, "cannot copy unrelated files");
    await assert.rejects(
      stageStockReference(p.directory, p.t3, pathToFileURL(outside).href),
      { code: "invalid_attachment" },
    );
    await assert.rejects(
      stageStockReference(p.directory, p.t3, "https://example.com/secret.txt"),
      { code: "invalid_attachment" },
    );
    await writeFile(
      path.join(p.directory, "config.json"),
      JSON.stringify({ roots: [] }),
    );
    await assert.rejects(
      stageStockFile(p.directory, p.t3, {
        name: "revoked.png",
        mimeType: "image/png",
        data: image.toString("base64"),
      }),
      { code: "no_approved_root" },
    );
  } finally {
    await p.close();
  }
});

test("ACP stock image and document blocks become CoS-readable paths; modern ingress remains unchanged", async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const gateway = {
    async call<T>(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<T> {
      calls.push({ method, params });
      if (method === "stage")
        return {
          path: "C:\\approved\\.cos-acp-attachments\\image.png",
          name: "image.png",
          mimeType: "image/png",
        } as T;
      if (method === "stage-reference")
        return {
          path: "C:\\approved\\referenced.txt",
          name: "referenced.txt",
        } as T;
      if (method === "upload")
        return {
          attachment: {
            id: "native-upload",
            name: "image.png",
            size: 4,
            mimeType: "image/png",
          },
        } as T;
      throw new Error("Unexpected " + method);
    },
  };
  const session: Session = {
    id: "session",
    cosId: null,
    cwd: "C:\\project",
    model: null,
    effort: null,
    mode: "cos",
    seq: 0,
    title: "",
    updatedAt: 0,
    activeInput: null,
    conversationId: null,
    compatibility: "existing-install",
  };
  const a = new Adapter(gateway);
  a.sessions.set("session", session);
  const payload = [
    { type: "text", text: "What does this show?" },
    {
      type: "image",
      name: "image.png",
      mimeType: "image/png",
      data: "aGVsbG8=",
    },
    {
      type: "resource",
      resource: {
        uri: "file:///note.txt",
        mimeType: "text/plain",
        blob: "dGVzdA==",
      },
    },
    { type: "resource_link", uri: "file:///C:/temp/referenced.txt" },
  ];
  const result = await a.content(payload, "session");
  assert.deepEqual(result.attachments, []);
  assert.match(result.text, /What does this show/);
  assert.equal((result.text.match(/staged at/g) ?? []).length, 3);
  assert.equal(calls.filter((c) => c.method === "stage").length, 2);
  assert.equal(calls.filter((c) => c.method === "stage-reference").length, 1);
  session.compatibility = "modern";
  const native = await a.content(
    [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
    "session",
  );
  assert.equal(native.attachments[0]?.id, "native-upload");
  assert.equal(calls.filter((c) => c.method === "upload").length, 1);
});

test("stock worker endpoint exposes only verified child events to T3", async () => {
  const p = await sandbox();
  const store = new Store(path.join(p.directory, "adapter"));
  const h: Health = {
    ok: true,
    protocol: 1,
    pid: 1,
    startedAt: new Date().toISOString(),
    appVersion: "2.1.40",
    routes: [
      "/v1/sessions",
      "/v1/sessions/{id}",
      "/v1/sessions/{id}/events",
      "/v1/sessions/{id}/events/stream",
      "/v1/inputs",
      "/v1/workers/{ownerId}",
      "/v1/workers/{ownerId}/reports",
    ],
    actions: {
      enabled: true,
      routes: [
        "POST /v1/inputs",
        "POST /v1/inputs/{id}/cancel",
        "POST /v1/sessions/{id}/stop",
      ],
    },
  };
  h.integration = negotiate(h, "existing-install");
  class StockControl extends Control {
    readonly calls: string[] = [];
    override async health() {
      return h;
    }
    override async request<T>(route: string): Promise<T> {
      this.calls.push(route);
      if (route === "/v1/sessions?limit=50")
        return {
          sessions: [
            {
              id: "old-child",
              endedAt: 123,
              origin: {
                kind: "worker",
                fromSessionId: "parent",
                task: "Completed worker",
              },
            },
            {
              id: "foreign-child",
              endedAt: 123,
              origin: {
                kind: "worker",
                fromSessionId: "other-parent",
                task: "Foreign worker",
              },
            },
          ],
          nextCursor: null,
        } as T;
      if (route === "/v1/workers/parent")
        return {
          workers: [
            {
              id: "worker-1",
              sessionId: "child",
              label: "Worker",
              state: "active",
            },
          ],
        } as T;
      if (route === "/v1/sessions/child/events?from=1&limit=100")
        return { events: [{ seq: 1, kind: "tool_call" }] } as T;
      if (route === "/v1/sessions/old-child/events?from=1&limit=100")
        return {
          events: [
            {
              seq: 1,
              kind: "assistant_message",
              message: { text: "finished" },
            },
          ],
        } as T;
      throw new Error("Unexpected " + route);
    }
  }
  const control = new StockControl(
    path.join(p.directory, "control-api"),
    undefined,
    "existing-install",
  );
  const engine = new Engine(store, control);
  try {
    const session = store.create(p.t3, "cos");
    session.compatibility = "existing-install";
    session.cosId = "parent";
    store.saveSession(session);
    const workers = (await engine.dispatch("workers", {
      sessionId: session.id,
    })) as { workers: Array<{ id: string }> };
    assert.equal(workers.workers[0]?.id, "worker-1");
    assert.equal(workers.workers[1]?.id, "old-child");
    assert.equal(workers.workers[1]?.state, "completed");
    assert.equal(workers.workers.length, 2);
    const old = (await engine.dispatch("worker-events", {
      sessionId: session.id,
      workerSessionId: "old-child",
      after: 0,
    })) as { events: Array<{ message?: { text: string } }> };
    assert.equal(old.events[0]?.message?.text, "finished");
    const events = (await engine.dispatch("worker-events", {
      sessionId: session.id,
      workerSessionId: "child",
      after: 0,
    })) as { events: Array<{ seq: number }> };
    assert.equal(events.events[0]?.seq, 1);
    await assert.rejects(
      engine.dispatch("worker-events", {
        sessionId: session.id,
        workerSessionId: "unrelated",
        after: 0,
      }),
      { code: "worker_not_in_session" },
    );
    assert(!control.calls.some((route) => route.includes("unrelated")));
  } finally {
    engine.close();
    store.close();
    await p.close();
  }
});
