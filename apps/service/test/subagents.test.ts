import { describe, expect, it } from "vitest";
import { SubagentLedger } from "../src/subagents.js";

const S = "session-1";

function ledger(start = 1_000_000) {
  let t = start;
  const l = new SubagentLedger({ now: () => t, staleMs: 30 * 60_000, idleGraceMs: 30_000 });
  return { l, advance: (ms: number) => (t += ms), at: () => t };
}

const view = (l: SubagentLedger, startedAt: number | null = Number.MAX_SAFE_INTEGER) =>
  l.view(S, { hooksInstalled: true, sessionStartedAt: startedAt });

describe("subagent ledger", () => {
  it("two starts -> 2 active, one stop -> 1", () => {
    const { l, advance } = ledger();
    l.record({ event: "SubagentStart", sessionId: S, agentId: "a1", agentType: "Explore" });
    advance(1000);
    l.record({ event: "SubagentStart", sessionId: S, agentId: "a2", agentType: "Plan" });
    let v = view(l);
    expect(v.active).toBe(2);
    expect(v.knownTotal).toBe(2);
    expect(v.types).toEqual(["Explore", "Plan"]);
    expect(v.quality).toBe("observed");
    expect(v.oldestActiveSince).toBe(new Date(1_000_000).toISOString());
    l.record({ event: "SubagentStop", sessionId: S, agentId: "a1" });
    v = view(l);
    expect(v.active).toBe(1);
    expect(v.knownTotal).toBe(2);
    expect(v.types).toEqual(["Plan"]);
  });

  it("duplicate and replayed events are idempotent", () => {
    const { l } = ledger();
    const start = { event: "SubagentStart" as const, sessionId: S, agentId: "a1", agentType: "Explore" };
    l.record(start);
    l.record(start);
    expect(view(l).active).toBe(1);
    l.record({ event: "SubagentStop", sessionId: S, agentId: "a1" });
    l.record({ event: "SubagentStop", sessionId: S, agentId: "a1" });
    l.record(start); // replayed start after stop
    expect(view(l).active).toBe(0);
    expect(view(l).knownTotal).toBe(1);
  });

  it("ignores malformed events", () => {
    const { l } = ledger();
    l.record({ event: "SubagentStart", sessionId: S, agentId: null });
    l.record({ event: "SubagentStop", sessionId: S });
    expect(view(l).active).toBe(0);
  });

  it("drops stale subagents after the timeout", () => {
    const { l, advance } = ledger();
    l.record({ event: "SubagentStart", sessionId: S, agentId: "a1" });
    advance(29 * 60_000);
    expect(view(l).active).toBe(1);
    advance(2 * 60_000);
    expect(view(l).active).toBe(0);
    l.sweep();
    expect(l.stats().active).toBe(0);
  });

  it("clears when the parent stops or fails", () => {
    const { l } = ledger();
    l.record({ event: "SubagentStart", sessionId: S, agentId: "a1" });
    l.record({ event: "SubagentStart", sessionId: S, agentId: "a2" });
    l.reconcile(S, "stopped", null);
    expect(view(l).active).toBe(0);
    l.record({ event: "SubagentStart", sessionId: S, agentId: "a3" });
    l.reconcile(S, "failed", null);
    expect(view(l).active).toBe(0);
  });

  it("clears on SessionEnd and on clearSession (parent vanished)", () => {
    const { l } = ledger();
    l.record({ event: "SubagentStart", sessionId: S, agentId: "a1" });
    l.record({ event: "SessionEnd", sessionId: S });
    expect(view(l).active).toBe(0);
    l.record({ event: "SubagentStart", sessionId: S, agentId: "a2" });
    l.clearSession(S);
    expect(view(l).active).toBe(0);
  });

  it("clears leftovers once the parent finished its turn and stayed idle", () => {
    const { l, advance, at } = ledger();
    l.record({ event: "SubagentStart", sessionId: S, agentId: "a1" });
    advance(5000);
    l.record({ event: "Stop", sessionId: S });
    const idleSince = at();
    advance(10_000);
    l.reconcile(S, "ready", idleSince);
    expect(view(l).active).toBe(1); // still within grace
    advance(25_000);
    l.reconcile(S, "ready", idleSince);
    expect(view(l).active).toBe(0);
  });

  it("is unavailable (not zero) when hooks aren't installed", () => {
    const { l } = ledger();
    const v = l.view(S, { hooksInstalled: false, sessionStartedAt: null });
    expect(v).toEqual({ active: null, knownTotal: null, types: [], oldestActiveSince: null, partial: false, quality: "unavailable" });
  });

  it("marks sessions that started before the service as partial", () => {
    const { l } = ledger(1_000_000);
    expect(l.view(S, { hooksInstalled: true, sessionStartedAt: 500_000 }).partial).toBe(true);
    expect(l.view(S, { hooksInstalled: true, sessionStartedAt: 2_000_000 }).partial).toBe(false);
    expect(l.view("unseen", { hooksInstalled: true, sessionStartedAt: 2_000_000 })).toMatchObject({ active: 0, knownTotal: 0 });
  });

  it("sanitises and bounds agent types", () => {
    const { l } = ledger();
    l.record({ event: "SubagentStart", sessionId: S, agentId: "x", agentType: "\u001b[31m" + "y".repeat(100) });
    const t = view(l).types[0]!;
    expect(t.length).toBeLessThanOrEqual(32);
    expect(t).not.toContain("\u001b");
  });
});
