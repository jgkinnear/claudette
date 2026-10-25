import { describe, expect, it } from "vitest";
import { statusLinePayload } from "@claudette/test-fixtures";
import { LimitsStore, pickStatusLine } from "../src/limits.js";
import { formatStatusLine } from "../src/statusline.js";
import { scrub } from "../src/log.js";

describe("status-line limits", () => {
  it("picks only whitelisted fields", () => {
    const p = pickStatusLine(statusLinePayload("sess", { contextPercent: 42 }))!;
    expect(p.sessionId).toBe("sess");
    expect(p.contextPercent).toBe(42);
    expect(p.fiveHour?.usedPercent).toBe(23.5);
    expect(JSON.stringify(p)).not.toContain("teapot");
    expect(pickStatusLine({})).toBeNull();
    expect(pickStatusLine({ session_id: "s", context_window: { used_percentage: null } })!.contextPercent).toBeNull();
  });

  it("expires rate windows after resets_at", () => {
    let now = Date.now();
    const store = new LimitsStore(() => now);
    store.record(pickStatusLine(statusLinePayload("sess", { resetsInSec: 60 }))!);
    expect(store.rateLimits()?.fiveHour).not.toBeNull();
    now += 61_000;
    expect(store.rateLimits()?.fiveHour).toBeNull();
    expect(store.rateLimits()?.sevenDay).not.toBeNull();
    now += 4 * 86400_000;
    expect(store.rateLimits()).toBeNull();
  });

  it("keeps context per session", () => {
    const store = new LimitsStore();
    store.record(pickStatusLine(statusLinePayload("a", { contextPercent: 10 }))!);
    store.record(pickStatusLine(statusLinePayload("b", { contextPercent: 80 }))!);
    expect(store.contextFor("a")).toBe(10);
    expect(store.contextFor("b")).toBe(80);
    expect(store.contextFor("c")).toBeNull();
  });

  it("prints a short friendly line", () => {
    expect(formatStatusLine(pickStatusLine(statusLinePayload("a", { contextPercent: 42.4 })))).toBe("✿ ctx 42% · 5h 24%");
    expect(formatStatusLine(null)).toBe("✿ claudette");
  });
});

describe("log scrubber", () => {
  it("removes tokens and secrets", () => {
    const tok = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg";
    const line = scrub(`Authorization: Bearer ${tok} X-Claudette-Hook: abcdef0123456789abcdef0123456789 {"token":"${tok}","code":"123456"}`);
    expect(line).not.toContain(tok);
    expect(line).not.toContain("abcdef0123456789abcdef0123456789");
    expect(line).not.toContain("123456");
  });
});
