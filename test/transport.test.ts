import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Control } from "../src/control.js";
import { Translator } from "../src/translate.js";
test("real loopback control verifies instance, rotates credentials and replays SSE by exact sequence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cos-control-test-"));
  let token = "private-sentinel-one";
  let expected = "0";
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers.origin, undefined);
    if (req.url === "/v1/health") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          protocol: 1,
          pid: process.pid,
          startedAt: "fixture",
          routes: [
            "/v1/models",
            "/v1/projects",
            "/v1/sessions",
            "/v1/sessions/{id}",
            "/v1/sessions/{id}/events",
            "/v1/sessions/{id}/events/stream",
            "/v1/inputs",
            "/v1/inputs/{id}",
          ],
          actions: {
            enabled: true,
            routes: [
              "POST /v1/inputs",
              "POST /v1/inputs/{id}/cancel",
              "POST /v1/sessions/{id}/stop",
              "POST /v1/sessions/{id}/approval-policy",
            ],
          },
        }),
      );
    } else {
      expected = String(req.headers["last-event-id"]);
      res.setHeader("content-type", "text/event-stream");
      res.write(": heartbeat\n\n");
      res.write(
        'id: 8\nevent: assistant_message\ndata: {"seq":8,"position":0,"kind":"assistant_message","message":{"text":"hello"}}\n\n',
      );
      res.end('event: end\ndata: {"reason":"max_duration"}\n\n');
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  try {
    await writeFile(
      path.join(directory, "endpoint.json"),
      JSON.stringify({
        protocol: 1,
        port: address.port,
        pid: process.pid,
        startedAt: "fixture",
      }),
    );
    await writeFile(path.join(directory, "token"), token);
    const control = new Control(directory);
    assert.equal((await control.health()).ok, true);
    const events = [];
    for await (const e of control.stream(
      "session-test",
      7,
      new AbortController().signal,
    ))
      events.push(e);
    assert.equal(expected, "7");
    assert.equal(events[0].seq, 8);
    token = "private-sentinel-two";
    await writeFile(path.join(directory, "token"), token);
    assert.equal((await control.health()).ok, true);
    await writeFile(
      path.join(directory, "endpoint.json"),
      JSON.stringify({
        protocol: 1,
        port: address.port,
        pid: 1,
        startedAt: "fixture",
      }),
    );
    await assert.rejects(control.health(), { code: "wrong_application" });
    await writeFile(
      path.join(directory, "endpoint.json"),
      '{"protocol":1,"port":65536}',
    );
    await assert.rejects(control.endpoint(), { code: "control_unavailable" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
});
test("v2 revisions replace by stable message ID; v1 emits suffixes and clearly labels replacements", () => {
  const v2 = new Translator(2);
  const base = {
    seq: 1,
    position: 4,
    kind: "assistant_message",
    turnId: "t",
    messageId: "message-real",
    message: { text: "Hello" },
  };
  assert.equal(v2.event(base)[0].sessionUpdate, "agent_message");
  assert.deepEqual(
    v2.event({ ...base, seq: 2, message: { text: "Replaced" } })[0].content,
    [{ type: "text", text: "Replaced" }],
  );
  const v1 = new Translator(1);
  v1.event(base);
  assert.deepEqual(
    v1.event({ ...base, seq: 2, message: { text: "Hello world" } })[0].content,
    { type: "text", text: " world" },
  );
  assert.match(
    (
      v1.event({ ...base, seq: 3, message: { text: "Changed" } })[0]
        .content as { text: string }
    ).text,
    /Response revised/,
  );
  assert.deepEqual(
    v1.event({ ...base, seq: 4, message: { text: "Changed" } }),
    [],
  );
});

test("SSE parses CRLF frames split between network chunks", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cos-control-crlf-test-"),
  );
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/health") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          protocol: 1,
          pid: process.pid,
          startedAt: "fixture",
          routes: [
            "/v1/models",
            "/v1/projects",
            "/v1/sessions",
            "/v1/sessions/{id}",
            "/v1/sessions/{id}/events",
            "/v1/sessions/{id}/events/stream",
            "/v1/inputs",
            "/v1/inputs/{id}",
          ],
          actions: {
            enabled: true,
            routes: [
              "POST /v1/inputs",
              "POST /v1/inputs/{id}/cancel",
              "POST /v1/sessions/{id}/stop",
              "POST /v1/sessions/{id}/approval-policy",
            ],
          },
        }),
      );
    } else if (req.url === "/v1/sessions/session-test/events/stream") {
      res.setHeader("content-type", "text/event-stream");
      res.write(
        'id: 9\r\nevent: assistant_message\r\ndata: {"seq":9,"position":0,"kind":"assistant_message","message":{"text":"CRLF"}}\r',
      );
      setTimeout(() => res.end("\n\r\n"), 5);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  try {
    const control = new Control(directory, {
      url: `http://127.0.0.1:${address.port}`,
      token: "fixture-only",
      pid: process.pid,
      startedAt: "fixture",
    });
    const original = process.env.COS_ACP_TEST;
    process.env.COS_ACP_TEST = "1";
    try {
      const events = [];
      for await (const event of control.stream(
        "session-test",
        8,
        new AbortController().signal,
      ))
        events.push(event);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.seq, 9);
    } finally {
      if (original === undefined) delete process.env.COS_ACP_TEST;
      else process.env.COS_ACP_TEST = original;
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("v2 informational notes have unique stable message identities", () => {
  const translator = new Translator(2);
  const first = translator.note("connecting")[0];
  const second = translator.note("connected")[0];
  assert.notEqual(first.messageId, second.messageId);
});
