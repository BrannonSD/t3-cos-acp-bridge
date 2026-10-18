import assert from "node:assert/strict";
import { test } from "node:test";
import { Adapter } from "../src/adapter.js";
import { recordedStockWorkers } from "../src/stock-workers.js";
import type { Session } from "../src/contracts.js";

test("recorded stock worker lineage is parent-specific, bounded and paginated", async () => {
  const urls: string[] = [];
  const children = await recordedStockWorkers(async (route) => {
    urls.push(route);
    if (urls.length === 1)
      return {
        sessions: [
          {
            id: "child-one",
            origin: {
              kind: "worker",
              fromSessionId: "parent",
              task: "  Analyze   images \n",
            },
            activeTurnId: "turn",
          },
          {
            id: "foreign",
            origin: {
              kind: "worker",
              fromSessionId: "elsewhere",
              task: "Secret",
            },
            endedAt: 10,
          },
          {
            id: "non-worker",
            origin: { kind: "desktop", fromSessionId: "parent" },
            endedAt: 10,
          },
        ],
        nextCursor: "second page",
      };
    return {
      sessions: [
        {
          id: "child-two",
          origin: {
            kind: "worker",
            fromSessionId: "parent",
            task: "Review output",
          },
          endedAt: 10,
          lastTurnOutcome: "completed",
        },
      ],
      nextCursor: null,
    };
  }, "parent");
  assert.deepEqual(urls, [
    "/v1/sessions?limit=50",
    "/v1/sessions?limit=50&cursor=second%20page",
  ]);
  assert.deepEqual(
    children.map((x) => [x.id, x.state, x.label]),
    [
      ["child-one", "active", "Analyze images"],
      ["child-two", "completed", "Review output"],
    ],
  );
});

test("resumed stock chat replays parent-linked worker status and transcript", async () => {
  const session: Session = {
    id: "mapped",
    cosId: "parent",
    cwd: "C:\\project",
    model: null,
    effort: null,
    mode: "cos",
    seq: 0,
    title: "Test",
    updatedAt: 0,
    activeInput: null,
    conversationId: null,
    compatibility: "existing-install",
  };
  const calls: string[] = [];
  const updates: Array<{ method: string; params: any }> = [];
  const adapter = new Adapter({
    async call<T>(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<T> {
      calls.push(method);
      if (method === "load") return session as T;
      if (method === "state") return { session, events: [] } as T;
      if (method === "workers")
        return {
          workers: [
            {
              id: "child",
              sessionId: "child",
              label: "Worker report",
              state: "completed",
            },
          ],
        } as T;
      if (method === "worker-events")
        return {
          events: [
            {
              seq: 1,
              position: 0,
              kind: "assistant_message",
              message: { text: "Child completed its review" },
            },
          ],
        } as T;
      if (method === "models") return { state: "unavailable", models: [] } as T;
      throw Error("Unexpected gateway method " + method);
    },
  });
  await adapter.load("mapped", session.cwd, {
    async notify(method, params) {
      updates.push({ method, params });
    },
    async request() {
      throw Error("Unexpected client request");
    },
  });
  assert(calls.includes("worker-events"));
  assert(
    updates.some(
      (r) =>
        r.params.update?.sessionUpdate === "tool_call" &&
        r.params.update?.title === "Worker report",
    ),
  );
  assert(
    updates.some(
      (r) =>
        r.params.update?._meta?.["chat-on-steroids/workerContext"]
          ?.sessionId === "child",
    ),
  );
});
