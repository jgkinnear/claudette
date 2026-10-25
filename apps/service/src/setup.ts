import { existsSync, rmSync } from "node:fs";
import { runAgentsCli } from "./agents.js";
import { claudeVersion, compareVersions, findClaude } from "./claudeCli.js";
import {
  backupSettings,
  installStatusLine,
  mergeHooks,
  readSettings,
  removeOurHooks,
  removeOurStatusLine,
  statusLineCommandFor,
  statusLineState,
  writeSettings,
  type Settings,
} from "./claudeSettings.js";
import { MIN_CLAUDE_VERSION } from "./doctor.js";
import { installLaunchAgent, uninstallLaunchAgent, type Exec } from "./launchd.js";
import { resolvePaths, type Paths } from "./paths.js";
import { Store } from "./store.js";

export interface SetupIO {
  out(line: string): void;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  exec: Exec;
  openUrl(url: string): Promise<void>;
  waitForHealth(port: number): Promise<boolean>;
}

export interface SetupOptions {
  yes?: boolean;
  port?: number;
  /** false = never install the status line (--no-statusline). */
  statusline?: boolean;
  env?: NodeJS.ProcessEnv;
  nodePath: string;
  cliPath: string;
  platform?: NodeJS.Platform;
  /** Skip the Claude CLI probe (tests). */
  claudePath?: string;
  open?: boolean;
}

export interface SetupResult {
  ok: boolean;
  paths: Paths;
  backup: string | null;
  hooksChanged: boolean;
  statusLine: "installed" | "kept-yours" | "skipped" | "already";
  launchAgent: "installed" | "skipped" | "failed";
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Env vars worth carrying into the LaunchAgent so it sees the same dirs as setup. */
function passthroughEnv(env: NodeJS.ProcessEnv, claudePath: string): Record<string, string> {
  const out: Record<string, string> = {
    PATH: [claudePath.replace(/\/[^/]+$/, ""), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  };
  for (const k of ["CLAUDETTE_HOME", "CLAUDETTE_LOG_DIR", "CLAUDETTE_CLAUDE_DIR", "CLAUDE_CONFIG_DIR"]) {
    if (env[k]) out[k] = env[k]!;
  }
  return out;
}

export async function setup(opts: SetupOptions, io: SetupIO): Promise<SetupResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const paths = resolvePaths(env);
  const say = io.out;
  const result: SetupResult = { ok: false, paths, backup: null, hooksChanged: false, statusLine: "skipped", launchAgent: "skipped" };

  say("✿ Claudette setup");
  say("");
  // ---- checks
  if (platform !== "darwin") {
    say("! This isn't macOS. Claudette will configure hooks, but you'll need to run `npx get-claudette start` yourself,");
    say("  and devices will need this computer's address entered manually (no mDNS yet).");
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) {
    say(`✗ Node.js ${process.versions.node} is too old. Please install Node.js 22 or newer.`);
    return result;
  }
  say(`✓ Node.js v${process.versions.node}`);
  const claudePath = opts.claudePath ?? findClaude(env);
  if (!claudePath) {
    say("✗ Couldn't find the `claude` command. Install Claude Code first: https://docs.claude.com/claude-code");
    return result;
  }
  const version = await claudeVersion(claudePath);
  if (!version) {
    say(`✗ ${claudePath} didn't answer \`--version\`.`);
    return result;
  }
  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    say(`✗ Claude Code ${version} is too old for \`claude agents --json\`. Please update (needs ${MIN_CLAUDE_VERSION}+).`);
    return result;
  }
  say(`✓ Claude Code v${version} (${claudePath})`);
  try {
    const rows = await runAgentsCli(claudePath, 10_000);
    say(`✓ \`claude agents --json --all\` works (${rows.length} session${rows.length === 1 ? "" : "s"} right now)`);
  } catch (e) {
    say(`! \`claude agents --json --all\` failed: ${(e as Error).message}. Claudette will keep trying once it's running.`);
  }

  // ---- consent
  const store = new Store(paths);
  const port = opts.port ?? (existsSync(paths.configFile) ? store.load().config.port : 3333);
  say("");
  say("Here's what Claudette does on this Mac:");
  say("  • reads `claude agents --json --all` every 5 s (session names and states)");
  say("  • reads token counts from your Claude transcripts (numbers only, never message text)");
  say(`  • adds small HTTP hooks to ${paths.claudeSettings} (→ http://127.0.0.1:${port}/hooks/claude):`);
  say("    SubagentStart/Stop, Stop, SessionEnd to count helper agents, and PermissionRequest,");
  say("    PreToolUse (AskUserQuestion only) and Notification to show what a waiting session is asking.");
  say("    They always answer \"no decision\": Claude asks you exactly as before. Your existing settings");
  say("    and hooks are kept, and a backup is made first.");
  if (platform === "darwin") say(`  • installs a LaunchAgent so it starts when you log in (no sudo)`);
  say(`  • listens on port ${port} on your local network so your paired Claudette display can read the dashboard`);
  say("Nothing is sent to the internet. `claudette uninstall` removes only Claudette's own changes.");
  say("");
  if (!opts.yes && !(await io.confirm("Continue?", true))) {
    say("No changes made. Bye for now ✿");
    return result;
  }

  store.load({ port, claudePath });

  // ---- Claude settings
  let current: Settings;
  try {
    current = readSettings(paths.claudeSettings).data;
  } catch (e) {
    say(`✗ ${(e as Error).message}`);
    return result;
  }
  let next = mergeHooks(current, { port, secret: store.config.hookSecret });
  const command = statusLineCommandFor(opts.nodePath, opts.cliPath);
  const slState = statusLineState(current, store.config.statusLineCommand ?? command);
  if (slState === "other") {
    say("✓ You already have a status line, so Claudette leaves it alone (context % will show as unavailable).");
    result.statusLine = "kept-yours";
  } else if (slState === "ours") {
    next = installStatusLine(removeOurStatusLine(next, store.config.statusLineCommand ?? command), command).settings;
    result.statusLine = "already";
  } else if (opts.statusline !== false) {
    const want = opts.yes
      ? true
      : await io.confirm(
          "Optional: add a tiny Claudette status line (`✿ ctx 42%`) so the display can show context % and rate limits?",
          false,
        );
    if (want) {
      next = installStatusLine(next, command).settings;
      result.statusLine = "installed";
    }
  }
  if (!same(current, next)) {
    result.backup = backupSettings(paths.claudeSettings);
    if (result.backup) say(`✓ Backed up your Claude settings to ${result.backup}`);
    writeSettings(paths.claudeSettings, next);
    result.hooksChanged = true;
    say("✓ Claude settings updated");
  } else {
    say("✓ Claude settings already up to date");
  }
  store.config.hooksInstalled = true;
  store.config.statusLineInstalled = result.statusLine === "installed" || result.statusLine === "already";
  store.config.statusLineCommand = store.config.statusLineInstalled ? command : null;
  store.saveConfig();

  // ---- LaunchAgent
  if (platform === "darwin") {
    const r = await installLaunchAgent(paths, { nodePath: opts.nodePath, cliPath: opts.cliPath, env: passthroughEnv(env, claudePath) }, io.exec);
    if (r.ok) {
      result.launchAgent = "installed";
      store.config.launchAgentInstalled = true;
      store.saveConfig();
      say("✓ Claudette will start automatically when you log in");
    } else {
      result.launchAgent = "failed";
      say(`! Couldn't load the LaunchAgent (${r.detail}). You can run \`npx get-claudette start\` yourself.`);
    }
  }

  const url = `http://localhost:${port}`;
  if (result.launchAgent === "installed") {
    const up = await io.waitForHealth(port);
    say(up ? `✓ Service is up on port ${port}` : `! The service didn't answer yet. Try \`npx get-claudette doctor\`.`);
    if (up && opts.open !== false) await io.openUrl(url);
  }
  say("");
  say(`All done! Open ${url} to pair your Claudette and pick favourite sessions ✿`);
  result.ok = true;
  return result;
}

export interface UninstallOptions {
  yes?: boolean;
  purge?: boolean;
  env?: NodeJS.ProcessEnv;
  nodePath: string;
  cliPath: string;
}

export async function uninstall(
  opts: UninstallOptions,
  io: Pick<SetupIO, "out" | "confirm" | "exec">,
): Promise<{ ok: boolean; backup: string | null; removedData: boolean }> {
  const env = opts.env ?? process.env;
  const paths = resolvePaths(env);
  const say = io.out;
  say("✿ Claudette uninstall");
  say("This removes Claudette's hooks and status line from your Claude settings, and its LaunchAgent.");
  say("Your other Claude settings and hooks are left exactly as they are.");
  if (!opts.yes && !(await io.confirm("Continue?", true))) {
    say("Nothing changed.");
    return { ok: false, backup: null, removedData: false };
  }
  let ourCommand: string | null = null;
  if (existsSync(paths.configFile)) {
    try {
      ourCommand = new Store(paths).load().config.statusLineCommand;
    } catch {
      /* corrupt config: fall back below */
    }
  }
  ourCommand ??= statusLineCommandFor(opts.nodePath, opts.cliPath);
  let backup: string | null = null;
  try {
    const { exists, data } = readSettings(paths.claudeSettings);
    if (exists) {
      const next = removeOurStatusLine(removeOurHooks(data), ourCommand);
      if (!same(data, next)) {
        backup = backupSettings(paths.claudeSettings);
        writeSettings(paths.claudeSettings, next);
        say(`✓ Removed Claudette's hooks${statusLineState(data, ourCommand) === "ours" ? " and status line" : ""} (backup: ${backup})`);
      } else {
        say("✓ No Claudette entries in your Claude settings");
      }
    }
  } catch (e) {
    say(`! ${(e as Error).message}`);
  }
  if (process.platform === "darwin" || existsSync(paths.launchAgentPlist)) {
    const removed = await uninstallLaunchAgent(paths, io.exec);
    say(removed ? "✓ LaunchAgent removed" : "✓ No LaunchAgent installed");
  }
  let removedData = false;
  if (existsSync(paths.home)) {
    const del = opts.purge
      ? true
      : opts.yes
        ? false
        : await io.confirm(`Also delete Claudette's data (paired devices, favourites) in ${paths.home}?`, false);
    if (del) {
      rmSync(paths.home, { recursive: true, force: true });
      removedData = true;
      say("✓ Claudette data deleted");
    } else {
      say(`Kept your Claudette data in ${paths.home}`);
    }
  }
  say("Bye for now ✿");
  return { ok: true, backup, removedData };
}
