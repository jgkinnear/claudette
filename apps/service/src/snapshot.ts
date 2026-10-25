import {
  compareSessions,
  DEVICE_MAX_NAME,
  DEVICE_MAX_SESSIONS,
  SCHEMA_VERSION,
  type Session,
  type Snapshot,
} from "@claudette/protocol";
import { truncateChars, truncateUtf8 } from "./agents.js";
import type { Preferences } from "./store.js";

export const MAX_SESSIONS = 64;

export { compareSessions } from "@claudette/protocol";

/** Apply Claudette-only pins and aliases, sort, cap. */
export function applyPreferences(base: Snapshot, prefs: Pick<Preferences, "pinOrder" | "aliases">): Snapshot {
  const order = prefs.pinOrder;
  const sessions = base.sessions.map((s) => {
    const idx = order.indexOf(s.id);
    const alias = prefs.aliases[s.id];
    return {
      ...s,
      pinned: idx !== -1,
      pinOrder: idx === -1 ? null : idx,
      displayName: alias ? truncateChars(alias, 64) : s.displayName,
    };
  });
  // Re-number pin order densely over the pins that are actually present.
  const present = sessions.filter((s) => s.pinned).sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
  present.forEach((s, i) => (s.pinOrder = i));
  sessions.sort(compareSessions);
  return { ...base, sessions: sessions.slice(0, MAX_SESSIONS) };
}

/** Trim a snapshot for the ESP32: bounded list, byte-bounded strings. */
export function deviceView(full: Snapshot): Snapshot {
  const sessions = [...full.sessions].sort(compareSessions).slice(0, DEVICE_MAX_SESSIONS);
  return {
    ...full,
    host: { ...full.host, displayName: truncateUtf8(full.host.displayName, 40) },
    collection: {
      ...full.collection,
      message: full.collection.message === null ? null : truncateUtf8(full.collection.message, 80),
    },
    sessions: sessions.map((s) => ({
      ...s,
      displayName: truncateUtf8(s.displayName, DEVICE_MAX_NAME),
      needsAttentionReason: s.needsAttentionReason === null ? null : truncateUtf8(s.needsAttentionReason, 40),
      subagents: {
        ...s.subagents,
        types: s.subagents.types.slice(0, 4).map((t) => truncateUtf8(t, 24)),
      },
    })),
  };
}

export function emptySnapshot(host: { id: string; displayName: string }, now = new Date()): Snapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    host: { ...host, online: true },
    collection: { status: "degraded", message: "Starting up…", lastSessionPollAt: null, hooksInstalled: false },
    sessions: [],
    dailyUsage: { tokens: null, date: localDate(now), quality: "unavailable" },
    rateLimits: null,
  };
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
