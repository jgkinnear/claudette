import { describe, expect, it } from "vitest";
import { agents, agentsMixed } from "@claudette/test-fixtures";
import { mapState, normalise, opaqueId, parseAgentsJson, sourceIdOf, truncateUtf8 } from "../src/agents.js";

const SALT = "0123456789abcdef0123";

describe("state normalisation", () => {
  it.each([
    [agents.interactiveBusy, "working", null],
    [agents.interactiveIdle, "ready", null],
    [agents.interactiveWaiting, "needs_attention", "permission prompt"],
    [agents.interactiveDead, "stopped", null],
    [agents.backgroundWorking, "working", null],
    [agents.backgroundBlocked, "needs_attention", "needs your input"],
    [agents.backgroundDone, "ready", null],
    [agents.backgroundFailed, "failed", null],
    [agents.backgroundStopped, "stopped", null],
  ])("%o -> %s", (row, state, reason) => {
    const r = mapState(row);
    expect(r.state).toBe(state);
    expect(r.reason).toBe(reason);
  });

  it("documented background state wins over a contradicting live status", () => {
    expect(mapState({ kind: "background", state: "done", status: "busy" }).state).toBe("ready");
    expect(mapState({ kind: "background", state: "working", status: "idle" }).state).toBe("working");
  });

  it("live waiting status enriches a working background session", () => {
    const r = mapState({ kind: "background", state: "working", status: "waiting", waitingFor: "sandbox request" });
    expect(r).toEqual({ state: "needs_attention", reason: "sandbox request" });
  });

  it("anything else is unknown", () => {
    expect(mapState({ kind: "background" }).state).toBe("unknown");
    expect(mapState({ kind: "interactive", state: "teleporting" }).state).toBe("unknown");
    expect(mapState({ kind: "interactive", pid: 1, status: "dreaming" }).state).toBe("unknown");
  });

  it("produces opaque, stable ids that never contain the raw session id", () => {
    const a = normalise(agents.interactiveBusy, SALT)!;
    const b = normalise({ ...agents.interactiveBusy, status: "idle" }, SALT)!;
    expect(a.id).toBe(b.id);
    expect(a.id.length).toBeLessThanOrEqual(32);
    expect(a.id).not.toContain(agents.interactiveBusy.sessionId!.slice(0, 8));
    expect(a.id).toBe(opaqueId(sourceIdOf(agents.interactiveBusy)!, SALT));
    expect(normalise(agents.interactiveBusy, "another-salt-value")!.id).not.toBe(a.id);
  });

  it("display name is name, else basename(cwd), never the full path", () => {
    expect(normalise(agents.interactiveBusy, SALT)!.name).toBe("teapot api");
    expect(normalise(agents.interactiveIdle, SALT)!.name).toBe("garden-planner");
  });

  it("parses the CLI output leniently", () => {
    const rows = parseAgentsJson(JSON.stringify([...agentsMixed, 42, { kind: "interactive", cwd: 7 }]));
    expect(rows.length).toBe(agentsMixed.length + 1);
    expect(() => parseAgentsJson("not json")).toThrow();
    expect(() => parseAgentsJson("{}")).toThrow();
  });

  it("tolerates a stray notice around the list, and never echoes the output in errors", () => {
    const list = JSON.stringify(agentsMixed);
    expect(parseAgentsJson(`Update available: 9.9.9\n${list}\n`).length).toBe(agentsMixed.length);
    const secret = '[{"cwd": "/Users/someone/secret-project", "name": "my private thing"';
    expect(() => parseAgentsJson(secret)).toThrow(/isn't JSON \(\d+ bytes\)$/);
    expect(() => parseAgentsJson(secret)).not.toThrow(/secret|private/);
    expect(() => parseAgentsJson("  \n")).toThrow(/\(nothing\)/);
  });

  it("all fixture rows normalise with unique ids", () => {
    const ids = agentsMixed.map((a) => normalise(a, SALT)!.id);
    expect(new Set(ids).size).toBe(agentsMixed.length);
  });
});

describe("UTF-8 truncation", () => {
  it("never exceeds the byte budget or splits a code point", () => {
    for (const s of ["🍵".repeat(40), "é".repeat(100), "a".repeat(100), "日本語のセッション名".repeat(5), "x🍵".repeat(30)]) {
      const t = truncateUtf8(s, 40);
      expect(Buffer.byteLength(t, "utf8")).toBeLessThanOrEqual(40);
      expect(t).not.toContain("�");
      expect(Buffer.from(t, "utf8").toString("utf8")).toBe(t);
      expect(t.endsWith("…")).toBe(true);
    }
    expect(truncateUtf8("short", 40)).toBe("short");
  });
});
