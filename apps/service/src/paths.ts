import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every filesystem location Claudette touches, overridable through the
 * environment so tests (and cautious users) can point it at temp dirs.
 *
 *   CLAUDETTE_HOME                state dir (config/preferences/devices)
 *   CLAUDETTE_LOG_DIR             log dir
 *   CLAUDETTE_CLAUDE_DIR          Claude config dir (settings.json, projects/)
 *   CLAUDE_CONFIG_DIR             same, Claude Code's own variable (fallback)
 *   CLAUDETTE_LAUNCH_AGENTS_DIR   where the LaunchAgent plist goes
 */
export interface Paths {
  home: string;
  configFile: string;
  preferencesFile: string;
  devicesFile: string;
  logDir: string;
  logFile: string;
  claudeDir: string;
  claudeSettings: string;
  claudeProjects: string;
  launchAgentsDir: string;
  launchAgentPlist: string;
}

export const LAUNCH_AGENT_LABEL = "dev.claudette.service";

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const h = homedir();
  const mac = process.platform === "darwin";
  const home = env.CLAUDETTE_HOME
    ? resolve(env.CLAUDETTE_HOME)
    : mac
      ? join(h, "Library", "Application Support", "Claudette")
      : join(env.XDG_CONFIG_HOME ?? join(h, ".config"), "claudette");
  const logDir = env.CLAUDETTE_LOG_DIR
    ? resolve(env.CLAUDETTE_LOG_DIR)
    : env.CLAUDETTE_HOME
      ? join(home, "logs")
      : mac
        ? join(h, "Library", "Logs", "Claudette")
        : join(home, "logs");
  const claudeDir = resolve(env.CLAUDETTE_CLAUDE_DIR ?? env.CLAUDE_CONFIG_DIR ?? join(h, ".claude"));
  const launchAgentsDir = env.CLAUDETTE_LAUNCH_AGENTS_DIR
    ? resolve(env.CLAUDETTE_LAUNCH_AGENTS_DIR)
    : join(h, "Library", "LaunchAgents");
  return {
    home,
    configFile: join(home, "config.json"),
    preferencesFile: join(home, "preferences.json"),
    devicesFile: join(home, "devices.json"),
    logDir,
    logFile: join(logDir, "service.log"),
    claudeDir,
    claudeSettings: join(claudeDir, "settings.json"),
    claudeProjects: join(claudeDir, "projects"),
    launchAgentsDir,
    launchAgentPlist: join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`),
  };
}

const here = fileURLToPath(new URL(".", import.meta.url));

/** apps/service (works from both src/ under tsx and dist/ when built). */
export const serviceRoot = resolve(here, "..");
/** Absolute path to the CLI entry point the LaunchAgent / status line should run. */
export const cliEntry = join(serviceRoot, "dist", "cli.js");

/** First directory that has an index.html: an override, the npm package layout, then the repo layout. */
function firstSite(override: string | undefined, packaged: string, repo: string): string | null {
  const candidates = override ? [resolve(override)] : [join(serviceRoot, packaged), resolve(serviceRoot, "..", repo, "dist")];
  return candidates.find((d) => existsSync(join(d, "index.html"))) ?? null;
}

export function webDistDir(env: NodeJS.ProcessEnv = process.env): string | null {
  return firstSite(env.CLAUDETTE_WEB_DIR, "web", "web");
}

export function simulatorDistDir(env: NodeJS.ProcessEnv = process.env): string | null {
  return firstSite(env.CLAUDETTE_SIM_DIR, "sim", "simulator");
}
