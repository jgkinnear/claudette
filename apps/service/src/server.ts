import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import { PreferencesPatch, SCHEMA_VERSION, Snapshot, type Health } from "@claudette/protocol";
import { sanitizeText, truncateChars } from "./agents.js";
import type { DataSource } from "./collector.js";
import type { Logger } from "./log.js";
import { pickStatusLine } from "./limits.js";
import { applyPreferences, deviceView } from "./snapshot.js";
import { DeviceRegistry, PairingManager, RateLimiter, safeEqual } from "./security.js";
import type { Preferences } from "./store.js";
import type { HookEventName } from "./subagents.js";

export interface PreferencesProvider {
  get(): Preferences;
  save(): void;
}

export interface ServerDeps {
  source: DataSource;
  prefs: PreferencesProvider;
  devices: DeviceRegistry;
  pairing: PairingManager;
  log: Logger;
  version: string;
  host: () => { id: string; name: string };
  hookSecret: () => string;
  /** Port used for the Host-header (DNS rebinding) check. Set after listen. */
  port: () => number;
  doctor: () => Promise<unknown> | unknown;
  webDir: string | null;
  simDir: string | null;
  /** Tests only: override how the client address is determined. */
  clientAddress?: (req: IncomingMessage) => string;
  now?: () => number;
}

const LIMITS = { device: 8 * 1024, admin: 64 * 1024, hook: 1024 * 1024 };
const HOOK_EVENTS = new Set<HookEventName>(["SubagentStart", "SubagentStop", "Stop", "SessionEnd"]);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
    "Content-Length": String(Buffer.byteLength(data)),
    ...headers,
  });
  res.end(data);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > limit) {
      reject(new HttpError(413, "request too large"));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, "request too large"));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolveBody(Buffer.concat(chunks));
      }
    });
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

/** Read up to `cap` bytes, draining (and discarding) the rest. */
function readCapped(req: IncomingMessage, cap: number): Promise<{ buf: Buffer; truncated: boolean }> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    req.on("data", (c: Buffer) => {
      if (truncated) return;
      if (size + c.length > cap) {
        chunks.push(c.subarray(0, cap - size));
        size = cap;
        truncated = true;
        return;
      }
      chunks.push(c);
      size += c.length;
    });
    req.on("end", () => resolveBody({ buf: Buffer.concat(chunks), truncated }));
    req.on("error", reject);
  });
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const ct = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!/^application\/json\s*(;|$)/.test(ct)) throw new HttpError(415, "expected application/json");
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(addr);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".data": "application/octet-stream",
};

const UI_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function serveStatic(res: ServerResponse, root: string, urlPath: string, spaFallback: boolean, csp: string | null): boolean {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  if (rel.includes("\0")) return false;
  const rootAbs = resolve(root);
  let file = resolve(rootAbs, "." + normalize("/" + rel));
  if (file !== rootAbs && !file.startsWith(rootAbs + sep)) return false;
  let st;
  try {
    st = statSync(file);
    if (st.isDirectory()) {
      file = join(file, "index.html");
      st = statSync(file);
    }
  } catch {
    if (!spaFallback || extname(rel)) return false;
    file = join(rootAbs, "index.html");
    try {
      st = statSync(file);
    } catch {
      return false;
    }
  }
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const immutable = /\/assets\//.test(file);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": String(st.size),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...(csp ? { "Content-Security-Policy": csp } : {}),
  });
  createReadStream(file).pipe(res);
  return true;
}

/** Pull the few whitelisted fields out of a hook body, even an oversized one. */
export function pickHookFields(raw: Buffer, parsed: unknown): {
  event: string | null;
  sessionId: string | null;
  agentId: string | null;
  agentType: string | null;
} {
  const str = (v: unknown, max = 128) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    return {
      event: str(o.hook_event_name, 40),
      sessionId: str(o.session_id),
      agentId: str(o.agent_id),
      agentType: str(o.agent_type, 64),
    };
  }
  // Oversized/truncated body: scan the head for the top-level keys we need.
  const head = raw.subarray(0, 64 * 1024).toString("utf8");
  const grab = (k: string) => new RegExp(`"${k}"\\s*:\\s*"([^"\\\\]{1,128})"`).exec(head)?.[1] ?? null;
  return { event: grab("hook_event_name"), sessionId: grab("session_id"), agentId: grab("agent_id"), agentType: grab("agent_type") };
}

const AdminPrefsPatch = z.object({
  pins: z.array(z.object({ sessionId: z.string().max(32), pinned: z.boolean() })).max(64).optional(),
  pinOrder: z.array(z.string().max(32)).max(64).optional(),
  aliases: z.record(z.string().max(32), z.string().max(200).nullable()).optional(),
});

export function createHttpServer(deps: ServerDeps): Server {
  const now = deps.now ?? Date.now;
  const pairLimiter = new RateLimiter(10, 60_000, now);
  const pairPollLimiter = new RateLimiter(40, 60_000, now);
  const authFailLimiter = new RateLimiter(30, 60_000, now);
  let snapshotWarned = false;

  const clientAddr = (req: IncomingMessage) => deps.clientAddress?.(req) ?? req.socket.remoteAddress ?? "";

  function fullSnapshot(): Snapshot {
    const snap = applyPreferences(deps.source.snapshot(), deps.prefs.get());
    if (!snapshotWarned) {
      const r = Snapshot.safeParse(snap);
      if (!r.success) {
        snapshotWarned = true;
        deps.log.error("snapshot failed schema validation", { issues: r.error.issues.slice(0, 3).map((i) => i.path.join(".")) });
      }
    }
    return snap;
  }

  function hostAllowed(req: IncomingMessage): boolean {
    const host = String(req.headers.host ?? "").toLowerCase();
    const p = deps.port();
    return host === `localhost:${p}` || host === `127.0.0.1:${p}` || host === `[::1]:${p}`;
  }

  function requireLocal(req: IncomingMessage): void {
    if (!isLoopbackAddress(clientAddr(req)) || !hostAllowed(req)) throw new HttpError(403, "local access only");
  }

  function requireDevice(req: IncomingMessage) {
    const auth = String(req.headers.authorization ?? "");
    const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/.exec(auth);
    const ip = clientAddr(req);
    const dev = m ? deps.devices.verify(m[1]!) : null;
    if (!dev) {
      if (!authFailLimiter.allow(ip)) throw new HttpError(429, "slow down");
      throw new HttpError(401, "pairing required");
    }
    deps.devices.touch(dev, ip);
    return dev;
  }

  function knownOrPinned(id: string): boolean {
    return deps.source.knownIds().has(id) || deps.prefs.get().pinOrder.includes(id) || id in deps.prefs.get().aliases;
  }

  function applyPins(pins: Array<{ sessionId: string; pinned: boolean }>): void {
    const p = deps.prefs.get();
    for (const { sessionId, pinned } of pins) {
      const idx = p.pinOrder.indexOf(sessionId);
      if (pinned && idx === -1 && deps.source.knownIds().has(sessionId) && p.pinOrder.length < 64) p.pinOrder.push(sessionId);
      if (!pinned && idx !== -1) p.pinOrder.splice(idx, 1);
    }
  }

  function prefsView() {
    const p = deps.prefs.get();
    return { pinOrder: [...p.pinOrder], aliases: { ...p.aliases } };
  }

  async function handleDevice(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    if (path === "/api/v1/health" && method === "GET") {
      const h = deps.host();
      const body: Health = {
        schemaVersion: SCHEMA_VERSION,
        service: "claudette",
        version: deps.version,
        hostName: h.name,
        ready: deps.source.ready(),
      };
      return send(res, 200, body);
    }
    if (path === "/api/v1/pair/request" && method === "POST") {
      if (!pairLimiter.allow(clientAddr(req))) return send(res, 429, { error: "too many requests" }, { "Retry-After": "60" });
      const body = await readJsonBody(req, LIMITS.device);
      const r = deps.pairing.request(body);
      if (!r.ok) return send(res, r.status, { error: r.error });
      deps.log.info("pairing: new request from a device");
      return send(res, 200, r.value);
    }
    if (path === "/api/v1/pair/complete" && method === "POST") {
      if (!pairPollLimiter.allow(clientAddr(req))) return send(res, 429, { error: "too many requests" }, { "Retry-After": "10" });
      const body = await readJsonBody(req, LIMITS.device);
      const r = deps.pairing.complete(body);
      if (!r.ok) return send(res, r.status, { error: r.error });
      if (r.value.status === "approved") deps.log.info("pairing: device paired");
      return send(res, 200, r.value);
    }
    if (path === "/api/v1/status" && method === "GET") {
      requireDevice(req);
      const snap = fullSnapshot();
      return send(res, 200, url.searchParams.get("view") === "device" ? deviceView(snap) : snap);
    }
    if (path === "/api/v1/sessions" && method === "GET") {
      requireDevice(req);
      const snap = fullSnapshot();
      return send(res, 200, { schemaVersion: SCHEMA_VERSION, generatedAt: snap.generatedAt, sessions: snap.sessions });
    }
    if (path === "/api/v1/preferences") {
      requireDevice(req);
      if (method === "GET") return send(res, 200, { pins: deps.prefs.get().pinOrder });
      if (method === "PATCH") {
        const parsed = PreferencesPatch.safeParse(await readJsonBody(req, LIMITS.device));
        if (!parsed.success) throw new HttpError(400, "invalid preferences");
        if (parsed.data.pins) applyPins(parsed.data.pins);
        deps.prefs.save();
        return send(res, 200, { pins: deps.prefs.get().pinOrder });
      }
      throw new HttpError(405, "method not allowed");
    }
    throw new HttpError(404, "not found");
  }

  async function handleAdmin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    requireLocal(req);
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      if (req.headers["x-claudette-admin"] !== "1") throw new HttpError(403, "missing admin header");
      const ct = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!/^application\/json\s*(;|$)/.test(ct)) throw new HttpError(403, "expected application/json");
    }
    const readAdmin = () => readJsonBody(req, LIMITS.admin);

    if (path === "/admin/api/status" && method === "GET") return send(res, 200, fullSnapshot());
    if (path === "/admin/api/preferences") {
      if (method === "GET") return send(res, 200, prefsView());
      if (method === "PATCH") {
        const parsed = AdminPrefsPatch.safeParse(await readAdmin());
        if (!parsed.success) throw new HttpError(400, "invalid preferences");
        const p = deps.prefs.get();
        if (parsed.data.pins) applyPins(parsed.data.pins);
        if (parsed.data.pinOrder) {
          const wanted = [...new Set(parsed.data.pinOrder)].filter((id) => p.pinOrder.includes(id));
          const rest = p.pinOrder.filter((id) => !wanted.includes(id));
          p.pinOrder = [...wanted, ...rest];
        }
        if (parsed.data.aliases) {
          for (const [id, alias] of Object.entries(parsed.data.aliases)) {
            if (!knownOrPinned(id)) continue;
            const clean = alias === null ? "" : truncateChars(sanitizeText(alias), 64);
            if (clean) p.aliases[id] = clean;
            else delete p.aliases[id];
          }
        }
        deps.prefs.save();
        return send(res, 200, prefsView());
      }
      throw new HttpError(405, "method not allowed");
    }
    if (path === "/admin/api/pairing" && method === "GET") return send(res, 200, { requests: deps.pairing.list() });
    let m = /^\/admin\/api\/pairing\/([A-Za-z0-9_-]{1,64})\/(approve|deny)$/.exec(path);
    if (m && method === "POST") {
      const body = (await readAdmin()) as { code?: unknown };
      if (m[2] === "deny") {
        if (!deps.pairing.deny(m[1]!)) throw new HttpError(404, "no such pending request");
        return send(res, 200, { status: "denied" });
      }
      const r = deps.pairing.approve(m[1]!, body?.code);
      if (!r.ok) return send(res, r.status, { error: r.error });
      deps.log.info("pairing: approved on this Mac");
      return send(res, 200, r.value);
    }
    if (path === "/admin/api/devices" && method === "GET") {
      return send(res, 200, {
        devices: deps.devices.list().map((d) => ({
          id: d.id,
          name: d.name,
          firmwareVersion: d.firmwareVersion,
          createdAt: d.createdAt,
          lastSeenAt: d.lastSeenAt,
          lastSeenIp: d.lastSeenIp,
        })),
      });
    }
    m = /^\/admin\/api\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (m && method === "DELETE") {
      await readAdmin();
      if (!deps.devices.revoke(m[1]!)) throw new HttpError(404, "no such device");
      deps.log.info("devices: revoked a device");
      return send(res, 200, { revoked: true });
    }
    if (path === "/admin/api/doctor" && method === "GET") return send(res, 200, await deps.doctor());
    throw new HttpError(404, "not found");
  }

  async function handleHook(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!isLoopbackAddress(clientAddr(req))) throw new HttpError(403, "local access only");
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    const secret = req.headers["x-claudette-hook"];
    if (typeof secret !== "string" || !safeEqual(secret, deps.hookSecret())) throw new HttpError(403, "forbidden");
    // Keep at most 1 MB; anything beyond is drained and ignored (we only need a few small fields).
    const { buf: raw, truncated } = await readCapped(req, LIMITS.hook);
    let parsed: unknown = null;
    if (!truncated) {
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        parsed = null;
      }
    }
    if (path === "/hooks/statusline") {
      const p = pickStatusLine(parsed);
      if (p) deps.source.limits.record(p);
      return send(res, 204, undefined);
    }
    const f = pickHookFields(raw, parsed);
    if (f.event && f.sessionId && HOOK_EVENTS.has(f.event as HookEventName)) {
      deps.source.onHook({
        event: f.event as HookEventName,
        sessionId: f.sessionId,
        agentId: f.agentId,
        agentType: f.agentType,
        at: now(),
      });
    }
    return send(res, 204, undefined);
  }

  const server = createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return send(res, 400, { error: "bad request" });
    }
    const path = url.pathname;
    try {
      if (req.method === "OPTIONS") throw new HttpError(405, "method not allowed"); // never approve CORS preflight
      if (path.startsWith("/api/v1/")) return await handleDevice(req, res, path, url);
      if (path.startsWith("/admin/")) return await handleAdmin(req, res, path);
      if (path === "/hooks/claude" || path === "/hooks/statusline") return await handleHook(req, res, path);
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
      requireLocal(req);
      if (path === "/sim" || path.startsWith("/sim/")) {
        if (path === "/sim") return send(res, 302, undefined, { Location: "/sim/" });
        if (deps.simDir && serveStatic(res, deps.simDir, path.slice(4) || "/", false, null)) return;
        throw new HttpError(404, "simulator not built");
      }
      if (deps.webDir && serveStatic(res, deps.webDir, path, true, UI_CSP)) return;
      if (path === "/") {
        res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Claudette service is running. The web UI isn't built yet: pnpm --filter @claudette/web build\n");
      }
      throw new HttpError(404, "not found");
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) send(res, err.status, { error: err.message });
        return;
      }
      deps.log.error(`http: ${req.method} ${path} failed: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
