import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Collector, type DataSource } from "./collector.js";
import { findClaude } from "./claudeCli.js";
import { hooksState, readSettings, statusLineState } from "./claudeSettings.js";
import { staticChecks, type DoctorReport } from "./doctor.js";
import { createLogger, type Logger } from "./log.js";
import { createAdvertiser, type Advertiser } from "./mdns.js";
import { MockSource } from "./mock.js";
import { resolvePaths, simulatorDistDir, webDistDir, type Paths } from "./paths.js";
import { DeviceRegistry, PairingManager } from "./security.js";
import { createHttpServer, type PreferencesProvider } from "./server.js";
import { Store, type Preferences } from "./store.js";
import type { RawAgent } from "./agents.js";
import { VERSION } from "./version.js";

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  /** Runtime port override (not persisted). 0 = ephemeral. */
  port?: number;
  /** Interface to bind; default all interfaces so the device can reach us. */
  bindHost?: string;
  /** Serve a synthetic scenario instead of real Claude data. */
  mock?: string | null;
  noMdns?: boolean;
  log?: Logger;
  advertiser?: Advertiser;
  fetchAgents?: () => Promise<RawAgent[]>;
  intervalMs?: number;
  clientAddress?: (req: IncomingMessage) => string;
  webDir?: string | null;
  simDir?: string | null;
  now?: () => number;
}

export interface RunningService {
  port: number;
  server: Server;
  store: Store;
  paths: Paths;
  source: DataSource;
  devices: DeviceRegistry;
  pairing: PairingManager;
  advertiser: Advertiser;
  stop(): Promise<void>;
}

export async function startService(opts: StartOptions = {}): Promise<RunningService> {
  const env = opts.env ?? process.env;
  const paths = resolvePaths(env);
  const store = new Store(paths).load();
  const log = opts.log ?? createLogger({ file: paths.logFile, console: Boolean(process.stdout.isTTY) || env.CLAUDETTE_LOG_CONSOLE === "1" });
  const now = opts.now ?? Date.now;
  let port = opts.port ?? (Number(env.CLAUDETTE_PORT) || store.config.port);

  // Hooks state, re-read from Claude's settings every 30 s (read-only).
  let hooksCache = { at: 0, installed: false, statusLine: "none" as "none" | "ours" | "other" };
  const hooksInfo = () => {
    if (now() - hooksCache.at > 30_000) {
      try {
        const s = readSettings(paths.claudeSettings).data;
        hooksCache = {
          at: now(),
          installed: hooksState(s, port).installed,
          statusLine: statusLineState(s, store.config.statusLineCommand),
        };
      } catch {
        hooksCache = { at: now(), installed: false, statusLine: "none" };
      }
    }
    return hooksCache;
  };

  let prefs: PreferencesProvider;
  let source: DataSource;
  if (opts.mock) {
    const mock = new MockSource(opts.mock, { id: store.config.hostId, displayName: store.config.hostName });
    const mem: Preferences = mock.seedPreferences();
    prefs = { get: () => mem, save: () => {} };
    source = mock;
  } else {
    prefs = { get: () => store.preferences, save: () => store.savePreferences() };
    const claudePath = store.config.claudePath ?? findClaude(env);
    source = new Collector({
      claudePath,
      projectsDir: paths.claudeProjects,
      host: { id: store.config.hostId, displayName: store.config.hostName },
      salt: store.config.idSalt,
      hooksInstalled: () => hooksInfo().installed,
      isPinned: (id) => store.preferences.pinOrder.includes(id),
      pins: {
        ids: () => store.preferences.pinOrder,
        remembered: () => Object.keys(store.preferences.remembered),
        get: (id) => store.preferences.remembered[id],
        remember: (id, session) => {
          store.preferences.remembered[id] = session;
          store.savePreferences();
        },
        forget: (id) => {
          delete store.preferences.remembered[id];
          store.savePreferences();
        },
      },
      log,
      now,
      ...(opts.intervalMs ? { intervalMs: opts.intervalMs } : {}),
      ...(opts.fetchAgents ? { fetchAgents: opts.fetchAgents } : {}),
    });
  }

  const devices = new DeviceRegistry(store, now);
  const host = () => ({ id: store.config.hostId, name: store.config.hostName });
  const pairing = new PairingManager(devices, host, now);
  const advertiser = opts.advertiser ?? createAdvertiser(log, Boolean(opts.noMdns || env.CLAUDETTE_NO_MDNS === "1"));

  let staticCache: { at: number; checks: Awaited<ReturnType<typeof staticChecks>> } | null = null;
  const doctor = async (): Promise<DoctorReport> => {
    if (!staticCache || now() - staticCache.at > 60_000) {
      staticCache = { at: now(), checks: await staticChecks(paths, store.config, { port }) };
    }
    const diag = source.diagnostics();
    const checks = [...staticCache.checks];
    if (source.mode === "real") {
      const lastError = diag.lastError as { message: string } | null;
      checks.unshift({
        id: "collector",
        label: "Reading Claude sessions",
        ok: lastError ? false : source.ready() ? true : null,
        detail: lastError ? lastError.message : source.ready() ? `ok (last poll ${diag.lastOkAt ?? "never"})` : "starting…",
      });
    } else {
      checks.unshift({ id: "collector", label: "Data source", ok: null, detail: `demo mode: ${String(diag.title ?? diag.scenario)}` });
    }
    const m = advertiser.status();
    checks.push({
      id: "mdns",
      label: "Discovery (mDNS)",
      ok: m.state === "advertising" ? true : m.state === "error" ? false : null,
      detail: m.detail,
      ...(m.state === "advertising" ? {} : { fix: "Devices can still connect by entering this Mac's address manually." }),
    });
    return {
      checks,
      info: {
        version: VERSION,
        mode: source.mode,
        port,
        hostName: store.config.hostName,
        hooksInstalled: hooksInfo().installed,
        statusLine: hooksInfo().statusLine,
        devices: devices.list().length,
        pendingPairings: pairing.list().length,
        simulatorAvailable: Boolean(simDir),
        diagnostics: diag,
      },
    };
  };

  const webDir = opts.webDir !== undefined ? opts.webDir : webDistDir(env);
  const simDir = opts.simDir !== undefined ? opts.simDir : simulatorDistDir(env);
  const server = createHttpServer({
    source,
    prefs,
    devices,
    pairing,
    log,
    version: VERSION,
    host,
    hookSecret: () => store.config.hookSecret,
    port: () => port,
    doctor,
    webDir,
    simDir,
    now,
    ...(opts.clientAddress ? { clientAddress: opts.clientAddress } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Port ${port} is already in use. Is Claudette already running? Try \`claudette status\` or --port.`)
          : err,
      );
    };
    server.once("error", onError);
    server.listen({ port, ...(opts.bindHost ? { host: opts.bindHost } : {}) }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  source.start();
  advertiser.start({ name: store.config.hostName, port, version: VERSION, hostId: store.config.hostId });
  log.info(`claudette ${VERSION} listening on port ${port} (${source.mode} data)`);

  let stopped = false;
  return {
    port,
    server,
    store,
    paths,
    source,
    devices,
    pairing,
    advertiser,
    async stop() {
      if (stopped) return;
      stopped = true;
      source.stop();
      advertiser.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
