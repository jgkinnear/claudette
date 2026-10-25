import type { Snapshot } from "@claudette/protocol";

export interface StatusLinePost {
  sessionId: string;
  contextPercent: number | null;
  fiveHour: { usedPercent: number; resetsAt: number | null } | null;
  sevenDay: { usedPercent: number; resetsAt: number | null } | null;
  hasRateLimits: boolean;
}

function pct(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;
}

function window(v: unknown): { usedPercent: number; resetsAt: number | null } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const used = pct(o.used_percentage);
  if (used === null) return null;
  const r = o.resets_at;
  const resetsAt = typeof r === "number" && Number.isFinite(r) ? (r < 1e12 ? r * 1000 : r) : null;
  return { usedPercent: used, resetsAt };
}

/** Pick only the whitelisted fields out of a status-line JSON payload. */
export function pickStatusLine(body: unknown): StatusLinePost | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.session_id !== "string" || o.session_id.length === 0 || o.session_id.length > 128) return null;
  const cw = o.context_window as Record<string, unknown> | undefined;
  const rl = o.rate_limits as Record<string, unknown> | undefined;
  return {
    sessionId: o.session_id,
    contextPercent: cw && typeof cw === "object" ? pct(cw.used_percentage) : null,
    fiveHour: rl && typeof rl === "object" ? window(rl.five_hour) : null,
    sevenDay: rl && typeof rl === "object" ? window(rl.seven_day) : null,
    hasRateLimits: Boolean(rl && typeof rl === "object"),
  };
}

/** Context % per session and the account's rate-limit windows, from the opt-in status line. */
export class LimitsStore {
  private context = new Map<string, { percent: number | null; at: number }>();
  private rate: {
    fiveHour: { usedPercent: number; resetsAt: number | null } | null;
    sevenDay: { usedPercent: number; resetsAt: number | null } | null;
    at: number;
  } | null = null;
  lastPostAt: number | null = null;

  constructor(private now: () => number = Date.now) {}

  record(p: StatusLinePost): void {
    const at = this.now();
    this.lastPostAt = at;
    this.context.set(p.sessionId, { percent: p.contextPercent, at });
    if (this.context.size > 500) {
      const oldest = [...this.context.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.context.delete(oldest[0]);
    }
    if (p.hasRateLimits && (p.fiveHour || p.sevenDay)) {
      this.rate = { fiveHour: p.fiveHour, sevenDay: p.sevenDay, at };
    }
  }

  contextFor(sessionId: string | null): number | null {
    if (!sessionId) return null;
    return this.context.get(sessionId)?.percent ?? null;
  }

  forget(sessionId: string): void {
    this.context.delete(sessionId);
  }

  rateLimits(): Snapshot["rateLimits"] {
    if (!this.rate) return null;
    const now = this.now();
    const live = (w: { usedPercent: number; resetsAt: number | null } | null) =>
      w && (w.resetsAt === null || w.resetsAt > now)
        ? { usedPercent: w.usedPercent, resetsAt: w.resetsAt === null ? null : new Date(w.resetsAt).toISOString() }
        : null;
    const fiveHour = live(this.rate.fiveHour);
    const sevenDay = live(this.rate.sevenDay);
    if (!fiveHour && !sevenDay) return null;
    return { fiveHour, sevenDay, observedAt: new Date(this.rate.at).toISOString() };
  }
}
