import { appendFileSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeHome, expectedBusy, ids, usageLine } from "@claudette/test-fixtures";
import { TokenLedger, parseUsageLine } from "../src/tokens.js";
import { tempDir } from "./helpers.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function setup(now = new Date()) {
  const t = tempDir();
  cleanup = t.cleanup;
  const home = createClaudeHome(t.dir, { now });
  const ledger = new TokenLedger({ projectsDir: home.projects, now: () => now.getTime(), chunkBytes: 64 });
  return { home, ledger, now };
}

describe("token ledger", () => {
  it("dedupes streamed blocks by message id and includes subagents", async () => {
    const { ledger } = setup();
    await ledger.update([ids.busy]);
    const s = ledger.session(ids.busy)!;
    expect(s.sessionTotal).toBe(expectedBusy.sessionTotal);
    expect(s.cacheRead).toBe(expectedBusy.cacheRead);
  });

  it("counts only today's records in the daily total", async () => {
    const { ledger } = setup();
    await ledger.update([ids.busy]);
    expect(ledger.daily().tokens).toBe(expectedBusy.today);
  });

  it("returns null (not zero) for a session without a transcript", async () => {
    const { ledger } = setup();
    await ledger.update(["no-such-session"]);
    expect(ledger.session("no-such-session")).toBeNull();
    await ledger.update([ids.idle]);
    expect(ledger.session(ids.idle)).toMatchObject({ sessionTotal: 0, cacheRead: 0 });
  });

  it("reads incrementally and waits for a complete last line", async () => {
    const { ledger, home, now } = setup();
    await ledger.update([ids.busy]);
    const line = usageLine({ sessionId: ids.busy, messageId: "msg_new", requestId: "r9", timestamp: now.getTime(), usage: { input: 1000, output: 1 } });
    appendFileSync(home.mainPath, line.slice(0, 40)); // half-written
    await ledger.update([ids.busy]);
    expect(ledger.session(ids.busy)!.sessionTotal).toBe(expectedBusy.sessionTotal);
    appendFileSync(home.mainPath, line.slice(40) + "\n");
    await ledger.update([ids.busy]);
    expect(ledger.session(ids.busy)!.sessionTotal).toBe(expectedBusy.sessionTotal + 1001);
    // a repeat of the same message id later in the file doesn't double count
    appendFileSync(home.mainPath, line + "\n");
    await ledger.update([ids.busy]);
    expect(ledger.session(ids.busy)!.sessionTotal).toBe(expectedBusy.sessionTotal + 1001);
  });

  it("starts over when a file shrinks (truncated/rewritten)", async () => {
    const { ledger, home, now } = setup();
    await ledger.update([ids.busy]);
    truncateSync(home.mainPath, 0);
    writeFileSync(
      home.mainPath,
      usageLine({ sessionId: ids.busy, messageId: "only", requestId: "r", timestamp: now.getTime(), usage: { input: 5 } }) + "\n",
    );
    await ledger.update([ids.busy]);
    expect(ledger.session(ids.busy)!.sessionTotal).toBe(5 + 24 + 3); // new main + untouched subagent file
  });

  it("respects the local-day boundary", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const projects = join(t.dir, "projects");
    const dir = join(projects, "-demo");
    mkdirSync(dir, { recursive: true });
    const now = new Date(2026, 9, 25, 0, 0, 30); // 30 s after local midnight
    const midnight = new Date(2026, 9, 25).getTime();
    writeFileSync(
      join(dir, "sess.jsonl"),
      [
        usageLine({ sessionId: "sess", messageId: "late", requestId: "a", timestamp: midnight - 1, usage: { input: 100 } }),
        usageLine({ sessionId: "sess", messageId: "early", requestId: "b", timestamp: midnight, usage: { input: 7 } }),
      ].join("\n") + "\n",
    );
    const ledger = new TokenLedger({ projectsDir: projects, now: () => now.getTime() });
    await ledger.update(["sess"]);
    expect(ledger.daily()).toEqual({ date: "2026-10-25", tokens: 7 });
    expect(ledger.session("sess")!.sessionTotal).toBe(107);
  });

  it("is unavailable when there's no projects dir", async () => {
    const ledger = new TokenLedger({ projectsDir: "/nonexistent/claudette/projects" });
    await ledger.update([]);
    expect(ledger.daily().tokens).toBeNull();
  });

  it("only extracts numbers from usage lines", () => {
    expect(parseUsageLine('{"type":"user","message":{"content":"\\"usage\\""}}')).toBeNull();
    expect(parseUsageLine("garbage")).toBeNull();
    const p = parseUsageLine(
      JSON.stringify({ type: "assistant", requestId: "r", timestamp: "2026-10-25T00:00:00Z", message: { id: "m", content: "secret", usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } }),
    )!;
    expect(p).toEqual({ key: "m|r", rec: { work: 6, cacheRead: 4, ts: Date.parse("2026-10-25T00:00:00Z") } });
    expect(JSON.stringify(p)).not.toContain("secret");
  });
});
