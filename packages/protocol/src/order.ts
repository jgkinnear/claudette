import type { Session } from "./schema.js";

const STATE_RANK: Record<Session["state"], number> = {
  needs_attention: 0,
  working: 1,
  ready: 2,
  failed: 3,
  unknown: 4,
  stopped: 5,
};

function recency(s: Session): number {
  const t = s.lastActivityAt ?? s.stateSince;
  return t ? Date.parse(t) : 0;
}

/**
 * The one session order every client shows:
 *   1. anything that needs you (pinned ones first, then newest),
 *   2. pinned sessions, in pin order,
 *   3. everything else: working, ready, failed, unknown, stopped — newest first.
 */
export function compareSessions(a: Session, b: Session): number {
  const an = a.state === "needs_attention";
  const bn = b.state === "needs_attention";
  if (an !== bn) return an ? -1 : 1;
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned && b.pinned && !an) return (a.pinOrder ?? 0) - (b.pinOrder ?? 0);
  const r = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (r !== 0) return r;
  return recency(b) - recency(a) || a.id.localeCompare(b.id);
}

export function sortSessions<T extends Session>(sessions: T[]): T[] {
  return [...sessions].sort(compareSessions);
}
