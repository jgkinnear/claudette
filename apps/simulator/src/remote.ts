import type { PairCompleteResponse, PairRequestResponse, Snapshot } from "@claudette/protocol";

/**
 * Talking to a Claudette service from a page it doesn't serve (e.g. the public demo site).
 * The page pairs exactly like a physical display: it asks for a code, you approve the code on
 * your Mac at localhost:3333, and it gets a device token that only reads the dashboard and
 * toggles favourites. The token lives in this browser's storage; unpair it on the Mac any time.
 */

const STORE_KEY = "claudette.remote";

interface Saved {
  service: string;
  token: string;
  deviceId: string;
}

function load(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Partial<Saved>;
  } catch {
    return {};
  }
}

function save(v: Partial<Saved>) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    // storage unavailable: you'll just need to pair again next time
  }
}

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

export class RemoteService {
  private saved: Partial<Saved>;

  constructor(readonly base: string) {
    const s = load();
    // A token only belongs to the service that issued it.
    this.saved = s.service === base ? s : { deviceId: s.deviceId };
    if (!this.saved.deviceId) this.saved.deviceId = `web-${hex(8)}`;
    save({ ...this.saved, service: base });
  }

  get paired(): boolean {
    return Boolean(this.saved.token);
  }

  /** The Mac's name if a Claudette service is answering at `base`, else null. */
  async running(): Promise<string | null> {
    try {
      const r = await fetch(`${this.base}/api/v1/health`, { cache: "no-store" });
      const h = (await r.json()) as { service?: string; hostName?: string };
      return r.ok && h.service === "claudette" ? h.hostName || "your Mac" : null;
    } catch {
      return null;
    }
  }

  /** Start pairing; resolves with the code to approve on the Mac. */
  async requestPairing(): Promise<{ pairingId: string; code: string; secret: string }> {
    const secret = hex(16);
    const r = await fetch(`${this.base}/api/v1/pair/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: this.saved.deviceId,
        deviceName: "Browser demo",
        firmwareVersion: "web",
        pairSecret: secret,
      }),
    });
    if (r.status === 429) throw new Error("Too many pairing attempts. Wait a minute and try again.");
    if (!r.ok) throw new Error(`Pairing request failed (${r.status})`);
    const body = (await r.json()) as PairRequestResponse;
    return { pairingId: body.pairingId, code: body.code, secret };
  }

  /** One poll of the pairing result. Stores the token when approved. */
  async completePairing(pairingId: string, secret: string): Promise<PairCompleteResponse["status"]> {
    const r = await fetch(`${this.base}/api/v1/pair/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingId, pairSecret: secret }),
    });
    if (!r.ok) return r.status === 429 ? "pending" : "expired";
    const body = (await r.json()) as PairCompleteResponse;
    if (body.status === "approved") {
      this.saved.token = body.token;
      save({ ...this.saved, service: this.base });
    }
    return body.status;
  }

  forget() {
    delete this.saved.token;
    save({ ...this.saved, service: this.base });
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.saved.token ?? ""}` };
  }

  /** The dashboard snapshot. Throws "unpaired" if the Mac revoked this browser. */
  async status(): Promise<Snapshot> {
    const r = await fetch(`${this.base}/api/v1/status`, { headers: this.auth(), cache: "no-store" });
    if (r.status === 401) {
      this.forget();
      throw new Error("unpaired");
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as Snapshot;
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    await fetch(`${this.base}/api/v1/preferences`, {
      method: "PATCH",
      headers: { ...this.auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ pins: [{ sessionId, pinned }] }),
    });
  }
}
