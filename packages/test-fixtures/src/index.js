// Synthetic Claude Code fixtures for Claudette tests.
//
// Everything here is made up: session ids, names, paths, agent ids and token
// numbers are invented and do not come from any real machine or transcript.

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to an executable fake `claude` CLI (see fake-claude.mjs). */
export const fakeClaudePath = join(here, "fake-claude.mjs");
/** Directory holding static fixture files. */
export const fixturesDir = join(here, "..", "fixtures");

export function ensureFakeClaudeExecutable() {
  chmodSync(fakeClaudePath, 0o755);
  return fakeClaudePath;
}

// ------------------------------------------------------------------ ids

export const ids = {
  busy: "00000000-0000-4000-8000-00000000a001",
  idle: "00000000-0000-4000-8000-00000000a002",
  waiting: "00000000-0000-4000-8000-00000000a003",
  dead: "00000000-0000-4000-8000-00000000a004",
  bgWorking: "00000000-0000-4000-8000-00000000b001",
  bgBlocked: "00000000-0000-4000-8000-00000000b002",
  bgDone: "00000000-0000-4000-8000-00000000b003",
  bgFailed: "00000000-0000-4000-8000-00000000b004",
  bgStopped: "00000000-0000-4000-8000-00000000b005",
};

const T0 = Date.UTC(2026, 9, 25, 9, 0, 0); // a made-up morning

// ------------------------------------------------------------------ claude agents --json --all

/** One entry per documented shape of `claude agents --json --all`. */
export const agents = {
  interactiveBusy: {
    cwd: "/Users/demo/code/teapot-api",
    kind: "interactive",
    name: "teapot api",
    pid: 41001,
    sessionId: ids.busy,
    startedAt: T0,
    status: "busy",
  },
  interactiveIdle: {
    cwd: "/Users/demo/code/garden-planner",
    kind: "interactive",
    pid: 41002,
    sessionId: ids.idle,
    startedAt: T0 + 60_000,
    status: "idle",
  },
  interactiveWaiting: {
    cwd: "/Users/demo/code/lighthouse",
    kind: "interactive",
    name: "lighthouse docs",
    pid: 41003,
    sessionId: ids.waiting,
    startedAt: T0 + 120_000,
    status: "waiting",
    waitingFor: "permission prompt",
  },
  interactiveDead: {
    cwd: "/Users/demo/code/old-thing",
    kind: "interactive",
    name: "old thing",
    sessionId: ids.dead,
    startedAt: T0 - 3_600_000,
  },
  backgroundWorking: {
    cwd: "/Users/demo/code/teapot-api",
    kind: "background",
    id: "bg-job-working",
    sessionId: ids.bgWorking,
    state: "working",
    pid: 42001,
    status: "busy",
    startedAt: T0 + 300_000,
    name: "nightly lint sweep",
  },
  backgroundBlocked: {
    cwd: "/Users/demo/code/lighthouse",
    kind: "background",
    id: "bg-job-blocked",
    sessionId: ids.bgBlocked,
    state: "blocked",
    pid: 42002,
    status: "waiting",
    waitingFor: "input needed",
    startedAt: T0 + 360_000,
  },
  backgroundDone: {
    cwd: "/Users/demo/code/garden-planner",
    kind: "background",
    id: "bg-job-done",
    sessionId: ids.bgDone,
    state: "done",
    startedAt: T0 + 420_000,
  },
  backgroundFailed: {
    cwd: "/Users/demo/code/garden-planner",
    kind: "background",
    id: "bg-job-failed",
    state: "failed",
    startedAt: T0 + 480_000,
  },
  backgroundStopped: {
    cwd: "/Users/demo/code/teapot-api",
    kind: "background",
    id: "bg-job-stopped",
    state: "stopped",
    startedAt: T0 + 540_000,
  },
};

/** A realistic mixed list, as the CLI would print it. */
export const agentsMixed = Object.values(agents);

/** Session names that try to be nasty. They must be treated as plain data. */
export const maliciousNames = [
  "<script>alert('pwned')</script>",
  "'; DROP TABLE sessions; --",
  "\u001b[31mred\u001b[0m\u0000nul",
  "🍵".repeat(40),
  "../../../../etc/passwd",
  "x".repeat(500),
];

// ------------------------------------------------------------------ hooks

const hookCommon = (sessionId, event) => ({
  session_id: sessionId,
  transcript_path: `/Users/demo/.claude/projects/-Users-demo-code-teapot-api/${sessionId}.jsonl`,
  cwd: "/Users/demo/code/teapot-api",
  permission_mode: "default",
  hook_event_name: event,
});

export const hooks = {
  subagentStart(sessionId, agentId, agentType = "Explore") {
    return { ...hookCommon(sessionId, "SubagentStart"), agent_id: agentId, agent_type: agentType };
  },
  subagentStop(sessionId, agentId, agentType = "Explore") {
    return {
      ...hookCommon(sessionId, "SubagentStop"),
      agent_id: agentId,
      agent_type: agentType,
      stop_hook_active: false,
      agent_transcript_path: `/Users/demo/.claude/projects/x/${sessionId}/subagents/agent-${agentId}.jsonl`,
      last_assistant_message: "SECRET-CONTENT: the teapot recipe is 42 leaves",
    };
  },
  stop(sessionId) {
    return { ...hookCommon(sessionId, "Stop"), stop_hook_active: false, last_assistant_message: "SECRET-CONTENT done" };
  },
  sessionEnd(sessionId, reason = "prompt_input_exit") {
    return { ...hookCommon(sessionId, "SessionEnd"), reason };
  },
};

export function statusLinePayload(sessionId, { contextPercent = 42, fiveHour = 23.5, sevenDay = 41.2, resetsInSec = 7200 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    hook_event_name: "Status",
    session_id: sessionId,
    transcript_path: `/Users/demo/.claude/projects/x/${sessionId}.jsonl`,
    cwd: "/Users/demo/code/teapot-api",
    model: { id: "claude-demo", display_name: "Demo" },
    workspace: { current_dir: "/Users/demo/code/teapot-api", project_dir: "/Users/demo/code/teapot-api" },
    version: "2.1.191",
    cost: { total_cost_usd: 0.01 },
    context_window: { used_percentage: contextPercent, context_window_size: 200000 },
    rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: now + resetsInSec },
      seven_day: { used_percentage: sevenDay, resets_at: now + 3 * 86400 },
    },
  };
}

// ------------------------------------------------------------------ transcripts

/** Claude Code's project-dir slug for a cwd (we only use it to lay out fixtures). */
export function slugify(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function usageLine({ sessionId, messageId, requestId, timestamp, usage, agentId, text = "made-up reply" }) {
  const rec = {
    parentUuid: null,
    isSidechain: Boolean(agentId),
    ...(agentId ? { agentId } : {}),
    message: {
      model: "claude-demo",
      id: messageId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      usage: {
        input_tokens: usage.input ?? 0,
        cache_creation_input_tokens: usage.cacheCreation ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        output_tokens: usage.output ?? 0,
        service_tier: "standard",
      },
    },
    requestId,
    type: "assistant",
    uuid: `${messageId}-${Math.random().toString(16).slice(2, 10)}`,
    timestamp: new Date(timestamp).toISOString(),
    cwd: "/Users/demo/code/teapot-api",
    sessionId,
    version: "2.1.191",
  };
  return JSON.stringify(rec);
}

export function userLine({ sessionId, timestamp, text = 'please check the "usage" docs' }) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    timestamp: new Date(timestamp).toISOString(),
    sessionId,
  });
}

/**
 * The standard transcript for `ids.busy`: three distinct API responses, the
 * first streamed as three content blocks (same message id repeated), plus one
 * response from yesterday. Main thread + one subagent file.
 *
 * Expected (see `expectedBusy`):
 *   main today:    m1 (100+50+1000, cr 5000), m2 (10+20+0, cr 8000)
 *   main earlier:  m0 (1+2+3, cr 4)  [timestamp = startOfToday - 1h]
 *   subagent today: s1 (7+8+9, cr 10), s2 (1+1+1, cr 1)
 */
export function busyTranscript(now = new Date()) {
  const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayTs = Math.max(sod + 60_000, now.getTime() - 60_000);
  const sid = ids.busy;
  const main = [
    usageLine({ sessionId: sid, messageId: "msg_m0", requestId: "req_0", timestamp: sod - 3_600_000, usage: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 } }),
    userLine({ sessionId: sid, timestamp: todayTs - 5000 }),
    usageLine({ sessionId: sid, messageId: "msg_m1", requestId: "req_1", timestamp: todayTs, usage: { input: 100, output: 50, cacheCreation: 1000, cacheRead: 5000 } }),
    usageLine({ sessionId: sid, messageId: "msg_m1", requestId: "req_1", timestamp: todayTs + 1, usage: { input: 100, output: 50, cacheCreation: 1000, cacheRead: 5000 } }),
    usageLine({ sessionId: sid, messageId: "msg_m1", requestId: "req_1", timestamp: todayTs + 2, usage: { input: 100, output: 50, cacheCreation: 1000, cacheRead: 5000 } }),
    usageLine({ sessionId: sid, messageId: "msg_m2", requestId: "req_2", timestamp: todayTs + 3, usage: { input: 10, output: 20, cacheCreation: 0, cacheRead: 8000 } }),
  ];
  const sub = [
    usageLine({ sessionId: sid, agentId: "a1", messageId: "msg_s1", requestId: "req_s1", timestamp: todayTs + 4, usage: { input: 7, output: 8, cacheCreation: 9, cacheRead: 10 } }),
    usageLine({ sessionId: sid, agentId: "a1", messageId: "msg_s1", requestId: "req_s1", timestamp: todayTs + 5, usage: { input: 7, output: 8, cacheCreation: 9, cacheRead: 10 } }),
    usageLine({ sessionId: sid, agentId: "a1", messageId: "msg_s2", requestId: "req_s2", timestamp: todayTs + 6, usage: { input: 1, output: 1, cacheCreation: 1, cacheRead: 1 } }),
  ];
  return { main: main.join("\n") + "\n", subagent: sub.join("\n") + "\n" };
}

export const expectedBusy = {
  /** all distinct responses, main + subagent */
  sessionTotal: 6 + 1150 + 30 + 24 + 3,
  cacheRead: 4 + 5000 + 8000 + 10 + 1,
  /** responses timestamped today only */
  today: 1150 + 30 + 24 + 3,
};

/**
 * Lay out a fake Claude config dir (`<root>/projects/<slug>/<sessionId>.jsonl`
 * plus `<sessionId>/subagents/agent-*.jsonl`) and return useful paths.
 */
export function createClaudeHome(root, { now = new Date(), withSettings = true } = {}) {
  const projects = join(root, "projects");
  const slug = slugify(agents.interactiveBusy.cwd);
  const projectDir = join(projects, slug);
  mkdirSync(join(projectDir, ids.busy, "subagents"), { recursive: true });
  const t = busyTranscript(now);
  const mainPath = join(projectDir, `${ids.busy}.jsonl`);
  const subagentPath = join(projectDir, ids.busy, "subagents", "agent-a1.jsonl");
  writeFileSync(mainPath, t.main);
  writeFileSync(subagentPath, t.subagent);
  writeFileSync(join(projectDir, ids.busy, "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore" }));
  // An idle session with an empty transcript in another project.
  const idleDir = join(projects, slugify(agents.interactiveIdle.cwd));
  mkdirSync(idleDir, { recursive: true });
  writeFileSync(join(idleDir, `${ids.idle}.jsonl`), userLine({ sessionId: ids.idle, timestamp: now.getTime() - 10_000 }) + "\n");
  if (withSettings) {
    writeFileSync(join(root, "settings.json"), JSON.stringify(userSettings, null, 2));
  }
  return { root, projects, projectDir, mainPath, subagentPath, settingsPath: join(root, "settings.json") };
}

/** A user's pre-existing Claude settings with their own hooks and status line. */
export const userSettings = {
  model: "opus",
  statusLine: { type: "command", command: "~/bin/my-fancy-statusline.sh", padding: 0 },
  hooks: {
    SubagentStart: [{ matcher: "", hooks: [{ type: "command", command: "echo user-hook >> /tmp/demo-hook.log" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/bin/guard.sh" }] }],
  },
  permissions: { allow: ["Bash(ls:*)"] },
};
