import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

const SCRUBBERS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,"']+/gi, "$1$2[redacted]"],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
  [/(x-claudette-hook\s*[:=]\s*"?)[^\s,"']+/gi, "$1[redacted]"],
  [/("?(?:token|secret|pairSecret|hookSecret|password|code|tokenHash)"?\s*[:=]\s*"?)[^\s,"'}]+/gi, "$1[redacted]"],
  // long hex / base64url blobs look like secrets: never print them
  [/\b[a-f0-9]{32,}\b/gi, "[redacted-hex]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]"],
];

/** Remove anything that looks like a token or secret from a log line. */
export function scrub(text: string): string {
  let out = text;
  for (const [re, rep] of SCRUBBERS) out = out.replace(re, rep);
  return out;
}

export interface FileLoggerOptions {
  file?: string | null;
  maxBytes?: number;
  keep?: number;
  level?: LogLevel;
  console?: boolean;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(opts: FileLoggerOptions = {}): Logger {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const keep = opts.keep ?? 3;
  const min = ORDER[opts.level ?? (process.env.CLAUDETTE_DEBUG ? "debug" : "info")];
  const file = opts.file ?? null;
  if (file) mkdirSync(file.replace(/\/[^/]+$/, ""), { recursive: true, mode: 0o700 });

  function rotate(): void {
    if (!file || !existsSync(file)) return;
    try {
      if (statSync(file).size < maxBytes) return;
      const last = `${file}.${keep}`;
      if (existsSync(last)) unlinkSync(last);
      for (let i = keep - 1; i >= 1; i--) {
        if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      }
      renameSync(file, `${file}.1`);
    } catch {
      /* never let logging crash the service */
    }
  }

  function write(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (ORDER[level] < min) return;
    const line = scrub(
      `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra ? " " + JSON.stringify(extra) : ""}`,
    );
    if (opts.console !== false) {
      (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
    }
    if (file) {
      try {
        rotate();
        appendFileSync(file, line + "\n", { mode: 0o600 });
      } catch {
        /* ignore */
      }
    }
  }

  return {
    debug: (m, e) => write("debug", m, e),
    info: (m, e) => write("info", m, e),
    warn: (m, e) => write("warn", m, e),
    error: (m, e) => write("error", m, e),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
