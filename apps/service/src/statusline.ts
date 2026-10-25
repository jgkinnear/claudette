import { readFileSync } from "node:fs";
import { request } from "node:http";
import { resolvePaths } from "./paths.js";
import { pickStatusLine } from "./limits.js";

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    const t = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) {
        clearTimeout(t);
        resolve(data);
      }
    });
    process.stdin.on("end", () => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

function post(port: number, secret: string, body: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/hooks/statusline",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Claudette-Hook": secret,
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      resolve();
    }, timeoutMs);
    req.on("error", () => resolve());
    req.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    req.end(body);
  });
}

/**
 * `claudette statusline`: Claude Code pipes its status JSON on stdin. We
 * forward only session id, context % and rate limits to the local service
 * (fire-and-forget, ≤300 ms) and print a short friendly line.
 */
export async function runStatusLine(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const raw = await readStdin(500);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  const p = pickStatusLine(parsed);
  if (p) {
    try {
      const cfg = JSON.parse(readFileSync(resolvePaths(env).configFile, "utf8")) as { port?: number; hookSecret?: string };
      const port = Number(env.CLAUDETTE_PORT) || cfg.port;
      if (cfg.hookSecret && port) {
        const o = parsed as Record<string, unknown>;
        const body = JSON.stringify({
          session_id: p.sessionId,
          context_window: { used_percentage: p.contextPercent },
          ...(o.rate_limits && typeof o.rate_limits === "object" ? { rate_limits: o.rate_limits } : {}),
        });
        await post(port, cfg.hookSecret, body, 300);
      }
    } catch {
      /* never break the user's prompt */
    }
  }
  return formatStatusLine(p);
}

export function formatStatusLine(p: ReturnType<typeof pickStatusLine>): string {
  const parts = ["✿"];
  if (p?.contextPercent !== null && p?.contextPercent !== undefined) parts.push(`ctx ${Math.round(p.contextPercent)}%`);
  else parts.push("claudette");
  if (p?.fiveHour) parts.push(`· 5h ${Math.round(p.fiveHour.usedPercent)}%`);
  return parts.join(" ");
}
