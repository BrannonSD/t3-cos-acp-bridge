import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  existingProject,
  integrationMode,
  negotiate,
  validateLegacyIdentity,
} from "../src/compatibility.js";
import { Control } from "../src/control.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { Adapter, apps, type Gateway } from "../src/adapter.js";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { BrokerClient } from "../src/broker.js";
import { options, sessionCommands } from "../src/translate.js";
import type { Health, Input, Models } from "../src/contracts.js";

const id = "00000000-0000-4000-a000-000000000001";
const legacy = (appVersion = "2.1.39", models = false): Health => ({
  ok: true,
  protocol: 1,
  pid: process.pid,
  appVersion,
  startedAt: "2026-10-16T05:08:37.224Z",
  routes: [
    "/v1/sessions",
    "/v1/sessions/{id}",
    "/v1/sessions/{id}/events",
    "/v1/sessions/{id}/events/stream",
    "/v1/inputs",
    ...(models ? ["/v1/models"] : []),
  ],
  actions: {
    enabled: true,
    routes: [
      "POST /v1/inputs",
      "POST /v1/inputs/{id}/cancel",
      "POST /v1/sessions/{id}/stop",
    ],
  },
});
test("legacy negotiation is capability-based: explicit mode, verified stock baseline and the durable route contract", () => {
  assert.throws(() => negotiate(legacy(), "modern"), {
    code: "runtime_update_required",
  });
  for (const appVersion of ["2.1.39", "2.1.40", "2.2.0", "2.9.3"]) {
    const report = negotiate(legacy(appVersion), "existing-install");
    assert.equal(report.tier, "existing-install", appVersion);
    assert.equal(report.appVersion, appVersion);
    assert.equal(report.permissions, "cos-only");
    assert.equal(report.models, false);
    assert.equal(report.attachments, false);
    assert.equal(report.workspace, "exact-local-project");
  }
  // 2.1.40 adds the account model catalog; capability negotiation must pick
  // it up instead of the adapter's old exact-version pin.
  const withCatalog = negotiate(legacy("2.1.40", true), "existing-install");
  assert.equal(withCatalog.models, true);
  assert.equal(withCatalog.tier, "existing-install");
  for (const appVersion of [
    "2.1.38",
    "2.0.9",
    "3.0.0",
    "2.1",
    "2.1.40-beta.1",
    "2.1.40.1",
    undefined,
  ] as Array<string | undefined>) {
    assert.throws(
      () =>
        negotiate({ ...legacy(), appVersion } as Health, "existing-install"),
      { code: "runtime_update_required" },
      String(appVersion),
    );
  }
  assert.throws(
    () => negotiate({ ...legacy(), routes: [] }, "existing-install"),
    { code: "incompatible_runtime" },
  );
  assert.throws(() => integrationMode("auto"), {
    code: "invalid_integration_mode",
  });
  assert.throws(
    () =>
      negotiate(
        {
          ...legacy(),
          integrationManifest: {
            id: "chat-on-steroids.control",
            version: 2,
            features: {},
          },
        },
        "existing-install",
      ),
    { code: "incompatible_runtime" },
  );
});
test("stock split-timestamp identity requires one supported release on both sides and the exact OS process start", () => {
  const endpoint = {
    appVersion: "2.1.39",
    startedAt: "2026-10-17T15:34:55.858Z",
  };
  const osStart = Date.parse("2026-10-16T05:08:36.037Z");
  validateLegacyIdentity(
    legacy(),
    endpoint,
    osStart,
    Date.parse("2026-10-17T15:35:00Z"),
  );
  // Official 2.1.40 keeps the same process-start/listener-start split and is
  // covered by the same structural proof.
  validateLegacyIdentity(
    legacy("2.1.40"),
    { ...endpoint, appVersion: "2.1.40" },
    osStart,
    Date.parse("2026-10-17T15:35:00Z"),
  );
  assert.throws(
    () => validateLegacyIdentity(legacy(), endpoint, osStart + 60_000),
    { code: "wrong_application" },
  );
  assert.throws(
    () =>
      validateLegacyIdentity(
        legacy("2.1.38"),
        { ...endpoint, appVersion: "2.1.38" },
        osStart,
      ),
    { code: "wrong_application" },
  );
  assert.throws(
    () =>
      validateLegacyIdentity(
        legacy("2.1.40"),
        { ...endpoint, appVersion: "2.1.39" },
        osStart,
      ),
    { code: "wrong_application" },
  );
  assert.throws(
    () =>
      validateLegacyIdentity(
        legacy(),
        { ...endpoint, appVersion: undefined },
        osStart,
      ),
    { code: "wrong_application" },
  );
  assert.throws(
    () =>
      validateLegacyIdentity(
        legacy(),
        { ...endpoint, startedAt: "invalid" },
        osStart,
      ),
    { code: "wrong_application" },
  );
  assert.throws(
    () => validateLegacyIdentity(legacy(), endpoint, osStart, osStart),
    { code: "wrong_application" },
  );
});
test("modern manifest feature versions require both a supported flag and its route; unknown core features cannot silently downgrade", () => {
  const h = legacy();
  h.routes.push(
    "/v1/projects",
    "/v1/models",
    "/v1/inputs/{id}",
    "/v1/sessions/{id}/workers",
  );
  h.actions.routes.push(
    "POST /v1/sessions/{id}/approval-policy",
    "POST /v1/attachments",
  );
  h.integrationManifest = {
    id: "chat-on-steroids.control",
    version: 1,
    features: {
      listenerIdentity: 1,
      sessionCwd: 1,
      integrationApprovals: 1,
      projects: 1,
      inputLookup: 1,
      inputModels: 1,
      attachmentIngress: 2,
      sessionWorkers: 1,
    },
  };
  assert.equal(negotiate(h, "modern").attachments, false);
  assert.equal(negotiate(h, "modern").models, true);
  h.actions.routes.push("POST /v1/sessions/{id}/compact");
  h.routes.push("/v1/sessions/{id}/assets/{assetId}");
  h.integrationManifest.features.sessionCompaction = 2;
  h.integrationManifest.features.sessionAssets = 2;
  assert.equal(negotiate(h, "modern").compact, false);
  assert.equal(negotiate(h, "modern").assets, false);
  h.integrationManifest.features.sessionCompaction = 1;
  h.integrationManifest.features.sessionAssets = 1;
  assert.equal(negotiate(h, "modern").compact, true);
  assert.equal(negotiate(h, "modern").assets, true);
  h.routes = h.routes.filter((r) => r !== "/v1/sessions/{id}/workers");
  assert.equal(negotiate(h, "modern").sessionWorkers, false);
  h.integrationManifest.features.sessionCwd = 2;
  assert.throws(() => negotiate(h, "existing-install"), {
    code: "incompatible_runtime",
  });
});
test("ACP stock mode advertises staged image support while preserving CoS-only permissions", async () => {
  const report = negotiate(legacy(), "existing-install");
  const gateway: Gateway = {
    async call<T>() {
      return { ...legacy(), integration: report } as T;
    },
  };
  for (const version of [1, 2] as const) {
    const result = await new Adapter(gateway, version).initialize();
    assert.deepEqual(result._meta?.["chat-on-steroids/integration"], report);
    if ("agentCapabilities" in result)
      assert.equal(result.agentCapabilities?.promptCapabilities?.image, true);
  }
});
async function profile() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cos-existing-test-")));
  const cwd = path.join(directory, "project");
  await mkdir(cwd);
  await mkdir(path.join(directory, "state"));
  const catalog = [{ id, name: "Existing", path: cwd, createdAt: 1 }];
  await writeFile(
    path.join(directory, "state", "projects.json"),
    JSON.stringify(catalog),
  );
  await writeFile(
    path.join(directory, "config.json"),
    JSON.stringify({ roots: [{ name: "existing", path: directory }] }),
  );
  return {
    directory,
    cwd,
    catalog,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
test("read-only stock catalog binding accepts exact canonical projects and refuses worktrees/revoked grants/import mismatch", async () => {
  const p = await profile();
  try {
    assert.equal((await existingProject(p.directory, p.cwd)).id, id);
    const child = path.join(p.cwd, "worktree");
    await mkdir(child);
    await assert.rejects(existingProject(p.directory, child), {
      code: "project_binding_unavailable",
    });
    await assert.rejects(existingProject(p.directory, p.cwd, "wrong-id"), {
      code: "project_binding_unavailable",
    });
    await writeFile(path.join(p.directory, "config.json"), '{"roots":[]}');
    await assert.rejects(existingProject(p.directory, p.cwd), {
      code: "project_binding_unavailable",
    });
    await writeFile(
      path.join(p.directory, "config.json"),
      '{"roots":"corrupt"}',
    );
    await assert.rejects(existingProject(p.directory, p.cwd), {
      code: "project_binding_unavailable",
    });
  } finally {
    await p.close();
  }
});
class LegacyControl extends Control {
  calls: Array<{ route: string; body?: Record<string, unknown> }> = [];
  appVersion = "2.1.39";
  catalog?: Models;
  override async health() {
    const h = legacy(this.appVersion, this.catalog !== undefined);
    h.integration = negotiate(h, "existing-install");
    return h;
  }
  override async request<T>(route: string, raw?: unknown): Promise<T> {
    const body = raw as Record<string, unknown> | undefined;
    this.calls.push({ route, body });
    if (route === "/v1/inputs") {
      const keys = Object.keys(body!).sort();
      assert.deepEqual(
        keys.filter((key) => !["model", "reasoningEffort"].includes(key)),
        body!.projectId ? ["id", "projectId", "text"] : ["id", "text"],
      );
      assert.equal(
        keys.includes("reasoningEffort"),
        keys.includes("model"),
        "reasoningEffort is only carried with an explicit model",
      );
      return {
        input: {
          id: body!.id,
          sessionId: body!.id,
          deliveredSessionId: null,
          conversationId: null,
          delivery: "pending",
          state: "queued",
          messageId: null,
          error: null,
        } satisfies Input,
      } as T;
    }
    if (route === "/v1/inputs?limit=500")
      return { inputs: [], total: 700 } as T;
    if (route === "/v1/models") {
      assert(this.catalog, "catalog requested without a stock model route");
      return this.catalog as T;
    }
    throw new Error(`Unexpected runtime call ${route}`);
  }
}
test("stock CoS supports projectless T3 sessions without assigning an unrelated project", async () => {
  const p = await profile();
  const store = new Store(path.join(p.directory, "adapter"));
  const control = new LegacyControl(
    path.join(p.directory, "control-api"),
    undefined,
    "existing-install",
  );
  const engine = new Engine(store, control);
  engine.watch = () => {};
  try {
    const s = await engine.create(p.directory, "t3-code");
    assert.equal(s.projectId, undefined);
    assert.equal(s.mode, "cos");
    const op = await engine.start(
      s.id,
      "hello from a projectless T3 chat",
      [],
      "projectless-1",
    );
    assert.equal(op.phase, "admitted");
    const send = control.calls.find((call) => call.route === "/v1/inputs")!;
    assert(!("projectId" in send.body!));
    assert(!("cwd" in send.body!));
    assert.match(String(send.body!.text), /projectless T3 chat/);
    assert.match(String(send.body!.text), /T3 supplied working directory/);
    const known = await engine.import(s.id, p.directory);
    assert.equal(known.id, s.id);
    await assert.rejects(engine.import(s.id, p.cwd), { code: "cwd_mismatch" });
    const bound = await engine.create(p.cwd, "t3-code");
    assert.equal(bound.projectId, id);
  } finally {
    engine.close();
    store.close();
    await p.close();
  }
});
test("probe fallback cannot mask missing, unreadable or corrupt profile files", async () => {
  for (const damage of [
    "missing-config",
    "missing-catalog",
    "unreadable-catalog",
    "invalid-json",
    "invalid-roots",
    "invalid-project",
    "invalid-grant",
  ]) {
    const p = await profile();
    const store = new Store(path.join(p.directory, "adapter"));
    const control = new LegacyControl(
      path.join(p.directory, "control-api"),
      undefined,
      "existing-install",
    );
    const engine = new Engine(store, control);
    try {
      const config = path.join(p.directory, "config.json");
      const catalog = path.join(p.directory, "state", "projects.json");
      if (damage === "missing-config") await rm(config);
      if (damage === "missing-catalog") await rm(catalog);
      if (damage === "unreadable-catalog") {
        await rm(catalog);
        await mkdir(catalog);
      }
      if (damage === "invalid-json") await writeFile(catalog, "{");
      if (damage === "invalid-roots")
        await writeFile(config, '{"roots":"bad"}');
      if (damage === "invalid-project") await writeFile(catalog, "[null]");
      if (damage === "invalid-grant")
        await writeFile(config, '{"roots":[null]}');
      await assert.rejects(
        engine.create(p.directory, "t3-code-provider-test"),
        { code: "project_binding_unavailable" },
        damage,
      );
      assert.equal(store.sessions().length, 0, damage);
      assert.deepEqual(control.calls, []);
    } finally {
      engine.close();
      store.close();
      await p.close();
    }
  }
});
test("existing-install text admission uses stock fields, current selection, explicit CoS permissions and preserves fences", async () => {
  const p = await profile();
  const store = new Store(path.join(p.directory, "adapter"));
  const control = new LegacyControl(
    path.join(p.directory, "control-api"),
    undefined,
    "existing-install",
  );
  const engine = new Engine(store, control);
  engine.watch = () => {};
  try {
    const s = await engine.create(p.cwd);
    assert.equal(s.mode, "cos");
    assert.equal(s.projectId, id);
    const models = await engine.models();
    assert.deepEqual(models.models, []);
    const permission = options(s, models).find((o) => o.id === "mode")!;
    assert.equal(permission.type, "select");
    assert.equal((permission as { options: unknown[] }).options.length, 1);
    assert.deepEqual(
      sessionCommands(s).map((c) => c.name),
      ["cos-status", "cos-workers"],
    );
    await assert.rejects(engine.set(s.id, { mode: "supervised" }), {
      code: "permissions_unavailable",
    });
    assert.equal(engine.session(s.id).mode, "cos");
    await assert.rejects(
      engine.set(s.id, { model: "invented", effort: "high" }),
      { code: "model_unavailable" },
    );
    await assert.rejects(
      engine.start(
        s.id,
        "image",
        [{ id: "x", name: "x", size: 1, mimeType: "image/png" }],
        "image-key",
      ),
      { code: "unsupported_content" },
    );
    const operation = await engine.start(
      s.id,
      "Authenticated through existing CoS",
      [],
      "stable-key",
    );
    assert.equal(
      (
        await engine.start(
          s.id,
          "Authenticated through existing CoS",
          [],
          "stable-key",
        )
      ).id,
      operation.id,
    );
    assert.equal(
      control.calls.filter((c) => c.route === "/v1/inputs").length,
      1,
    );
    operation.phase = "uncertain";
    operation.delivery = "unconfirmed";
    store.saveOperation(operation);
    const current = engine.session(s.id);
    await engine.reconcile(current, operation);
    assert.equal(
      operation.phase,
      "uncertain",
      "absence from newest 500 rows is never proof of unsent delivery",
    );
    engine.receive(current, {
      seq: 1,
      position: 1,
      kind: "user_message",
      inputId: operation.id,
      inputDelivery: "sent",
      turnId: "exact-turn",
    });
    engine.receive(current, {
      seq: 2,
      position: 2,
      kind: "turn_start",
      turnId: "exact-turn",
    });
    engine.receive(current, {
      seq: 3,
      position: 3,
      kind: "turn_end",
      turnId: "exact-turn",
      outcome: "completed",
    });
    await engine.reconcile(current, store.operation(operation.id)!);
    assert.equal(
      store.operation(operation.id)?.phase,
      "complete",
      "durable exact-turn receipts settle after outbox retention",
    );
    const second = await engine.create(p.cwd);
    await assert.rejects(
      engine.start(
        second.id,
        "Authenticated through existing CoS",
        [],
        "stable-key",
      ),
      { code: "outcome_unconfirmed" },
    );
  } finally {
    engine.close();
    store.close();
    await p.close();
  }
});
test("official 2.1.40 negotiates its account catalog into stock admission with exact-project binding", async () => {
  const p = await profile();
  const store = new Store(path.join(p.directory, "adapter"));
  const control = new LegacyControl(
    path.join(p.directory, "control-api"),
    undefined,
    "existing-install",
  );
  control.appVersion = "2.1.40";
  control.catalog = {
    state: "ready",
    models: [
      {
        id: "gpt-6-thinking",
        label: "GPT-6 Thinking",
        efforts: ["high", "max"],
      },
    ],
  };
  const engine = new Engine(store, control);
  engine.watch = () => {};
  try {
    const s = await engine.create(p.cwd);
    assert.equal(s.mode, "cos");
    const models = await engine.models();
    assert.equal(models.state, "ready");
    assert.equal(models.models[0]?.id, "gpt-6-thinking");
    await engine.set(s.id, { model: "gpt-6-thinking", effort: "max" });
    const operation = await engine.start(
      s.id,
      "Use the account model",
      [],
      "stable-2-1-40",
    );
    const send = control.calls.find((c) => c.route === "/v1/inputs")!;
    assert.equal(send.body?.model, "gpt-6-thinking");
    assert.equal(send.body?.reasoningEffort, "max");
    assert.equal(send.body?.projectId, id);
    assert.equal(operation.phase, "admitted");
    assert.equal(engine.session(s.id).model, "gpt-6-thinking");
  } finally {
    engine.close();
    store.close();
    await p.close();
  }
});
test("stock CoS initializes GPT-6 Medium and exposes thinking choices before the first input", async () => {
  const p = await profile();
  const store = new Store(path.join(p.directory, "adapter"));
  const control = new LegacyControl(
    path.join(p.directory, "control-api"),
    undefined,
    "existing-install",
  );
  control.appVersion = "2.1.40";
  control.catalog = {
    state: "ready",
    models: [
      { id: "gpt-6", label: "GPT-6", efforts: ["none", "medium", "high"] },
      { id: "gpt-5-6", label: "GPT-5.6", efforts: ["none", "medium", "high"] },
    ],
  };
  const engine = new Engine(store, control);
  engine.watch = () => {};
  try {
    const session = await engine.create(p.directory, "t3-code");
    assert.equal(session.projectId, undefined, "projectless chats still work");
    assert.equal(session.model, "gpt-6");
    assert.equal(
      session.effort,
      "medium",
      "new sessions do not silently use Instant",
    );
    const config = options(session, await engine.models());
    assert.equal(config.find((o) => o.id === "model")?.currentValue, "gpt-6");
    const reasoning = config.find((o) => o.id === "reasoning");
    assert.equal(reasoning?.currentValue, "medium");
    assert.deepEqual(
      reasoning?.options.map((o) => o.value),
      ["none", "medium", "high"],
    );
    const op = await engine.start(
      session.id,
      "First message using thinking",
      [],
      "first-reasoning",
    );
    assert.equal(op.phase, "admitted");
    const send = control.calls.find((c) => c.route === "/v1/inputs")!;
    assert.equal(send.body?.model, "gpt-6");
    assert.equal(send.body?.reasoningEffort, "medium");
    const later = await engine.create(p.directory, "t3-code");
    await engine.set(later.id, { model: "_cos_current" });
    assert.equal(
      engine.session(later.id).model,
      null,
      "current ChatGPT setting remains opt-in",
    );
    assert.equal(engine.session(later.id).effort, null);
    await engine.set(later.id, { model: "gpt-5-6" });
    assert.equal(
      engine.session(later.id).effort,
      "medium",
      "changing from current does not default to none",
    );
    await engine.set(later.id, { effort: "high" });
    assert.equal(engine.session(later.id).effort, "high");
    await engine.set(later.id, { effort: "none" });
    assert.equal(
      engine.session(later.id).effort,
      "none",
      "Instant is still supported explicitly",
    );
  } finally {
    engine.close();
    store.close();
    await p.close();
  }
});
test("an unrecognized stock model catalog falls back to the safe current-selection view", async () => {
  const p = await profile();
  const store = new Store(path.join(p.directory, "adapter"));
  const control = new LegacyControl(
    path.join(p.directory, "control-api"),
    undefined,
    "existing-install",
  );
  control.appVersion = "2.1.40";
  const engine = new Engine(store, control);
  engine.watch = () => {};
  try {
    const s = await engine.create(p.cwd);
    const shapes = [
      { state: "ready", models: "bigger-than-expected" },
      { state: "ready", models: [{ id: "", label: "no id", efforts: [] }] },
      {
        state: "ready",
        models: [{ id: "x".repeat(81), label: "long", efforts: ["high"] }],
      },
      { state: "ready", models: [{ id: "ok", label: "ok", efforts: [7] }] },
    ] as unknown as Models[];
    for (const catalog of shapes) {
      control.catalog = catalog;
      assert.deepEqual(
        await engine.models(),
        { state: "unavailable", models: [] },
        JSON.stringify(catalog),
      );
    }
    await assert.rejects(engine.set(s.id, { model: "invented" }), {
      code: "model_unavailable",
    });
    assert.equal(engine.session(s.id).model, null);
  } finally {
    engine.close();
    store.close();
    await p.close();
  }
});
test("legacy health verifies PID/OS identity, requires one supported release on both sides, and rejects credential rotation before an action", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cos-legacy-health-"));
  const osStart = Date.parse("2026-10-16T05:08:36.037Z");
  let posts = 0;
  let served = legacy();
  const server = http.createServer((req, res) => {
    if (req.method === "POST") posts++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(served));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const endpoint = {
      protocol: 1,
      port: (server.address() as { port: number }).port,
      pid: process.pid,
      appVersion: "2.1.39",
      startedAt: "2026-10-17T15:34:55.858Z",
    };
    await writeFile(
      path.join(directory, "endpoint.json"),
      JSON.stringify(endpoint),
    );
    await writeFile(path.join(directory, "token"), "fixture-private-token");
    const control = new Control(
      directory,
      undefined,
      "existing-install",
      async () => osStart,
    );
    assert.equal(
      (await control.health()).integration?.tier,
      "existing-install",
    );
    // Official 2.1.40 passes the same structural proof; no version pin.
    served = legacy("2.1.40");
    await writeFile(
      path.join(directory, "endpoint.json"),
      JSON.stringify({ ...endpoint, appVersion: "2.1.40" }),
    );
    assert.equal((await control.health()).integration?.appVersion, "2.1.40");
    // Both sides must report the same supported release.
    served = legacy("2.1.39");
    await assert.rejects(control.health(), { code: "wrong_application" });
    served = legacy("2.1.38");
    await writeFile(
      path.join(directory, "endpoint.json"),
      JSON.stringify({ ...endpoint, appVersion: "2.1.38" }),
    );
    await assert.rejects(control.health(), { code: "wrong_application" });
    served = legacy();
    await writeFile(
      path.join(directory, "endpoint.json"),
      JSON.stringify(endpoint),
    );
    assert.equal((await control.health()).integration?.appVersion, "2.1.39");
    await writeFile(path.join(directory, "token"), "rotated-private-token");
    await assert.rejects(
      control.request("/v1/inputs", { text: "never sent" }),
      { code: "instance_changed" },
    );
    assert.equal(posts, 0);
    const raced = new Control(
      directory,
      undefined,
      "existing-install",
      async () => {
        await writeFile(
          path.join(directory, "token"),
          "changed-during-identity-check",
        );
        return osStart;
      },
    );
    await assert.rejects(raced.health(), { code: "instance_changed" });
    const wrong = new Control(
      directory,
      undefined,
      "existing-install",
      async () => osStart + 60_000,
    );
    await assert.rejects(wrong.health(), { code: "wrong_application" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
test("legacy identity caches the OS start probe and retries it after a transient failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cos-legacy-cache-"));
  let probes = 0;
  let failNext = true;
  let osStart = Date.parse("2026-10-16T05:08:36.037Z");
  let served = legacy();
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(served));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const endpoint = {
      protocol: 1,
      port: (server.address() as { port: number }).port,
      pid: process.pid,
      appVersion: "2.1.39",
      startedAt: "2026-10-17T15:34:55.858Z",
    };
    await writeFile(
      path.join(directory, "endpoint.json"),
      JSON.stringify(endpoint),
    );
    await writeFile(path.join(directory, "token"), "fixture-private-token");
    const control = new Control(
      directory,
      undefined,
      "existing-install",
      async () => {
        probes++;
        if (failNext) {
          failNext = false;
          throw new Error("transient PowerShell probe failure");
        }
        return osStart;
      },
    );
    await assert.rejects(control.health(), {
      code: "process_identity_unavailable",
    });
    assert.equal(probes, 1);
    // A transient probe failure is never cached: the next check retries it.
    assert.equal(
      (await control.health()).integration?.tier,
      "existing-install",
    );
    assert.equal(probes, 2);
    // Steady state reuses the cached OS start for the same process instance.
    assert.equal(
      (await control.health()).integration?.tier,
      "existing-install",
    );
    assert.equal(probes, 2, "steady-state checks do not re-probe the OS");
    // A different app start marker (stock restart) misses the cache once.
    osStart = Date.parse("2026-10-16T05:08:41.037Z");
    served = { ...legacy(), startedAt: "2026-10-16T05:08:41.037Z" };
    assert.equal(
      (await control.health()).integration?.tier,
      "existing-install",
    );
    assert.equal(probes, 3, "a different process start misses the cache");
    assert.equal(
      (await control.health()).integration?.tier,
      "existing-install",
    );
    assert.equal(probes, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
test("state migration retains recovery records and rejects future schema without mutation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cos-schema-test-"));
  try {
    let store = new Store(directory);
    const session = store.create(directory);
    store.close();
    store = new Store(directory);
    assert.equal(store.session(session.id)?.id, session.id);
    store.close();
    const db = new DatabaseSync(path.join(directory, "state.sqlite"));
    db.exec("PRAGMA user_version=999");
    db.close();
    assert.throws(() => new Store(directory), { code: "state_version_newer" });
    const check = new DatabaseSync(path.join(directory, "state.sqlite"));
    assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 999);
    check.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("a live broker from another release or profile is never silently reused or stopped", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cos-broker-version-"),
  );
  try {
    await writeFile(
      path.join(directory, "broker.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        pipe: "unused",
        token: "fixture-private",
        integrationMode: "modern",
        adapterPath: "old-release",
        nodePath: process.execPath,
        controlDirectory: "other-profile",
      }),
    );
    await assert.rejects(new BrokerClient(directory).call("health"), {
      code: "broker_configuration_mismatch",
    });
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stock history lists only known projectless CoS sessions with their original T3 directory", async () => {
  const p = await profile();
  const store = new Store(path.join(p.directory, "adapter"));
  class HistoryControl extends LegacyControl {
    override async request<T>(route: string, raw?: unknown): Promise<T> {
      if (route === "/v1/sessions?limit=50")
        return {
          sessions: [
            {
              id: "unbound-cos-id",
              title: "Unbound",
              updatedAt: Date.now(),
              projectId: null,
            },
            {
              id: "foreign-unbound",
              title: "Other",
              updatedAt: Date.now(),
              projectId: null,
            },
          ],
          nextCursor: null,
        } as T;
      return super.request<T>(route, raw);
    }
  }
  const control = new HistoryControl(
    path.join(p.directory, "control-api"),
    undefined,
    "existing-install",
  );
  const engine = new Engine(store, control);
  try {
    const s = await engine.create(p.directory);
    s.cosId = "unbound-cos-id";
    store.saveSession(s);
    const result = (await engine.dispatch("list")) as {
      sessions: Array<{ id: string; cwd: string | null }>;
    };
    assert.equal(result.sessions[0]?.cwd, p.directory);
    assert.equal(result.sessions[1]?.cwd, null);
    const adapter = new Adapter({
      async call<T>(method: string, params?: Record<string, unknown>) {
        return (await engine.dispatch(method, params)) as T;
      },
    });
    const listed = await adapter.list(undefined, p.directory);
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0]?.title, "Unbound");
  } finally {
    engine.close();
    store.close();
    await p.close();
  }
});

test("unbound native CoS sessions cannot be adopted into arbitrary T3 folders", async () => {
  const p = await profile();
  const store = new Store(path.join(p.directory, "adapter"));
  class ReadOnlyUnboundControl extends LegacyControl {
    override async request<T>(route: string, raw?: unknown): Promise<T> {
      if (route.startsWith("/v1/sessions/"))
        return {
          session: {
            id: "unknown-stock-session",
            title: "Native conversation",
            conversationId: "native-conversation",
            projectId: null,
          },
        } as T;
      return super.request<T>(route, raw);
    }
  }
  const control = new ReadOnlyUnboundControl(
    path.join(p.directory, "control-api"),
    undefined,
    "existing-install",
  );
  const engine = new Engine(store, control);
  try {
    await assert.rejects(engine.import("unknown-stock-session", p.directory), {
      code: "project_binding_unavailable",
    });
    assert.equal(store.sessions().length, 0);
  } finally {
    engine.close();
    store.close();
    await p.close();
  }
});
