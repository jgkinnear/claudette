import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { Logger } from "./log.js";

export interface AdvertiserStatus {
  state: "advertising" | "stopped" | "unsupported" | "error" | "disabled";
  detail: string;
}

/** Announces `_claudette._tcp` so devices can find this host. */
export interface Advertiser {
  start(opts: { name: string; port: number; version: string; hostId: string }): void;
  stop(): void;
  status(): AdvertiserStatus;
}

export class NoopAdvertiser implements Advertiser {
  constructor(private why: AdvertiserStatus = { state: "disabled", detail: "mDNS disabled" }) {}
  start(): void {}
  stop(): void {}
  status(): AdvertiserStatus {
    return this.why;
  }
}

const DNS_SD = "/usr/bin/dns-sd";

/** macOS: use the system `dns-sd -R` (Bonjour) — no npm dependency. */
export class DnsSdAdvertiser implements Advertiser {
  private child: ChildProcess | null = null;
  private st: AdvertiserStatus = { state: "stopped", detail: "not started" };
  private restarts = 0;
  private stopping = false;
  private opts: { name: string; port: number; version: string; hostId: string } | null = null;
  private onExit = () => this.child?.kill();

  constructor(private log: Logger) {}

  start(opts: { name: string; port: number; version: string; hostId: string }): void {
    this.opts = opts;
    this.stopping = false;
    this.spawn();
    process.once("exit", this.onExit);
  }

  private spawn(): void {
    if (!this.opts) return;
    const { name, port, hostId } = this.opts;
    const instance = Buffer.from(name, "utf8").subarray(0, 63).toString("utf8").replace(/\uFFFD$/, "");
    const args = ["-R", instance, "_claudette._tcp", "local", String(port), "v=1", `name=${instance}`, `id=${hostId}`];
    const child = spawn(DNS_SD, args, { stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    this.st = { state: "advertising", detail: `_claudette._tcp on port ${port}` };
    child.on("error", (err) => {
      this.st = { state: "error", detail: `dns-sd failed: ${err.message}` };
    });
    child.on("exit", (code) => {
      this.child = null;
      if (this.stopping) return;
      this.st = { state: "error", detail: `dns-sd exited (${code ?? "signal"})` };
      this.log.warn(`mdns: dns-sd exited unexpectedly (${code ?? "signal"})`);
      if (this.restarts < 5) {
        this.restarts++;
        setTimeout(() => !this.stopping && this.spawn(), 10_000).unref();
      }
    });
  }

  stop(): void {
    this.stopping = true;
    process.removeListener("exit", this.onExit);
    this.child?.kill();
    this.child = null;
    this.st = { state: "stopped", detail: "stopped" };
  }

  status(): AdvertiserStatus {
    return this.st;
  }
}

export function createAdvertiser(log: Logger, disabled = false): Advertiser {
  if (disabled) return new NoopAdvertiser();
  if (process.platform === "darwin" && existsSync(DNS_SD)) return new DnsSdAdvertiser(log);
  log.warn("mdns: discovery isn't supported on this platform yet; enter this host's address on the device manually");
  return new NoopAdvertiser({
    state: "unsupported",
    detail: "mDNS not supported on this platform; use manual host entry on the device",
  });
}
