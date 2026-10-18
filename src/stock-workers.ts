/**
 * Read stock CoS session history to recover workers no longer present
 * in the live worker listing, using CoS's own parent origin relationship.
 */
export interface StockWorker {
  id: string;
  sessionId: string;
  label: string;
  state: "active" | "waiting" | "completed" | "failed" | "cancelled";
}

export async function recordedStockWorkers(
  request: (route: string) => Promise<{
    sessions: Array<{
      id?: string;
      title?: string;
      origin?: { kind?: string; fromSessionId?: string | null; task?: string };
      activeTurnId?: string | null;
      endedAt?: string | number | null;
      lastTurnOutcome?: string | null;
    }>;
    nextCursor?: string | null;
  }>,
  parentId: string,
): Promise<StockWorker[]> {
  const found = new Map<string, StockWorker>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 4; page++) {
    const route =
      "/v1/sessions?limit=50" +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const data = await request(route);
    if (!Array.isArray(data.sessions)) break;
    for (const child of data.sessions) {
      if (
        !child ||
        typeof child.id !== "string" ||
        !child.id ||
        child.id.length > 128 ||
        child.origin?.kind !== "worker" ||
        child.origin.fromSessionId !== parentId
      )
        continue;
      const name =
        typeof child.origin.task === "string" ? child.origin.task : "";
      const label =
        name.trim().replace(/\s+/g, " ").slice(0, 100) ||
        child.title?.trim().slice(0, 100) ||
        "Worker " + child.id.slice(-8);
      const outcome = child.lastTurnOutcome;
      const state: StockWorker["state"] =
        outcome === "failed" || outcome === "error"
          ? "failed"
          : outcome === "cancelled"
            ? "cancelled"
            : child.endedAt
              ? "completed"
              : child.activeTurnId
                ? "active"
                : "waiting";
      found.set(child.id, { id: child.id, sessionId: child.id, label, state });
    }
    if (
      !data.nextCursor ||
      typeof data.nextCursor !== "string" ||
      seen.has(data.nextCursor) ||
      data.nextCursor.length > 512
    )
      break;
    seen.add(data.nextCursor);
    cursor = data.nextCursor;
  }
  return [...found.values()];
}
