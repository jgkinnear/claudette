import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import type { SessionState } from "@claudette/protocol";

/**
 * One row of `claude agents --json --all`. Lenient: unknown fields are
 * ignored, documented fields are optional except cwd/kind/startedAt, and
 * anything with an unexpected type is dropped rather than failing the poll.
 */
export const RawAgent = z
  .object({
    cwd: z.string().optional().catch(undefined),
    kind: z.string().optional().catch(undefined),
    startedAt: z.union([z.number(), z.string()]).optional().catch(undefined),
    id: z.string().optional().catch(undefined),
    state: z.string().optional().catch(undefined),
    pid: z.number().optional().catch(undefined),
    status: z.string().optional().catch(undefined),
    waitingFor: z.string().optional().catch(undefined),
    sessionId: z.string().optional().catch(undefined),
    name: z.string().optional().catch(undefined),
  })
  .passthrough();
export type RawAgent = z.infer<typeof RawAgent>;

export class AgentsCliError extends Error {
  constructor(
    message: string,
    readonly kind: "missing" | "failed" | "timeout" | "parse",
  ) {
    super(message);
  }
}

export function parseAgentsJson(stdout: string): RawAgent[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    // Tolerate a stray notice printed around the list; never log the output itself (it has paths and names).
    const start = stdout.indexOf("[");
    const end = stdout.lastIndexOf("]");
    try {
      if (start < 0 || end < start) throw new Error("no list");
      data = JSON.parse(stdout.slice(start, end + 1));
    } catch {
      const what = stdout.trim() ? `${stdout.length} bytes` : "nothing";
      throw new AgentsCliError(`claude agents printed something that isn't JSON (${what})`, "parse");
    }
  }
  if (!Array.isArray(data)) throw new AgentsCliError("claude agents didn't return a list", "parse");
  const out: RawAgent[] = [];
  for (const row of data) {
    const r = RawAgent.safeParse(row);
    if (r.success) out.push(r.data);
  }
  return out;
}

/** Run `claude agents --json --all` without a shell. */
export function runAgentsCli(claudePath: string, timeoutMs = 15_000): Promise<RawAgent[]> {
  return new Promise((resolve, reject) => {
    execFile(
      claudePath,
      ["agents", "--json", "--all"],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          if (e.code === "ENOENT" || e.code === "EACCES") {
            return reject(new AgentsCliError("Claude CLI not found. Run `npx get-claudette` again.", "missing"));
          }
          if (e.killed || e.signal === "SIGTERM") {
            return reject(new AgentsCliError("`claude agents` timed out", "timeout"));
          }
          return reject(
            new AgentsCliError("`claude agents --json` failed. Is Claude Code up to date?", "failed"),
          );
        }
        try {
          resolve(parseAgentsJson(stdout));
        } catch (pe) {
          reject(pe);
        }
      },
    );
  });
}

export interface Normalised {
  /** The source identifier we hashed (never exposed). */
  sourceId: string;
  /** Raw Claude session id, used to join hooks/transcripts (never exposed). */
  claudeSessionId: string | null;
  id: string;
  kind: "interactive" | "background" | "unknown";
  name: string;
  state: SessionState;
  needsAttentionReason: string | null;
  startedAtMs: number | null;
  alive: boolean;
}

export function sourceIdOf(a: RawAgent): string | null {
  if (a.kind === "background") return a.id ? `bg:${a.id}` : a.sessionId ? `s:${a.sessionId}` : null;
  if (a.sessionId) return `s:${a.sessionId}`;
  if (a.id) return `bg:${a.id}`;
  if (a.pid !== undefined) return `pid:${a.pid}:${a.startedAt ?? ""}`;
  if (a.cwd && a.startedAt !== undefined) return `cwd:${a.cwd}:${a.startedAt}`;
  return null;
}

/** Short, stable, opaque id. Never reversible to the Claude session id. */
export function opaqueId(sourceId: string, salt: string): string {
  return "s" + createHmac("sha256", salt).update(sourceId).digest("base64url").slice(0, 11);
}

const REASONS: Record<string, string> = {
  "permission prompt": "permission prompt",
  "input needed": "needs your input",
  "sandbox request": "sandbox request",
  "worker request": "worker request",
  "dialog open": "dialog open",
};

/** Map Claude's state/status to Claudette's six states (docs/architecture.md). */
export function mapState(a: RawAgent): { state: SessionState; reason: string | null } {
  const state = a.state?.toLowerCase();
  const status = a.status?.toLowerCase();
  // Documented background states are authoritative; live status may only enrich.
  if (state === "done") return { state: "ready", reason: null };
  if (state === "failed") return { state: "failed", reason: null };
  if (state === "stopped") return { state: "stopped", reason: null };
  if (state === "blocked" || (status === "waiting" && (state === undefined || state === "working"))) {
    const w = a.waitingFor?.toLowerCase();
    const reason = w ? (REASONS[w] ?? truncateChars(sanitizeText(a.waitingFor ?? ""), 40)) : "waiting for you";
    return { state: "needs_attention", reason: reason || "waiting for you" };
  }
  if (state === "working") return { state: "working", reason: null };
  if (state === undefined) {
    if (status === "busy") return { state: "working", reason: null };
    if (status === "idle") return { state: "ready", reason: null };
    if (status === undefined && a.pid === undefined && a.kind === "interactive") {
      return { state: "stopped", reason: null };
    }
  }
  return { state: "unknown", reason: null };
}

export function parseStartedAt(v: number | string | undefined): number | null {
  if (v === undefined) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // tolerate unix seconds
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Strip control/bidi characters; names are untrusted data. */
export function sanitizeText(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate to at most `max` UTF-16 code units without splitting a code point. */
export function truncateChars(s: string, max: number, ellipsis = "…"): string {
  if (s.length <= max) return s;
  const budget = max - ellipsis.length;
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return out + ellipsis;
}

/** Truncate to at most `maxBytes` UTF-8 bytes (ellipsis included), never splitting a code point. */
export function truncateUtf8(s: string, maxBytes: number, ellipsis = "…"): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const budget = maxBytes - Buffer.byteLength(ellipsis, "utf8");
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > budget) break;
    out += ch;
    bytes += b;
  }
  return out + ellipsis;
}

export function normalise(a: RawAgent, salt: string): Normalised | null {
  const sourceId = sourceIdOf(a);
  if (!sourceId) return null;
  const { state, reason } = mapState(a);
  const kind = a.kind === "interactive" || a.kind === "background" ? a.kind : "unknown";
  const rawName = a.name && sanitizeText(a.name) ? a.name : a.cwd ? basename(a.cwd) : "Claude session";
  return {
    sourceId,
    claudeSessionId: a.sessionId ?? null,
    id: opaqueId(sourceId, salt),
    kind,
    name: truncateChars(sanitizeText(rawName) || "Claude session", 64),
    state,
    needsAttentionReason: state === "needs_attention" ? reason : null,
    startedAtMs: parseStartedAt(a.startedAt),
    alive: a.pid !== undefined || a.status !== undefined,
  };
}
