import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { http, startTestService, tempDir, type TestService } from "./helpers.js";

let t: TestService;
let cleanup: () => void;

beforeAll(async () => {
  const d = tempDir();
  cleanup = d.cleanup;
  const web = join(d.dir, "web");
  const sim = join(d.dir, "sim");
  mkdirSync(join(web, "assets"), { recursive: true });
  mkdirSync(sim, { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Claudette</title>");
  writeFileSync(join(web, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(d.dir, "secret.txt"), "do not serve");
  writeFileSync(join(sim, "index.html"), "<!doctype html><title>Sim</title>");
  writeFileSync(join(sim, "ui.wasm"), Buffer.from([0, 97, 115, 109]));
  t = await startTestService({ webDir: web, simDir: sim });
});
afterAll(async () => {
  await t.close();
  cleanup();
});

describe("static UI", () => {
  it("serves the web UI with a strict CSP and SPA fallback", async () => {
    const r = await http(t.port, "GET", "/");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Claudette");
    expect(String(r.headers["content-security-policy"])).toContain("default-src 'self'");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect((await http(t.port, "GET", "/devices")).text).toContain("Claudette");
    expect((await http(t.port, "GET", "/assets/app.js")).headers["content-type"]).toContain("javascript");
    expect((await http(t.port, "GET", "/assets/missing.js")).status).toBe(404);
  });

  it("blocks path traversal", async () => {
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const r = await http(t.port, "GET", p);
      expect(r.text).not.toContain("do not serve");
    }
  });

  it("serves the simulator under /sim/ for loopback only", async () => {
    expect((await http(t.port, "GET", "/sim")).status).toBe(302);
    expect((await http(t.port, "GET", "/sim/")).text).toContain("Sim");
    expect((await http(t.port, "GET", "/sim/ui.wasm")).headers["content-type"]).toBe("application/wasm");
    t.setRemote("192.168.0.4");
    expect((await http(t.port, "GET", "/sim/")).status).toBe(403);
    t.setRemote("127.0.0.1");
  });
});
