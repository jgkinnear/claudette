import { getScenario, scenarios, type Scenario, type Snapshot } from "@claudette/protocol";
import type { DataSource } from "./collector.js";
import { LimitsStore } from "./limits.js";
import type { Preferences } from "./store.js";

/** Serves a synthetic `@claudette/protocol` scenario. No Claude needed. */
export class MockSource implements DataSource {
  readonly mode = "mock" as const;
  readonly limits = new LimitsStore();
  private scenario: Scenario;
  private current: Snapshot;
  private tick = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    scenarioId: string,
    private host: { id: string; displayName: string },
    private stepMs = 3000,
  ) {
    const s = getScenario(scenarioId);
    if (!s) {
      throw new Error(`Unknown scenario "${scenarioId}". Try one of: ${scenarios.map((x) => x.id).join(", ")}`);
    }
    this.scenario = s;
    this.current = s.build(new Date());
  }

  /** Seed in-memory preferences from the scenario's own pins. */
  seedPreferences(): Preferences {
    const pinned = this.current.sessions
      .filter((s) => s.pinned)
      .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0))
      .map((s) => s.id);
    return { pinOrder: pinned, aliases: {}, remembered: {} };
  }

  start(): void {
    if (this.timer || !this.scenario.step) return;
    this.timer = setInterval(() => {
      this.tick++;
      this.current = this.scenario.step!(this.current, this.tick, new Date());
    }, this.stepMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  ready(): boolean {
    return true;
  }

  snapshot(): Snapshot {
    const now = new Date();
    return {
      ...structuredClone(this.current),
      generatedAt: now.toISOString(),
      host: { ...this.current.host, id: this.host.id, displayName: `${this.host.displayName} (demo)`.slice(0, 40) },
    };
  }

  knownIds(): Set<string> {
    return new Set(this.current.sessions.map((s) => s.id));
  }

  onHook(): void {
    /* mock ignores hooks */
  }

  diagnostics(): Record<string, unknown> {
    return { mode: this.mode, scenario: this.scenario.id, title: this.scenario.title, tick: this.tick };
  }
}
