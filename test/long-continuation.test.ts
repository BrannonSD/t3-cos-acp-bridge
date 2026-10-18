import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, TURN_SETTLE_MS } from "../src/engine.js";
import { Adapter } from "../src/adapter.js";
import { Store } from "../src/store.js";
import { belongsToInput, isCoSContinuation } from "../src/continuation.js";
import type { Event, Operation, Session } from "../src/contracts.js";

const continuations = [
  "Continue the task from where you are. (Chat On Steroids starts a fresh turn every so often so long work stays reliable; nothing else changed.)",
  "Carry on and finish what was requested. Your response appears to have stalled before its final answer; check for work already completed, because its tool calls may be absent from the visible history.",
  "Keep working until the request is complete. This turn appears to have been interrupted; missing tool calls do not mean no work happened, so check the existing results and build on them.",
];

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "cos-long-continuation-"));
  const store = new Store(folder);
  const s = store.create(process.cwd(), "cos");
  s.cosId = "native-session";
  const op: Operation = {
    id: "original-input",
    sessionId: s.id,
    fingerprint: "input-fingerprint",
    phase: "admitted",
    turnId: null,
    delivery: "sent",
    error: null,
    baseline: 0,
  };
  s.activeInput = op.id;
  s.lastInput = op.id;
  store.saveOperation(op);
  store.saveSession(s);
  const control = {
    async health() {
      return { integration: { tier: "existing-install" } };
    },
    async request<T>(route: string): Promise<T> {
      if (route === "/v1/inputs?limit=500")
        return { inputs: [{ id: op.id, delivery: "sent" }] } as T;
      if (route.includes("/events?")) return { events: [], nextFrom: 0 } as T;
      throw Error("Unexpected route: " + route);
    },
  };
  const engine = new Engine(store, control as never);
  const event = (
    seq: number,
    kind: string,
    turnId?: string,
    extra: Partial<Event> = {},
  ): Event => ({ seq, position: seq, kind, turnId, ...extra });
  const send = (e: Event) => engine.receive(s, e);
  const current = () => store.operation(op.id)!;
  const settle = (ms = TURN_SETTLE_MS + 1) => {
    const o = current();
    // Deterministic simulated clock: no 5-second test sleep.
    (
      engine as unknown as {
        settlePending(s: Session, o: Operation, now: number): void;
      }
    ).settlePending(s, o, (o.pendingEnd?.observedAt ?? Date.now()) + ms);
  };
  return {
    store,
    s,
    op,
    engine,
    send,
    event,
    current,
    settle,
    folder,
    close() {
      store.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

test("four native CoS turns remain one T3 input across completed and interrupted endings", () => {
  const f = fixture();
  try {
    f.send(
      f.event(1, "user_message", undefined, {
        inputId: f.op.id,
        inputDelivery: "confirmed",
        message: { text: "Create an asset" },
      }),
    );
    f.send(f.event(2, "turn_start", "first"));
    assert.equal(f.current().turnId, "first");
    f.send(
      f.event(193, "assistant_message", "first", {
        messageId: "progress-1",
        message: { text: "Still working" },
      }),
    );
    // First CoS continuation is queued BEFORE turn_end, but native outcome
    // is "completed", not "interrupted". This exact case prematurely stopped T3.
    f.send(
      f.event(194, "user_message", "boundary-hint", {
        inputId: "auto-1",
        message: { text: continuations[0]! },
      }),
    );
    f.send(f.event(195, "turn_end", "first", { outcome: "completed" }));
    assert.equal(f.current().awaitingContinuation, true);
    assert.equal(f.current().phase, "admitted");
    f.send(f.event(196, "turn_start", "second"));
    assert.equal(f.current().turnId, "second");
    assert.equal(f.current().awaitingContinuation, false);
    assert.equal(f.s.activeInput, f.op.id);
    f.send(
      f.event(333, "chat_error", "second", {
        message: { text: "Native stream recovery required" },
      }),
    );
    // CoS reports interrupted before its second auto continuation appears.
    f.send(f.event(336, "turn_end", "second", { outcome: "interrupted" }));
    assert.equal(f.current().pendingEnd?.turnId, "second");
    f.send(
      f.event(338, "user_message", "boundary-hint-2", {
        inputId: "auto-2",
        message: { text: continuations[1]! },
      }),
    );
    assert.equal(f.current().awaitingContinuation, true);
    f.send(f.event(339, "turn_start", "third"));
    assert.equal(f.current().turnId, "third");
    // Later third native completion can be followed by a continuation even
    // though its user message was not queued before that turn_end.
    f.send(f.event(503, "turn_end", "third", { outcome: "completed" }));
    assert.equal(f.current().phase, "admitted");
    assert.equal(f.current().pendingEnd?.turnId, "third");
    f.send(
      f.event(505, "user_message", "boundary-hint-3", {
        inputId: "auto-3",
        message: { text: continuations[0]! },
      }),
    );
    f.send(f.event(506, "turn_start", "fourth"));
    assert.equal(f.current().turnId, "fourth");
    const linked = f.current().continuationTurnIds!;
    assert.deepEqual(linked, ["first", "second", "third", "fourth"]);
    assert(
      belongsToInput(
        f.event(688, "assistant_message", "fourth", {
          messageId: "last-real-answer",
          final: true,
        }),
        f.current(),
      ),
    );
    f.send(f.event(689, "turn_end", "fourth", { outcome: "completed" }));
    assert.equal(f.current().phase, "admitted");
    f.settle(TURN_SETTLE_MS - 1);
    assert.equal(f.current().phase, "admitted");
    f.settle();
    assert.equal(f.current().phase, "complete");
    assert.equal(f.s.activeInput, null);
    assert.equal(f.current().turnId, "fourth");
    assert.equal(f.current().pendingEnd, undefined);
  } finally {
    f.close();
  }
});

test("all known CoS continuation variants are matched but ordinary messages are not", () => {
  for (const text of continuations)
    assert(
      isCoSContinuation({
        seq: 1,
        position: 1,
        kind: "user_message",
        message: { text },
      }),
    );
  assert(
    !isCoSContinuation({
      seq: 1,
      position: 1,
      kind: "user_message",
      message: { text: "Continue on another project please" },
    }),
  );
});

test("native turn completion stays pending for grace window and duplicate receipts do not postpone it", () => {
  const f = fixture();
  try {
    f.send(
      f.event(1, "user_message", undefined, {
        inputId: f.op.id,
        inputDelivery: "sent",
        message: { text: "Build" },
      }),
    );
    f.send(f.event(2, "turn_start", "only"));
    f.send(f.event(3, "turn_end", "only", { outcome: "completed" }));
    const until = f.current().pendingEnd?.observedAt;
    assert.equal(f.current().phase, "admitted");
    // Duplicate event receipts and revisionary input receipts do not slide
    // the original completion deadline or emit a new terminal decision.
    f.send(f.event(3, "turn_end", "only", { outcome: "completed" }));
    assert.equal(f.current().pendingEnd?.observedAt, until);
    f.settle();
    assert.equal(f.current().phase, "complete");
  } finally {
    f.close();
  }
});

test("ordinary user messages cannot be mistaken for an automatic continuation", () => {
  const f = fixture();
  try {
    f.send(
      f.event(1, "user_message", undefined, {
        inputId: f.op.id,
        inputDelivery: "confirmed",
        message: { text: "Build" },
      }),
    );
    f.send(f.event(2, "turn_start", "main"));
    f.send(f.event(3, "turn_end", "main", { outcome: "completed" }));
    f.send(
      f.event(4, "user_message", undefined, {
        inputId: "unrelated",
        message: { text: "Hey, are you done?" },
      }),
    );
    assert.equal(f.current().awaitingContinuation, undefined);
    f.settle();
    assert.equal(f.current().phase, "complete");
  } finally {
    f.close();
  }
});

test("pending native completion persists across adapter restart", () => {
  const f = fixture();
  try {
    f.send(
      f.event(1, "user_message", undefined, {
        inputId: f.op.id,
        inputDelivery: "confirmed",
        message: { text: "Build" },
      }),
    );
    f.send(f.event(2, "turn_start", "first"));
    f.send(f.event(3, "turn_end", "first", { outcome: "completed" }));
    const saved = f.current().pendingEnd;
    assert(saved);
    const reread = f.store.session(f.s.id)!;
    const again = f.store.operation(f.op.id)!;
    assert.deepEqual(again.pendingEnd, saved);
    assert.equal(reread.activeInput, f.op.id);
    f.send(
      f.event(4, "user_message", undefined, {
        inputId: "next-runtime-input",
        message: { text: continuations[2]! },
      }),
    );
    f.send(f.event(5, "turn_start", "second"));
    assert.equal(f.current().turnId, "second");
    assert.equal(f.current().pendingEnd, undefined);
  } finally {
    f.close();
  }
});

test("complete T3 ACP prompt stays open through three CoS rotations, receives eventual final", async () => {
  const f = fixture();
  try {
    const realFinal = "THE_AUTHORITATIVE_FINAL_AFTER_FOUR_NATIVE_TURNS";
    const phases: Event[][] = [
      [
        f.event(1, "user_message", undefined, {
          inputId: f.op.id,
          inputDelivery: "confirmed",
          message: { text: "Long overhaul request" },
        }),
        f.event(2, "turn_start", "t-1"),
        f.event(3, "assistant_message", "t-1", {
          messageId: "status1",
          message: { text: "Starting overhaul." },
          final: false,
        }),
        f.event(4, "user_message", undefined, {
          inputId: "coS-auto-1",
          message: { text: continuations[0]! },
        }),
        f.event(5, "turn_end", "t-1", { outcome: "completed" }),
      ],
      [
        f.event(6, "turn_start", "t-2"),
        f.event(7, "assistant_message", "t-2", {
          messageId: "status2",
          message: { text: "Checking camera proportions." },
          final: false,
        }),
        f.event(8, "turn_end", "t-2", { outcome: "interrupted" }),
      ],
      [
        f.event(9, "user_message", undefined, {
          inputId: "coS-auto-recovery",
          message: { text: continuations[1]! },
        }),
        f.event(10, "turn_start", "t-3"),
        f.event(11, "assistant_message", "t-3", {
          messageId: "status3",
          message: { text: "Running a second build and verification." },
          final: false,
        }),
        f.event(12, "turn_end", "t-3", { outcome: "completed" }),
      ],
      [
        f.event(13, "user_message", undefined, {
          inputId: "coS-auto-3",
          message: { text: continuations[0]! },
        }),
        f.event(14, "turn_start", "t-4"),
        f.event(15, "assistant_message", "t-4", {
          messageId: "final",
          message: { text: realFinal },
          final: true,
        }),
        f.event(16, "turn_end", "t-4", { outcome: "completed" }),
      ],
      [],
    ];
    let requests = 0;
    const adapter = new Adapter({
      async call<T>(
        method: string,
        args?: Record<string, unknown>,
      ): Promise<T> {
        if (method === "health")
          return {
            actions: { enabled: true, routes: [] },
            routes: [],
            integration: { tier: "existing-install" },
          } as T;
        if (method === "start") return f.current() as T;
        if (method === "models")
          return { state: "unavailable", models: [] } as T;
        if (method === "workers") return { workers: [] } as T;
        if (method === "state") {
          const batch = phases[requests++] ?? [];
          for (const event of batch) f.send(event);
          if (requests === phases.length) {
            const pending = f.current().pendingEnd!;
            assert(pending);
            (
              f.engine as unknown as {
                settlePending(s: Session, o: Operation, now: number): void;
              }
            ).settlePending(
              f.s,
              f.current(),
              pending.observedAt + TURN_SETTLE_MS + 1,
            );
          }
          return {
            session: f.store.session(f.s.id),
            operation: f.current(),
            events: f.store.events(f.s.id, Number(args?.after ?? 0)),
          } as T;
        }
        throw Error("Unexpected gateway request " + method);
      },
    });
    await adapter.initialize({ clientInfo: { name: "t3-code" } });
    adapter.sessions.set(f.s.id, f.s);
    const updates: Array<Record<string, any>> = [];
    const result = await adapter.prompt(
      f.s.id,
      [{ type: "text", text: "Build and verify" }],
      null,
      {
        async notify(method, params: any) {
          if (method === "session/update") updates.push(params.update);
        },
        async request<T>() {
          throw Error("Unneeded permission request");
        },
      },
      new AbortController().signal,
    );
    assert.equal(result.stopReason, "end_turn");
    assert.equal(requests, phases.length);
    const visible = updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => String(u.content?.text ?? ""));
    assert(visible.some((s) => s.includes("Starting overhaul")));
    assert(visible.some((s) => s.includes("camera proportions")));
    assert(visible.some((s) => s.includes("second build")));
    assert.equal(visible.at(-1), realFinal);
    assert.equal(f.current().phase, "complete");
    assert.equal(f.current().continuationTurnIds?.length, 4);
  } finally {
    f.close();
  }
});

test("reconciliation cannot overwrite a later native continuation while an input lookup is in flight", async () => {
  const f = fixture();
  try {
    f.send(
      f.event(1, "user_message", undefined, {
        inputId: f.op.id,
        inputDelivery: "confirmed",
        message: { text: "Build" },
      }),
    );
    f.send(f.event(2, "turn_start", "t-1"));
    let release!: (result: any) => void;
    const delayed = new Promise<any>((resolve) => {
      release = resolve;
    });
    const engine = new Engine(f.store, {
      async health() {
        return { integration: { tier: "existing-install" } };
      },
      async request<T>(route: string): Promise<T> {
        if (route === "/v1/inputs?limit=500") return delayed as T;
        if (route.includes("/events?")) return { events: [], nextFrom: 0 } as T;
        throw Error("Unexpected route " + route);
      },
    } as never);
    const olderSession = f.store.session(f.s.id)!;
    const olderOperation = f.current();
    const reconciling = engine.reconcile(olderSession, olderOperation);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The actual SSE stream progresses while the query has not completed.
    f.send(
      f.event(3, "user_message", undefined, {
        inputId: "auto-1",
        message: { text: continuations[0]! },
      }),
    );
    f.send(f.event(4, "turn_end", "t-1", { outcome: "completed" }));
    f.send(f.event(5, "turn_start", "t-2"));
    f.send(
      f.event(6, "assistant_message", "t-2", {
        messageId: "later",
        message: { text: "Working on second turn" },
      }),
    );
    release({ inputs: [{ id: f.op.id, delivery: "sent", state: "sent" }] });
    await reconciling;
    assert.equal(f.current().turnId, "t-2");
    assert.deepEqual(f.current().continuationTurnIds, ["t-1", "t-2"]);
    assert.equal(f.current().phase, "admitted");
    assert.equal(f.store.session(f.s.id)?.seq, 6);
  } finally {
    f.close();
  }
});

test("reconciliation drains a queued continuation before settling an expired completion candidate", async () => {
  const f = fixture();
  try {
    f.send(
      f.event(1, "user_message", undefined, {
        inputId: f.op.id,
        inputDelivery: "confirmed",
        message: { text: "Build" },
      }),
    );
    f.send(f.event(2, "turn_start", "first"));
    f.send(f.event(3, "turn_end", "first", { outcome: "completed" }));
    const pending = f.current().pendingEnd!;
    // Model a delayed network recovery: the local settlement clock has
    // already expired, but native CoS has an automatic user message queued.
    const o = f.current();
    o.pendingEnd!.observedAt -= TURN_SETTLE_MS + 1000;
    f.store.saveOperation(o);
    const nextEvents = [
      f.event(4, "user_message", undefined, {
        inputId: "auto-after-end",
        message: { text: continuations[0]! },
      }),
      f.event(5, "turn_start", "second"),
    ];
    const engine = new Engine(f.store, {
      async health() {
        return { integration: { tier: "existing-install" } };
      },
      async request<T>(route: string): Promise<T> {
        if (route === "/v1/inputs?limit=500")
          return { inputs: [{ id: f.op.id, delivery: "sent" }] } as T;
        if (route.includes("/events?"))
          return { events: nextEvents, nextFrom: 6 } as T;
        throw Error("Unexpected route " + route);
      },
    } as never);
    await engine.reconcile(f.s, f.current());
    assert.notEqual(pending, undefined);
    assert.equal(f.current().phase, "admitted");
    assert.equal(f.current().turnId, "second");
    assert.equal(f.current().pendingEnd, undefined);
  } finally {
    f.close();
  }
});
