import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopAdvertiser } from "../src/mdns.js";
import { silentLogger } from "../src/log.js";
import { startService, type RunningService, type StartOptions } from "../src/service.js";

export function tempDir(prefix = "claudette-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: any;
  text: string;
}

export function http(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; raw?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    if (payload !== undefined) headers["Content-Length"] = String(Buffer.byteLength(payload));
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export const json = { "Content-Type": "application/json" };
export const admin = { "Content-Type": "application/json", "X-Claudette-Admin": "1" };

export interface TestService {
  svc: RunningService;
  home: string;
  claudeDir: string;
  port: number;
  /** Simulated client address for the next requests (default loopback). */
  setRemote(addr: string): void;
  close(): Promise<void>;
}

export async function startTestService(opts: Partial<StartOptions> & { claudeDir?: string } = {}): Promise<TestService> {
  const t = tempDir();
  const claudeDir = opts.claudeDir ?? join(t.dir, "claude");
  let remote = "127.0.0.1";
  const env = {
    ...process.env,
    CLAUDETTE_HOME: join(t.dir, "home"),
    CLAUDETTE_CLAUDE_DIR: claudeDir,
    CLAUDETTE_LAUNCH_AGENTS_DIR: join(t.dir, "LaunchAgents"),
    CLAUDETTE_NO_MDNS: "1",
  };
  const svc = await startService({
    env,
    port: 0,
    bindHost: "127.0.0.1",
    log: silentLogger,
    advertiser: new NoopAdvertiser(),
    webDir: null,
    simDir: null,
    fetchAgents: async () => [],
    clientAddress: () => remote,
    ...opts,
  });
  return {
    svc,
    home: env.CLAUDETTE_HOME,
    claudeDir,
    port: svc.port,
    setRemote: (a) => (remote = a),
    async close() {
      await svc.stop();
      t.cleanup();
    },
  };
}

export async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not met in time");
}
