export declare const fakeClaudePath: string;
export declare const fixturesDir: string;
export declare function ensureFakeClaudeExecutable(): string;

export declare const ids: {
  busy: string; idle: string; waiting: string; dead: string;
  bgWorking: string; bgBlocked: string; bgDone: string; bgFailed: string; bgStopped: string;
};

export interface FixtureAgent {
  [key: string]: unknown;
  cwd: string;
  kind: string;
  startedAt: number;
  name?: string;
  pid?: number;
  sessionId?: string;
  id?: string;
  status?: string;
  state?: string;
  waitingFor?: string;
}

export declare const agents: {
  interactiveBusy: FixtureAgent;
  interactiveIdle: FixtureAgent;
  interactiveWaiting: FixtureAgent;
  interactiveDead: FixtureAgent;
  backgroundWorking: FixtureAgent;
  backgroundBlocked: FixtureAgent;
  backgroundDone: FixtureAgent;
  backgroundFailed: FixtureAgent;
  backgroundStopped: FixtureAgent;
};
export declare const agentsMixed: FixtureAgent[];
export declare const maliciousNames: string[];

export type HookPayload = Record<string, unknown> & { session_id: string; hook_event_name: string };
export declare const hooks: {
  subagentStart(sessionId: string, agentId: string, agentType?: string): HookPayload;
  subagentStop(sessionId: string, agentId: string, agentType?: string): HookPayload;
  stop(sessionId: string): HookPayload;
  sessionEnd(sessionId: string, reason?: string): HookPayload;
};
export declare function statusLinePayload(
  sessionId: string,
  opts?: { contextPercent?: number | null; fiveHour?: number; sevenDay?: number; resetsInSec?: number },
): Record<string, unknown>;

export declare function slugify(cwd: string): string;
export declare function usageLine(opts: {
  sessionId: string;
  messageId: string;
  requestId: string;
  timestamp: number;
  usage: { input?: number; output?: number; cacheCreation?: number; cacheRead?: number };
  agentId?: string;
  text?: string;
}): string;
export declare function userLine(opts: { sessionId: string; timestamp: number; text?: string }): string;
export declare function busyTranscript(now?: Date): { main: string; subagent: string };
export declare const expectedBusy: { sessionTotal: number; cacheRead: number; today: number };
export declare function createClaudeHome(
  root: string,
  opts?: { now?: Date; withSettings?: boolean },
): { root: string; projects: string; projectDir: string; mainPath: string; subagentPath: string; settingsPath: string };
export declare const userSettings: {
  model: string;
  statusLine: { type: string; command: string; padding: number };
  hooks: Record<string, Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>>;
  permissions: { allow: string[] };
};
