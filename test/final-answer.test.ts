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
): Event => ({
  seq,
  position,
  kind: "assistant_message",
  turnId: "turn-1",
  messageId: id,
  message: { text },
  final,
});

const fullAnswer =
  "Apple screenshots can remain locked after approval. " +
  "Here is the complete option comparison and recommended release plan. " +
  "Publishing first and using an approved optimization treatment can avoid another app build.";

test("out-of-order CoS draft message cannot replace the actual final answer", () => {
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
    const updates = [
      ...events.flatMap((record) => projection.message(record, translator)),
      ...projection.end(
        {
          seq: 7,
          position: 30,
          kind: "turn_end",
          turnId: "turn-1",
          outcome: "completed",
        },
        translator,
      ),
    ];
    const answers = updates.filter((u) =>
      ["agent_message", "agent_message_chunk"].includes(
        String(u.sessionUpdate),
      ),
    );
    const answerText = answers
      .flatMap((u) =>
        Array.isArray(u.content)
          ? u.content.map((block: { text: string }) => block.text)
          : [(u.content as { text: string }).text],
      )
      .join("");
    assert.equal(answers.length, 1);
    assert.equal(answerText, fullAnswer);
    assert(!answerText.includes("I found an exception"));
    assert(
      updates.filter((u) => u.sessionUpdate === "agent_thought_chunk").length >=
        3,
    );
  }
});

test("no-final stock sessions preserve the most complete draft at turn end", () => {
  for (const version of [1, 2] as const) {
    const projector = new FinalAnswerProjection();
    const translator = new Translator(version);
    projector.message(event(1, "main", fullAnswer, false, 8), translator);
    projector.message(
      event(2, "later-progress", "Checking one last thing.", false, 29),
      translator,
    );
    const updates = projector.end(
      {
        seq: 3,
        position: 30,
        kind: "turn_end",
        turnId: "turn-1",
        outcome: "completed",
      },
      translator,
    );
    const answer = updates[0]!;
    assert(
      ["agent_message", "agent_message_chunk"].includes(
        String(answer.sessionUpdate),
      ),
    );
    assert.equal(
      version === 2
        ? (answer.content as Array<{ text: string }>)[0]!.text
        : (answer.content as { text: string }).text,
      fullAnswer,
    );
    assert.deepEqual(projector.finish(translator), []);
  }
});

test("interrupted automatic continuation does not prematurely promote drafts", () => {
  const projector = new FinalAnswerProjection();
  const translator = new Translator(1);
  projector.message(
    event(1, "old", "Part of a response", false, 2),
    translator,
  );
  assert.deepEqual(
    projector.end(
      {
        seq: 2,
        position: 3,
        kind: "turn_end",
        turnId: "turn-1",
        outcome: "interrupted",
      },
      translator,
    ),
    [],
  );
  assert.deepEqual(projector.finish(translator), []);
});

test("actual T3 ACP monitor projects the finalized old-position answer last", async () => {
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
    turnId: "turn-1",
    delivery: "sent",
    error: null,
    baseline: 0,
  };
  const nativeEvents: Event[] = [
    event(1, "initial", "I will check.", false, 4),
    event(2, "main", fullAnswer.slice(0, 80), false, 8),
    event(3, "late", "I am checking an exception.", false, 29),
    event(4, "main", fullAnswer, true, 8),
    {
      seq: 5,
      position: 30,
      kind: "turn_end",
      turnId: "turn-1",
      outcome: "completed",
    },
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
    [{ type: "text", text: "Question about release screenshots" }],
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
  const answers = updates.filter(
    (u) => u.sessionUpdate === "agent_message_chunk",
  );
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.content?.text, fullAnswer);
  assert(!answers[0]?.content?.text?.includes("I am checking an exception."));
});
