import { describe, expect, it } from "vitest";
import { Collector } from "../src/collector.js";
import { applyPreferences } from "../src/snapshot.js";
import type { RememberedSession } from "../src/store.js";

type Row = Record<string, unknown>;

/** A collector wired to an in-memory preferences store, like service.ts does with the real one. */
function setup(
  prefs = { pinOrder: [] as string[], remembered: {} as Record<string, RememberedSession> },
  extra: Partial<ConstructorParameters<typeof Collector>[0]> = { fillTo: 0 }, // no recent top-up unless a test asks
) {
  let rows: Row[] = [];
  const c = new Collector({
    ...extra,
    claudePath: null,
    projectsDir: "/nonexistent",
    host: { id: "h", displayName: "Mac" },
    salt: "x".repeat(16),
    fetchAgents: async () => rows as never,
    isPinned: (id) => prefs.pinOrder.includes(id),
    pins: {
      ids: () => prefs.pinOrder,
      remembered: () => Object.keys(prefs.remembered),
      get: (id) => prefs.remembered[id],
      remember: (id, s) => (prefs.remembered[id] = s),
      forget: (id) => delete prefs.remembered[id],
    },
  });
  const view = () => applyPreferences(c.snapshot(), { pinOrder: prefs.pinOrder, aliases: {} }).sessions;
  return { c, prefs, view, setRows: (r: Row[]) => (rows = r) };
}

const live = (sessionId: string, name: string, status: "busy" | "idle" | "waiting" = "idle"): Row => ({
  kind: "interactive",
  sessionId,
  name,
  pid: 100,
  status,
  ...(status === "waiting" ? { waitingFor: "permission prompt" } : {}),
  cwd: "/work",
  startedAt: 1_700_000_000_000,
});

describe("pinned sessions", () => {
  it("stay listed as stopped after Claude stops their process; unpinned ones drop off", async () => {
    const { c, prefs, view, setRows } = setup();
    setRows([live("a", "Pinned one"), live("b", "Not pinned")]);
    await c.poll();
    const pinnedId = view().find((s) => s.displayName === "Pinned one")!.id;
    prefs.pinOrder.push(pinnedId);
    await c.poll(); // remembers the pinned session's details
    expect(prefs.remembered[pinnedId]?.name).toBe("Pinned one");

    setRows([]); // both processes stopped
    await c.poll();
    const after = view();
    expect(after.map((s) => s.displayName)).toEqual(["Pinned one"]);
    expect(after[0]).toMatchObject({ state: "stopped", pinned: true, pinOrder: 0, needsAttentionReason: null });
  });

  it("come back after a service restart, even though Claude isn't running them", async () => {
    const prefs = {
      pinOrder: ["s-remembered"],
      remembered: {
        "s-remembered": { name: "Weekend side project", kind: "interactive" as const, claudeSessionId: "zzz", startedAtMs: null },
      },
    };
    const { c, view, setRows } = setup(prefs);
    setRows([live("a", "Something running", "busy")]);
    await c.poll();
    expect(view().map((s) => [s.displayName, s.state, s.pinned])).toEqual([
      ["Weekend side project", "stopped", true],
      ["Something running", "working", false],
    ]);
    expect(c.knownIds().has("s-remembered")).toBe(true); // so it can still be unpinned / reordered
  });

  it("are forgotten once unpinned", async () => {
    const { c, prefs, view, setRows } = setup();
    setRows([live("a", "Pinned one")]);
    await c.poll();
    const id = view()[0]!.id;
    prefs.pinOrder.push(id);
    await c.poll();
    setRows([]);
    await c.poll();
    expect(view()).toHaveLength(1);

    prefs.pinOrder.length = 0;
    await c.poll();
    expect(view()).toHaveLength(0);
    expect(prefs.remembered).toEqual({});
  });
});

describe("recently closed sessions", () => {
  it("fill the list up to 6 with sessions closed in the last 4 hours, newest first; running ones always show", async () => {
    let now = 1_800_000_000_000;
    const { c, view, setRows } = setup(undefined, { now: () => now });
    const names = ["One", "Two", "Three", "Four", "Five", "Six", "Seven"];
    // Seven sessions run, then the app closes them one at a time, a minute apart.
    setRows(names.map((n, i) => live(`s${i}`, n)));
    await c.poll();
    for (let i = 0; i < names.length; i++) {
      now += 60_000;
      setRows(names.slice(i + 1).map((n, k) => live(`s${i + 1 + k}`, n)));
      await c.poll();
    }
    // Nothing running now: the six most recently closed show, newest first, as stopped.
    expect(view().map((s) => s.displayName)).toEqual(["Seven", "Six", "Five", "Four", "Three", "Two"]);
    expect(view().every((s) => s.state === "stopped")).toBe(true);

    // Four running sessions leave room for two recent ones.
    setRows(["A", "B", "C", "D"].map((n) => live(`r${n}`, n, "busy")));
    await c.poll();
    const names4 = view().map((s) => s.displayName);
    expect(names4.slice(0, 4).sort()).toEqual(["A", "B", "C", "D"]); // running first (same age: any order)
    expect(names4.slice(4)).toEqual(["Seven", "Six"]); // then the most recently closed

    // Eight running: no room, and running ones are never cut to make space.
    setRows("ABCDEFGH".split("").map((n) => live(`r${n}`, n, "busy")));
    await c.poll();
    expect(view()).toHaveLength(8);
    expect(view().every((s) => s.state === "working")).toBe(true);

    // After four hours, the closed ones are gone for good.
    setRows([]);
    now += 4 * 3600_000 + 60_000;
    await c.poll();
    expect(view()).toHaveLength(6); // the eight just closed fill the list; the older ones expired
    expect(view().every((s) => "ABCDEFGH".includes(s.displayName) && s.state === "stopped")).toBe(true);
    now += 4 * 3600_000 + 60_000;
    await c.poll();
    expect(view()).toHaveLength(0);
  });

  it("come back as running when the app reopens them", async () => {
    const { c, view, setRows } = setup(undefined, {});
    setRows([live("a", "Reopened", "busy")]);
    await c.poll();
    setRows([]);
    await c.poll();
    expect(view()[0]).toMatchObject({ displayName: "Reopened", state: "stopped" });
    setRows([live("a", "Reopened", "busy")]);
    await c.poll();
    expect(view()[0]).toMatchObject({ displayName: "Reopened", state: "working" });
  });
});

describe("list order", () => {
  it("is needs-you first (even above pins), then pinned in pin order, then working, ready", async () => {
    const { c, prefs, view, setRows } = setup();
    setRows([
      live("r", "Ready one", "idle"),
      live("w", "Working one", "busy"),
      live("n", "Needs you", "waiting"),
      live("p1", "Pin A", "idle"),
      live("p2", "Pin B", "busy"),
    ]);
    await c.poll();
    const id = (name: string) => view().find((s) => s.displayName === name)!.id;
    prefs.pinOrder.push(id("Pin B"), id("Pin A"));
    await c.poll();
    expect(view().map((s) => s.displayName)).toEqual(["Needs you", "Pin B", "Pin A", "Working one", "Ready one"]);
  });
});
