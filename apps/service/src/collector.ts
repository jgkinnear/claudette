import type { Session, Snapshot } from "@claudette/protocol";
import { SCHEMA_VERSION } from "@claudette/protocol";
import { AgentsCliError, normalise, runAgentsCli, type Normalised, type RawAgent } from "./agents.js";
import type { Logger } from "./log.js";
import { silentLogger } from "./log.js";
import { LimitsStore } from "./limits.js";
import { SubagentLedger, type HookEvent } from "./subagents.js";
import { TokenLedger, localDateString } from "./tokens.js";
import { truncateChars } from "./agents.js";
import type { RememberedSession } from "./store.js";
import { QuestionBook, type Question } from "./questions.js";

export interface DataSource {
  readonly mode: "real" | "mock";
  start(): void;
  stop(): void;
  /** Snapshot without preferences applied. */
  snapshot(): Snapshot;
  ready(): boolean;
  /** Ids (opaque) currently known. */
  knownIds(): Set<string>;
  onHook(e: HookEvent): void;
  /** A session started waiting on you (from PermissionRequest / AskUserQuestion / Notification hooks). */
  onQuestion(sessionId: string, q: Question): void;
  limits: LimitsStore;
  diagnostics(): Record<string, unknown>;
}

interface Tracked {
  norm: Normalised;
  firstSeenAt: number;
  stateSince: number | null;
  idleSince: number | null;
  lastPollSeen: number;
}

export interface CollectorOptions {
  claudePath: string | null;
  projectsDir: string;
  host: { id: string; displayName: string };
  salt: string;
  intervalMs?: number;
  hooksInstalled?: () => boolean;
  isPinned?: (id: string) => boolean;
  /**
   * Pinned sessions are remembered so they stay listed (as stopped) once Claude stops their
   * process, including across service restarts.
   */
  pins?: {
    ids(): string[];
    /** Ids we currently remember details for. */
    remembered(): string[];
    get(id: string): RememberedSession | undefined;
    remember(id: string, session: RememberedSession): void;
    forget(id: string): void;
  };
  /** Hide finished/failed/stopped sessions inactive for longer than this (default 24 h). */
  retentionMs?: number;
  log?: Logger;
  now?: () => number;
  /** For tests: replace the CLI call. */
  fetchAgents?: () => Promise<RawAgent[]>;
  subagents?: SubagentLedger;
  tokens?: TokenLedger;
}

const TERMINAL = new Set(["ready", "stopped", "failed"]);

/** Real data: polls `claude agents`, joins hooks, transcripts and status-line data. */
export class Collector implements DataSource {
  readonly mode = "real" as const;
  readonly subagents: SubagentLedger;
  readonly tokens: TokenLedger;
  readonly limits: LimitsStore;
  private tracked = new Map<string, Tracked>();
  private questions = new QuestionBook();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private polls = 0;
  private lastOkAt: number | null = null;
  private lastError: { message: string; kind: string; at: number } | null = null;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly intervalMs: number;
  private readonly startedAt: number;
  private hookSeen = false;

  constructor(private opts: CollectorOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? silentLogger;
    this.intervalMs = opts.intervalMs ?? 5000;
    this.subagents = opts.subagents ?? new SubagentLedger({ now: this.now });
    this.tokens = opts.tokens ?? new TokenLedger({ projectsDir: opts.projectsDir, now: this.now });
    this.limits = new LimitsStore(this.now);
    this.startedAt = this.now();
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  ready(): boolean {
    return this.polls > 0;
  }

  hooksInstalled(): boolean {
    return (this.opts.hooksInstalled?.() ?? false) || this.hookSeen;
  }

  onHook(e: HookEvent): void {
    this.hookSeen = true;
    this.subagents.record(e);
    if (e.event === "Stop" || e.event === "SessionEnd") this.questions.clear(e.sessionId);
  }

  onQuestion(sessionId: string, q: Question): void {
    this.hookSeen = true;
    this.questions.record(sessionId, q);
  }

  private fetch(): Promise<RawAgent[]> {
    if (this.opts.fetchAgents) return this.opts.fetchAgents();
    if (!this.opts.claudePath) {
      return Promise.reject(new AgentsCliError("Claude CLI not found. Run `npx get-claudette`.", "missing"));
    }
    return runAgentsCli(this.opts.claudePath);
  }

  /** One poll cycle. Never throws. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let rows: RawAgent[];
      try {
        rows = await this.fetch();
      } catch (err) {
        const e = err instanceof AgentsCliError ? err : new AgentsCliError("Couldn't read Claude sessions", "failed");
        if (!this.lastError || this.lastError.message !== e.message) this.log.warn(`collector: ${e.message}`);
        this.lastError = { message: e.message, kind: e.kind, at: this.now() };
        return;
      }
      if (this.lastError) this.log.info("collector: Claude sessions readable again");
      this.lastError = null;
      this.ingest(rows);
      this.lastOkAt = this.now();
      try {
        const ids = [...this.tracked.values()].map((t) => t.norm.claudeSessionId).filter((x): x is string => !!x);
        await this.tokens.update(ids);
      } catch (err) {
        this.log.warn(`collector: token usage read failed (${(err as Error).message})`);
      }
      this.subagents.sweep();
    } finally {
      this.polls++;
      this.polling = false;
    }
  }

  /** Normalise one CLI result into tracked sessions (exposed for tests). */
  ingest(rows: RawAgent[]): void {
    const now = this.now();
    const initial = this.polls === 0 && this.tracked.size === 0;
    const seen = new Set<string>();
    for (const row of rows) {
      const norm = normalise(row, this.opts.salt);
      if (!norm || seen.has(norm.id)) continue;
      seen.add(norm.id);
      const prev = this.tracked.get(norm.id);
      if (!prev) {
        this.tracked.set(norm.id, {
          norm,
          firstSeenAt: now,
          stateSince: initial ? null : now,
          idleSince: norm.state === "ready" ? now : null,
          lastPollSeen: now,
        });
      } else {
        if (prev.norm.state !== norm.state) {
          prev.stateSince = now;
          prev.idleSince = norm.state === "ready" ? now : null;
        }
        prev.norm = norm;
        prev.lastPollSeen = now;
      }
      const t = this.tracked.get(norm.id)!;
      if (norm.claudeSessionId) {
        if (norm.state === "stopped" || norm.state === "failed") this.subagents.clearSession(norm.claudeSessionId);
        else this.subagents.reconcile(norm.claudeSessionId, norm.state, t.idleSince);
      }
    }
    for (const [id, t] of this.tracked) {
      if (!seen.has(id)) {
        // Session vanished from `claude agents`: nothing of it can still be running.
        if (t.norm.claudeSessionId) {
          this.subagents.clearSession(t.norm.claudeSessionId);
          this.limits.forget(t.norm.claudeSessionId);
        }
        if (this.opts.pins && this.opts.isPinned?.(id)) {
          // Pinned: keep it on the list, honestly marked as not running.
          if (t.norm.state !== "stopped") t.stateSince = now;
          t.norm = { ...t.norm, state: "stopped", needsAttentionReason: null, alive: false };
          continue;
        }
        this.tracked.delete(id);
      }
    }
    this.syncPins(seen, now);
  }

  /** Remember live pinned sessions; bring back pinned ones we only know from disk. */
  private syncPins(seen: Set<string>, now: number): void {
    const pins = this.opts.pins;
    if (!pins) return;
    const pinned = new Set(pins.ids());
    for (const id of pinned) {
      const t = this.tracked.get(id);
      if (t && seen.has(id)) {
        const meta: RememberedSession = {
          name: t.norm.name,
          kind: t.norm.kind,
          claudeSessionId: t.norm.claudeSessionId,
          startedAtMs: t.norm.startedAtMs,
        };
        const old = pins.get(id);
        if (!old || JSON.stringify(old) !== JSON.stringify(meta)) pins.remember(id, meta);
      } else if (!t) {
        const meta = pins.get(id);
        if (!meta) continue; // pinned before we remembered sessions; nothing to show
        this.tracked.set(id, {
          norm: {
            sourceId: `pinned:${id}`,
            claudeSessionId: meta.claudeSessionId,
            id,
            kind: meta.kind,
            name: meta.name,
            state: "stopped",
            needsAttentionReason: null,
            startedAtMs: meta.startedAtMs,
            alive: false,
          },
          firstSeenAt: now,
          stateSince: null,
          idleSince: null,
          lastPollSeen: now,
        });
      }
    }
    // Once unpinned, a session is no longer remembered (and drops off when it isn't running).
    for (const id of pins.remembered()) if (!pinned.has(id)) pins.forget(id);
  }

  knownIds(): Set<string> {
    return new Set(this.tracked.keys());
  }

  private buildSession(t: Tracked, hooks: boolean): Session {
    const n = t.norm;
    const sid = n.claudeSessionId;
    const tok = sid ? this.tokens.session(sid) : null;
    const ctx = this.limits.contextFor(sid);
    const candidates = [tok?.lastActivityMs ?? null, t.stateSince, n.startedAtMs].filter(
      (x): x is number => typeof x === "number" && x > 0,
    );
    const lastActivity = candidates.length ? Math.max(...candidates) : null;
    let stateSince = t.stateSince;
    if (stateSince === null && TERMINAL.has(n.state)) stateSince = tok?.lastActivityMs ?? null;
    return {
      id: n.id,
      displayName: n.name,
      kind: n.kind,
      pinned: false,
      pinOrder: null,
      state: n.state,
      needsAttentionReason: n.needsAttentionReason,
      stateSince: stateSince ? new Date(stateSince).toISOString() : null,
      subagents: this.subagents.view(sid, { hooksInstalled: hooks, sessionStartedAt: n.startedAtMs }),
      tokens: tok
        ? { sessionTotal: tok.sessionTotal, cacheRead: tok.cacheRead, quality: "observed", source: "transcript-usage" }
        : { sessionTotal: null, cacheRead: null, quality: "unavailable", source: "none" },
      context: {
        usedPercent: ctx,
        tokens: tok?.contextTokens ?? null,
        quality: ctx === null && (tok?.contextTokens ?? null) === null ? "unavailable" : "observed",
      },
      lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null,
      question: this.questionFor(sid, n.state),
    };
  }

  /**
   * Show a question while the session needs you. A fresh one (under 10 s) also shows before the next
   * `claude agents` poll catches up; once the session has moved on, it's dropped.
   */
  private questionFor(sid: string | null, state: Session["state"]): Session["question"] {
    const q = this.questions.get(sid);
    if (!q || !sid) return null;
    const fresh = this.now() - q.askedAt < 10_000;
    if (state !== "needs_attention" && !fresh) {
      this.questions.clear(sid);
      return null;
    }
    return { kind: q.kind, title: q.title, detail: q.detail, options: q.options, askedAt: new Date(q.askedAt).toISOString() };
  }

  snapshot(): Snapshot {
    const now = this.now();
    const hooks = this.hooksInstalled();
    const retention = this.opts.retentionMs ?? 24 * 3600_000;
    const sessions: Session[] = [];
    for (const t of this.tracked.values()) {
      const s = this.buildSession(t, hooks);
      const terminal = s.state === "stopped" || s.state === "failed" || (s.state === "ready" && t.norm.kind === "background") || (s.state === "ready" && !t.norm.alive);
      const last = s.lastActivityAt ? Date.parse(s.lastActivityAt) : 0;
      if (terminal && now - last > retention && !this.opts.isPinned?.(s.id)) continue;
      sessions.push(s);
    }
    let status: Snapshot["collection"]["status"] = "healthy";
    let message: string | null = null;
    if (this.lastError) {
      status = "error";
      message = this.lastError.message;
    } else if (this.polls === 0) {
      status = "degraded";
      message = "Starting up…";
    } else if (this.lastOkAt !== null && now - this.lastOkAt > this.intervalMs * 4) {
      status = "degraded";
      message = "Session data is a little old";
    }
    const daily = this.tokens.daily();
    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date(now).toISOString(),
      host: { id: this.opts.host.id, displayName: this.opts.host.displayName, online: true },
      collection: {
        status,
        message: message === null ? null : truncateChars(message, 80),
        lastSessionPollAt: this.lastOkAt ? new Date(this.lastOkAt).toISOString() : null,
        hooksInstalled: hooks,
      },
      sessions,
      dailyUsage: {
        tokens: daily.tokens,
        date: daily.date || localDateString(now),
        quality: daily.tokens === null ? "unavailable" : "observed",
      },
      rateLimits: this.limits.rateLimits(),
    };
  }

  diagnostics(): Record<string, unknown> {
    return {
      mode: this.mode,
      claudePath: this.opts.claudePath,
      polls: this.polls,
      lastOkAt: this.lastOkAt ? new Date(this.lastOkAt).toISOString() : null,
      lastError: this.lastError ? { message: this.lastError.message, kind: this.lastError.kind } : null,
      sessions: this.tracked.size,
      subagents: this.subagents.stats(),
      lastHookAt: this.subagents.lastEventAt ? new Date(this.subagents.lastEventAt).toISOString() : null,
      lastStatusLineAt: this.limits.lastPostAt ? new Date(this.limits.lastPostAt).toISOString() : null,
      transcripts: this.tokens.stats(),
      startedAt: new Date(this.startedAt).toISOString(),
    };
  }
}
