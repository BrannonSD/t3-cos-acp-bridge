import { test } from "node:test";
import assert from "node:assert/strict";
import { Adapter } from "../src/adapter.js";
import { belongsToInput, isCoSContinuation } from "../src/continuation.js";
import type { Event, Operation, Session } from "../src/contracts.js";

const session = (overrides: Partial<Session> = {}): Session => ({
  id: "t3-mapped",
  cosId: "cos-live",
  cwd: "C:\\project",
  model: null,
  effort: null,
  mode: "cos",
  seq: 10,
  title: "T3 conversation",
  updatedAt: 0,
  activeInput: null,
  conversationId: "native",
  compatibility: "existing-install",
  ...overrides,
});
const operation = (overrides: Partial<Operation> = {}): Operation => ({
  id: "input",
  sessionId: "t3-mapped",
  fingerprint: "test",
  phase: "complete",
  turnId: "current",
  delivery: "sent",
  error: null,
  baseline: 10,
  ...overrides,
});

test("prior-turn assistant revisions are never presented as a new T3 reply", async () => {
  const events: Event[] = [
    {
      seq: 11,
      position: 3,
      kind: "assistant_message",
      turnId: "previous",
      messageId: "old",
      message: { text: "All prior assistant conversation history" },
    },
    {
      seq: 12,
      position: 12,
      kind: "assistant_message",
      turnId: "current",
      messageId: "new",
      message: { text: "Fresh actual answer" },
    },
  ];
  const updates: Array<{ update?: { content?: { text: string } } }> = [];
  const s = session();
  const o = operation();
  const adapter = new Adapter({
    async call<T>(method: string): Promise<T> {
      if (method === "health")
        return {
          actions: { routes: [] },
          routes: [],
          integration: { tier: "existing-install" },
        } as T;
      if (method === "start") return o as T;
      if (method === "state") return { session: s, operation: o, events } as T;
      if (method === "workers") return { workers: [] } as T;
      if (method === "models") return { state: "unavailable", models: [] } as T;
      throw Error("Unexpected " + method);
    },
  });
  await adapter.initialize({ clientInfo: { name: "t3-code" } });
  adapter.sessions.set(s.id, s);
  await adapter.prompt(
    s.id,
    [{ type: "text", text: "follow-up" }],
    null,
    {
      async notify(method, params) {
        if (method === "session/update")
          updates.push(params as { update: any });
      },
      async request() {
        throw Error("Unexpected client request");
      },
    },
    new AbortController().signal,
  );
  const messages = updates
    .map((u) => u.update?.content?.text)
    .filter((t): t is string => typeof t === "string");
  assert(messages.some((t) => t.includes("Fresh actual answer")));
  assert(!messages.some((t) => t.includes("All prior assistant")));
});

test("T3 reload preserves native T3 transcript without replaying every prior assistant message", async () => {
  const records: Array<{ update: any }> = [];
  const s = session({ seq: 15 });
  const history = {
    seq: 8,
    position: 8,
    kind: "assistant_message",
    turnId: "old",
    messageId: "historical",
    message: { text: "Historical assistant answer" },
  };
  const requests: number[] = [];
  const gateway = {
    async call<T>(method: string, p?: Record<string, unknown>): Promise<T> {
      if (method === "health")
        return {
          actions: { routes: [] },
          routes: [],
          integration: { tier: "existing-install" },
        } as T;
      if (method === "load") return s as T;
      if (method === "state") {
        requests.push(Number(p?.after));
        return {
          session: s,
          events: Number(p?.after) === 0 ? [history] : [],
        } as T;
      }
      if (method === "models") return { state: "unavailable", models: [] } as T;
      throw Error("Unexpected gateway " + method);
    },
  };
  const client = {
    async notify(method: string, params: unknown) {
      if (method === "session/update") records.push(params as { update: any });
    },
    async request() {
      throw Error("Unexpected client request");
    },
  };
  const adapter = new Adapter(gateway);
  await adapter.initialize({ clientInfo: { name: "t3-code" } });
  await adapter.load(s.id, s.cwd, client);
  assert.deepEqual(requests, [15]);
  assert(
    !records.some((r) =>
      String(r.update?.content?.text ?? "").includes(
        "Historical assistant answer",
      ),
    ),
  );
  // Imported/native ACP consumers without their own thread history still get replay.
  const other = new Adapter(gateway);
  await other.initialize({ clientInfo: { name: "ordinary-acp" } });
  requests.length = 0;
  records.length = 0;
  await other.load(s.id, s.cwd, client);
  assert.equal(requests[0], 0);
  assert(
    records.some((r) =>
      String(r.update?.content?.text ?? "").includes(
        "Historical assistant answer",
      ),
    ),
  );
});

test("CoS automatic continuation is internal to T3 and active turn matching is strict", () => {
  const e: Event = {
    seq: 14,
    position: 14,
    kind: "user_message",
    message: {
      text: "Continue the task from where you are. (Chat On Steroids starts a fresh turn every so often so long work stays reliable; nothing else changed.)",
    },
  };
  assert(isCoSContinuation(e));
  assert(
    !isCoSContinuation({
      ...e,
      message: { text: "Continue some unrelated task" },
    }),
  );
  assert(
    !belongsToInput(
      { seq: 12, position: 12, kind: "assistant_message", turnId: "previous" },
      operation(),
    ),
  );
  assert(
    belongsToInput(
      { seq: 13, position: 13, kind: "assistant_message", turnId: "current" },
      operation(),
    ),
  );
  assert(
    belongsToInput(
      { seq: 14, position: 14, kind: "assistant_message", turnId: "continued" },
      operation({
        turnId: "continued",
        continuationTurnIds: ["current", "continued"],
      }),
    ),
  );
  assert(
    !belongsToInput(
      { seq: 8, position: 8, kind: "assistant_message", turnId: "current" },
      operation(),
    ),
  );
});

test("old message position overrides new event sequence", () => {
  assert(
    !belongsToInput(
      { seq: 99, position: 3, kind: "assistant_message" },
      operation(),
    ),
  );
});
