import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { atomicWrite } from "./fsutil.js";
import { LAUNCH_AGENT_LABEL, type Paths } from "./paths.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;

export const realExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function plistXml(opts: {
  nodePath: string;
  cliPath: string;
  logDir: string;
  env: Record<string, string>;
}): string {
  const envEntries = Object.entries(opts.env)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.nodePath)}</string>
    <string>${xml(opts.cliPath)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>StandardOutPath</key>
  <string>${xml(opts.logDir)}/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${xml(opts.logDir)}/launchd.err.log</string>
</dict>
</plist>
`;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function installLaunchAgent(
  paths: Paths,
  opts: { nodePath: string; cliPath: string; env: Record<string, string> },
  exec: Exec,
): Promise<{ ok: boolean; detail: string }> {
  mkdirSync(paths.launchAgentsDir, { recursive: true });
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  atomicWrite(paths.launchAgentPlist, plistXml({ ...opts, logDir: paths.logDir }), 0o644);
  await exec("/bin/launchctl", ["bootout", `${domain()}/${LAUNCH_AGENT_LABEL}`]); // ignore "not loaded"
  // bootout returns before the old job has fully gone; bootstrapping too soon fails with
  // "Bootstrap failed: 5: Input/output error". Wait for it to disappear, then retry a few times.
  for (let i = 0; i < 20 && (await launchAgentLoaded(exec)); i++) await sleep(150);
  let r: ExecResult = { code: 1, stdout: "", stderr: "" };
  for (let attempt = 0; attempt < 4; attempt++) {
    r = await exec("/bin/launchctl", ["bootstrap", domain(), paths.launchAgentPlist]);
    if (r.code === 0) return { ok: true, detail: "loaded" };
    await sleep(500);
  }
  return { ok: false, detail: (r.stderr || r.stdout).trim() || `launchctl exited ${r.code}` };
}

export async function uninstallLaunchAgent(paths: Paths, exec: Exec): Promise<boolean> {
  await exec("/bin/launchctl", ["bootout", `${domain()}/${LAUNCH_AGENT_LABEL}`]);
  if (existsSync(paths.launchAgentPlist)) {
    unlinkSync(paths.launchAgentPlist);
    return true;
  }
  return false;
}

export async function restartLaunchAgent(exec: Exec): Promise<ExecResult> {
  return exec("/bin/launchctl", ["kickstart", "-k", `${domain()}/${LAUNCH_AGENT_LABEL}`]);
}

export async function launchAgentLoaded(exec: Exec): Promise<boolean> {
  const r = await exec("/bin/launchctl", ["print", `${domain()}/${LAUNCH_AGENT_LABEL}`]);
  return r.code === 0;
}
