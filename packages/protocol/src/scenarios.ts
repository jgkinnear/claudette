import { SCHEMA_VERSION, type Session, type Snapshot } from "./schema.js";

/**
 * Synthetic demo scenarios. All names, numbers and sessions here are made up;
 * none of it is real Claude activity. Used by the browser simulator, the
 * service's `--mock` mode and tests.
 */

export type LinkState = "live" | "stale" | "offline";

export type Onboarding =
  | { step: "wifi"; apName: string; apPassword: string }
  | { step: "connecting"; ssid: string }
  | { step: "discover"; hosts: string[] }
  | { step: "pairing"; hostName: string; code: string }
  | { step: "paired"; hostName: string };

export interface Scenario {
  id: string;
  title: string;
  description: string;
  link: LinkState;
  /** Seconds since the last good snapshot, for stale/offline scenarios. */
  lastOkAgoSec?: number;
  onboarding?: Onboarding;
  build(now: Date): Snapshot;
  /** Optional: evolve the snapshot over time for a lively demo. */
  step?(prev: Snapshot, tick: number, now: Date): Snapshot;
}

const ago = (now: Date, sec: number) => new Date(now.getTime() - sec * 1000).toISOString();

function today(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Ids come from the name so each demo session keeps the same Claudette look everywhere.
const slug = (name: string) =>
  `demo-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`.slice(0, 32);

function session(now: Date, partial: Partial<Session> & { displayName: string }): Session {
  return {
    id: partial.id ?? slug(partial.displayName),
    kind: "interactive",
    pinned: false,
    pinOrder: null,
    state: "ready",
    needsAttentionReason: null,
    stateSince: ago(now, 120),
    subagents: {
      active: 0,
      knownTotal: 0,
      types: [],
      oldestActiveSince: null,
      partial: false,
      quality: "observed",
    },
    tokens: { sessionTotal: 42_000, cacheRead: 610_000, quality: "observed", source: "transcript-usage" },
    // Context size is known from the transcript; the % needs the optional status line.
    context: { usedPercent: null, tokens: 48_600, quality: "observed" },
    lastActivityAt: ago(now, 30),
    ...partial,
  };
}

function snapshot(now: Date, sessions: Session[], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    host: { id: "demo-host", displayName: "Demo MacBook", online: true },
    collection: {
      status: "healthy",
      message: null,
      lastSessionPollAt: ago(now, 2),
      hooksInstalled: true,
    },
    sessions,
    dailyUsage: { tokens: 1_240_000, date: today(now), quality: "observed" },
    rateLimits: null,
    ...extra,
  };
}

const helpers = (now: Date, active: number, types: string[], sinceSec = 95) => ({
  active,
  knownTotal: active + 3,
  types,
  oldestActiveSince: active > 0 ? ago(now, sinceSec) : null,
  partial: false,
  quality: "observed" as const,
});

const rates = (now: Date) => ({
  fiveHour: { usedPercent: 23.5, resetsAt: ago(now, -2 * 3600 - 840) },
  sevenDay: { usedPercent: 41.2, resetsAt: ago(now, -3 * 86400) },
  observedAt: ago(now, 40),
});

export const scenarios: Scenario[] = [
  {
    id: "tour",
    title: "Lively demo",
    description: "A busy afternoon: helpers come and go, one session asks for you.",
    link: "live",
    build: (now) =>
      snapshot(
        now,
        [
          session(now, {
            id: "tour-maps",
            displayName: "Maps project",
            pinned: true,
            pinOrder: 0,
            state: "working",
            stateSince: ago(now, 312),
            subagents: helpers(now, 2, ["Explore", "general-purpose"]),
            tokens: { sessionTotal: 84_200, cacheRead: 1_920_000, quality: "observed", source: "transcript-usage" },
            context: { usedPercent: 38, tokens: 76_000, quality: "observed" },
          }),
          session(now, {
            id: "tour-api",
            displayName: "Billing API refactor",
            pinned: true,
            pinOrder: 1,
            state: "ready",
            stateSince: ago(now, 64),
            tokens: { sessionTotal: 212_900, cacheRead: 4_100_000, quality: "observed", source: "transcript-usage" },
            context: { usedPercent: 71, tokens: 142_000, quality: "observed" },
          }),
          session(now, { id: "tour-docs", displayName: "Docs tidy-up", state: "ready", lastActivityAt: ago(now, 1800) }),
          session(now, {
            id: "tour-ci",
            displayName: "Flaky CI hunt",
            kind: "background",
            state: "working",
            stateSince: ago(now, 45),
            subagents: helpers(now, 1, ["Plan"], 40),
          }),
        ],
        { rateLimits: rates(now) },
      ),
    step(prev, tick, now) {
      // A slow loop: maps spawns/finishes helpers, billing needs you, CI finishes.
      const phase = tick % 12;
      const s = structuredClone(prev);
      s.generatedAt = now.toISOString();
      s.collection.lastSessionPollAt = now.toISOString();
      const maps = s.sessions.find((x) => x.id === "tour-maps")!;
      const api = s.sessions.find((x) => x.id === "tour-api")!;
      const ci = s.sessions.find((x) => x.id === "tour-ci")!;
      const bump = 900 + ((tick * 37) % 1400);
      if (maps.tokens.sessionTotal !== null && maps.state === "working") maps.tokens.sessionTotal += bump;
      if (s.dailyUsage.tokens !== null) s.dailyUsage.tokens += bump;
      maps.lastActivityAt = now.toISOString();
      const mapsTypes: string[][] = [
        ["Explore", "general-purpose"],
        ["Explore", "general-purpose", "Plan"],
        ["Explore", "general-purpose", "Plan"],
        ["general-purpose"],
        [],
        [],
      ];
      const t = mapsTypes[Math.floor(phase / 2)] ?? [];
      maps.subagents = { ...maps.subagents, active: t.length, types: t };
      maps.state = t.length > 0 ? "working" : phase >= 10 ? "ready" : "working";
      maps.context.usedPercent = Math.min(95, 38 + phase * 3);
      maps.context.tokens = maps.context.usedPercent * 2000;
      if (phase === 4) {
        api.state = "needs_attention";
        api.needsAttentionReason = "permission prompt";
        api.stateSince = now.toISOString();
      } else if (phase === 8) {
        api.state = "working";
        api.needsAttentionReason = null;
        api.stateSince = now.toISOString();
      } else if (phase === 0) {
        api.state = "ready";
        api.stateSince = now.toISOString();
      }
      ci.state = phase < 6 ? "working" : "ready";
      ci.subagents = { ...ci.subagents, active: phase < 6 ? 1 : 0, types: phase < 6 ? ["Plan"] : [] };
      return s;
    },
  },
  {
    id: "empty",
    title: "No sessions",
    description: "Fresh install: Claude Code isn't running anything yet.",
    link: "live",
    build: (now) => snapshot(now, [], { dailyUsage: { tokens: 0, date: today(now), quality: "observed" } }),
  },
  {
    id: "one-working",
    title: "One working session",
    description: "A single session busily working, no pins chosen yet.",
    link: "live",
    build: (now) =>
      snapshot(now, [
        session(now, {
          displayName: "Weekend game jam",
          state: "working",
          stateSince: ago(now, 75),
          subagents: helpers(now, 0, []),
          context: { usedPercent: 12, tokens: 24_000, quality: "observed" },
        }),
      ]),
  },
  {
    id: "needs-you",
    title: "Needs your permission",
    description: "A pinned session is blocked on a permission prompt.",
    link: "live",
    build: (now) =>
      snapshot(now, [
        session(now, {
          displayName: "Database migration",
          pinned: true,
          pinOrder: 0,
          state: "needs_attention",
          needsAttentionReason: "permission prompt",
          stateSince: ago(now, 48),
          context: { usedPercent: 54, tokens: 108_000, quality: "observed" },
        }),
        session(now, {
          displayName: "Landing page copy",
          pinned: true,
          pinOrder: 1,
          state: "working",
          stateSince: ago(now, 200),
          subagents: helpers(now, 1, ["Explore"]),
        }),
      ]),
  },
  {
    id: "helpers",
    title: "Busy little helpers",
    description: "Lots of subagents running across sessions.",
    link: "live",
    build: (now) =>
      snapshot(now, [
        session(now, {
          displayName: "Monorepo upgrade",
          pinned: true,
          pinOrder: 0,
          state: "working",
          stateSince: ago(now, 900),
          subagents: helpers(now, 5, ["Explore", "Plan", "general-purpose", "code-reviewer"], 610),
          tokens: { sessionTotal: 1_480_000, cacheRead: 22_000_000, quality: "observed", source: "transcript-usage" },
          context: { usedPercent: 88, tokens: 176_000, quality: "observed" },
        }),
        session(now, {
          displayName: "Test coverage",
          state: "working",
          stateSince: ago(now, 300),
          subagents: helpers(now, 2, ["general-purpose"]),
        }),
      ]),
  },
  {
    id: "finished",
    title: "All done",
    description: "Everything finished: sessions are ready for your next prompt.",
    link: "live",
    build: (now) =>
      snapshot(now, [
        session(now, { displayName: "Release notes", pinned: true, pinOrder: 0, state: "ready", stateSince: ago(now, 30) }),
        session(now, { displayName: "Bug triage", pinned: true, pinOrder: 1, state: "ready", stateSince: ago(now, 3600) }),
      ]),
  },
  {
    id: "failed",
    title: "Something broke",
    description: "One background session failed, another was stopped.",
    link: "live",
    build: (now) =>
      snapshot(now, [
        session(now, {
          displayName: "Nightly data import",
          kind: "background",
          pinned: true,
          pinOrder: 0,
          state: "failed",
          stateSince: ago(now, 420),
        }),
        session(now, { displayName: "Old experiment", kind: "background", state: "stopped", stateSince: ago(now, 7200) }),
        session(now, { displayName: "Auth cleanup", state: "working", stateSince: ago(now, 60) }),
      ]),
  },
  {
    id: "unknown-usage",
    title: "Unknown metrics",
    description: "Token and context data aren't available — shown honestly, not as zero.",
    link: "live",
    build: (now) =>
      snapshot(
        now,
        [
          session(now, {
            displayName: "Mystery session",
            pinned: true,
            pinOrder: 0,
            state: "unknown",
            subagents: {
              active: null,
              knownTotal: null,
              types: [],
              oldestActiveSince: null,
              partial: false,
              quality: "unavailable",
            },
            tokens: { sessionTotal: null, cacheRead: null, quality: "unavailable", source: "none" },
            context: { usedPercent: null, quality: "unavailable" },
          }),
        ],
        {
          collection: {
            status: "degraded",
            message: "Hooks not installed: run claudette setup",
            lastSessionPollAt: ago(now, 3),
            hooksInstalled: false,
          },
          dailyUsage: { tokens: null, date: today(now), quality: "unavailable" },
        },
      ),
  },
  {
    id: "long-names",
    title: "Long names",
    description: "Very long and non-ASCII session names truncate safely.",
    link: "live",
    build: (now) =>
      snapshot(now, [
        session(now, {
          displayName: "Investigate why prod checkout occasionally double-charges users",
          pinned: true,
          pinOrder: 0,
          state: "needs_attention",
          needsAttentionReason: "input needed",
        }),
        session(now, {
          displayName: "Café menü — ünïcödé naïve façade résumé",
          pinned: true,
          pinOrder: 1,
          state: "working",
          subagents: helpers(now, 3, ["extremely-long-custom-agent-name", "Explore", "Plan"]),
        }),
      ]),
  },
  {
    id: "many",
    title: "Lots of sessions",
    description: "Twelve sessions in different states; extras scroll.",
    link: "live",
    build: (now) => {
      const states: Session["state"][] = ["working", "ready", "needs_attention", "working", "ready", "stopped"];
      const names = [
        "Search indexer", "Mobile app", "Infra as code", "Design system", "Analytics", "Email templates",
        "Onboarding flow", "Payments", "Feature flags", "Perf budget", "Accessibility", "Localization",
      ];
      return snapshot(
        now,
        names.map((n, i) =>
          session(now, {
            displayName: n,
            pinned: i < 2,
            pinOrder: i < 2 ? i : null,
            state: states[i % states.length]!,
            needsAttentionReason: states[i % states.length] === "needs_attention" ? "permission prompt" : null,
            subagents: helpers(now, i % 3, i % 3 ? ["Explore"] : []),
            lastActivityAt: ago(now, i * 140),
          }),
        ),
        { rateLimits: rates(now) },
      );
    },
  },
  {
    id: "stale",
    title: "Connection hiccup",
    description: "Data is a little old; values stay visible but look stale.",
    link: "stale",
    lastOkAgoSec: 12,
    build: (now) =>
      snapshot(now, [
        session(now, { displayName: "Maps project", pinned: true, pinOrder: 0, state: "working", subagents: helpers(now, 1, ["Explore"]) }),
      ]),
  },
  {
    id: "offline",
    title: "Mac asleep",
    description: "The Mac stopped answering; Claudette naps until it's back.",
    link: "offline",
    lastOkAgoSec: 25 * 60,
    build: (now) =>
      snapshot(now, [
        session(now, { displayName: "Maps project", pinned: true, pinOrder: 0, state: "working" }),
      ]),
  },
  {
    id: "onboard-wifi",
    title: "Setup: Wi-Fi",
    description: "First boot: join Claudette's setup network from your phone.",
    link: "offline",
    onboarding: { step: "wifi", apName: "Claudette-7F3A", apPassword: "cosy-otter-42" },
    build: (now) => snapshot(now, []),
  },
  {
    id: "onboard-discover",
    title: "Setup: pick a Mac",
    description: "Claudette found computers running the companion service.",
    link: "offline",
    onboarding: { step: "discover", hosts: ["Demo MacBook", "Studio iMac"] },
    build: (now) => snapshot(now, []),
  },
  {
    id: "onboard-pair",
    title: "Setup: pairing code",
    description: "Type the code shown here into the Mac's Claudette page.",
    link: "offline",
    onboarding: { step: "pairing", hostName: "Demo MacBook", code: "482915" },
    build: (now) => snapshot(now, []),
  },
];

export function getScenario(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id);
}
