import { z } from "zod";

/**
 * Claudette wire protocol, schema version 1.
 *
 * Every client (ESP32 firmware, browser simulator, local web UI) consumes the
 * same snapshot. The C mirror of these types lives in
 * packages/lvgl-ui/include/cl_model.h — keep the two in step and bump
 * SCHEMA_VERSION on any breaking change.
 *
 * Honesty rules (spec §6.4):
 *   - `null` means "unavailable", `0` means "measured zero".
 *   - every metric carries a `quality` so the UI can say how sure it is.
 */
export const SCHEMA_VERSION = 1 as const;

export const SessionState = z.enum([
  "working",
  "needs_attention",
  "ready",
  "failed",
  "stopped",
  "unknown",
]);
export type SessionState = z.infer<typeof SessionState>;

export const Quality = z.enum(["observed", "estimated", "unavailable"]);
export type Quality = z.infer<typeof Quality>;

const IsoTime = z.string().datetime({ offset: true });

export const Subagents = z.object({
  /** Currently running subagents, or null when we can't tell. */
  active: z.number().int().nonnegative().nullable(),
  /** Subagents seen for this session since the service started watching. */
  knownTotal: z.number().int().nonnegative().nullable(),
  /** Agent types of the active subagents (e.g. "Explore"), deduplicated. */
  types: z.array(z.string().max(32)).max(8),
  /** Earliest start time among active subagents. */
  oldestActiveSince: IsoTime.nullable(),
  /** True when the service started after the session, so earlier events may be missing. */
  partial: z.boolean(),
  quality: Quality,
});
export type Subagents = z.infer<typeof Subagents>;

export const Tokens = z.object({
  /**
   * Tokens the session has processed: input + output + cache writes.
   * Cache reads are reported separately because they dwarf everything else
   * and are not "new" work.
   */
  sessionTotal: z.number().int().nonnegative().nullable(),
  cacheRead: z.number().int().nonnegative().nullable(),
  quality: Quality,
  source: z.enum(["transcript-usage", "none"]),
});
export type Tokens = z.infer<typeof Tokens>;

export const Context = z.object({
  /** Current context window occupancy, 0-100 (needs the Claudette status line). Not lifetime tokens. */
  usedPercent: z.number().min(0).max(100).nullable(),
  /**
   * Tokens in the context window right now (from the latest response in the transcript),
   * available without the status line. Optional so older services stay valid.
   */
  tokens: z.number().int().nonnegative().nullable().optional(),
  quality: Quality,
});
export type Context = z.infer<typeof Context>;

export const Session = z.object({
  /** Stable, opaque id. Never a raw Claude session id or path. */
  id: z.string().min(1).max(32),
  displayName: z.string().max(64),
  kind: z.enum(["interactive", "background", "unknown"]),
  pinned: z.boolean(),
  pinOrder: z.number().int().nonnegative().nullable(),
  state: SessionState,
  /** Short human reason when state is needs_attention, e.g. "permission prompt". */
  needsAttentionReason: z.string().max(40).nullable(),
  /** When the session entered its current state (best effort). */
  stateSince: IsoTime.nullable(),
  subagents: Subagents,
  tokens: Tokens,
  context: Context,
  lastActivityAt: IsoTime.nullable(),
});
export type Session = z.infer<typeof Session>;

export const RateWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  resetsAt: IsoTime.nullable(),
});
export type RateWindow = z.infer<typeof RateWindow>;

export const Snapshot = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generatedAt: IsoTime,
  host: z.object({
    id: z.string().max(32),
    displayName: z.string().max(40),
    online: z.boolean(),
  }),
  collection: z.object({
    status: z.enum(["healthy", "degraded", "error"]),
    /** Short, actionable message when not healthy. */
    message: z.string().max(80).nullable(),
    lastSessionPollAt: IsoTime.nullable(),
    hooksInstalled: z.boolean(),
  }),
  sessions: z.array(Session).max(64),
  dailyUsage: z.object({
    tokens: z.number().int().nonnegative().nullable(),
    /** Host-local calendar date, YYYY-MM-DD. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    quality: Quality,
  }),
  rateLimits: z
    .object({
      fiveHour: RateWindow.nullable(),
      sevenDay: RateWindow.nullable(),
      observedAt: IsoTime,
    })
    .nullable(),
});
export type Snapshot = z.infer<typeof Snapshot>;

/** Max sessions sent to a physical device (bounded C arrays). */
export const DEVICE_MAX_SESSIONS = 12;
/** Max display-name bytes on device, including room for the ellipsis. */
export const DEVICE_MAX_NAME = 40;

export const Health = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  service: z.literal("claudette"),
  version: z.string(),
  hostName: z.string().max(40),
  ready: z.boolean(),
});
export type Health = z.infer<typeof Health>;

// ---------------------------------------------------------------- pairing

export const PairRequest = z.object({
  /** Random id the device generates once and keeps in NVS. */
  deviceId: z.string().regex(/^[A-Za-z0-9-]{8,40}$/),
  deviceName: z.string().min(1).max(32),
  firmwareVersion: z.string().max(24),
  /**
   * Random secret (>= 128 bits, hex) only the device knows. The service stores
   * its hash and requires it again in /pair/complete, so nobody else on the LAN
   * can collect the token once the user approves.
   */
  pairSecret: z.string().regex(/^[a-f0-9]{32,64}$/),
});
export type PairRequest = z.infer<typeof PairRequest>;

export const PairRequestResponse = z.object({
  pairingId: z.string(),
  /** Six-digit code the device shows; the user types it into the Mac UI. */
  code: z.string().regex(/^\d{6}$/),
  expiresAt: IsoTime,
});
export type PairRequestResponse = z.infer<typeof PairRequestResponse>;

export const PairComplete = z.object({
  pairingId: z.string(),
  pairSecret: z.string().regex(/^[a-f0-9]{32,64}$/),
});
export type PairComplete = z.infer<typeof PairComplete>;

export const PairCompleteResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
  z.object({
    status: z.literal("approved"),
    /** Bearer token for /api/v1/*. Shown exactly once. */
    token: z.string(),
    hostId: z.string(),
    hostName: z.string(),
  }),
]);
export type PairCompleteResponse = z.infer<typeof PairCompleteResponse>;

// ---------------------------------------------------------------- preferences

export const PreferencesPatch = z.object({
  /** Claudette-only favourites. Never touches Claude's native pin. */
  pins: z
    .array(z.object({ sessionId: z.string().max(32), pinned: z.boolean() }))
    .max(16)
    .optional(),
});
export type PreferencesPatch = z.infer<typeof PreferencesPatch>;
