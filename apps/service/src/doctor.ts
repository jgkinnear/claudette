import { existsSync, statSync } from "node:fs";
import { claudeVersion, compareVersions, findClaude } from "./claudeCli.js";
import { hooksState, readSettings, statusLineState } from "./claudeSettings.js";
import type { Paths } from "./paths.js";
import type { Config } from "./store.js";

export const MIN_CLAUDE_VERSION = "2.1.0";

export interface Check {
  id: string;
  label: string;
  /** true = fine, false = broken, null = informational / optional */
  ok: boolean | null;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  checks: Check[];
  info: Record<string, unknown>;
}

function mode(p: string): number | null {
  try {
    return statSync(p).mode & 0o777;
  } catch {
    return null;
  }
}

/** Checks that don't need a running service. */
export async function staticChecks(paths: Paths, config: Config, opts: { port?: number } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const port = opts.port ?? config.port;
  checks.push({
    id: "platform",
    label: "Operating system",
    ok: process.platform === "darwin" ? true : null,
    detail: process.platform === "darwin" ? "macOS" : `${process.platform} (launch-at-login and mDNS are macOS-only for now)`,
  });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    id: "node",
    label: "Node.js",
    ok: nodeMajor >= 22,
    detail: `v${process.versions.node}`,
    ...(nodeMajor >= 22 ? {} : { fix: "Install Node.js 22 or newer." }),
  });

  const claudePath = config.claudePath && existsSync(config.claudePath) ? config.claudePath : findClaude();
  const version = claudePath ? await claudeVersion(claudePath) : null;
  checks.push({
    id: "claude",
    label: "Claude Code CLI",
    ok: Boolean(claudePath && version && compareVersions(version, MIN_CLAUDE_VERSION) >= 0),
    detail: claudePath ? (version ? `v${version}` : "found, but `claude --version` failed") : "not found",
    ...(claudePath && version && compareVersions(version, MIN_CLAUDE_VERSION) >= 0
      ? {}
      : { fix: `Install or update Claude Code (needs ${MIN_CLAUDE_VERSION}+), then run \`claudette setup\`.` }),
  });

  let settingsOk = true;
  let hooks = { installed: false, events: [] as string[], ports: [] as number[] };
  let sl: "none" | "ours" | "other" = "none";
  try {
    const s = readSettings(paths.claudeSettings);
    hooks = hooksState(s.data, port);
    sl = statusLineState(s.data, config.statusLineCommand);
  } catch (e) {
    settingsOk = false;
    checks.push({ id: "settings", label: "Claude settings", ok: false, detail: (e as Error).message });
  }
  if (settingsOk) {
    const stalePorts = hooks.ports.filter((p) => p !== port);
    checks.push({
      id: "hooks",
      label: "Subagent hooks",
      ok: hooks.installed,
      detail: hooks.installed
        ? `installed (${hooks.events.join(", ")})`
        : stalePorts.length
          ? `installed for port ${stalePorts.join(", ")}, but the service uses ${port}`
          : "not installed: subagent counts are unavailable",
      ...(hooks.installed ? {} : { fix: "Run `claudette setup` to add them." }),
    });
    checks.push({
      id: "statusline",
      label: "Status line (context % and rate limits)",
      ok: null,
      detail:
        sl === "ours"
          ? "installed (Claudette)"
          : sl === "other"
            ? "you have your own status line, so context % stays unavailable (that's fine)"
            : "not installed (optional)",
    });
  }
  checks.push({
    id: "transcripts",
    label: "Claude transcripts (token counts)",
    ok: existsSync(paths.claudeProjects) ? true : null,
    detail: existsSync(paths.claudeProjects) ? "readable" : "no transcripts yet",
  });
  const dm = mode(paths.home);
  const badFiles = [paths.configFile, paths.preferencesFile, paths.devicesFile].filter((f) => {
    const m = mode(f);
    return m !== null && (m & 0o077) !== 0;
  });
  checks.push({
    id: "permissions",
    label: "Private state folder",
    ok: dm === 0o700 && badFiles.length === 0,
    detail: dm === null ? "missing" : dm === 0o700 && badFiles.length === 0 ? "0700 / 0600" : "permissions too open",
    ...(dm === 0o700 && badFiles.length === 0 ? {} : { fix: `chmod 700 "${paths.home}" && chmod 600 "${paths.home}"/*.json` }),
  });
  if (process.platform === "darwin") {
    const installed = existsSync(paths.launchAgentPlist);
    checks.push({
      id: "launchagent",
      label: "Starts at login",
      ok: installed ? true : null,
      detail: installed ? "LaunchAgent installed" : "not installed (run `claudette setup`)",
    });
  }
  return checks;
}
