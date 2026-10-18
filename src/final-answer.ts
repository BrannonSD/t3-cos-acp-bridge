import type { Event } from "./contracts.js";
import { Translator } from "./translate.js";

/**
 * Project actual CoS message updates into ordinary, visible ACP chat output.
 * CoS uses final:false for both drafts of a future final answer and real
 * progress messages. We cannot hide all such updates without also hiding
 * every progress report during long runs.
 *
 * CoS may revise an INTERRUPTED turn long after its turn_end, including after
 * another continuation has produced its true final answer. Those late events
 * must never be promoted to a new final response.
 */
export class FinalAnswerProjection {
  private readonly pending = new Map<string, Map<string, Event>>();
  private readonly finalized = new Set<string>();
  private readonly interrupted = new Set<string>();
  private latestAppeared: string | undefined;

  message(
    event: Event,
    translator: Translator,
  ): Array<Record<string, unknown>> {
    if (event.kind !== "assistant_message" || typeof event.final !== "boolean")
      return translator.event(event);
    const turn = event.turnId ?? "";
    if (this.interrupted.has(turn)) return [];
    const key = event.messageId ?? "assistant:" + turn + ":" + event.position;
    if (event.final) {
      if (!this.finalized.has(turn)) {
        this.finalized.add(turn);
        this.pending.delete(turn);
      }
      return this.promote(event, translator, key);
    }
    if (this.finalized.has(turn)) return [];

    let messages = this.pending.get(turn);
    if (!messages) {
      messages = new Map();
      this.pending.set(turn, messages);
    }
    messages.set(key, event);
    if (!this.creationOrder.has(key)) {
      this.creationOrder.add(key);
      this.latestAppeared = key;
    }
    // Ordinary assistant chunks preserve the authored chat messages. Stock T3
    // may collapse earlier bubbles into its work details until completion.
    // A clearly labelled progress activity also surfaces the actual text
    // during the run; it does not pretend a CoS tool was executed.
    const output = translator.event(event);
    const detail = event.message?.text ?? "";
    if (output.length && detail.trim().length >= 12) {
      const first = !this.progressCards.has(key);
      this.progressCards.add(key);
      output.push({
        sessionUpdate:
          translator.version === 2 || !first ? "tool_call_update" : "tool_call",
        toolCallId: "cos-progress:" + key,
        title: "CoS progress: " + detail.replace(/\s+/g, " ").slice(0, 100),
        kind: "think",
        status: "completed",
        rawInput: "",
        rawOutput: detail,
        content: [{ type: "content", content: { type: "text", text: detail } }],
        _meta: { "chat-on-steroids/name": "progress-update" },
      });
    }
    return output;
  }

  private readonly creationOrder = new Set<string>();
  private readonly progressCards = new Set<string>();
  end(event: Event, translator: Translator): Array<Record<string, unknown>> {
    if (event.kind !== "turn_end") return [];
    const turn = event.turnId ?? "";
    if (event.outcome === "interrupted") {
      this.pending.delete(turn);
      this.interrupted.add(turn);
      return [];
    }
    return event.outcome === "completed" ? this.flush(turn, translator) : [];
  }

  /**
   * Only the authenticated operation's current turn can be promoted when
   * completion arrives without a terminal final revision or turn_end.
   */
  finish(
    translator: Translator,
    currentTurnId?: string,
  ): Array<Record<string, unknown>> {
    if (currentTurnId) return this.flush(currentTurnId, translator);
    if (this.pending.size === 1)
      return this.flush([...this.pending.keys()][0]!, translator);
    return [];
  }

  private promote(event: Event, translator: Translator, key: string) {
    // T3 orders v1 chat bubbles by their first appearance. Merely updating
    // an older message ID, or sending a duplicate snapshot, won't move that
    // completed answer after a later progress bubble. If another message was
    // created since, append a separate *confirmed* final response at the end.
    const mustAppend =
      this.creationOrder.has(key) && this.latestAppeared !== key;
    const visibleEvent = mustAppend
      ? { ...event, messageId: key + ":confirmed-final" }
      : event;
    if (!this.creationOrder.has(key)) {
      this.creationOrder.add(key);
      this.latestAppeared = key;
    }
    if (mustAppend) this.latestAppeared = key + ":confirmed-final";
    return translator.event(visibleEvent);
  }

  private flush(turn: string, translator: Translator) {
    const drafts = this.pending.get(turn);
    this.pending.delete(turn);
    if (this.finalized.has(turn) || this.interrupted.has(turn) || !drafts?.size)
      return [];
    const best = [...drafts.values()].sort(
      (a, b) => b.position - a.position || b.seq - a.seq,
    )[0];
    if (!best) return [];
    const key = best.messageId ?? "assistant:" + turn + ":" + best.position;
    this.finalized.add(turn);
    return this.promote({ ...best, final: true }, translator, key);
  }
}
