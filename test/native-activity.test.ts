import { test } from "node:test";
import assert from "node:assert/strict";
import { Adapter, type Gateway } from "../src/adapter.js";
import type { Session } from "../src/contracts.js";

const session: Session = {
  id: "00000000-0000-4000-8000-000000000001",
  cosId: "00000000-0000-4000-8000-000000000002",
  cwd: process.cwd(),
  model: "gpt-6",
  effort: "high",
  mode: "cos",
  seq: 0,
  title: "Projectless",
  updatedAt: 1000,
  activeInput: null,
  conversationId: "native-conversation",
  compatibility: "existing-install",
};

test("stock CoS live jobs map into native ACP compaction; modes are observational", async () => {
  let live = {
    automation: "goal",
    job: {
      stage: "opening",
      startedAt: 12345,
      automatic: true,
      busy: true,
      error: null as string | null,
    },
  };
  const gateway: Gateway = {
    async call(method) {
      switch (method) {
        case "live":
          return { live } as never;
        case "workers":
          return { workers: [] } as never;
        default:
          throw new Error("unexpected " + method);
      }
    },
  };
  const adapter = new Adapter(gateway, 2);
  adapter.sessions.set(session.id, session);
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    notify: async (_method: string, body: unknown) => {
      updates.push((body as { update: Record<string, unknown> }).update);
    },
    request: async () => ({}),
  };
  const observe = () =>
    (
      adapter as unknown as {
        workers(id: string, s: Session, client: unknown): Promise<boolean>;
      }
    ).workers(session.id, session, client);
  assert.equal(await observe(), false);
  assert.equal(
    updates.filter((u) => u.sessionUpdate === "compaction_update").length,
    1,
  );
  assert.deepEqual(
    updates.find((u) => u.sessionUpdate === "compaction_update"),
    {
      sessionUpdate: "compaction_update",
      compactionId: "cos-compaction:12345",
      status: "in_progress",
      _meta: {
        "chat-on-steroids/compaction": { stage: "opening", automatic: true },
      },
    },
  );
  assert(updates.some((u) => u.sessionUpdate === "agent_thought_chunk"));
  await observe();
  assert.equal(
    updates.filter((u) => u.sessionUpdate === "compaction_update").length,
    1,
    "identical live state does not replay",
  );
  live = {
    automation: "off",
    job: {
      stage: "done",
      startedAt: 12345,
      automatic: true,
      busy: false,
      error: null,
    },
  };
  await observe();
  const compactions = updates.filter(
    (u) => u.sessionUpdate === "compaction_update",
  );
  assert.equal(compactions.length, 2);
  assert.equal(compactions[1]?.status, "completed");
  assert.equal(compactions[1]?.compactionId, compactions[0]?.compactionId);
  assert.equal(
    updates.filter((u) => u.sessionUpdate === "agent_thought_chunk").length,
    2,
    "Goal turning off is also observable",
  );
});

test("stock CoS worker announces T3-native lineage and carries child activity", async () => {
  const gateway: Gateway = {
    async call(method) {
      if (method === "live") return { live: null } as never;
      if (method === "workers")
        return {
          workers: [
            {
              id: "worker-1",
              runId: "00000000-0000-4000-8000-000000000010",
              sessionId: "child-abc",
              label: "Research engine",
              state: "active",
            },
          ],
        } as never;
      if (method === "worker-events")
        return {
          events: [
            {
              seq: 1,
              position: 1,
              kind: "assistant_message",
              messageId: "child-message",
              message: { text: "Working now." },
            },
            {
              seq: 2,
              position: 2,
              kind: "tool_call",
              tool: {
                callId: "child-tool",
                name: "read_file",
                outcome: "ok",
                summary: { title: "Read child file", kind: "read" },
                args: { text: "x" },
                result: { text: "read" },
                changes: [],
              },
            },
          ],
        } as never;
      throw new Error("unexpected " + method);
    },
  };
  const adapter = new Adapter(gateway, 2);
  adapter.sessions.set(session.id, session);
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    notify: async (_method: string, body: unknown) => {
      updates.push((body as { update: Record<string, unknown> }).update);
    },
    request: async () => ({}),
  };
  const active = await (
    adapter as unknown as {
      workers(id: string, s: Session, client: unknown): Promise<boolean>;
    }
  ).workers(session.id, session, client);
  assert.equal(active, true);
  const worker = updates.find((u) =>
    String(u.toolCallId).startsWith("cos-worker:"),
  );
  assert(worker);
  const metadata = (worker._meta as Record<string, unknown>)[
    "chat-on-steroids/worker"
  ] as Record<string, unknown>;
  assert.equal(metadata.id, "worker-1");
  assert.equal(metadata.prompt, "Research engine");
  assert.equal(metadata.sessionId, "child-abc");
  const childUpdates = updates.filter(
    (u) =>
      (u._meta as Record<string, unknown> | undefined)?.[
        "chat-on-steroids/workerContext"
      ] !== undefined,
  );
  assert(childUpdates.some((u) => u.sessionUpdate === "agent_message"));
  assert(childUpdates.some((u) => u.sessionUpdate === "tool_call_update"));
  assert(
    childUpdates.every(
      (u) =>
        (
          (u._meta as Record<string, unknown>)[
            "chat-on-steroids/workerContext"
          ] as Record<string, unknown>
        ).sessionId === "child-abc",
    ),
  );
});

test("read-only live activity is not fabricated when a stock session has no CoS ID", async () => {
  const gateway: Gateway = {
    call: async () => {
      throw new Error("No control read allowed");
    },
  };
  const adapter = new Adapter(gateway, 2);
  const noCos: Session = { ...session, cosId: null };
  const updates: unknown[] = [];
  await (
    adapter as unknown as {
      nativeActivity(id: string, s: Session, client: unknown): Promise<void>;
    }
  ).nativeActivity(noCos.id, noCos, {
    notify: async (_: string, params: unknown) => {
      updates.push(params);
    },
  });
  assert.equal(updates.length, 0);
});

test("generic stock T3 keeps child assistant output under the worker instead of its parent reply", async () => {
  const adapter = new Adapter(
    {
      async call(method) {
        if (method === "live") return { live: null } as never;
        if (method === "workers")
          return {
            workers: [
              {
                id: "worker-1",
                runId: "run-1",
                sessionId: "child-1",
                label: "Child research",
                state: "completed",
              },
            ],
          } as never;
        if (method === "worker-events")
          return {
            events: [
              {
                seq: 1,
                position: 0,
                kind: "user_message",
                messageId: "child-prompt",
                message: { text: "Internal worker instruction: reply ORBIT" },
              },
              {
                seq: 2,
                position: 1,
                kind: "assistant_message",
                messageId: "child-msg",
                message: { text: "Child answer" },
              },
            ],
          } as never;
        throw new Error("unexpected " + method);
      },
    },
    2,
  );
  (adapter as unknown as { clientName: string }).clientName = "t3-code";
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    notify: async (_: string, payload: unknown) => {
      updates.push((payload as { update: Record<string, unknown> }).update);
    },
    request: async () => ({}),
  };
  await (
    adapter as unknown as {
      workers(id: string, s: Session, client: unknown): Promise<boolean>;
    }
  ).workers(session.id, session, client);
  assert(
    !updates.some((u) => u.sessionUpdate === "agent_message"),
    "a generic T3 thread must not mistake the child answer for the parent's answer",
  );
  assert(
    !updates.some((u) => u.sessionUpdate === "user_message"),
    "a generic T3 thread must not show the worker's internal instruction as another parent user prompt",
  );
  const card = updates.find((u) => u.rawOutput === "Child answer");
  assert(card);
  assert.equal(card.toolCallId, "cos-worker:run-1:worker-1");
  assert.equal(
    card.status,
    "completed",
    "completed workers must not become running again",
  );
});
