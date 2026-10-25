import type { Snapshot } from "@claudette/protocol";

export type { Snapshot };
export type Session = Snapshot["sessions"][number];

export interface Preferences {
  pinOrder: string[];
  aliases: Record<string, string>;
}

export interface PairingRequest {
  id: string;
  deviceName: string;
  firmwareVersion: string;
  createdAt: string;
  expiresAt: string;
  ageSec: number;
}

export interface Device {
  id: string;
  name: string;
  firmwareVersion: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastSeenIp: string | null;
}

export interface Check {
  id: string;
  label: string;
  ok: boolean | null;
  detail: string;
  fix?: string;
}

export interface Doctor {
  checks: Check[];
  info: {
    version: string;
    mode: "real" | "mock";
    port: number;
    hostName: string;
    hooksInstalled: boolean;
    statusLine: string;
    devices: number;
    pendingPairings: number;
    simulatorAvailable: boolean;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (method !== "GET") {
    // Both headers force a CORS preflight the service never approves, so
    // other websites can't drive these endpoints from your browser.
    init.headers = { "Content-Type": "application/json", "X-Claudette-Admin": "1" };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, init);
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  status: () => call<Snapshot>("GET", "/admin/api/status"),
  preferences: () => call<Preferences>("GET", "/admin/api/preferences"),
  patchPreferences: (patch: {
    pins?: Array<{ sessionId: string; pinned: boolean }>;
    pinOrder?: string[];
    aliases?: Record<string, string | null>;
  }) => call<Preferences>("PATCH", "/admin/api/preferences", patch),
  pairing: () => call<{ requests: PairingRequest[] }>("GET", "/admin/api/pairing"),
  approve: (id: string, code: string) => call<{ status: string }>("POST", `/admin/api/pairing/${encodeURIComponent(id)}/approve`, { code }),
  deny: (id: string) => call<{ status: string }>("POST", `/admin/api/pairing/${encodeURIComponent(id)}/deny`, {}),
  devices: () => call<{ devices: Device[] }>("GET", "/admin/api/devices"),
  revoke: (id: string) => call<{ revoked: boolean }>("DELETE", `/admin/api/devices/${encodeURIComponent(id)}`, {}),
  doctor: () => call<Doctor>("GET", "/admin/api/doctor"),
};
