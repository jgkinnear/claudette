import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureFakeClaudeExecutable, fixturesDir } from "@claudette/test-fixtures";
import { runAgentsCli } from "../src/agents.js";
import { Collector } from "../src/collector.js";
import { createAdvertiser, NoopAdvertiser } from "../src/mdns.js";
import { silentLogger } from "../src/log.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("claude agents CLI adapter", () => {
  it("runs the CLI without a shell and parses its JSON", async () => {
    process.env.FAKE_CLAUDE_AGENTS_FILE = join(fixturesDir, "agents-mixed.json");
    const rows = await runAgentsCli(ensureFakeClaudeExecutable());
    expect(rows.length).toBe(9);
  });

  it("maps failures to a visible collection error and keeps polling", async () => {
    process.env.FAKE_CLAUDE_FAIL = "1";
    const c = new Collector({ claudePath: ensureFakeClaudeExecutable(), projectsDir: "/nonexistent", host: { id: "h", displayName: "Mac" }, salt: "x".repeat(16) });
    await c.poll();
    const s = c.snapshot();
    expect(s.collection.status).toBe("error");
    expect(s.collection.message).toMatch(/failed/);
    delete process.env.FAKE_CLAUDE_FAIL;
    process.env.FAKE_CLAUDE_AGENTS_FILE = join(fixturesDir, "agents-interactive.json");
    await c.poll();
    expect(c.snapshot().collection.status).toBe("healthy");
    expect(c.snapshot().sessions.length).toBe(3);
  });

  it("tracks stateSince across transitions", async () => {
    let now = 1_000_000;
    let rows: Array<Record<string, unknown>> = [{ kind: "interactive", sessionId: "x1", pid: 1, status: "busy", cwd: "/a/b", startedAt: 900_000 }];
    const c = new Collector({ claudePath: null, projectsDir: "/nonexistent", host: { id: "h", displayName: "Mac" }, salt: "x".repeat(16), fetchAgents: async () => rows as never, now: () => now });
    await c.poll();
    expect(c.snapshot().sessions[0]!.stateSince).toBeNull(); // unknown on first sight at startup
    now += 5000;
    rows = [{ ...rows[0], status: "idle" }];
    await c.poll();
    expect(c.snapshot().sessions[0]!.stateSince).toBe(new Date(now).toISOString());
    expect(c.snapshot().sessions[0]!.state).toBe("ready");
  });
});

describe("mDNS advertiser", () => {
  it("can be disabled / mocked", () => {
    const a = createAdvertiser(silentLogger, true);
    a.start({ name: "x", port: 1, version: "0", hostId: "h-test" });
    expect(a.status().state).toBe("disabled");
    expect(new NoopAdvertiser({ state: "unsupported", detail: "manual" }).status().state).toBe("unsupported");
  });
});
