import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { PairComplete, PairRequest, type PairCompleteResponse, type PairRequestResponse } from "@claudette/protocol";
import type { Device, Store } from "./store.js";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Constant-time comparison of two strings (by their SHA-256, so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

function safeEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ devices

export class DeviceRegistry {
  private lastPersist = new Map<string, number>();

  constructor(
    private store: Store,
    private now: () => number = Date.now,
  ) {}

  list(): Device[] {
    return this.store.devices;
  }

  /** Create (or replace) a device credential. The token is returned exactly once. */
  issue(deviceId: string, name: string, firmwareVersion: string): { device: Device; token: string } {
    const token = randomBytes(32).toString("base64url");
    const device: Device = {
      id: `d-${randomBytes(6).toString("hex")}`,
      deviceId,
      name,
      firmwareVersion,
      tokenHash: sha256Hex(token),
      createdAt: new Date(this.now()).toISOString(),
      lastSeenAt: null,
      lastSeenIp: null,
    };
    this.store.devices = [...this.store.devices.filter((d) => d.deviceId !== deviceId), device];
    this.store.saveDevices();
    return { device, token };
  }

  /** Look up a bearer token. Compares SHA-256 digests in constant time. */
  verify(token: string | null): Device | null {
    if (!token || token.length > 128) return null;
    const h = sha256Hex(token);
    let found: Device | null = null;
    for (const d of this.store.devices) {
      if (safeEqualHex(h, d.tokenHash)) found = d;
    }
    return found;
  }

  touch(d: Device, ip: string | null): void {
    const now = this.now();
    d.lastSeenAt = new Date(now).toISOString();
    d.lastSeenIp = ip;
    const last = this.lastPersist.get(d.id) ?? 0;
    if (now - last > 60_000) {
      this.lastPersist.set(d.id, now);
      this.store.saveDevices();
    }
  }

  revoke(id: string): boolean {
    const before = this.store.devices.length;
    this.store.devices = this.store.devices.filter((d) => d.id !== id);
    if (this.store.devices.length === before) return false;
    this.store.saveDevices();
    return true;
  }
}

// ------------------------------------------------------------------ pairing

interface Pairing {
  id: string;
  deviceId: string;
  deviceName: string;
  firmwareVersion: string;
  code: string;
  secretHash: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied";
  attempts: number;
}

export const PAIRING_TTL_MS = 5 * 60_000;
export const MAX_PENDING = 5;
const MAX_CODE_ATTEMPTS = 5;

export type PairResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export class PairingManager {
  private pairings = new Map<string, Pairing>();

  constructor(
    private devices: DeviceRegistry,
    private host: () => { id: string; name: string },
    private now: () => number = Date.now,
  ) {}

  private prune(): void {
    const now = this.now();
    for (const [id, p] of this.pairings) if (p.expiresAt <= now) this.pairings.delete(id);
  }

  request(body: unknown): PairResult<PairRequestResponse> {
    const parsed = PairRequest.safeParse(body);
    if (!parsed.success) return { ok: false, status: 400, error: "invalid pairing request" };
    this.prune();
    const r = parsed.data;
    for (const [id, p] of this.pairings) if (p.deviceId === r.deviceId && p.status === "pending") this.pairings.delete(id);
    const pending = [...this.pairings.values()].filter((p) => p.status === "pending").length;
    if (pending >= MAX_PENDING) return { ok: false, status: 429, error: "too many pending pairing requests" };
    const now = this.now();
    const p: Pairing = {
      id: `p-${randomBytes(12).toString("base64url")}`,
      deviceId: r.deviceId,
      deviceName: r.deviceName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 32) || "Claudette",
      firmwareVersion: r.firmwareVersion,
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      secretHash: sha256Hex(r.pairSecret),
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      status: "pending",
      attempts: 0,
    };
    this.pairings.set(p.id, p);
    return { ok: true, value: { pairingId: p.id, code: p.code, expiresAt: new Date(p.expiresAt).toISOString() } };
  }

  complete(body: unknown): PairResult<PairCompleteResponse> {
    const parsed = PairComplete.safeParse(body);
    if (!parsed.success) return { ok: false, status: 400, error: "invalid request" };
    const p = this.pairings.get(parsed.data.pairingId);
    if (!p || p.expiresAt <= this.now()) {
      if (p) this.pairings.delete(p.id);
      return { ok: true, value: { status: "expired" } };
    }
    if (!safeEqualHex(sha256Hex(parsed.data.pairSecret), p.secretHash)) {
      return { ok: false, status: 403, error: "pairing secret mismatch" };
    }
    if (p.status === "pending") return { ok: true, value: { status: "pending" } };
    this.pairings.delete(p.id); // one-shot: a replay sees "expired"
    if (p.status === "denied") return { ok: true, value: { status: "denied" } };
    const { token } = this.devices.issue(p.deviceId, p.deviceName, p.firmwareVersion);
    const host = this.host();
    return { ok: true, value: { status: "approved", token, hostId: host.id, hostName: host.name } };
  }

  approve(id: string, code: unknown): PairResult<{ status: "approved" }> {
    this.prune();
    const p = this.pairings.get(id);
    if (!p) return { ok: false, status: 404, error: "That pairing request has expired. Ask the device for a new code." };
    if (p.status !== "pending") return { ok: false, status: 409, error: `already ${p.status}` };
    if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
      return { ok: false, status: 400, error: "Enter the 6-digit code shown on the device." };
    }
    if (!safeEqual(code.trim(), p.code)) {
      p.attempts++;
      if (p.attempts >= MAX_CODE_ATTEMPTS) {
        p.status = "denied";
        return { ok: false, status: 400, error: "Too many wrong codes. This request was denied; start pairing again." };
      }
      return { ok: false, status: 400, error: "That code doesn't match. Check the device screen." };
    }
    p.status = "approved";
    p.expiresAt = this.now() + PAIRING_TTL_MS;
    return { ok: true, value: { status: "approved" } };
  }

  deny(id: string): boolean {
    const p = this.pairings.get(id);
    if (!p || p.status !== "pending") return false;
    p.status = "denied";
    return true;
  }

  /** Pending requests for the admin UI. Never includes the code or secret. */
  list(): Array<{ id: string; deviceName: string; firmwareVersion: string; createdAt: string; expiresAt: string; ageSec: number; status: string }> {
    this.prune();
    const now = this.now();
    return [...this.pairings.values()]
      .filter((p) => p.status === "pending")
      .map((p) => ({
        id: p.id,
        deviceName: p.deviceName,
        firmwareVersion: p.firmwareVersion,
        createdAt: new Date(p.createdAt).toISOString(),
        expiresAt: new Date(p.expiresAt).toISOString(),
        ageSec: Math.round((now - p.createdAt) / 1000),
        status: p.status,
      }));
  }
}

// ------------------------------------------------------------------ rate limiting

/** Fixed-window per-key limiter. */
export class RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      if (this.hits.size > 10_000) this.cleanup();
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }

  private cleanup(): void {
    const now = this.now();
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
  }
}
