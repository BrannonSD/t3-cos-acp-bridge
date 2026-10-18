import assert from "node:assert/strict";
import { test } from "node:test";
import { FinalAnswerProjection } from "../src/final-answer.js";
import { Translator } from "../src/translate.js";
import { Adapter } from "../src/adapter.js";
import type { Event, Operation, Session } from "../src/contracts.js";

const event = (
  seq: number,
  id: string,
  text: string,
  final: boolean,
  position: number,
  turnId = "turn-1",
): Event => ({
  seq,
  position,
  kind: "assistant_message",
  turnId,
  messageId: id,
  message: { text },
  final,
});
const end = (seq: number, turnId: string, outcome: string): Event => ({
  seq,
  position: seq,
  kind: "turn_end",
  turnId,
  outcome,
});
const fullAnswer =
  "The finished project is configured and saved. " +
  "It contains the expected separate mesh materials, presets and editor checks. " +
  "Client playtesting and packaging validation remain to be completed.";
const updatesFor = (updates: Record<string, unknown>[]) =>
  updates.filter((u) =>
    ["agent_message", "agent_message_chunk"].includes(String(u.sessionUpdate)),
  );
const textOf = (update: Record<string, any>) =>
  Array.isArray(update.content)
    ? update.content.map((c: { text: string }) => c.text).join("")
    : update.content?.text;

/** ACP v1 delivers deltas; ACP v2 revises stable message IDs. */
function reconstructedMessages(updates: Record<string, any>[]) {
  const messages = new Map<string, string>();
  for (const u of updatesFor(updates)) {
    const id = String(
      u.messageId ?? u._meta?.["chat-on-steroids/messageId"] ?? "anonymous",
    );
    const text = textOf(u);
    if (u.sessionUpdate === "agent_message_chunk")
      messages.set(id, (messages.get(id) ?? "") + text);
    else messages.set(id, text);
  }
  return [...messages.values()];
}
test("real progress messages stream visibly, while an earlier-position completed answer is the last T3 bubble", () => {
  for (const version of [1, 2] as const) {
    const projection = new FinalAnswerProjection();
    const translator = new Translator(version);
    const events = [
      event(1, "initial", "I will check the rules.", false, 4),
      event(2, "main", fullAnswer.slice(0, 45), false, 8),
      event(3, "main", fullAnswer.slice(0, 110), false, 8),
      event(
        4,
        "progress",
        "I found an exception and am checking it.",
        false,
        29,
      ),
      event(5, "main", fullAnswer, false, 8),
      event(6, "main", fullAnswer, true, 8),
    ];
    const streamed: Record<string, any>[] = [];
    for (const record of events) {
      streamed.push(...projection.message(record, translator));
      // Progress updates cannot be relegated to hidden reasoning.
      if (record.seq === 1 || record.seq === 4)
        assert(
          updatesFor(streamed).some((u) =>
            textOf(u).includes(record.message!.text),
          ),
        );
    }
    streamed.push(...projection.end(end(7, "turn-1", "completed"), translator));
    const answers = updatesFor(streamed);
    assert(answers.length >= 4);
    assert.equal(reconstructedMessages(streamed).at(-1), fullAnswer);
    if (version === 1)
      assert.match(
        String(answers.at(-1)?._meta?.["chat-on-steroids/messageId"]),
        /confirmed-final/,
      );
    else assert.match(String(answers.at(-1)?.messageId), /confirmed-final/);
    assert.equal(
      streamed.filter((u) => u.sessionUpdate === "agent_thought_chunk").length,
      0,
    );
  }
});

test("no-final stock turns finish on the most complete draft rather than the latest short status", () => {
  for (const version of [1, 2] as const) {
    const projector = new FinalAnswerProjection();
    const translator = new Translator(version);
    projector.message(event(1, "main", fullAnswer, false, 8), translator);
    projector.message(
      event(2, "later-progress", "Checking one last thing.", false, 29),
      translator,
    );
    const updates = projector.end(end(3, "turn-1", "completed"), translator);
    const final = updatesFor(updates).at(-1)!;
    assert.equal(textOf(final), fullAnswer);
    assert.deepEqual(projector.finish(translator, "turn-1"), []);
  }
});

test("late revisions from an interrupted turn never become a false final after a later successful continuation", () => {
  for (const version of [1, 2] as const) {
    const projector = new FinalAnswerProjection();
    const translator = new Translator(version);
    const emitted: Record<string, any>[] = [];
    const ingest = (e: Event) =>
      emitted.push(
        ...(e.kind === "turn_end"
          ? projector.end(e, translator)
          : projector.message(e, translator)),
      );
    ingest(event(1, "begin", "Creating the project.", false, 4, "early-turn"));
    ingest(event(2, "old", "The editor is opening.", false, 105, "early-turn"));
    ingest(end(3, "early-turn", "interrupted"));
    // Native CoS can revise a message from early-turn *after* the interrupt.
    ingest(
      event(
        4,
        "old",
        "The editor is opening, still checking.",
        false,
        105,
        "early-turn",
      ),
    );
    ingest(
      event(
        5,
        "next",
        "Checking geometry and materials.",
        false,
        205,
        "next-turn",
      ),
    );
    ingest(end(6, "next-turn", "interrupted"));
    ingest(
      event(
        7,
        "next",
        "A late revision from the second interrupted turn.",
        false,
        205,
        "next-turn",
      ),
    );
    ingest(event(8, "status", "Final testing now.", false, 234, "last-turn"));
    ingest(
      event(9, "result", fullAnswer.slice(0, 83), false, 298, "last-turn"),
    );
    ingest(event(10, "result", fullAnswer, true, 298, "last-turn"));
    ingest(end(11, "last-turn", "completed"));
    emitted.push(...projector.finish(translator, "last-turn"));
    const answers = updatesFor(emitted);
    assert.equal(reconstructedMessages(emitted).at(-1), fullAnswer);
    assert(!answers.some((u) => textOf(u).includes("A late revision from")));
    assert(!answers.some((u) => textOf(u).includes("still checking")));
    assert.equal(reconstructedMessages(emitted).at(-1), fullAnswer);
    assert.deepEqual(projector.finish(translator, "early-turn"), []);
  }
});

test("real T3 ACP monitor emits status while running and never follows a final with a delayed old-turn draft", async () => {
  const session: Session = {
    id: "synthetic-session",
    cosId: "synthetic-session",
    cwd: process.cwd(),
    model: null,
    effort: null,
    mode: "cos",
    seq: 0,
    title: "T3 case",
    updatedAt: Date.now(),
    activeInput: null,
    conversationId: "conversation",
    compatibility: "existing-install",
  };
  const operation: Operation = {
    id: "prompt-1",
    sessionId: session.id,
    fingerprint: "fingerprint",
    phase: "complete",
    turnId: "last-turn",
    delivery: "sent",
    error: null,
    baseline: 0,
    continuationTurnIds: ["early-turn", "last-turn"],
  };
  const nativeEvents: Event[] = [
    event(1, "progress", "Work underway.", false, 4, "early-turn"),
    end(2, "early-turn", "interrupted"),
    event(3, "old", "Delayed earlier status.", false, 105, "early-turn"),
    event(4, "last-progress", "Almost done.", false, 235, "last-turn"),
    event(5, "complete", fullAnswer.slice(0, 70), false, 298, "last-turn"),
    event(6, "complete", fullAnswer, true, 298, "last-turn"),
    end(7, "last-turn", "completed"),
  ];
  const adapter = new Adapter({
    async call<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      if (method === "start") return operation as T;
      if (method === "state")
        return {
          session,
          operation,
          events: Number(args?.after ?? 0) ? [] : nativeEvents,
        } as T;
      if (method === "workers") return { workers: [] } as T;
      if (method === "health")
        return { routes: [], actions: { enabled: true, routes: [] } } as T;
      if (method === "models") return { state: "unavailable", models: [] } as T;
      throw Error("Unexpected " + method);
    },
  });
  await adapter.initialize({ clientInfo: { name: "t3-code" } });
  adapter.sessions.set(session.id, session);
  const updates: Array<Record<string, any>> = [];
  await adapter.prompt(
    session.id,
    [{ type: "text", text: "Build an asset" }],
    null,
    {
      async notify(method, params: any) {
        if (method === "session/update") updates.push(params.update);
      },
      async request<T>() {
        throw Error("Unneeded request");
      },
    },
    new AbortController().signal,
  );
  const answers = updatesFor(updates);
  assert(answers.some((u) => textOf(u) === "Work underway."));
  assert(answers.some((u) => textOf(u) === "Almost done."));
  assert(!answers.some((u) => textOf(u) === "Delayed earlier status."));
  assert.equal(reconstructedMessages(updates).at(-1), fullAnswer);
});

test("resuming an active T3 chat replays progress but never promotes late revisions of an interrupted turn", async () => {
  const session: Session = {
    id: "resumable-t3",
    cosId: "resumable-t3",
    cwd: process.cwd(),
    model: null,
    effort: null,
    mode: "cos",
    seq: 6,
    title: "Resumable T3",
    updatedAt: Date.now(),
    activeInput: "prompt-1",
    conversationId: "conversation",
    compatibility: "existing-install",
  };
  const operation: Operation = {
    id: "prompt-1",
    sessionId: session.id,
    fingerprint: "fingerprint",
    phase: "admitted",
    turnId: "last-turn",
    delivery: "sent",
    error: null,
    baseline: 0,
    continuationTurnIds: ["old-turn", "last-turn"],
  };
  const history = [
    event(1, "old", "Starting the work.", false, 4, "old-turn"),
    end(2, "old-turn", "interrupted"),
    event(3, "old", "Stale old-turn update.", false, 4, "old-turn"),
    event(4, "new", "Running the final checks.", false, 21, "last-turn"),
  ];
  const gateway = {
    async call<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      if (method === "load") return session as T;
      if (method === "state")
        return {
          session,
          operation,
          events: Number(args?.after ?? 0) ? [] : history,
        } as T;
      if (method === "health")
        return { routes: [], actions: { enabled: true, routes: [] } } as T;
      if (method === "workers") return { workers: [] } as T;
      if (method === "models") return { state: "unavailable", models: [] } as T;
      throw Error("Unexpected " + method);
    },
  };
  const adapter = new Adapter(gateway);
  await adapter.initialize({ clientInfo: { name: "t3-code" } });
  const updates: Array<Record<string, any>> = [];
  await adapter.load(session.id, session.cwd, {
    async notify(method, params: any) {
      if (method === "session/update") updates.push(params.update);
    },
    async request<T>() {
      throw Error("Unneeded request");
    },
  });
  const messages = reconstructedMessages(updates);
  assert(messages.includes("Starting the work."));
  assert(messages.includes("Running the final checks."));
  assert(!messages.some((text) => text.includes("Stale old-turn update")));
});
