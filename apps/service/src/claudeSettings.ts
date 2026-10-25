import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { atomicWrite } from "./fsutil.js";

/**
 * Read/merge/unmerge of Claude Code's settings.json. Claudette only ever adds
 * its own entries and only ever removes entries it can prove are its own:
 *   - hooks whose `url` starts with http://127.0.0.1:<port>/hooks/
 *   - a statusLine whose command is the exact one we installed
 */

export const HOOK_EVENTS = ["SubagentStart", "SubagentStop", "Stop", "SessionEnd"] as const;
const OUR_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/hooks\//;

export type Settings = Record<string, unknown> & {
  hooks?: Record<string, unknown>;
  statusLine?: unknown;
};

interface HookGroup {
  matcher?: string;
  hooks?: unknown[];
  [k: string]: unknown;
}

export function isOurHook(h: unknown): boolean {
  if (!h || typeof h !== "object") return false;
  const o = h as Record<string, unknown>;
  return o.type === "http" && typeof o.url === "string" && OUR_URL.test(o.url);
}

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hooks/claude`;
}

export function readSettings(path: string): { exists: boolean; data: Settings } {
  if (!existsSync(path)) return { exists: false, data: {} };
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return { exists: true, data: {} };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${path} isn't valid JSON, so Claudette won't touch it. Fix it and run setup again.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${path} doesn't contain a JSON object, so Claudette won't touch it.`);
  }
  return { exists: true, data: data as Settings };
}

export function writeSettings(path: string, data: Settings): void {
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    /* new file */
  }
  atomicWrite(path, JSON.stringify(data, null, 2) + "\n", mode);
}

export function backupSettings(path: string, now = new Date()): string | null {
  if (!existsSync(path)) return null;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  let dest = `${path}.claudette-backup-${stamp}`;
  for (let i = 1; existsSync(dest); i++) dest = `${path}.claudette-backup-${stamp}-${i}`;
  copyFileSync(path, dest);
  return dest;
}

function groupsOf(hooks: Record<string, unknown>, event: string): HookGroup[] {
  const v = hooks[event];
  return Array.isArray(v) ? (v as HookGroup[]) : [];
}

/** Remove Claudette's hook entries (any port), leaving everything else intact. */
export function removeOurHooks(settings: Settings): Settings {
  const out: Settings = structuredClone(settings);
  if (!out.hooks || typeof out.hooks !== "object") return out;
  const hooks = out.hooks as Record<string, unknown>;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    let touched = false;
    const kept: HookGroup[] = [];
    for (const g of groups as HookGroup[]) {
      if (!g || typeof g !== "object" || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const remaining = g.hooks.filter((h) => !isOurHook(h));
      if (remaining.length !== g.hooks.length) touched = true;
      if (remaining.length > 0) kept.push({ ...g, hooks: remaining });
      else if (remaining.length === g.hooks.length) kept.push(g);
    }
    if (touched) {
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
    }
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

/** Add (or refresh) Claudette's HTTP hooks. Existing user hooks are preserved. */
export function mergeHooks(settings: Settings, opts: { port: number; secret: string }): Settings {
  const out = removeOurHooks(settings);
  if (out.hooks !== undefined && (typeof out.hooks !== "object" || Array.isArray(out.hooks))) {
    throw new Error('settings.json has a "hooks" value that isn\'t an object; not touching it.');
  }
  const hooks = (out.hooks ?? {}) as Record<string, unknown>;
  for (const event of HOOK_EVENTS) {
    const groups = groupsOf(hooks, event);
    groups.push({
      matcher: "",
      hooks: [
        {
          type: "http",
          url: hookUrl(opts.port),
          timeout: 3,
          headers: { "X-Claudette-Hook": opts.secret },
        },
      ],
    });
    hooks[event] = groups;
  }
  out.hooks = hooks;
  return out;
}

export interface HooksState {
  /** All four events have a Claudette hook pointing at `port`. */
  installed: boolean;
  events: string[];
  ports: number[];
}

export function hooksState(settings: Settings, port: number): HooksState {
  const events: string[] = [];
  const ports = new Set<number>();
  const hooks = settings.hooks && typeof settings.hooks === "object" ? (settings.hooks as Record<string, unknown>) : {};
  for (const event of HOOK_EVENTS) {
    for (const g of groupsOf(hooks, event)) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (isOurHook(h)) {
          const p = Number(/:(\d+)\//.exec((h as { url: string }).url)?.[1]);
          ports.add(p);
          if (p === port && !events.includes(event)) events.push(event);
        }
      }
    }
  }
  return {
    installed: events.includes("SubagentStart") && events.includes("SubagentStop"),
    events,
    ports: [...ports],
  };
}

export type StatusLineState = "none" | "ours" | "other";

export function statusLineCommandFor(nodePath: string, cliPath: string): string {
  const q = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
  return `${q(nodePath)} ${q(cliPath)} statusline`;
}

export function statusLineState(settings: Settings, ourCommand: string | null): StatusLineState {
  const sl = settings.statusLine;
  if (sl === undefined || sl === null) return "none";
  if (typeof sl === "object" && ourCommand && (sl as Record<string, unknown>).command === ourCommand) return "ours";
  return "other";
}

/** Install our status line only when the user has none. Never overwrites. */
export function installStatusLine(settings: Settings, command: string): { settings: Settings; installed: boolean } {
  if (statusLineState(settings, command) === "other") return { settings, installed: false };
  return { settings: { ...structuredClone(settings), statusLine: { type: "command", command, padding: 0 } }, installed: true };
}

export function removeOurStatusLine(settings: Settings, ourCommand: string | null): Settings {
  if (statusLineState(settings, ourCommand) !== "ours") return settings;
  const out = structuredClone(settings);
  delete out.statusLine;
  return out;
}
