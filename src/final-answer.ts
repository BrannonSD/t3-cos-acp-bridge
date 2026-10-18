import type { Event } from "./contracts.js";
import { Translator, visible } from "./translate.js";

/**
 * CoS snapshots can interleave: a later-position message can be provisional
 * while an earlier-position assistant message is still growing and ultimately
 * receives final:true. Stock T3 ACP does not understand CoS's final flag.
 * Drafts belong in thought activity, not the authoritative final reply.
 *
 * One instance per monitored ACP prompt; no durable state or network I/O.
 */
export class FinalAnswerProjection {
  private readonly pending = new Map<string, Map<string, Event>>();
  private readonly finalized = new Set<string>();

  message(
    event: Event,
    translator: Translator,
  ): Array<Record<string, unknown>> {
    if (event.kind !== "assistant_message" || typeof event.final !== "boolean")
      return translator.event(event);
    const turn = event.turnId ?? "";
    const key = event.messageId ?? "assistant:" + turn + ":" + event.position;
    if (event.final) {
      this.finalized.add(turn);
      this.pending.delete(turn);
      return translator.event(event);
    }
    if (!this.finalized.has(turn)) {
      let messages = this.pending.get(turn);
      if (!messages) {
        messages = new Map();
        this.pending.set(turn, messages);
      }
      messages.set(key, event);
    }
    return translator.draft(event);
  }

  end(event: Event, translator: Translator): Array<Record<string, unknown>> {
    if (event.kind !== "turn_end") return [];
    const turn = event.turnId ?? "";
    // A rotation may end "interrupted" before a real continuation.
    if (event.outcome === "interrupted") {
      this.pending.delete(turn);
      return [];
    }
    return this.flush(turn, translator);
  }

  /** A completed turn can lack a retained final revision or turn_end. */
  finish(translator: Translator): Array<Record<string, unknown>> {
    const updates: Array<Record<string, unknown>> = [];
    for (const turn of this.pending.keys())
      updates.push(...this.flush(turn, translator));
    return updates;
  }

  private flush(turn: string, translator: Translator) {
    const drafts = this.pending.get(turn);
    this.pending.delete(turn);
    if (this.finalized.has(turn) || !drafts?.size) return [];
    // With no native final marker, prefer the most complete candidate
    // instead of promoting a later short progress update.
    const best = [...drafts.values()].sort(
      (a, b) =>
        visible(b.message).length - visible(a.message).length || b.seq - a.seq,
    )[0];
    return best ? translator.event({ ...best, final: true }) : [];
  }
}
