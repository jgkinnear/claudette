import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** One distinct API response's usage. */
interface UsageRec {
  /** input + output + cache creation */
  work: number;
  cacheRead: number;
  ts: number;
}

interface Tracked {
  path: string;
  ino: number;
  offset: number;
  records: Map<string, UsageRec>;
  lastTs: number;
  mtimeMs: number;
}

export interface SessionTokens {
  sessionTotal: number;
  cacheRead: number;
  lastActivityMs: number | null;
}

export interface TokenLedgerOptions {
  projectsDir: string;
  now?: () => number;
  /** Minimum time between directory walks (default 15 s). */
  walkIntervalMs?: number;
  chunkBytes?: number;
}

const USAGE = Buffer.from('"usage"');
const NL = 0x0a;

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function localDateString(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Parse one transcript line. Returns null for anything that isn't an
 * assistant usage record. Only numbers, ids and the timestamp are kept;
 * message content is discarded immediately.
 */
export function parseUsageLine(line: string): { key: string; rec: UsageRec } | null {
  let o: {
    type?: unknown;
    uuid?: unknown;
    requestId?: unknown;
    timestamp?: unknown;
    message?: { id?: unknown; usage?: Record<string, unknown> };
  };
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || o.type !== "assistant" || !o.message || typeof o.message.usage !== "object" || !o.message.usage) return null;
  const u = o.message.usage;
  const id = typeof o.message.id === "string" ? o.message.id : typeof o.uuid === "string" ? o.uuid : null;
  if (!id) return null;
  const req = typeof o.requestId === "string" ? o.requestId : "";
  const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  return {
    key: `${id}|${req}`,
    rec: {
      work: n(u.input_tokens) + n(u.output_tokens) + n(u.cache_creation_input_tokens),
      cacheRead: n(u.cache_read_input_tokens),
      ts: Number.isFinite(ts) ? ts : 0,
    },
  };
}

/**
 * Read-only, incremental reader of Claude Code transcript usage.
 *
 * - finds a session's transcript by session id (directory walk, cached)
 * - reads only appended bytes (per-file offset), resets if a file shrinks or is replaced
 * - only JSON.parses lines containing `"usage"`
 * - dedupes API responses by message id + request id (streamed blocks repeat them)
 */
export class TokenLedger {
  private files = new Map<string, Tracked>();
  /** Claude session id -> main transcript path */
  private index = new Map<string, string>();
  /** Claude session id -> subagent transcript paths */
  private subIndex = new Map<string, string[]>();
  private lastWalk = 0;
  private lastForcedWalk = 0;
  private dailyFiles = new Set<string>();
  private readonly projectsDir: string;
  private readonly now: () => number;
  private readonly walkIntervalMs: number;
  private readonly chunkBytes: number;
  private dirty = true;
  private dailyCache: { date: string; tokens: number } | null = null;
  projectsDirExists = false;

  constructor(opts: TokenLedgerOptions) {
    this.projectsDir = opts.projectsDir;
    this.now = opts.now ?? Date.now;
    this.walkIntervalMs = opts.walkIntervalMs ?? 15_000;
    this.chunkBytes = opts.chunkBytes ?? 1 << 20;
  }

  /** Walk projects/ to (re)build the session index and today's file list. */
  async walk(): Promise<void> {
    this.lastWalk = this.now();
    const sod = startOfLocalDay(this.now());
    const index = new Map<string, string>();
    const daily = new Set<string>();
    let dirs: string[];
    try {
      dirs = (await readdir(this.projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      this.projectsDirExists = true;
    } catch {
      this.projectsDirExists = false;
      this.index = index;
      this.dailyFiles = daily;
      return;
    }
    for (const d of dirs) {
      const dir = join(this.projectsDir, d);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
        const sid = e.name.slice(0, -6);
        const p = join(dir, e.name);
        index.set(sid, p);
        try {
          const st = await stat(p);
          if (st.mtimeMs >= sod) {
            daily.add(p);
            for (const sp of await this.listSubagents(dir, sid)) {
              try {
                if ((await stat(sp)).mtimeMs >= sod) daily.add(sp);
              } catch {
                /* vanished */
              }
            }
          }
        } catch {
          /* vanished */
        }
      }
    }
    this.index = index;
    this.dailyFiles = daily;
    // forget files that are neither today's nor tracked for a live session
    for (const p of this.files.keys()) {
      if (!daily.has(p) && !this.isSessionFile(p)) {
        this.files.delete(p);
        this.dirty = true;
      }
    }
  }

  private liveSessionFiles = new Set<string>();
  private isSessionFile(p: string): boolean {
    return this.liveSessionFiles.has(p);
  }

  private async listSubagents(projectDir: string, sid: string): Promise<string[]> {
    const dir = join(projectDir, sid, "subagents");
    try {
      return (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
    } catch {
      return [];
    }
  }

  /**
   * Refresh usage for the given live Claude session ids (and, when due,
   * today's files). Call after each `claude agents` poll.
   */
  async update(sessionIds: Iterable<string>): Promise<void> {
    const now = this.now();
    const wanted = [...sessionIds];
    const missing = wanted.some((s) => !this.index.has(s));
    if (now - this.lastWalk >= this.walkIntervalMs || (missing && now - this.lastForcedWalk >= 5_000)) {
      if (missing) this.lastForcedWalk = now;
      await this.walk();
    }
    const live = new Set<string>();
    for (const sid of wanted) {
      const main = this.index.get(sid);
      if (!main) continue;
      const subs = await this.listSubagents(join(main, ".."), sid);
      this.subIndex.set(sid, subs);
      live.add(main);
      for (const s of subs) live.add(s);
    }
    this.liveSessionFiles = live;
    for (const p of new Set([...live, ...this.dailyFiles])) {
      if (await this.readFile(p)) this.dirty = true;
    }
  }

  /** Incrementally read one file. Returns true when its records changed. */
  async readFile(path: string): Promise<boolean> {
    let st;
    try {
      st = await stat(path);
    } catch {
      return this.files.delete(path);
    }
    let t = this.files.get(path);
    let changed = false;
    if (!t || t.ino !== st.ino || st.size < t.offset) {
      // new, replaced or truncated: start over
      changed = Boolean(t && t.records.size > 0);
      t = { path, ino: st.ino, offset: 0, records: new Map(), lastTs: 0, mtimeMs: st.mtimeMs };
      this.files.set(path, t);
    }
    t.mtimeMs = st.mtimeMs;
    if (st.size === t.offset) return changed;
    const fh = await open(path, "r");
    try {
      let pos = t.offset;
      let carry: Buffer = Buffer.alloc(0);
      while (pos < st.size) {
        const len = Math.min(this.chunkBytes, st.size - pos);
        const chunk = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(chunk, 0, len, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        let start = 0;
        for (;;) {
          const nl = buf.indexOf(NL, start);
          if (nl === -1) break;
          const line = buf.subarray(start, nl);
          if (line.indexOf(USAGE) !== -1) {
            const parsed = parseUsageLine(line.toString("utf8"));
            if (parsed) {
              const prev = t.records.get(parsed.key);
              if (!prev || prev.work !== parsed.rec.work || prev.cacheRead !== parsed.rec.cacheRead) changed = true;
              // keep the first timestamp, the latest numbers
              t.records.set(parsed.key, { ...parsed.rec, ts: prev?.ts || parsed.rec.ts });
              if (parsed.rec.ts > t.lastTs) t.lastTs = parsed.rec.ts;
            }
          }
          start = nl + 1;
        }
        t.offset += start;
        carry = Buffer.from(buf.subarray(start));
      }
      // an unterminated last line is left for the next read
    } finally {
      await fh.close();
    }
    return changed;
  }

  /** Totals for one Claude session (main transcript + subagents), or null if no transcript was found. */
  session(sessionId: string): SessionTokens | null {
    const main = this.index.get(sessionId);
    if (!main || !this.files.has(main)) return null;
    const paths = [main, ...(this.subIndex.get(sessionId) ?? [])];
    const seen = new Set<string>();
    let work = 0;
    let cacheRead = 0;
    let last = 0;
    for (const p of paths) {
      const t = this.files.get(p);
      if (!t) continue;
      if (t.lastTs > last) last = t.lastTs;
      for (const [k, r] of t.records) {
        if (seen.has(k)) continue;
        seen.add(k);
        work += r.work;
        cacheRead += r.cacheRead;
      }
    }
    const mtime = this.files.get(main)?.mtimeMs ?? 0;
    const lastActivity = Math.max(last, mtime);
    return { sessionTotal: work, cacheRead, lastActivityMs: lastActivity > 0 ? lastActivity : null };
  }

  /** Today's total across all transcripts (host-local calendar day). */
  daily(): { date: string; tokens: number | null } {
    const now = this.now();
    const date = localDateString(now);
    if (!this.projectsDirExists) return { date, tokens: null };
    if (!this.dirty && this.dailyCache?.date === date) return this.dailyCache;
    const sod = startOfLocalDay(now);
    const eod = new Date(new Date(sod).setDate(new Date(sod).getDate() + 1)).getTime();
    const seen = new Set<string>();
    let tokens = 0;
    for (const t of this.files.values()) {
      for (const [k, r] of t.records) {
        if (r.ts < sod || r.ts >= eod || seen.has(k)) continue;
        seen.add(k);
        tokens += r.work;
      }
    }
    this.dirty = false;
    this.dailyCache = { date, tokens };
    return this.dailyCache;
  }

  stats(): { files: number; indexed: number; dailyFiles: number } {
    return { files: this.files.size, indexed: this.index.size, dailyFiles: this.dailyFiles.size };
  }
}
