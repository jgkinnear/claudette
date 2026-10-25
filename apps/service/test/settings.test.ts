import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureFakeClaudeExecutable, userSettings } from "@claudette/test-fixtures";
import { hooksState, isOurHook, mergeHooks, removeOurHooks, statusLineCommandFor } from "../src/claudeSettings.js";
import type { Exec } from "../src/launchd.js";
import { setup, uninstall } from "../src/setup.js";
import { tempDir } from "./helpers.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("settings merge", () => {
  it("adds our hooks, keeps the user's hooks and status line, and removes only ours", () => {
    const merged = mergeHooks(structuredClone(userSettings), { port: 3333, secret: "s".repeat(64) });
    expect(merged.statusLine).toEqual(userSettings.statusLine);
    expect(merged.permissions).toEqual(userSettings.permissions);
    const hooks = merged.hooks as Record<string, Array<{ hooks: unknown[] }>>;
    expect(hooks.PreToolUse).toEqual(userSettings.hooks.PreToolUse);
    expect(hooks.SubagentStart!.length).toBe(2); // user's + ours
    expect(hooks.SubagentStart![0]).toEqual(userSettings.hooks.SubagentStart![0]);
    expect(hooksState(merged, 3333)).toMatchObject({ installed: true });
    expect(hooksState(merged, 4444).installed).toBe(false);

    // idempotent
    const again = mergeHooks(merged, { port: 3333, secret: "s".repeat(64) });
    expect(again).toEqual(merged);

    const removed = removeOurHooks(again);
    expect(removed).toEqual(userSettings);
  });

  it("removes the hooks key entirely when only ours were there", () => {
    const merged = mergeHooks({}, { port: 3333, secret: "x".repeat(64) });
    expect(removeOurHooks(merged)).toEqual({});
  });

  it("recognises only Claudette URLs as ours", () => {
    expect(isOurHook({ type: "http", url: "http://127.0.0.1:3333/hooks/claude" })).toBe(true);
    expect(isOurHook({ type: "http", url: "http://127.0.0.1:3333/other" })).toBe(false);
    expect(isOurHook({ type: "http", url: "http://example.com/hooks/claude" })).toBe(false);
    expect(isOurHook({ type: "command", command: "curl http://127.0.0.1:3333/hooks/claude" })).toBe(false);
  });
});

function fakeExec(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

describe("setup / uninstall (temp dirs only)", () => {
  function env(dir: string) {
    return {
      ...process.env,
      CLAUDETTE_HOME: join(dir, "home"),
      CLAUDETTE_CLAUDE_DIR: join(dir, "claude"),
      CLAUDETTE_LAUNCH_AGENTS_DIR: join(dir, "LaunchAgents"),
      CLAUDETTE_LOG_DIR: join(dir, "logs"),
      FAKE_CLAUDE_AGENTS_FILE: "",
    };
  }

  it("merges hooks with a backup, keeps the user's status line, installs the LaunchAgent, and uninstalls cleanly", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const e = env(t.dir);
    const claudeDir = e.CLAUDETTE_CLAUDE_DIR;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2));
    const { exec, calls } = fakeExec();
    const out: string[] = [];
    const r = await setup(
      { yes: true, env: e, nodePath: "/usr/local/bin/node", cliPath: "/opt/claudette/dist/cli.js", platform: "darwin", claudePath: ensureFakeClaudeExecutable(), open: false },
      { out: (l) => out.push(l), confirm: async () => true, exec, openUrl: async () => {}, waitForHealth: async () => true },
    );
    expect(r.ok).toBe(true);
    expect(r.backup).toBeTruthy();
    expect(JSON.parse(readFileSync(r.backup!, "utf8"))).toEqual(userSettings);
    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after.statusLine).toEqual(userSettings.statusLine); // never overwritten
    expect(r.statusLine).toBe("kept-yours");
    expect(after.hooks.PreToolUse).toEqual(userSettings.hooks.PreToolUse);
    expect(hooksState(after, 3333).installed).toBe(true);
    const plist = join(t.dir, "LaunchAgents", "dev.claudette.service.plist");
    expect(existsSync(plist)).toBe(true);
    const xml = readFileSync(plist, "utf8");
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(calls.some((c) => c.includes("bootstrap"))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(e.CLAUDETTE_HOME, "config.json"), "utf8"));
    expect(cfg.claudePath).toBe(ensureFakeClaudeExecutable());
    expect(statSync(e.CLAUDETTE_HOME).mode & 0o777).toBe(0o700);
    expect(statSync(join(e.CLAUDETTE_HOME, "config.json")).mode & 0o777).toBe(0o600);
    // secret must not be printed
    expect(out.join("\n")).not.toContain(cfg.hookSecret);

    // second run is idempotent: no new changes to settings
    const r2 = await setup(
      { yes: true, env: e, nodePath: "/usr/local/bin/node", cliPath: "/opt/claudette/dist/cli.js", platform: "darwin", claudePath: ensureFakeClaudeExecutable(), open: false },
      { out: () => {}, confirm: async () => true, exec, openUrl: async () => {}, waitForHealth: async () => true },
    );
    expect(r2.hooksChanged).toBe(false);

    const u = await uninstall(
      { yes: true, env: e, nodePath: "/usr/local/bin/node", cliPath: "/opt/claudette/dist/cli.js" },
      { out: () => {}, confirm: async () => false, exec },
    );
    expect(u.ok).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(userSettings);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(e.CLAUDETTE_HOME)).toBe(true); // data kept unless confirmed
    expect(readdirSync(claudeDir).filter((f) => f.includes("claudette-backup")).length).toBeGreaterThanOrEqual(2);
  });

  it("installs our status line only when asked and none exists, and uninstall removes it", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const e = env(t.dir);
    const { exec } = fakeExec();
    const io = { out: () => {}, confirm: async () => true, exec, openUrl: async () => {}, waitForHealth: async () => true };
    const opts = { yes: false, env: e, nodePath: "/usr/local/bin/node", cliPath: "/opt/claudette/dist/cli.js", platform: "linux" as const, claudePath: ensureFakeClaudeExecutable(), open: false };
    const r = await setup(opts, io);
    expect(r.statusLine).toBe("installed");
    expect(r.launchAgent).toBe("skipped");
    const settingsPath = join(e.CLAUDETTE_CLAUDE_DIR, "settings.json");
    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after.statusLine.command).toBe(statusLineCommandFor("/usr/local/bin/node", "/opt/claudette/dist/cli.js"));
    await uninstall({ yes: true, purge: true, env: e, nodePath: "/usr/local/bin/node", cliPath: "/opt/claudette/dist/cli.js" }, io);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({});
    expect(existsSync(e.CLAUDETTE_HOME)).toBe(false);
  });

  it("--no-statusline and declined consent change nothing they shouldn't", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const e = env(t.dir);
    const { exec } = fakeExec();
    const declined = await setup(
      { env: e, nodePath: "n", cliPath: "c", platform: "linux", claudePath: ensureFakeClaudeExecutable() },
      { out: () => {}, confirm: async () => false, exec, openUrl: async () => {}, waitForHealth: async () => true },
    );
    expect(declined.ok).toBe(false);
    expect(existsSync(join(e.CLAUDETTE_CLAUDE_DIR, "settings.json"))).toBe(false);
    const r = await setup(
      { yes: true, statusline: false, env: e, nodePath: "n", cliPath: "c", platform: "linux", claudePath: ensureFakeClaudeExecutable() },
      { out: () => {}, confirm: async () => true, exec, openUrl: async () => {}, waitForHealth: async () => true },
    );
    expect(r.statusLine).toBe("skipped");
    expect(JSON.parse(readFileSync(join(e.CLAUDETTE_CLAUDE_DIR, "settings.json"), "utf8")).statusLine).toBeUndefined();
  });

  it("refuses to touch an invalid settings.json", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const e = env(t.dir);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(e.CLAUDETTE_CLAUDE_DIR, { recursive: true });
    const p = join(e.CLAUDETTE_CLAUDE_DIR, "settings.json");
    writeFileSync(p, "{ not json");
    const { exec } = fakeExec();
    const r = await setup(
      { yes: true, env: e, nodePath: "n", cliPath: "c", platform: "linux", claudePath: ensureFakeClaudeExecutable() },
      { out: () => {}, confirm: async () => true, exec, openUrl: async () => {}, waitForHealth: async () => true },
    );
    expect(r.ok).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("{ not json");
  });
});
