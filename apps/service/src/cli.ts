#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { cliEntry } from "./paths.js";

/** The built entry point (the LaunchAgent and status line run plain node, not tsx). */
const selfPath = () => {
  const p = fileURLToPath(import.meta.url);
  return p.endsWith(".ts") ? cliEntry : p;
};

const HELP = `✿ claudette — a tiny desk companion for Claude Code

Usage:
  claudette setup [--yes] [--port N] [--no-statusline]   set up hooks + start at login
  claudette status                                       is it running? what does it see?
  claudette doctor                                       diagnose Claude CLI, hooks, mDNS, port
  claudette logs [-f]                                    show (scrubbed) service logs
  claudette restart                                      restart the background service
  claudette uninstall [--yes] [--purge]                  remove Claudette's hooks and LaunchAgent
  claudette start [--port N] [--mock [scenario]] [--no-mdns]   run the service in the foreground
  claudette statusline                                   (used by Claude Code's status line)

Environment: CLAUDETTE_HOME, CLAUDETTE_PORT, CLAUDETTE_CLAUDE_DIR (or CLAUDE_CONFIG_DIR),
             CLAUDETTE_LOG_DIR, CLAUDETTE_LAUNCH_AGENTS_DIR, CLAUDETTE_NO_MDNS=1
`;

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("-") ? v : undefined;
}

function portOption(args: string[]): number | undefined {
  const v = option(args, "--port");
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`Invalid --port ${v}`);
    process.exit(2);
  }
  return n;
}

async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // non-interactive: only --yes says yes
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (!a) return defaultYes;
    return a === "y" || a === "yes";
  } finally {
    rl.close();
  }
}

async function localGet(port: number, path: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return null;
  }
}

async function cmdStart(args: string[]): Promise<void> {
  const { startService } = await import("./service.js");
  const mockIdx = args.indexOf("--mock");
  let mock: string | null = null;
  if (mockIdx !== -1) {
    const next = args[mockIdx + 1];
    mock = next && !next.startsWith("-") ? next : "tour";
  }
  const port = portOption(args);
  const svc = await startService({ ...(port !== undefined ? { port } : {}), mock, noMdns: flag(args, "--no-mdns") });
  console.log(`✿ Claudette is listening on http://localhost:${svc.port}${mock ? ` (demo: ${mock})` : ""}`);
  const shutdown = async () => {
    await svc.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * `npx get-claudette setup` runs from npm's cache, which npm may clean up later. The LaunchAgent and
 * status line need a path that lasts, so copy the package into Claudette's own folder first.
 */
async function stableCliPath(): Promise<string> {
  const self = selfPath();
  if (!/[\\/]_npx[\\/]/.test(self)) return self;
  const { cpSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { resolvePaths, serviceRoot } = await import("./paths.js");
  const app = join(resolvePaths().home, "app");
  rmSync(app, { recursive: true, force: true });
  cpSync(serviceRoot, app, { recursive: true, filter: (p) => !p.includes(`${serviceRoot}/node_modules`) });
  console.log(`✓ Installed Claudette to ${app}`);
  return join(app, "dist", "cli.js");
}

async function cmdSetup(args: string[]): Promise<void> {
  const { setup } = await import("./setup.js");
  const { realExec } = await import("./launchd.js");
  const cliPath = await stableCliPath();
  const port = portOption(args);
  const r = await setup(
    {
      yes: flag(args, "--yes") || flag(args, "-y"),
      ...(port !== undefined ? { port } : {}),
      ...(flag(args, "--no-statusline") ? { statusline: false } : {}),
      nodePath: process.execPath,
      cliPath,
      open: !flag(args, "--no-open"),
    },
    {
      out: (l) => console.log(l),
      confirm,
      exec: realExec,
      openUrl: async (url) => {
        if (process.platform === "darwin") await realExec("/usr/bin/open", [url]);
      },
      waitForHealth: async (p) => {
        for (let i = 0; i < 20; i++) {
          if ((await localGet(p, "/api/v1/health"))?.status === 200) return true;
          await new Promise((r) => setTimeout(r, 500));
        }
        return false;
      },
    },
  );
  process.exitCode = r.ok ? 0 : 1;
}

async function cmdUninstall(args: string[]): Promise<void> {
  const { uninstall } = await import("./setup.js");
  const { realExec } = await import("./launchd.js");
  await uninstall(
    {
      yes: flag(args, "--yes") || flag(args, "-y"),
      purge: flag(args, "--purge"),
      nodePath: process.execPath,
      cliPath: selfPath(),
    },
    { out: (l) => console.log(l), confirm, exec: realExec },
  );
}

async function loadConfig() {
  const { resolvePaths } = await import("./paths.js");
  const { Store } = await import("./store.js");
  const paths = resolvePaths();
  const store = new Store(paths).load();
  const envPort = Number(process.env.CLAUDETTE_PORT);
  if (envPort) store.config.port = envPort; // runtime override, not saved
  return { paths, store };
}

function printChecks(checks: Array<{ label: string; ok: boolean | null; detail: string; fix?: string }>): void {
  for (const c of checks) {
    const icon = c.ok === true ? "✓" : c.ok === false ? "✗" : "·";
    console.log(`${icon} ${c.label}: ${c.detail}`);
    if (c.ok === false && c.fix) console.log(`    → ${c.fix}`);
  }
}

async function cmdStatus(): Promise<void> {
  const { paths, store } = await loadConfig();
  const port = store.config.port;
  console.log(`✿ Claudette (${store.config.hostName}) — port ${port}`);
  if (process.platform === "darwin") {
    const { launchAgentLoaded, realExec } = await import("./launchd.js");
    const loaded = await launchAgentLoaded(realExec);
    console.log(`  LaunchAgent: ${loaded ? "loaded" : (await import("node:fs")).existsSync(paths.launchAgentPlist) ? "installed, not loaded" : "not installed"}`);
  }
  const health = await localGet(port, "/api/v1/health");
  if (!health) {
    console.log("  Service: not running (try `npx get-claudette restart` or `npx get-claudette start`)");
    process.exitCode = 1;
    return;
  }
  const h = health.body as { version: string; ready: boolean };
  console.log(`  Service: running v${h.version}${h.ready ? "" : " (warming up)"}`);
  const s = (await localGet(port, "/admin/api/status"))?.body as
    | { collection: { status: string; message: string | null; hooksInstalled: boolean }; sessions: Array<{ state: string }>; dailyUsage: { tokens: number | null } }
    | undefined;
  if (s) {
    const counts: Record<string, number> = {};
    for (const x of s.sessions) counts[x.state] = (counts[x.state] ?? 0) + 1;
    console.log(`  Claude data: ${s.collection.status}${s.collection.message ? ` — ${s.collection.message}` : ""}`);
    console.log(`  Sessions: ${s.sessions.length} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    console.log(`  Subagent hooks: ${s.collection.hooksInstalled ? "installed" : "not installed"}`);
    console.log(`  Tokens today: ${s.dailyUsage.tokens ?? "unavailable"}`);
  }
  const d = (await localGet(port, "/admin/api/devices"))?.body as { devices: unknown[] } | undefined;
  if (d) console.log(`  Paired devices: ${d.devices.length}`);
}

async function cmdDoctor(): Promise<void> {
  const { paths, store } = await loadConfig();
  const live = await localGet(store.config.port, "/admin/api/doctor");
  console.log("✿ Claudette doctor");
  if (live?.status === 200) {
    const r = live.body as { checks: Array<{ label: string; ok: boolean | null; detail: string; fix?: string }> };
    console.log(`  service running on port ${store.config.port}`);
    printChecks(r.checks);
    process.exitCode = r.checks.some((c) => c.ok === false) ? 1 : 0;
    return;
  }
  console.log(`✗ Service isn't answering on port ${store.config.port}`);
  console.log("    → Try `npx get-claudette restart`, or `npx get-claudette logs` to see why.");
  const { staticChecks } = await import("./doctor.js");
  printChecks(await staticChecks(paths, store.config));
  process.exitCode = 1;
}

async function cmdLogs(args: string[]): Promise<void> {
  const { resolvePaths } = await import("./paths.js");
  const { existsSync, readFileSync, statSync, openSync, readSync, closeSync } = await import("node:fs");
  const { scrub } = await import("./log.js");
  const file = resolvePaths().logFile;
  if (!existsSync(file)) {
    console.log(`No logs yet (${file})`);
    return;
  }
  const lines = readFileSync(file, "utf8").split("\n");
  process.stdout.write(scrub(lines.slice(-200).join("\n")) + "\n");
  if (!flag(args, "-f") && !flag(args, "--follow")) return;
  let pos = statSync(file).size;
  setInterval(() => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < pos) pos = 0; // rotated
    if (size === pos) return;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size - pos);
    readSync(fd, buf, 0, buf.length, pos);
    closeSync(fd);
    pos = size;
    process.stdout.write(scrub(buf.toString("utf8")));
  }, 500);
}

async function cmdRestart(): Promise<void> {
  const { paths } = await loadConfig();
  const { existsSync } = await import("node:fs");
  if (process.platform !== "darwin" || !existsSync(paths.launchAgentPlist)) {
    console.log("Claudette isn't installed as a background service. Run `npx get-claudette`, or `npx get-claudette start` in a terminal.");
    process.exitCode = 1;
    return;
  }
  const { restartLaunchAgent, realExec } = await import("./launchd.js");
  const r = await restartLaunchAgent(realExec);
  console.log(r.code === 0 ? "✓ Restarted" : `✗ launchctl said: ${(r.stderr || r.stdout).trim()}`);
  process.exitCode = r.code === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  // `npx get-claudette` with no command means "set me up" (see the get-claudette entry point).
  const fallback = (globalThis as { __claudetteDefaultCommand?: string }).__claudetteDefaultCommand;
  const [cmd = fallback, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "start":
      return cmdStart(args);
    case "setup":
      return cmdSetup(args);
    case "uninstall":
      return cmdUninstall(args);
    case "status":
      return cmdStatus();
    case "doctor":
      return cmdDoctor();
    case "logs":
      return cmdLogs(args);
    case "restart":
      return cmdRestart();
    case "statusline": {
      const { runStatusLine } = await import("./statusline.js");
      process.stdout.write((await runStatusLine()) + "\n");
      process.exit(0);
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    case "--version":
    case "-v": {
      const { VERSION } = await import("./version.js");
      console.log(VERSION);
      return;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((err: Error) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
