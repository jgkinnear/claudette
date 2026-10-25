import type { Subagents } from "@claudette/protocol";
import { sanitizeText, truncateChars } from "./agents.js";

export type HookEventName = "SubagentStart" | "SubagentStop" | "Stop" | "SessionEnd";

export interface HookEvent {
  event: HookEventName;
  /** Raw Claude session id (kept in memory only, never exposed). */
  sessionId: string;
  agentId?: string | null;
  agentType?: string | null;
  at?: number;
}

interface ActiveAgent {
  type: string;
  since: number;
}

interface SessionLedger {
  active: Map<string, ActiveAgent>;
  /** Every agent id ever seen for this session (start or stop). */
  seen: Set<string>;
  /** Agents that have stopped: a replayed start for these is ignored. */
  stopped: Set<string>;
  lastStopAt: number | null;
  lastEventAt: number;
  ended: boolean;
}

export interface SubagentLedgerOptions {
  /** Drop an active subagent with no stop after this long (default 30 min). */
  staleMs?: number;
  /** Clear active subagents once the parent has been idle this long after a Stop hook (default 30 s). */
  idleGraceMs?: number;
  now?: () => number;
}

const MAX_SEEN = 2000;

/**
 * Subagent bookkeeping from SubagentStart/SubagentStop hooks, keyed by
 * (session, agent_id). Idempotent: replayed or duplicate events change nothing.
 * Reconciled against `claude agents` state by the collector.
 */
export class SubagentLedger {
  private sessions = new Map<string, SessionLedger>();
  readonly startedAt: number;
  private staleMs: number;
  private idleGraceMs: number;
  private now: () => number;
  lastEventAt: number | null = null;

  constructor(opts: SubagentLedgerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.staleMs = opts.staleMs ?? 30 * 60_000;
    this.idleGraceMs = opts.idleGraceMs ?? 30_000;
    this.startedAt = this.now();
  }

  private ledger(sessionId: string): SessionLedger {
    let l = this.sessions.get(sessionId);
    if (!l) {
      l = { active: new Map(), seen: new Set(), stopped: new Set(), lastStopAt: null, lastEventAt: 0, ended: false };
      this.sessions.set(sessionId, l);
    }
    return l;
  }

  record(e: HookEvent): void {
    const at = e.at ?? this.now();
    this.lastEventAt = at;
    const l = this.ledger(e.sessionId);
    l.lastEventAt = Math.max(l.lastEventAt, at);
    const agentId = e.agentId ?? null;
    switch (e.event) {
      case "SubagentStart": {
        if (!agentId) return;
        l.ended = false;
        if (l.active.has(agentId) || l.stopped.has(agentId)) return; // duplicate / replay
        if (l.seen.size < MAX_SEEN) l.seen.add(agentId);
        const type = truncateChars(sanitizeText(e.agentType ?? "") || "agent", 32);
        l.active.set(agentId, { type, since: at });
        return;
      }
      case "SubagentStop": {
        if (!agentId) return;
        l.active.delete(agentId);
        if (l.seen.size < MAX_SEEN) l.seen.add(agentId);
        if (l.stopped.size < MAX_SEEN) l.stopped.add(agentId);
        return;
      }
      case "Stop":
        l.lastStopAt = at;
        return;
      case "SessionEnd":
        l.active.clear();
        l.ended = true;
        return;
    }
  }

  /** Parent ended, failed, stopped or vanished: nothing can still be running. */
  clearSession(sessionId: string): void {
    const l = this.sessions.get(sessionId);
    if (l) l.active.clear();
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Reconcile with the authoritative parent state. `idleSince` is when the
   * collector first saw the parent idle (ready), or null if it isn't idle.
   */
  reconcile(sessionId: string, parentState: string, idleSince: number | null): void {
    const l = this.sessions.get(sessionId);
    if (!l) return;
    const now = this.now();
    if (parentState === "stopped" || parentState === "failed") {
      l.active.clear();
      return;
    }
    for (const [id, a] of l.active) {
      if (now - a.since > this.staleMs) l.active.delete(id);
    }
    // Missed SubagentStop (e.g. interrupted with Esc): if the main agent has
    // finished its turn after these started and the session has been idle
    // for a while, they can't still be running in the foreground.
    if (idleSince !== null && l.lastStopAt !== null && now - idleSince >= this.idleGraceMs) {
      for (const [id, a] of l.active) {
        if (a.since <= l.lastStopAt) l.active.delete(id);
      }
    }
  }

  /** Drop all expired entries (call periodically). */
  sweep(): void {
    const now = this.now();
    for (const [sid, l] of this.sessions) {
      for (const [id, a] of l.active) if (now - a.since > this.staleMs) l.active.delete(id);
      if (l.active.size === 0 && now - l.lastEventAt > 24 * 3600_000) this.sessions.delete(sid);
    }
  }

  view(sessionId: string | null, opts: { hooksInstalled: boolean; sessionStartedAt: number | null }): Subagents {
    if (!opts.hooksInstalled) {
      return { active: null, knownTotal: null, types: [], oldestActiveSince: null, partial: false, quality: "unavailable" };
    }
    const l = sessionId ? this.sessions.get(sessionId) : undefined;
    const partial = opts.sessionStartedAt === null || opts.sessionStartedAt < this.startedAt;
    if (!l) {
      return { active: 0, knownTotal: 0, types: [], oldestActiveSince: null, partial, quality: "observed" };
    }
    const now = this.now();
    let oldest: number | null = null;
    const types: string[] = [];
    let active = 0;
    for (const a of l.active.values()) {
      if (now - a.since > this.staleMs) continue;
      active++;
      if (oldest === null || a.since < oldest) oldest = a.since;
      if (!types.includes(a.type) && types.length < 8) types.push(a.type);
    }
    return {
      active,
      knownTotal: Math.max(l.seen.size, active),
      types,
      oldestActiveSince: oldest === null ? null : new Date(oldest).toISOString(),
      partial,
      quality: "observed",
    };
  }

  /** For diagnostics only. */
  stats(): { sessions: number; active: number } {
    let active = 0;
    for (const l of this.sessions.values()) active += l.active.size;
    return { sessions: this.sessions.size, active };
  }
}
