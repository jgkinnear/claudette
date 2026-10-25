import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Health, PairRequestResponse, Snapshot } from "@claudette/protocol";
import { agents, hooks, ids, maliciousNames, statusLinePayload } from "@claudette/test-fixtures";
import { admin, http, json, startTestService, until, type TestService } from "./helpers.js";

const secretHex = "00112233445566778899aabbccddeeff";
const pairBody = (deviceId = "dev-00000001", pairSecret = secretHex) => ({
  deviceId,
  deviceName: "Claudette 7F2A",
  firmwareVersion: "0.1.0",
  pairSecret,
});

let t: TestService;
let rows = [agents.interactiveBusy, agents.interactiveIdle, agents.interactiveWaiting];

beforeEach(async () => {
  rows = [agents.interactiveBusy, agents.interactiveIdle, agents.interactiveWaiting];
  t = await startTestService({ fetchAgents: async () => rows, intervalMs: 50 });
  await until(() => t.svc.source.ready());
});
afterEach(async () => {
  await t.close();
});

async function pair(deviceId = "dev-00000001"): Promise<string> {
  const req = await http(t.port, "POST", "/api/v1/pair/request", { headers: json, body: pairBody(deviceId) });
  expect(req.status).toBe(200);
  const { pairingId, code } = PairRequestResponse.parse(req.body);
  const ok = await http(t.port, "POST", `/admin/api/pairing/${pairingId}/approve`, { headers: admin, body: { code } });
  expect(ok.status).toBe(200);
  const done = await http(t.port, "POST", "/api/v1/pair/complete", { headers: json, body: { pairingId, pairSecret: secretHex } });
  expect(done.body.status).toBe("approved");
  return done.body.token as string;
}

describe("device API", () => {
  it("health is public and minimal", async () => {
    const r = await http(t.port, "GET", "/api/v1/health");
    expect(r.status).toBe(200);
    expect(Health.parse(r.body).ready).toBe(true);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("unpaired -> 401, bad token -> 401", async () => {
    expect((await http(t.port, "GET", "/api/v1/status")).status).toBe(401);
    expect((await http(t.port, "GET", "/api/v1/status", { headers: { Authorization: "Bearer " + "A".repeat(43) } })).status).toBe(401);
    expect((await http(t.port, "GET", "/api/v1/sessions", { headers: { Authorization: "Basic abc" } })).status).toBe(401);
    expect((await http(t.port, "PATCH", "/api/v1/preferences", { headers: json, body: { pins: [] } })).status).toBe(401);
  });

  it("full pairing flow returns a token once; status works; device view is trimmed and valid", async () => {
    const token = await pair();
    const r = await http(t.port, "GET", "/api/v1/status?view=device", { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const snap = Snapshot.parse(r.body);
    expect(snap.sessions.length).toBe(3);
    expect(snap.sessions[0]!.state).toBe("needs_attention");
    // token is stored hashed only
    const devicesFile = readFileSync(join(t.home, "devices.json"), "utf8");
    expect(devicesFile).not.toContain(token);
    expect(JSON.parse(devicesFile).devices[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const sessions = await http(t.port, "GET", "/api/v1/sessions", { headers: { Authorization: `Bearer ${token}` } });
    expect(sessions.body.sessions.length).toBe(3);
  });

  it("revoked token -> 401", async () => {
    const token = await pair();
    const list = await http(t.port, "GET", "/admin/api/devices");
    const id = list.body.devices[0].id;
    expect(JSON.stringify(list.body)).not.toContain("tokenHash");
    expect((await http(t.port, "DELETE", `/admin/api/devices/${id}`, { headers: admin, body: {} })).status).toBe(200);
    expect((await http(t.port, "GET", "/api/v1/status", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("re-pairing the same device replaces its old token", async () => {
    const t1 = await pair("dev-same-0001");
    const t2 = await pair("dev-same-0001");
    expect((await http(t.port, "GET", "/api/v1/status", { headers: { Authorization: `Bearer ${t1}` } })).status).toBe(401);
    expect((await http(t.port, "GET", "/api/v1/status", { headers: { Authorization: `Bearer ${t2}` } })).status).toBe(200);
  });

  it("device can pin via PATCH /preferences (known sessions only)", async () => {
    const token = await pair();
    const auth = { Authorization: `Bearer ${token}`, ...json };
    const snap = (await http(t.port, "GET", "/api/v1/status", { headers: auth })).body as Snapshot;
    const target = snap.sessions.find((s) => s.state === "ready")!.id;
    const r = await http(t.port, "PATCH", "/api/v1/preferences", { headers: auth, body: { pins: [{ sessionId: target, pinned: true }, { sessionId: "sUnknown", pinned: true }] } });
    expect(r.status).toBe(200);
    expect(r.body.pins).toEqual([target]);
    const after = (await http(t.port, "GET", "/api/v1/status?view=device", { headers: auth })).body as Snapshot;
    // Sessions that need you always come first; the pin is next.
    const firstCalm = after.sessions.find((s) => s.state !== "needs_attention")!;
    expect(firstCalm.id).toBe(target);
    expect(firstCalm.pinned).toBe(true);
    expect((await http(t.port, "PATCH", "/api/v1/preferences", { headers: auth, body: { pins: "nope" } })).status).toBe(400);
    expect((await http(t.port, "PATCH", "/api/v1/preferences", { headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" }, raw: "{}" })).status).toBe(415);
  });
});

describe("pairing security", () => {
  it("wrong pairSecret can't collect the token", async () => {
    const req = await http(t.port, "POST", "/api/v1/pair/request", { headers: json, body: pairBody() });
    const { pairingId, code } = req.body;
    await http(t.port, "POST", `/admin/api/pairing/${pairingId}/approve`, { headers: admin, body: { code } });
    const bad = await http(t.port, "POST", "/api/v1/pair/complete", { headers: json, body: { pairingId, pairSecret: "f".repeat(32) } });
    expect(bad.status).toBe(403);
    expect(bad.text).not.toContain("token");
    const good = await http(t.port, "POST", "/api/v1/pair/complete", { headers: json, body: { pairingId, pairSecret: secretHex } });
    expect(good.body.status).toBe("approved");
  });

  it("replayed pairing completion -> expired; pending before approval", async () => {
    const req = await http(t.port, "POST", "/api/v1/pair/request", { headers: json, body: pairBody() });
    const { pairingId, code } = req.body;
    const pending = await http(t.port, "POST", "/api/v1/pair/complete", { headers: json, body: { pairingId, pairSecret: secretHex } });
    expect(pending.body).toEqual({ status: "pending" });
    await http(t.port, "POST", `/admin/api/pairing/${pairingId}/approve`, { headers: admin, body: { code } });
    await http(t.port, "POST", "/api/v1/pair/complete", { headers: json, body: { pairingId, pairSecret: secretHex } });
    const replay = await http(t.port, "POST", "/api/v1/pair/complete", { headers: json, body: { pairingId, pairSecret: secretHex } });
    expect(replay.body).toEqual({ status: "expired" });
    // approving again also fails
    expect((await http(t.port, "POST", `/admin/api/pairing/${pairingId}/approve`, { headers: admin, body: { code } })).status).toBe(404);
  });

  it("expired pairing codes can't be approved or completed", async () => {
    await t.close();
    let now = Date.now();
    t = await startTestService({ fetchAgents: async () => rows, now: () => now });
    const req = await http(t.port, "POST", "/api/v1/pair/request", { headers: json, body: pairBody() });
    const { pairingId, code } = req.body;
    now += 5 * 60_000 + 1;
    expect((await http(t.port, "POST", `/admin/api/pairing/${pairingId}/approve`, { headers: admin, body: { code } })).status).toBe(404);
    const c = await http(t.port, "POST", "/api/v1/pair/complete", { headers: json, body: { pairingId, pairSecret: secretHex } });
    expect(c.body).toEqual({ status: "expired" });
  });

  it("wrong codes are rejected and five strikes deny the request", async () => {
    const req = await http(t.port, "POST", "/api/v1/pair/request", { headers: json, body: pairBody() });
    const { pairingId, code } = req.body;
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) {
      expect((await http(t.port, "POST", `/admin/api/pairing/${pairingId}/approve`, { headers: admin, body: { code: wrong } })).status).toBe(400);
    }
    expect((await http(t.port, "POST", `/admin/api/pairing/${pairingId}/approve`, { headers: admin, body: { code } })).status).toBe(409);
    const c = await http(t.port, "POST", "/api/v1/pair/complete", { headers: json, body: { pairingId, pairSecret: secretHex } });
    expect(c.body).toEqual({ status: "denied" });
  });

  it("deny works and the admin list never includes the code", async () => {
    const req = await http(t.port, "POST", "/api/v1/pair/request", { headers: json, body: pairBody() });
    const list = await http(t.port, "GET", "/admin/api/pairing");
    expect(list.body.requests.length).toBe(1);
    expect(list.text).not.toContain(req.body.code);
    expect((await http(t.port, "POST", `/admin/api/pairing/${req.body.pairingId}/deny`, { headers: admin, body: {} })).status).toBe(200);
    const c = await http(t.port, "POST", "/api/v1/pair/complete", { headers: json, body: { pairingId: req.body.pairingId, pairSecret: secretHex } });
    expect(c.body).toEqual({ status: "denied" });
  });

  it("at most 5 pending requests, and 10 requests per minute per IP", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await http(t.port, "POST", "/api/v1/pair/request", { headers: json, body: pairBody(`dev-pending-${i}`) })).status).toBe(200);
    }
    expect((await http(t.port, "POST", "/api/v1/pair/request", { headers: json, body: pairBody("dev-pending-x") })).status).toBe(429);
    t.setRemote("192.168.1.50");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await http(t.port, "POST", "/api/v1/pair/request", { headers: json, body: { bad: true } })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("rejects malformed pairing requests and oversized bodies", async () => {
    expect((await http(t.port, "POST", "/api/v1/pair/request", { headers: json, body: { ...pairBody(), pairSecret: "short" } })).status).toBe(400);
    expect((await http(t.port, "POST", "/api/v1/pair/request", { headers: json, raw: "{" })).status).toBe(400);
    expect((await http(t.port, "POST", "/api/v1/pair/request", { headers: json, raw: JSON.stringify({ x: "y".repeat(20_000) }) })).status).toBe(413);
  });
});

describe("admin API", () => {
  it("is reachable from loopback with the right Host", async () => {
    const r = await http(t.port, "GET", "/admin/api/status");
    expect(r.status).toBe(200);
    expect(Snapshot.safeParse(r.body).success).toBe(true);
    expect((await http(t.port, "GET", "/admin/api/status", { headers: { Host: `localhost:${t.port}` } })).status).toBe(200);
    expect((await http(t.port, "GET", "/admin/api/doctor")).status).toBe(200);
  });

  it("non-loopback client -> 403", async () => {
    t.setRemote("192.168.1.23");
    expect((await http(t.port, "GET", "/admin/api/status")).status).toBe(403);
    expect((await http(t.port, "GET", "/")).status).toBe(403);
    expect((await http(t.port, "GET", "/sim/")).status).toBe(403);
  });

  it("bad Host header (DNS rebinding) -> 403", async () => {
    expect((await http(t.port, "GET", "/admin/api/status", { headers: { Host: "evil.example:3333" } })).status).toBe(403);
    expect((await http(t.port, "GET", "/admin/api/status", { headers: { Host: `localhost:${t.port + 1}` } })).status).toBe(403);
  });

  it("mutation without admin header or JSON content type -> 403", async () => {
    expect((await http(t.port, "PATCH", "/admin/api/preferences", { headers: json, body: {} })).status).toBe(403);
    expect((await http(t.port, "PATCH", "/admin/api/preferences", { headers: { "X-Claudette-Admin": "1", "Content-Type": "text/plain" }, raw: "{}" })).status).toBe(403);
    expect((await http(t.port, "PATCH", "/admin/api/preferences", { headers: admin, body: {} })).status).toBe(200);
  });

  it("never answers CORS preflights", async () => {
    const r = await http(t.port, "OPTIONS", "/admin/api/preferences", {
      headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "PATCH" },
    });
    expect(r.status).toBe(405);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("pins, reorders and aliases sessions; malicious aliases are plain data", async () => {
    const snap = (await http(t.port, "GET", "/admin/api/status")).body as Snapshot;
    // Two sessions that don't need you, so pin order alone decides where they go.
    const [a, b] = snap.sessions.filter((s) => s.state !== "needs_attention").map((s) => s.id);
    const needsYou = snap.sessions.filter((s) => s.state === "needs_attention").length;
    let r = await http(t.port, "PATCH", "/admin/api/preferences", { headers: admin, body: { pins: [{ sessionId: a, pinned: true }, { sessionId: b, pinned: true }] } });
    expect(r.body.pinOrder).toEqual([a, b]);
    r = await http(t.port, "PATCH", "/admin/api/preferences", { headers: admin, body: { pinOrder: [b, a] } });
    expect(r.body.pinOrder).toEqual([b, a]);
    r = await http(t.port, "PATCH", "/admin/api/preferences", { headers: admin, body: { aliases: { [a!]: maliciousNames[0], sNope: "x" } } });
    expect(r.body.aliases).toEqual({ [a!]: maliciousNames[0] });
    const after = (await http(t.port, "GET", "/admin/api/status")).body as Snapshot;
    expect(after.sessions[needsYou]!.id).toBe(b);
    expect(after.sessions[needsYou + 1]!.displayName).toBe(maliciousNames[0]);
    expect(Snapshot.safeParse(after).success).toBe(true);
    r = await http(t.port, "PATCH", "/admin/api/preferences", { headers: admin, body: { aliases: { [a!]: null } } });
    expect(r.body.aliases).toEqual({});
    const prefs = JSON.parse(readFileSync(join(t.home, "preferences.json"), "utf8"));
    expect(prefs.pinOrder).toEqual([b, a]);
  });

  it("serves a placeholder at / when the UI isn't built, loopback only", async () => {
    const r = await http(t.port, "GET", "/");
    expect(r.status).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("hook intake", () => {
  const secret = () => JSON.parse(readFileSync(join(t.home, "config.json"), "utf8")).hookSecret as string;

  it("rejects hooks without the secret", async () => {
    expect((await http(t.port, "POST", "/hooks/claude", { headers: json, body: hooks.subagentStart(ids.busy, "a1") })).status).toBe(403);
    expect((await http(t.port, "POST", "/hooks/claude", { headers: { ...json, "X-Claudette-Hook": "wrong" }, body: hooks.subagentStart(ids.busy, "a1") })).status).toBe(403);
    t.setRemote("10.0.0.9");
    expect((await http(t.port, "POST", "/hooks/claude", { headers: { ...json, "X-Claudette-Hook": secret() }, body: hooks.subagentStart(ids.busy, "a1") })).status).toBe(403);
  });

  it("counts subagents from hooks and keeps no message content", async () => {
    const h = { ...json, "X-Claudette-Hook": secret() };
    await http(t.port, "POST", "/hooks/claude", { headers: h, body: hooks.subagentStart(ids.busy, "a1", "Explore") });
    await http(t.port, "POST", "/hooks/claude", { headers: h, body: hooks.subagentStart(ids.busy, "a2", "Plan") });
    await http(t.port, "POST", "/hooks/claude", { headers: h, body: hooks.subagentStart(ids.busy, "a2", "Plan") });
    await http(t.port, "POST", "/hooks/claude", { headers: h, body: hooks.subagentStop(ids.busy, "a1", "Explore") });
    const snap = (await http(t.port, "GET", "/admin/api/status")).body as Snapshot;
    const busy = snap.sessions.find((s) => s.displayName === "teapot api")!;
    expect(busy.subagents).toMatchObject({ active: 1, knownTotal: 2, types: ["Plan"], quality: "observed" });
    expect(snap.collection.hooksInstalled).toBe(true);
    expect(JSON.stringify(snap)).not.toContain("SECRET-CONTENT");
  });

  it("extracts fields from an oversized hook body", async () => {
    const h = { ...json, "X-Claudette-Hook": secret() };
    const big = { ...hooks.subagentStart(ids.busy, "big1", "Explore") } as Record<string, unknown>;
    big.padding = "x".repeat(1_200_000);
    const r = await http(t.port, "POST", "/hooks/claude", { headers: h, body: big });
    expect(r.status).toBe(204);
    const snap = (await http(t.port, "GET", "/admin/api/status")).body as Snapshot;
    expect(snap.sessions.find((s) => s.displayName === "teapot api")!.subagents.active).toBe(1);
  });

  it("clears subagents when the parent session disappears", async () => {
    const h = { ...json, "X-Claudette-Hook": secret() };
    await http(t.port, "POST", "/hooks/claude", { headers: h, body: hooks.subagentStart(ids.busy, "a1") });
    rows = [agents.interactiveIdle];
    await until(async () => ((await http(t.port, "GET", "/admin/api/status")).body as Snapshot).sessions.length === 1);
    rows = [agents.interactiveBusy, agents.interactiveIdle];
    await until(async () => ((await http(t.port, "GET", "/admin/api/status")).body as Snapshot).sessions.length === 2);
    const snap = (await http(t.port, "GET", "/admin/api/status")).body as Snapshot;
    expect(snap.sessions.find((s) => s.displayName === "teapot api")!.subagents.active).toBe(0);
  });

  it("turns permission hooks into a question, with details only when allowed", async () => {
    const h = { ...json, "X-Claudette-Hook": secret() };
    const body = { hook_event_name: "PermissionRequest", session_id: ids.busy, tool_name: "Bash", tool_input: { command: "pnpm test --watch" } };
    expect((await http(t.port, "POST", "/hooks/claude", { headers: h, body })).status).toBe(204); // no decision: Claude asks as usual
    let snap = (await http(t.port, "GET", "/admin/api/status")).body as Snapshot;
    let s = snap.sessions.find((x) => x.displayName === "teapot api")!;
    expect(s.question).toMatchObject({ kind: "permission", title: "Can I run this command?", detail: null, options: [] });
    expect(Snapshot.safeParse(snap).success).toBe(true);
    const r = await http(t.port, "PATCH", "/admin/api/preferences", { headers: admin, body: { questionText: true } });
    expect(r.body.questionText).toBe(true);
    snap = (await http(t.port, "GET", "/admin/api/status")).body as Snapshot;
    s = snap.sessions.find((x) => x.displayName === "teapot api")!;
    expect(s.question?.detail).toBe("pnpm test --watch");
  });

  it("accepts status-line posts for context % and rate limits", async () => {
    const h = { ...json, "X-Claudette-Hook": secret() };
    expect((await http(t.port, "POST", "/hooks/statusline", { headers: json, body: statusLinePayload(ids.busy) })).status).toBe(403);
    expect((await http(t.port, "POST", "/hooks/statusline", { headers: h, body: statusLinePayload(ids.busy, { contextPercent: 42 }) })).status).toBe(204);
    const snap = (await http(t.port, "GET", "/admin/api/status")).body as Snapshot;
    expect(snap.sessions.find((s) => s.displayName === "teapot api")!.context).toMatchObject({ usedPercent: 42, quality: "observed" });
    expect(snap.rateLimits?.fiveHour?.usedPercent).toBe(23.5);
    expect(Snapshot.safeParse(snap).success).toBe(true);
  });
});
