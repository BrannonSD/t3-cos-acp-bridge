import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Control } from "../src/control.js";
import { Engine, TURN_SETTLE_MS } from "../src/engine.js";
import { Store, fingerprint } from "../src/store.js";
import {
  BridgeError,
  type Event,
  type Input,
  type Session,
} from "../src/contracts.js";
class FakeControl extends Control {
  calls: Array<{ route: string; body: Record<string, unknown> | undefined }> =
    [];
  rows = new Map<string, Input>();
  events: Event[] = [];
  uncertain = false;
  cancelPending = true;
  constructor() {
    super("unused");
  }
  override async health() {
    return {
      ok: true as const,
      protocol: 1,
      pid: process.pid,
      startedAt: "fixture",
      routes: ["/v1/projects", "/v1/models"],
      actions: {
        enabled: true,
        routes: [
          "POST /v1/inputs",
          "POST /v1/attachments",
          "POST /v1/sessions/{id}/approval-policy",
        ],
      },
    };
  }
  override async request<T>(route: string, body?: unknown): Promise<T> {
    const value = body as Record<string, unknown> | undefined;
    this.calls.push({ route, body: value });
    let result: unknown;
    if (route === "/v1/projects")
      result = {
        projects: [
          {
            id: "00000000-0000-4000-a000-000000000001",
            root: process.cwd(),
            available: true,
            remote: false,
          },
        ],
      };
    else if (route === "/v1/models")
      result = {
        state: "ready",
        models: [
          {
            id: "chatgpt-real",
            label: "Actual account model",
            efforts: ["high", "max"],
          },
        ],
      };
    else if (route.endsWith("/approval-policy")) result = { mode: value?.mode };
    else if (route.endsWith("/workers"))
      result = { workers: [{ id: "worker-1", sessionId: "child-read-only" }] };
    else if (route.startsWith("/v1/approvals?"))
      result = { mode: "supervised", approvals: [] };
    else if (route === "/v1/inputs" && value) {
      const id = String(value.id);
      const input: Input = {
        id,
        sessionId: String(value.sessionId ?? id),
        deliveredSessionId: null,
        conversationId: null,
        delivery: "pending",
        state: "queued",
        messageId: null,
        error: null,
      };
      this.rows.set(id, input);
      if (this.uncertain)
        throw new BridgeError("action_timeout", "Outcome unknown");
      result = { input, replayed: false };
    } else if (/\/inputs\/[^/]+\/cancel$/.test(route)) {
      const id = route.split("/")[3];
      const row = this.rows.get(id)!;
      if (!this.cancelPending)
        throw new BridgeError("not_cancellable", "Already delivered");
      row.delivery = "not_sent";
      row.state = "cancelled";
      result = { input: row, cancelled: true };
    } else if (route.startsWith("/v1/inputs/")) {
      const row = this.rows.get(route.split("/")[3]);
      if (!row) throw new BridgeError("input_not_found", "Not found");
      result = { input: row };
    } else if (route.includes("/events?")) {
      const url = new URL("http://local" + route);
      const from = Number(url.searchParams.get("from") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      // Stock CoS rejects any events page beyond 100 rows (MAX_EVENTS).
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new BridgeError("invalid_query", "limit is not valid");
      const events = this.events
        .filter((e) => e.seq >= from)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
      result = {
        events,
        nextFrom: (events.at(-1)?.seq ?? 0) + 1,
        total: this.events.length,
      };
    } else if (route.includes("/assets/"))
      result = { asset: { id: route.split("/").at(-1), data: "YWJj" } };
    else if (route.endsWith("/stop")) result = { live: { stopPending: true } };
    else throw new Error("Unexpected route " + route);
    return result as T;
  }
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cos-acp-test-"));
  const control = new FakeControl();
  const store = new Store(directory);
  const engine = new Engine(store, control);
  engine.watch = () => {};
  return {
    directory,
    control,
    store,
    engine,
    async close() {
      engine.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
function settle(s: Session, opId: string, engine: Engine, store: Store) {
  const operation = store.operation(opId)!;
  assert(
    operation.pendingEnd,
    "Native terminal is pending during the continuation grace window",
  );
  (
    engine as unknown as {
      settlePending(s: Session, o: typeof operation, now: number): void;
    }
  ).settlePending(
    store.session(s.id)!,
    operation,
    operation.pendingEnd.observedAt + TURN_SETTLE_MS + 1,
  );
}
test("new session reserves identity; first prompt binds workspace and policy before durable outbox admission", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    assert.equal(f.control.calls.length, 0);
    await f.engine.set(s.id, { model: "chatgpt-real", effort: "max" });
    const op = await f.engine.start(s.id, "Implement task", [], "t3-turn-1");
    const send = f.control.calls.find((c) => c.route === "/v1/inputs")!;
    assert.equal(send.body?.sessionId, undefined);
    assert.equal(send.body?.id, op.id);
    assert.equal(send.body?.cwd, process.cwd());
    assert.equal(send.body?.model, "chatgpt-real");
    assert.equal(send.body?.reasoningEffort, "max");
    const policy = f.control.calls.find((c) =>
      c.route.endsWith("/approval-policy"),
    )!;
    assert.equal(policy.route, `/v1/sessions/${op.id}/approval-policy`);
    assert.equal(policy.body?.mode, "supervised");
    const lease = f.control.calls.findIndex(
      (c) => c.route === `/v1/approvals?sessionId=${op.id}`,
    );
    const admission = f.control.calls.findIndex(
      (c) => c.route === "/v1/inputs",
    );
    assert(
      lease >= 0 && lease < admission,
      "controller lease precedes admission",
    );
    assert.equal(f.store.session(s.id)?.cosId, op.id);
  } finally {
    await f.close();
  }
});
test("idempotent prompt ID prevents a duplicate after completion and across adapter restart", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    const op = await f.engine.start(s.id, "Same request", [], "turn-1");
    const row = f.control.rows.get(op.id)!;
    row.delivery = "sent";
    row.conversationId = "real-chatgpt-id";
    const current = f.engine.session(s.id);
    f.engine.receive(current, {
      seq: 1,
      position: 0,
      kind: "user_message",
      inputId: op.id,
      inputDelivery: "sent",
      turnId: "exact-turn",
    });
    f.engine.receive(current, {
      seq: 2,
      position: 1,
      kind: "turn_start",
      turnId: "exact-turn",
    });
    f.engine.receive(current, {
      seq: 3,
      position: 2,
      kind: "turn_end",
      turnId: "exact-turn",
      outcome: "completed",
    });
    settle(s, op.id, f.engine, f.store);
    assert.equal(f.store.operation(op.id)?.phase, "complete");
    const restarted = new Engine(f.store, f.control);
    restarted.watch = () => {};
    assert.equal(
      (await restarted.start(s.id, "Same request", [], "turn-1")).id,
      op.id,
    );
    assert.equal(
      f.control.calls.filter((c) => c.route === "/v1/inputs").length,
      1,
    );
    await assert.rejects(
      restarted.start(s.id, "Changed request", [], "turn-1"),
      { code: "id_conflict" },
    );
  } finally {
    await f.close();
  }
});
test("stable prompt IDs are globally claimed and cannot replay through a new ACP session", async () => {
  const f = await fixture();
  try {
    const first = await f.engine.create(process.cwd());
    const original = await f.engine.start(
      first.id,
      "Do this once",
      [],
      "t3-message-1",
    );
    assert.equal(
      f.store.promptOwner(fingerprint({ promptId: "t3-message-1" })),
      first.id,
    );
    const second = await f.engine.create(process.cwd());
    await assert.rejects(
      f.engine.start(second.id, "Do this once", [], "t3-message-1"),
      { code: "outcome_unconfirmed" },
    );
    assert.equal(
      f.control.calls.filter((c) => c.route === "/v1/inputs").length,
      1,
    );
    const reopened = new Store(f.directory);
    assert.equal(
      reopened.promptOwner(fingerprint({ promptId: "t3-message-1" })),
      first.id,
    );
    const restarted = new Engine(reopened, f.control);
    restarted.watch = () => {};
    await assert.rejects(
      restarted.start(second.id, "Do this once", [], "t3-message-1"),
      { code: "outcome_unconfirmed" },
    );
    const fresh = await restarted.start(
      second.id,
      "An intentional new message",
      [],
      "t3-message-2",
    );
    assert.notEqual(fresh.id, original.id);
    assert.equal(
      f.control.calls.filter((c) => c.route === "/v1/inputs").length,
      2,
    );
    reopened.close();
  } finally {
    await f.close();
  }
});
test("a timed-out admission retains global prompt ownership across fresh sessions", async () => {
  const f = await fixture();
  try {
    f.control.uncertain = true;
    const first = await f.engine.create(process.cwd());
    const op = await f.engine.start(
      first.id,
      "Potentially sent",
      [],
      "unknown-delivery-key",
    );
    assert.equal(op.phase, "uncertain");
    const second = await f.engine.create(process.cwd());
    await assert.rejects(
      f.engine.start(second.id, "Potentially sent", [], "unknown-delivery-key"),
      { code: "outcome_unconfirmed" },
    );
    assert.equal(
      f.control.calls.filter((c) => c.route === "/v1/inputs").length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("admitted write followed by timeout reconciles original input and never automatically resends", async () => {
  const f = await fixture();
  try {
    f.control.uncertain = true;
    const s = await f.engine.create(process.cwd());
    const op = await f.engine.start(s.id, "Uncertain request", [], "turn-u");
    assert.equal(op.phase, "uncertain");
    assert.equal(f.store.session(s.id)?.activeInput, op.id);
    const restarted = new Engine(f.store, f.control);
    restarted.watch = () => {};
    assert.equal(
      (await restarted.start(s.id, "Uncertain request", [], "turn-u")).id,
      op.id,
    );
    await assert.rejects(
      restarted.start(s.id, "Another request", [], "turn-next"),
      { code: "outcome_unconfirmed" },
    );
    assert.equal(
      f.control.calls.filter((c) => c.route === "/v1/inputs").length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("completion requires delivery receipt and exact turn, including late user-message revision", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    const o = await f.engine.start(s.id, "Correlate", []);
    const current = f.engine.session(s.id);
    f.engine.receive(current, {
      seq: 1,
      position: 0,
      kind: "turn_end",
      turnId: "unrelated",
      outcome: "completed",
    });
    f.engine.receive(current, {
      seq: 2,
      position: 1,
      kind: "user_message",
      inputId: o.id,
    });
    f.engine.receive(current, {
      seq: 3,
      position: 2,
      kind: "turn_start",
      turnId: "actual",
    });
    f.engine.receive(current, {
      seq: 4,
      position: 3,
      kind: "turn_end",
      turnId: "actual",
      outcome: "completed",
    });
    assert.equal(f.store.operation(o.id)?.phase, "admitted");
    // The late revision proves delivery but carries only a page marker; the
    // recorded turn_start is what names the exact turn.
    f.engine.receive(current, {
      seq: 5,
      position: 1,
      kind: "user_message",
      inputId: o.id,
      inputDelivery: "sent",
      turnId: "c0ffee00-0000-4000-8000-000000000000",
    });
    assert.equal(f.store.operation(o.id)?.turnId, "actual");
    settle(s, o.id, f.engine, f.store);
    assert.equal(f.store.operation(o.id)?.phase, "complete");
  } finally {
    await f.close();
  }
});
test("queued cancellation proves not-sent; active cancellation names the observed exact turn", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    const o = await f.engine.start(s.id, "Cancel queued", []);
    assert.deepEqual(await f.engine.cancel(s.id), { confirmed: true });
    assert.equal(f.store.operation(o.id)?.phase, "cancelled");
    const second = await f.engine.start(s.id, "Cancel active", []);
    f.control.rows.get(second.id)!.delivery = "sent";
    f.control.cancelPending = false;
    f.control.events = [
      {
        seq: 1,
        position: 0,
        kind: "user_message",
        inputId: second.id,
        inputDelivery: "sent",
        turnId: "do-not-stop-newer-turn",
      },
      {
        seq: 2,
        position: 1,
        kind: "turn_start",
        turnId: "do-not-stop-newer-turn",
      },
    ];
    assert.deepEqual(await f.engine.cancel(s.id), {
      confirmed: false,
      turnId: "do-not-stop-newer-turn",
    });
    assert.deepEqual(
      f.control.calls.find((c) => c.route.endsWith("/stop"))?.body,
      { turnId: "do-not-stop-newer-turn" },
    );
    assert.equal(f.store.operation(second.id)?.phase, "admitted");
  } finally {
    await f.close();
  }
});
test("cancel with unconfirmed identity refuses a broad stop", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    const o = await f.engine.start(s.id, "Unknown turn", []);
    f.control.rows.get(o.id)!.delivery = "unconfirmed";
    await assert.rejects(f.engine.cancel(s.id), {
      code: "outcome_unconfirmed",
    });
    assert.equal(
      f.control.calls.some((c) => c.route.endsWith("/stop")),
      false,
    );
  } finally {
    await f.close();
  }
});

test("unknown turn end does not settle an admitted prompt; failed turn retains failure outcome", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    const o = await f.engine.start(s.id, "Watch actual outcome", []);
    const current = f.engine.session(s.id);
    f.engine.receive(current, {
      seq: 1,
      position: 0,
      kind: "user_message",
      inputId: o.id,
      inputDelivery: "sent",
      turnId: "actual-turn",
    });
    f.engine.receive(current, {
      seq: 2,
      position: 1,
      kind: "turn_start",
      turnId: "actual-turn",
    });
    f.engine.receive(current, {
      seq: 3,
      position: 2,
      kind: "turn_end",
      turnId: "actual-turn",
      outcome: "unknown",
    });
    assert.equal(f.store.operation(o.id)?.phase, "admitted");
    assert.equal(f.store.session(s.id)?.activeInput, o.id);
    f.engine.receive(current, {
      seq: 4,
      position: 3,
      kind: "turn_end",
      turnId: "actual-turn",
      outcome: "failed",
    });
    assert.equal(f.store.operation(o.id)?.phase, "failed");
    assert.equal(f.store.operation(o.id)?.error, "turn_failed");
    assert.equal(f.store.session(s.id)?.activeInput, null);
  } finally {
    await f.close();
  }
});

test("broker limits worker transcript reads to a child of the requested parent", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    await f.engine.start(s.id, "Delegate", []);
    f.control.events = [
      {
        seq: 1,
        position: 0,
        kind: "assistant_message",
        message: { text: "Child output" },
      },
    ];
    const result = (await f.engine.dispatch("worker-events", {
      sessionId: s.id,
      workerSessionId: "child-read-only",
      after: 0,
    })) as { events: Event[] };
    assert.equal(result.events[0]?.message?.text, "Child output");
    await assert.rejects(
      f.engine.dispatch("worker-events", {
        sessionId: s.id,
        workerSessionId: "foreign-child",
        after: 0,
      }),
      { code: "worker_not_in_session" },
    );
    assert.equal(
      f.control.calls.some((c) => c.route.includes("/foreign-child/events?")),
      false,
    );
  } finally {
    await f.close();
  }
});

test("asset dispatch accepts only parent or owned worker images with safe IDs", async () => {
  const f = await fixture();
  try {
    const session = await f.engine.create(process.cwd());
    await f.engine.start(session.id, "Generate art", []);
    const parent = (await f.engine.dispatch("asset", {
      sessionId: session.id,
      assetId: "deadbeef.png",
    })) as { asset: { data: string } };
    assert.equal(parent.asset.data, "YWJj");
    await f.engine.dispatch("asset", {
      sessionId: session.id,
      workerSessionId: "child-read-only",
      assetId: "deadbeef.png",
    });
    await assert.rejects(
      f.engine.dispatch("asset", {
        sessionId: session.id,
        workerSessionId: "another-session",
        assetId: "deadbeef.png",
      }),
      { code: "worker_not_in_session" },
    );
    await assert.rejects(
      f.engine.dispatch("asset", {
        sessionId: session.id,
        assetId: "../token",
      }),
      { code: "invalid_asset" },
    );
    assert.equal(
      f.control.calls.some((c) => c.route.includes("another-session/assets")),
      false,
    );
  } finally {
    await f.close();
  }
});
test("stock vocabulary: a confirmed message links the named turn and settles on its end", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    const o = await f.engine.start(s.id, "Stock vocabulary", []);
    const current = f.engine.session(s.id);
    // The recorded stock stream: user_message confirms delivery, then the
    // turn_start event names the turn the user message never carried.
    f.engine.receive(current, {
      seq: 1,
      position: 1,
      kind: "user_message",
      inputId: o.id,
      inputDelivery: "confirmed",
    });
    f.engine.receive(current, {
      seq: 2,
      position: 2,
      kind: "turn_start",
      turnId: "g-stock-1",
    });
    assert.equal(f.store.operation(o.id)?.delivery, "sent");
    assert.equal(f.store.operation(o.id)?.turnId, "g-stock-1");
    assert.equal(f.store.operation(o.id)?.phase, "admitted");
    f.engine.receive(current, {
      seq: 3,
      position: 3,
      kind: "turn_end",
      turnId: "g-stock-1",
      outcome: "completed",
    });
    settle(s, o.id, f.engine, f.store);
    assert.equal(f.store.operation(o.id)?.phase, "complete");
    assert.equal(f.store.session(s.id)?.activeInput, null);
    assert.equal(
      f.control.calls.filter((c) => c.route === "/v1/inputs").length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("offered is never delivery proof: an unproven handout never links or settles a turn", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    const o = await f.engine.start(s.id, "Offered only", []);
    const current = f.engine.session(s.id);
    f.engine.receive(current, {
      seq: 1,
      position: 1,
      kind: "user_message",
      inputId: o.id,
      inputDelivery: "offered",
    });
    f.engine.receive(current, {
      seq: 2,
      position: 2,
      kind: "turn_start",
      turnId: "g-foreign",
    });
    assert.equal(
      f.store.operation(o.id)?.turnId,
      null,
      "an offered handout must not claim a turn",
    );
    assert.equal(f.store.operation(o.id)?.delivery, "pending");
    f.engine.receive(current, {
      seq: 3,
      position: 3,
      kind: "turn_end",
      turnId: "g-foreign",
      outcome: "completed",
    });
    assert.equal(f.store.operation(o.id)?.phase, "admitted");
    // Even after a later confirmation, the turn that started while this input
    // was only offered must not be retroactively claimed.
    f.engine.receive(current, {
      seq: 4,
      position: 4,
      kind: "user_message",
      inputId: o.id,
      inputDelivery: "confirmed",
    });
    const stored = f.store.operation(o.id)!;
    await f.engine.reconcile(current, stored);
    assert.equal(f.store.operation(o.id)?.delivery, "sent");
    assert.equal(f.store.operation(o.id)?.turnId, null);
    assert.equal(f.store.operation(o.id)?.phase, "admitted");
  } finally {
    await f.close();
  }
});
test("a tool handout carries its own turn: confirmation under the actual turn settles, not the stale one", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    const o = await f.engine.start(s.id, "Injected handout", []);
    const current = f.engine.session(s.id);
    // The injection lands inside an already-started turn, so its toolTurnId
    // names a turn the recorded stream has already begun.
    f.engine.receive(current, {
      seq: 1,
      position: 1,
      kind: "turn_start",
      turnId: "g-injected",
    });
    f.engine.receive(current, {
      seq: 2,
      position: 2,
      kind: "user_message",
      inputId: o.id,
      inputDelivery: "offered",
      turnId: "g-injected",
    });
    assert.equal(f.store.operation(o.id)?.turnId, "g-injected");
    assert.equal(f.store.operation(o.id)?.delivery, "pending");
    f.engine.receive(current, {
      seq: 3,
      position: 3,
      kind: "turn_end",
      turnId: "g-injected",
      outcome: "completed",
    });
    assert.equal(
      f.store.operation(o.id)?.phase,
      "admitted",
      "an offered injection that was never acked does not settle",
    );
    f.engine.receive(current, {
      seq: 4,
      position: 4,
      kind: "turn_start",
      turnId: "g-reoffer",
    });
    assert.equal(f.store.operation(o.id)?.turnId, "g-injected");
    f.engine.receive(current, {
      seq: 5,
      position: 5,
      kind: "user_message",
      inputId: o.id,
      inputDelivery: "confirmed",
      turnId: "g-reoffer",
    });
    assert.equal(f.store.operation(o.id)?.turnId, "g-reoffer");
    assert.equal(f.store.operation(o.id)?.delivery, "sent");
    f.engine.receive(current, {
      seq: 6,
      position: 6,
      kind: "turn_end",
      turnId: "g-reoffer",
      outcome: "completed",
    });
    settle(s, o.id, f.engine, f.store);
    assert.equal(f.store.operation(o.id)?.phase, "complete");
    assert.equal(f.store.session(s.id)?.activeInput, null);
  } finally {
    await f.close();
  }
});
test("a page-side message marker never masquerades as a turn", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    const o = await f.engine.start(s.id, "Follow-up marker", []);
    const current = f.engine.session(s.id);
    // Live stock 2.1.39: a confirmed follow-up carries its own page marker,
    // which is the native message id, not the execution turn.
    f.engine.receive(current, {
      seq: 1,
      position: 1,
      kind: "user_message",
      inputId: o.id,
      inputDelivery: "confirmed",
      turnId: "88b602f4-4726-4ae0-9604-e45ee44532b4",
    });
    assert.equal(f.store.operation(o.id)?.delivery, "sent");
    assert.equal(
      f.store.operation(o.id)?.turnId,
      null,
      "a marker must not pin the operation to a turn that never started",
    );
    f.engine.receive(current, {
      seq: 2,
      position: 2,
      kind: "turn_start",
      turnId: "g-1n8rxw61e4mdo4-0-2",
    });
    assert.equal(f.store.operation(o.id)?.turnId, "g-1n8rxw61e4mdo4-0-2");
    f.engine.receive(current, {
      seq: 3,
      position: 3,
      kind: "turn_end",
      turnId: "g-1n8rxw61e4mdo4-0-2",
      outcome: "completed",
    });
    settle(s, o.id, f.engine, f.store);
    assert.equal(f.store.operation(o.id)?.phase, "complete");
    assert.equal(f.store.session(s.id)?.activeInput, null);
  } finally {
    await f.close();
  }
});
test("reconciliation drops a persisted page marker and settles the recorded turn without resending", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    const o = await f.engine.start(s.id, "Marker persisted", []);
    const current = f.engine.session(s.id);
    f.store.append(current, {
      seq: 1,
      position: 1,
      kind: "user_message",
      inputId: o.id,
      inputDelivery: "confirmed",
      turnId: "88b602f4-4726-4ae0-9604-e45ee44532b4",
    });
    f.store.append(current, {
      seq: 2,
      position: 2,
      kind: "turn_start",
      turnId: "g-1n8rxw61e4mdo4-0-2",
    });
    f.store.append(current, {
      seq: 3,
      position: 3,
      kind: "turn_end",
      turnId: "g-1n8rxw61e4mdo4-0-2",
      outcome: "completed",
    });
    // An earlier build linked the page marker; delivery was already proven.
    const stuck = f.store.operation(o.id)!;
    stuck.turnId = "88b602f4-4726-4ae0-9604-e45ee44532b4";
    stuck.delivery = "sent";
    f.store.saveOperation(stuck);
    assert.equal(f.store.operation(o.id)?.phase, "admitted");
    const restarted = new Engine(f.store, f.control);
    restarted.watch = () => {};
    await restarted.reconcile(
      restarted.session(s.id),
      f.store.operation(o.id)!,
    );
    settle(s, o.id, restarted, f.store);
    const settled = f.store.operation(o.id)!;
    assert.equal(settled.turnId, "g-1n8rxw61e4mdo4-0-2");
    assert.equal(settled.phase, "complete");
    assert.equal(f.store.session(s.id)?.activeInput, null);
    assert.equal(
      f.control.calls.filter((c) => c.route === "/v1/inputs").length,
      1,
      "reconciliation never resends the retained input",
    );
  } finally {
    await f.close();
  }
});
test("post-restart reconciliation settles a completed stock turn from stored receipts without resending", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    const o = await f.engine.start(s.id, "Stuck but completed", []);
    const current = f.engine.session(s.id);
    // Receipts recorded by an older adapter build that never linked turns.
    f.store.append(current, {
      seq: 1,
      position: 1,
      kind: "user_message",
      inputId: o.id,
      inputDelivery: "confirmed",
    });
    f.store.append(current, {
      seq: 2,
      position: 2,
      kind: "turn_start",
      turnId: "g-stuck-1",
    });
    f.store.append(current, {
      seq: 3,
      position: 3,
      kind: "turn_end",
      turnId: "g-stuck-1",
      outcome: "completed",
    });
    const stuck = f.store.operation(o.id)!;
    stuck.delivery = "sent";
    f.store.saveOperation(stuck);
    const restarted = new Engine(f.store, f.control);
    restarted.watch = () => {};
    const replay = f.store.operation(o.id)!;
    assert.equal(replay.phase, "admitted");
    assert.equal(replay.turnId, null);
    await restarted.reconcile(restarted.session(s.id), replay);
    settle(s, o.id, restarted, f.store);
    const settled = f.store.operation(o.id)!;
    assert.equal(settled.phase, "complete");
    assert.equal(settled.turnId, "g-stuck-1");
    assert.equal(f.store.session(s.id)?.activeInput, null);
    assert.equal(
      f.control.calls.filter((c) => c.route === "/v1/inputs").length,
      1,
      "reconciliation never resends the retained input",
    );
    await restarted.start(s.id, "Next instruction", [], "turn-next");
    assert.equal(
      f.control.calls.filter((c) => c.route === "/v1/inputs").length,
      2,
    );
  } finally {
    await f.close();
  }
});
test("catch-up pages stock events within the runtime's 100-row bound", async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create(process.cwd());
    await f.engine.start(s.id, "Build history", []);
    f.control.events = Array.from({ length: 150 }, (_, index) => ({
      seq: index + 1,
      position: index,
      kind: "assistant_message",
      message: { text: `record ${index + 1}` },
    }));
    await f.engine.catchUp(f.engine.session(s.id));
    assert.equal(f.store.events(s.id, 0).length, 150);
    const pages = f.control.calls.filter((c) => c.route.includes("/events?"));
    assert(pages.length >= 2, "a stock catch-up must page within the bound");
    for (const page of pages) {
      const limit = Number(
        new URL("http://local" + page.route).searchParams.get("limit"),
      );
      assert(
        limit >= 1 && limit <= 100,
        `page limit ${limit} exceeds stock caps`,
      );
    }
  } finally {
    await f.close();
  }
});

test("CoS automatic continuation keeps the same T3 prompt open across interrupted turns", async () => {
  const f = await fixture();
  try {
    const session = await f.engine.create(process.cwd());
    const op = await f.engine.start(session.id, "Implement task", []);
    const active = f.engine.session(session.id);
    const admitted = f.control.rows.get(op.id)!;
    admitted.delivery = "sent";
    admitted.state = "delivered";
    const automatic =
      "Continue the task from where you are. (Chat On Steroids starts a fresh turn every so often so long work stays reliable; nothing else changed.)";
    const events: Event[] = [
      {
        seq: 1,
        position: 1,
        kind: "user_message",
        inputId: op.id,
        inputDelivery: "confirmed",
        message: { text: "Implement task" },
      },
      { seq: 2, position: 2, kind: "turn_start", turnId: "turn-original" },
      {
        seq: 3,
        position: 3,
        kind: "assistant_message",
        turnId: "turn-original",
        messageId: "first",
        message: { text: "Working..." },
      },
      {
        seq: 4,
        position: 4,
        kind: "user_message",
        inputId: "cos-continuation-id",
        message: { text: automatic },
      },
      {
        seq: 5,
        position: 5,
        kind: "turn_end",
        turnId: "turn-original",
        outcome: "interrupted",
      },
    ];
    for (const event of events) f.engine.receive(active, event);
    assert.equal(f.store.operation(op.id)?.phase, "admitted");
    assert.equal(f.store.operation(op.id)?.awaitingContinuation, true);
    assert.equal(f.store.session(session.id)?.activeInput, op.id);
    await f.engine.reconcile(active, f.store.operation(op.id)!);
    assert.equal(
      f.store.operation(op.id)?.phase,
      "admitted",
      "reconciliation cannot cancel a pending automatic continuation",
    );
    f.engine.receive(active, {
      seq: 6,
      position: 6,
      kind: "turn_start",
      turnId: "turn-resumed",
    });
    assert.equal(f.store.operation(op.id)?.turnId, "turn-resumed");
    assert.deepEqual(f.store.operation(op.id)?.continuationTurnIds, [
      "turn-original",
      "turn-resumed",
    ]);
    f.engine.receive(active, {
      seq: 7,
      position: 7,
      kind: "assistant_message",
      turnId: "turn-resumed",
      messageId: "last",
      message: { text: "Finished." },
    });
    f.engine.receive(active, {
      seq: 8,
      position: 8,
      kind: "turn_end",
      turnId: "turn-resumed",
      outcome: "completed",
    });
    settle(session, op.id, f.engine, f.store);
    assert.equal(f.store.operation(op.id)?.phase, "complete");
    assert.equal(f.store.session(session.id)?.activeInput, null);
    assert.equal(
      f.control.calls.filter((c) => c.route === "/v1/inputs").length,
      1,
      "must not submit continuation twice",
    );
  } finally {
    await f.close();
  }
});

test("a genuinely interrupted CoS turn without an automatic continuation still ends", async () => {
  const f = await fixture();
  try {
    const session = await f.engine.create(process.cwd());
    const op = await f.engine.start(session.id, "Stop task", []);
    const active = f.engine.session(session.id);
    f.control.rows.get(op.id)!.delivery = "sent";
    f.engine.receive(active, {
      seq: 1,
      position: 1,
      kind: "user_message",
      inputId: op.id,
      inputDelivery: "confirmed",
      message: { text: "Stop task" },
    });
    f.engine.receive(active, {
      seq: 2,
      position: 2,
      kind: "turn_start",
      turnId: "turn-stopped",
    });
    f.engine.receive(active, {
      seq: 3,
      position: 3,
      kind: "turn_end",
      turnId: "turn-stopped",
      outcome: "interrupted",
    });
    settle(session, op.id, f.engine, f.store);
    assert.equal(f.store.operation(op.id)?.phase, "cancelled");
    assert.equal(f.store.session(session.id)?.activeInput, null);
  } finally {
    await f.close();
  }
});

test("a user repeating the continuation sentence as their own instruction is not treated as internal", async () => {
  const f = await fixture();
  try {
    const sentence =
      "Continue the task from where you are. (Chat On Steroids starts a fresh turn every so often so long work stays reliable; nothing else changed.)";
    const session = await f.engine.create(process.cwd());
    const op = await f.engine.start(session.id, sentence, []);
    const active = f.engine.session(session.id);
    f.control.rows.get(op.id)!.delivery = "sent";
    f.engine.receive(active, {
      seq: 1,
      position: 1,
      kind: "user_message",
      inputId: op.id,
      inputDelivery: "confirmed",
      message: { text: sentence },
    });
    f.engine.receive(active, {
      seq: 2,
      position: 2,
      kind: "turn_start",
      turnId: "manual",
    });
    f.engine.receive(active, {
      seq: 3,
      position: 3,
      kind: "turn_end",
      turnId: "manual",
      outcome: "interrupted",
    });
    settle(session, op.id, f.engine, f.store);
    assert.equal(f.store.operation(op.id)?.phase, "cancelled");
    assert.notEqual(f.store.operation(op.id)?.awaitingContinuation, true);
  } finally {
    await f.close();
  }
});
