import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an absolute path to the `claude` CLI without a shell. The LaunchAgent
 * runs with a minimal PATH, so setup stores this absolute path in config.
 */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDETTE_CLAUDE_BIN) {
    return isAbsolute(env.CLAUDETTE_CLAUDE_BIN) && isExecutable(env.CLAUDETTE_CLAUDE_BIN) ? env.CLAUDETTE_CLAUDE_BIN : null;
  }
  const h = homedir();
  const dirs = [
    ...(env.PATH ?? "").split(delimiter).filter((d) => d && isAbsolute(d)),
    join(h, ".local", "bin"),
    join(h, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(h, ".npm-global", "bin"),
    join(h, ".bun", "bin"),
  ];
  for (const d of dirs) {
    const p = join(d, "claude");
    if (isExecutable(p)) return p;
  }
  return null;
}

export function claudeVersion(claudePath: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(claudePath, ["--version"], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      const v = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
      resolve(v ?? (stdout.trim().slice(0, 40) || null));
    });
  });
}

/** Compare dotted versions: negative if a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
