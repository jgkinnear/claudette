import { describe, expect, it } from "vitest";
import { Snapshot, scenarios } from "./index.js";

describe("demo scenarios", () => {
  const now = new Date("2026-10-25T02:30:00Z");

  it("has at least ten scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
  });

  it.each(scenarios.map((s) => [s.id, s] as const))("%s builds a valid snapshot", (_id, scenario) => {
    let snap = scenario.build(now);
    expect(Snapshot.safeParse(snap).success).toBe(true);
    if (scenario.step) {
      for (let i = 0; i < 30; i++) {
        snap = scenario.step(snap, i, new Date(now.getTime() + i * 3000));
        const parsed = Snapshot.safeParse(snap);
        expect(parsed.error?.issues ?? []).toEqual([]);
      }
    }
  });

  it("keeps unavailable metrics as null, not zero", () => {
    const snap = scenarios.find((s) => s.id === "unknown-usage")!.build(now);
    expect(snap.sessions[0]!.tokens.sessionTotal).toBeNull();
    expect(snap.sessions[0]!.subagents.active).toBeNull();
    expect(snap.dailyUsage.tokens).toBeNull();
  });
});
