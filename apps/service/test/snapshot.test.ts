import { describe, expect, it } from "vitest";
import { DEVICE_MAX_SESSIONS, Snapshot, scenarios, type Session } from "@claudette/protocol";
import { agents, agentsMixed, createClaudeHome, ids, maliciousNames } from "@claudette/test-fixtures";
import { Collector } from "../src/collector.js";
import { applyPreferences, deviceView } from "../src/snapshot.js";
import { MockSource } from "../src/mock.js";
import { tempDir } from "./helpers.js";

const SALT = "0123456789abcdef0123";

function collector(rows = agentsMixed, now = Date.now()) {
  const t = tempDir();
  const home = createClaudeHome(t.dir);
  const c = new Collector({
    claudePath: null,
    projectsDir: home.projects,
    host: { id: "h-test", displayName: "Test Mac" },
    salt: SALT,
    hooksInstalled: () => true,
    fetchAgents: async () => rows,
    now: () => now,
  });
  return { c, cleanup: t.cleanup };
}

describe("snapshot", () => {
  it("real collector snapshot validates against the protocol schema", async () => {
    const { c, cleanup } = collector();
    try {
      await c.poll();
      const snap = applyPreferences(c.snapshot(), { pinOrder: [], aliases: {} });
      const r = Snapshot.safeParse(snap);
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
      expect(snap.collection.status).toBe("healthy");
      const busy = snap.sessions.find((s) => s.displayName === "teapot api")!;
      expect(busy.state).toBe("working");
      expect(busy.tokens.quality).toBe("observed");
      expect(busy.tokens.sessionTotal).toBeGreaterThan(0);
      const json = JSON.stringify(snap);
      for (const id of Object.values(ids)) expect(json).not.toContain(id);
      expect(json).not.toContain("/Users/demo");
    } finally {
      cleanup();
    }
  });

  it("keeps last-good sessions and reports an error when the CLI fails", async () => {
    let fail = false;
    const t = tempDir();
    const c = new Collector({
      claudePath: null,
      projectsDir: t.dir,
      host: { id: "h", displayName: "Mac" },
      salt: SALT,
      fetchAgents: async () => {
        if (fail) throw new Error("boom");
        return [agents.interactiveBusy];
      },
    });
    await c.poll();
    fail = true;
    await c.poll();
    const snap = c.snapshot();
    expect(snap.collection.status).toBe("error");
    expect(snap.collection.message).toBeTruthy();
    expect(snap.sessions.length).toBe(1);
    expect(Snapshot.safeParse(snap).success).toBe(true);
    t.cleanup();
  });

  it("reports a visible error when the claude CLI is missing", async () => {
    const t = tempDir();
    const c = new Collector({ claudePath: "/nonexistent/claude", projectsDir: t.dir, host: { id: "h", displayName: "Mac" }, salt: SALT });
    await c.poll();
    const snap = c.snapshot();
    expect(snap.collection.status).toBe("error");
    expect(snap.collection.message).toMatch(/not found/i);
    t.cleanup();
  });

  it("hides long-finished sessions unless pinned", async () => {
    const now = Date.now();
    const old = { ...agents.backgroundDone, startedAt: now - 3 * 86400_000 };
    const fresh = { ...agents.backgroundFailed, startedAt: now - 60_000 };
    const { c, cleanup } = collector([old, fresh, agents.interactiveBusy], now);
    try {
      await c.poll();
      const names = c.snapshot().sessions.map((s) => s.id);
      expect(names.length).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("every built-in scenario validates via the mock source", () => {
    for (const s of scenarios) {
      const m = new MockSource(s.id, { id: "h", displayName: "Mac" });
      const snap = applyPreferences(m.snapshot(), m.seedPreferences());
      expect(Snapshot.safeParse(snap).success, s.id).toBe(true);
    }
  });
});

function fakeSession(i: number, patch: Partial<Session> = {}): Session {
  return {
    id: `s${i}`,
    displayName: `Session ${i}`,
    kind: "interactive",
    pinned: false,
    pinOrder: null,
    state: "ready",
    needsAttentionReason: null,
    stateSince: null,
    subagents: { active: 0, knownTotal: 0, types: [], oldestActiveSince: null, partial: false, quality: "observed" },
    tokens: { sessionTotal: null, cacheRead: null, quality: "unavailable", source: "none" },
    context: { usedPercent: null, quality: "unavailable" },
    lastActivityAt: new Date(1_000_000 + i * 1000).toISOString(),
    ...patch,
  };
}

function snapOf(sessions: Session[]): Snapshot {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    host: { id: "h", displayName: "Mac", online: true },
    collection: { status: "healthy", message: null, lastSessionPollAt: null, hooksInstalled: true },
    sessions,
    dailyUsage: { tokens: 0, date: "2026-10-25", quality: "observed" },
    rateLimits: null,
  };
}

describe("device view", () => {
  it("trims to 12 sessions: needs-you first, then pinned by order, then working, ready by recency", () => {
    const sessions: Session[] = [];
    for (let i = 0; i < 20; i++) sessions.push(fakeSession(i));
    sessions[3]!.state = "needs_attention";
    sessions[4]!.state = "working";
    sessions[5]!.state = "failed";
    const full = applyPreferences(snapOf(sessions), { pinOrder: ["s10", "s2"], aliases: {} });
    const dev = deviceView(full);
    expect(dev.sessions.length).toBe(DEVICE_MAX_SESSIONS);
    expect(dev.sessions.map((s) => s.id).slice(0, 6)).toEqual(["s3", "s10", "s2", "s4", "s19", "s18"]);
    expect(dev.sessions[1]!.pinOrder).toBe(0);
    expect(dev.sessions[2]!.pinOrder).toBe(1);
    expect(dev.sessions.some((s) => s.id === "s5")).toBe(false); // failed sorts after ready ones and is cut
    expect(Snapshot.safeParse(dev).success).toBe(true);
  });

  it("truncates names to 40 UTF-8 bytes and keeps malicious names as plain data", () => {
    const sessions = maliciousNames.map((n, i) => fakeSession(i, { displayName: n.slice(0, 64) }));
    const dev = deviceView(applyPreferences(snapOf(sessions), { pinOrder: [], aliases: {} }));
    for (const s of dev.sessions) {
      expect(Buffer.byteLength(s.displayName, "utf8")).toBeLessThanOrEqual(40);
      expect(s.displayName).not.toContain("�");
    }
    expect(dev.sessions.map((s) => s.displayName)).toContain("<script>alert('pwned')</script>");
    expect(Snapshot.safeParse(dev).success).toBe(true);
  });

  it("applies aliases", () => {
    const full = applyPreferences(snapOf([fakeSession(1)]), { pinOrder: [], aliases: { s1: "Secret project" } });
    expect(full.sessions[0]!.displayName).toBe("Secret project");
  });
});
