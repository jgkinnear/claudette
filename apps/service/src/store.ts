import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { atomicWriteJson, ensurePrivateDir, readJson } from "./fsutil.js";
import type { Paths } from "./paths.js";

export const DEFAULT_PORT = 3333;

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  hostId: z.string().min(1).max(32),
  hostName: z.string().min(1).max(40),
  claudePath: z.string().nullable().default(null),
  hookSecret: z.string().min(32),
  /** Salt for opaque session ids, so ids are stable per host but unguessable. */
  idSalt: z.string().min(16),
  hooksInstalled: z.boolean().default(false),
  statusLineInstalled: z.boolean().default(false),
  /** The exact statusLine command we installed (so uninstall only removes ours). */
  statusLineCommand: z.string().nullable().default(null),
  launchAgentInstalled: z.boolean().default(false),
});
export type Config = z.infer<typeof ConfigSchema>;

/** What we remember about a pinned session, so it stays listed after Claude stops its process. Local only. */
export const RememberedSessionSchema = z.object({
  name: z.string().max(256),
  kind: z.enum(["interactive", "background", "unknown"]),
  claudeSessionId: z.string().max(64).nullable(),
  startedAtMs: z.number().nullable(),
});
export type RememberedSession = z.infer<typeof RememberedSessionSchema>;

export const PreferencesSchema = z.object({
  /** Pinned session ids in display order. */
  pinOrder: z.array(z.string().max(32)).max(64).default([]),
  aliases: z.record(z.string().max(32), z.string().max(64)).default({}),
  /** Last known details of pinned sessions (keyed by opaque id). Never sent to devices. */
  remembered: z.record(z.string().max(32), RememberedSessionSchema).default({}),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const DeviceSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  name: z.string().max(32),
  firmwareVersion: z.string().max(24).default(""),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable().default(null),
  lastSeenIp: z.string().nullable().default(null),
});
export type Device = z.infer<typeof DeviceSchema>;
const DevicesFile = z.object({ devices: z.array(DeviceSchema).default([]) });

export function defaultHostName(): string {
  let name = "";
  if (process.platform === "darwin") {
    try {
      name = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
    } catch {
      /* fall through */
    }
  }
  if (!name) name = hostname().replace(/\.local$/, "");
  return clip(name || "My computer", 40);
}

function clip(s: string, max: number): string {
  const chars = Array.from(s.replace(/[\u0000-\u001f\u007f]/g, ""));
  let out = "";
  for (const c of chars) {
    if (out.length + c.length > max) break;
    out += c;
  }
  return out;
}

/**
 * Small JSON-file state store. Directory is 0700, files 0600, writes atomic.
 */
export class Store {
  config!: Config;
  preferences!: Preferences;
  devices: Device[] = [];

  constructor(readonly paths: Paths) {}

  load(overrides: Partial<Config> = {}): this {
    ensurePrivateDir(this.paths.home);
    const raw = readJson<Record<string, unknown>>(this.paths.configFile) ?? {};
    const merged = {
      hostId: `h-${randomBytes(6).toString("hex")}`,
      hostName: defaultHostName(),
      hookSecret: randomBytes(32).toString("hex"),
      idSalt: randomBytes(16).toString("hex"),
      ...raw,
    };
    this.config = ConfigSchema.parse(merged);
    let changed = JSON.stringify(raw) !== JSON.stringify(this.config);
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined && (this.config as Record<string, unknown>)[k] !== v) {
        (this.config as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    if (changed) this.saveConfig();
    this.preferences = PreferencesSchema.parse(readJson(this.paths.preferencesFile) ?? {});
    this.devices = DevicesFile.parse(readJson(this.paths.devicesFile) ?? {}).devices;
    return this;
  }

  saveConfig(): void {
    atomicWriteJson(this.paths.configFile, this.config);
  }
  savePreferences(): void {
    atomicWriteJson(this.paths.preferencesFile, this.preferences);
  }
  saveDevices(): void {
    atomicWriteJson(this.paths.devicesFile, { devices: this.devices });
  }
}
