import { scenarios, sortSessions, type Scenario, type Snapshot } from "@claudette/protocol";
import { RemoteService } from "./remote.js";

const W = 320;
const H = 480;
const POLL_MS = 3000;
const OFFLINE_AFTER_MS = 15_000;

type LinkState = 0 | 1 | 2; // live, stale, offline (cl_link_t)

interface SimModule {
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _sim_init(ms: number): void;
  _sim_tick(ms: number): number;
  _sim_pointer(x: number, y: number, down: number): void;
  _sim_framebuffer(): number;
  _sim_set_snapshot(ptr: number, len: number): number;
  _sim_set_link(link: number, age: number): void;
  ccall(name: string, ret: null, types: string[], args: unknown[]): void;
  lengthBytesUTF8(s: string): number;
  stringToUTF8(s: string, ptr: number, max: number): void;
  onPlatform?: (event: string, arg: string, num: number) => void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("screen");
const ctx = canvas.getContext("2d")!;
const image = ctx.createImageData(W, H);
const statusEl = $("status");
const led = $("led");

const params = new URLSearchParams(location.search);
const start = performance.now();
let skew = 0; // advanced by pump() so tests can run time forward deterministically
const now = () => Math.floor(performance.now() - start + skew);

const factory = (await import(/* @vite-ignore */ new URL("./wasm/claudette.mjs", document.baseURI).href)).default as (
  opts: object,
) => Promise<SimModule>;
const sim = await factory({
  locateFile: (p: string) => new URL(`./wasm/${p}`, document.baseURI).href,
});

// ---------------------------------------------------------------- rendering loop

sim._sim_init(now());
const fb = () => sim._sim_framebuffer();
function render() {
  if (sim._sim_tick(now())) {
    image.data.set(sim.HEAPU8.subarray(fb(), fb() + W * H * 4));
    ctx.putImageData(image, 0, 0);
  }
}
function frame() {
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Exposed for the Playwright tests and for poking around in devtools.
const debug = {
  sim,
  /** Run the UI clock forward by `ms`, rendering as it goes (works in background tabs too). */
  pump(ms = 500) {
    for (let t = 0; t < ms; t += 16) {
      skew += 16;
      render();
    }
  },
  /** Press (and optionally hold) at a screen coordinate, pumping time meanwhile. */
  tap(x: number, y: number, holdMs = 80) {
    sim._sim_pointer(x, y, 1);
    debug.pump(holdMs);
    sim._sim_pointer(x, y, 0);
    debug.pump(300);
  },
  hit: (x: number, y: number) => sim.ccall("sim_debug_hit", "string" as unknown as null, ["number", "number"], [x, y]),
  look: (seed: string) => sim.ccall("sim_debug_look", "string" as unknown as null, ["string"], [seed]),
};
(window as unknown as { claudette: typeof debug }).claudette = debug;

// ---------------------------------------------------------------- input

let down = false;
/** Page coordinates → physical panel pixels (undoing the CSS turn). LVGL then applies its own rotation. */
function toScreen(e: PointerEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  const scale = (rotation % 2 ? r.height : r.width) / W;
  const dx = (e.clientX - (r.left + r.width / 2)) / scale;
  const dy = (e.clientY - (r.top + r.height / 2)) / scale;
  const a = (-90 * rotation * Math.PI) / 180; // inverse of the CSS rotate(90deg * rotation)
  const x = Math.round(dx * Math.cos(a) - dy * Math.sin(a) + W / 2);
  const y = Math.round(dx * Math.sin(a) + dy * Math.cos(a) + H / 2);
  return [Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(H - 1, y))];
}
canvas.addEventListener("pointerdown", (e) => {
  down = true;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // synthetic events (tests) have no capturable pointer
  }
  sim._sim_pointer(...toScreen(e), 1);
});
canvas.addEventListener("pointermove", (e) => {
  sim._sim_pointer(...toScreen(e), down ? 1 : 0);
});
const release = (e: PointerEvent) => {
  down = false;
  sim._sim_pointer(...toScreen(e), 0);
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------------------------------------------------------------- bridge helpers

function withString<T>(s: string, fn: (ptr: number, len: number) => T): T {
  const len = sim.lengthBytesUTF8(s);
  const ptr = sim._malloc(len + 1);
  sim.stringToUTF8(s, ptr, len + 1);
  try {
    return fn(ptr, len);
  } finally {
    sim._free(ptr);
  }
}

const call = (name: string, ...args: (string | number)[]) =>
  sim.ccall(name, null, args.map((a) => (typeof a === "number" ? "number" : "string")), args);

function pushSnapshot(s: Snapshot) {
  const ok = withString(JSON.stringify(s), (p, l) => sim._sim_set_snapshot(p, l));
  if (!ok) console.warn("simulator rejected snapshot", s);
}

function setLink(link: LinkState, ageSec: number) {
  sim._sim_set_link(link, Math.max(0, Math.floor(ageSec)));
  led.className = `led ${["live", "stale", "offline"][link]}`;
}

let brightness = 80;
let reduceMotion = params.get("motion") === "reduce" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Home layout, remembered per browser (falls back to the list if storage is unavailable).
const LAYOUT_KEY = "claudette.layout";
let tiles = params.get("layout") === "tiles" || (params.get("layout") !== "list" && readLayout() === "tiles");
function readLayout(): string | null {
  try {
    return localStorage.getItem(LAYOUT_KEY);
  } catch {
    return null;
  }
}
function saveLayout(value: "tiles" | "list") {
  try {
    localStorage.setItem(LAYOUT_KEY, value);
  } catch {
    // private mode etc.: the choice just won't stick
  }
}
// Screen rotation in quarter turns (0 portrait … 3), remembered like the layout.
const ROTATION_KEY = "claudette.rotation";
let rotation = Number(params.get("rotation") ?? readStored(ROTATION_KEY) ?? 0) & 3;
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the choice just won't stick
  }
}
/** Turn the on-page panel so the picture is upright, like a real device turned on its side. */
const wrap = $("screen-wrap");
function showRotation() {
  wrap.classList.toggle("landscape", rotation % 2 === 1);
  wrap.style.setProperty("--turn", `${90 * rotation}deg`);
}
let hostLabel = "Demo MacBook";
let modeLabel = "Demo mode";
function pushDevice() {
  call("sim_set_device", brightness, reduceMotion ? 1 : 0, hostLabel, modeLabel, tiles ? 1 : 0, rotation);
  showRotation();
  canvas.style.filter = `brightness(${0.35 + (0.65 * brightness) / 100})`;
}

// ---------------------------------------------------------------- demo mode

const pinOverrides = new Map<string, boolean>();
let current: Scenario | undefined;
let demoSnap: Snapshot | undefined;
let demoTimer: number | undefined;
let tick = 0;

/** Apply demo pin toggles, then order sessions exactly like the service does. */
function applyPins(s: Snapshot): Snapshot {
  const out = structuredClone(s);
  for (const sess of out.sessions) {
    const o = pinOverrides.get(sess.id);
    if (o !== undefined) sess.pinned = o;
  }
  const pinned = out.sessions.filter((x) => x.pinned).sort((a, b) => (a.pinOrder ?? 99) - (b.pinOrder ?? 99));
  pinned.forEach((x, i) => (x.pinOrder = i));
  out.sessions.forEach((x) => !x.pinned && (x.pinOrder = null));
  out.sessions = sortSessions(out.sessions);
  return out;
}

function showDemoDashboard() {
  if (!current || !demoSnap) return;
  pushSnapshot(applyPins(demoSnap));
  const lastOk = current.lastOkAgoSec ?? 0;
  setLink(current.link === "live" ? 0 : current.link === "stale" ? 1 : 2, lastOk);
  call("sim_show_dashboard");
  statusEl.textContent = `Demo: ${current.title}`;
}

function runScenario(sc: Scenario) {
  stopLive();
  current = sc;
  tick = 0;
  pinOverrides.clear();
  demoSnap = sc.build(new Date());
  window.clearInterval(demoTimer);
  hostLabel = demoSnap.host.displayName;
  modeLabel = "Demo mode";
  pushDevice();
  document.querySelectorAll(".scenarios button").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.id === sc.id));
  if (params.get("scenario") !== sc.id) {
    params.set("scenario", sc.id);
    params.delete("live");
    history.replaceState(null, "", `?${params}`);
  }

  const ob = sc.onboarding;
  if (ob) {
    setLink(2, 0);
    statusEl.textContent = `Setup: ${sc.title}`;
    if (ob.step === "wifi") call("sim_show_wifi", ob.apName, ob.apPassword, "http://192.168.4.1");
    else if (ob.step === "discover") call("sim_show_hosts", ob.hosts.join("\n"), "Not listed? Add your Mac's address in the setup page.");
    else if (ob.step === "pairing") call("sim_show_pairing", ob.hostName, ob.code);
    else if (ob.step === "connecting") call("sim_show_progress", "Joining Wi-Fi", ob.ssid);
    else call("sim_show_message", "All set!", `Paired with ${ob.hostName}.`, "Show me");
    return;
  }
  showDemoDashboard();
  if (sc.step) {
    demoTimer = window.setInterval(() => {
      demoSnap = sc.step!(demoSnap!, ++tick, new Date());
      pushSnapshot(applyPins(demoSnap));
    }, POLL_MS);
  } else if (sc.link === "live") {
    // Keep timestamps fresh so ages tick naturally.
    demoTimer = window.setInterval(() => {
      demoSnap = { ...demoSnap!, generatedAt: new Date().toISOString() };
    }, POLL_MS);
  }
}

const list = $("scenarios");
for (const sc of scenarios) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.dataset.id = sc.id;
  b.innerHTML = `<span class="t"></span><span class="d"></span>`;
  b.querySelector(".t")!.textContent = sc.title;
  b.querySelector(".d")!.textContent = sc.description;
  b.addEventListener("click", () => runScenario(sc));
  li.append(b);
  list.append(li);
}

// ---------------------------------------------------------------- live mode
//
// Served by the service itself (localhost:3333/sim/) or the Vite dev server (which proxies
// /admin), the page reads the service's local admin API. Anywhere else, like the public demo
// site, it pairs with the service on this computer exactly like a display does (remote.ts).

const LOCAL_SERVICE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const serviceParam = params.get("service")?.replace(/\/+$/, "");
const SERVICE = serviceParam && LOCAL_SERVICE.test(serviceParam) ? serviceParam : "http://localhost:3333";
const remote =
  serviceParam || !(location.pathname.startsWith("/sim") || import.meta.env.DEV) ? new RemoteService(SERVICE) : null;

type Phase = "find" | "unpaired" | "pairing" | "paired";
let phase: Phase = "find";
let pairing: { pairingId: string; secret: string; expires: number } | null = null;
let liveOn = false;
let liveTimer: number | undefined;
let lastOk = 0;
let liveHost = "your Mac";

function enter(p: Phase, error?: string) {
  phase = p;
  $("live-start").hidden = p !== "find";
  $("live-pair").hidden = p !== "unpaired";
  $("live-code").hidden = p !== "pairing";
  $("live-on").hidden = p !== "paired";
  $("pair-host").textContent = liveHost;
  const err = $("live-error");
  err.hidden = !error;
  err.textContent = error ?? "";
  if (p === "find") {
    setLink(2, 0);
    call("sim_show_progress", "Looking for your Mac", SERVICE.replace(/^http:\/\//, ""));
    statusEl.textContent = "Live: waiting for Claudette on this computer";
  } else if (p === "unpaired") {
    setLink(2, 0);
    call("sim_show_progress", `Found ${liveHost}`, "Press Connect to pair");
    statusEl.textContent = "Live: not paired yet";
  } else if (p === "pairing") {
    statusEl.textContent = "Live: waiting for you to approve the code";
  } else {
    call("sim_show_dashboard");
  }
}

function showLive(s: Snapshot) {
  lastOk = Date.now();
  hostLabel = s.host.displayName;
  pushSnapshot(s);
  setLink(0, 0);
  statusEl.textContent = `Live: ${s.sessions.length} session${s.sessions.length === 1 ? "" : "s"}`;
}

function lostLive(unreachable: string) {
  const age = lastOk ? (Date.now() - lastOk) / 1000 : 0;
  setLink(!lastOk || Date.now() - lastOk > OFFLINE_AFTER_MS ? 2 : 1, age);
  statusEl.textContent = lastOk ? "Live: reconnecting…" : unreachable;
}

async function pollLive() {
  if (!remote) {
    try {
      const res = await fetch("/admin/api/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showLive((await res.json()) as Snapshot);
    } catch {
      lostLive("Can't reach the Claudette service on this computer");
    }
    return;
  }
  switch (phase) {
    case "find":
    case "unpaired": {
      const host = await remote.running();
      if (!host) {
        if (phase !== "find") enter("find");
        return;
      }
      liveHost = host;
      if (remote.paired) {
        enter("paired");
        return pollLive();
      }
      if (phase !== "unpaired") enter("unpaired");
      return;
    }
    case "pairing": {
      if (!pairing) return enter("unpaired");
      const result = Date.now() > pairing.expires ? "expired" : await remote.completePairing(pairing.pairingId, pairing.secret).catch(() => "pending" as const);
      if (result === "pending") return;
      pairing = null;
      if (result === "approved") enter("paired");
      else enter("unpaired", result === "denied" ? "The pairing was declined on your Mac." : "That code expired. Connect to get a new one.");
      return;
    }
    case "paired":
      try {
        showLive(await remote.status());
      } catch (e) {
        if ((e as Error).message === "unpaired") enter("unpaired", "This page was unpaired on your Mac. Connect again to pair.");
        else {
          lostLive("Can't reach Claudette on this computer");
          // Gone for a while: remind them how to start it again.
          $("live-start").hidden = Date.now() - lastOk < OFFLINE_AFTER_MS;
        }
      }
  }
}

function scheduleLive() {
  window.clearTimeout(liveTimer);
  if (!liveOn) return;
  liveTimer = window.setTimeout(async () => {
    await pollLive();
    scheduleLive();
  }, phase === "pairing" ? 2000 : POLL_MS);
}

function startLive() {
  window.clearInterval(demoTimer);
  current = undefined;
  liveOn = true;
  modeLabel = "Live (this computer)";
  pushDevice();
  $("mode-live").classList.add("on");
  $("mode-demo").classList.remove("on");
  $("live-pane").hidden = false;
  $("demo-pane").hidden = true;
  params.set("live", "1");
  params.delete("scenario");
  history.replaceState(null, "", `?${params}`);
  if (remote) {
    $("live-hint").textContent = "Shows your real Claude Code sessions. Nothing leaves your computer: this page talks straight to Claudette on localhost.";
    enter(remote.paired ? "paired" : "find");
  } else {
    call("sim_show_dashboard");
  }
  void pollLive().then(scheduleLive);
}

function stopLive() {
  liveOn = false;
  window.clearTimeout(liveTimer);
  liveTimer = undefined;
  pairing = null;
  $("mode-live").classList.remove("on");
  $("mode-demo").classList.add("on");
  $("live-pane").hidden = true;
  $("demo-pane").hidden = false;
}

$("mode-live").addEventListener("click", startLive);
$("mode-demo").addEventListener("click", () => runScenario(current ?? scenarios[0]!));

($("approve-link") as HTMLAnchorElement).href = `${SERVICE}/`;
$("approve-link").textContent = SERVICE.replace(/^http:\/\//, "");
$("copy-cmd").addEventListener("click", () => {
  void navigator.clipboard?.writeText($("start-cmd").textContent ?? "").then(() => {
    $("copy-cmd").textContent = "Copied";
    window.setTimeout(() => ($("copy-cmd").textContent = "Copy"), 1500);
  });
});
$("pair-btn").addEventListener("click", async () => {
  try {
    const p = await remote!.requestPairing();
    pairing = { pairingId: p.pairingId, secret: p.secret, expires: Date.now() + 5 * 60_000 };
    $("pair-code").textContent = p.code;
    call("sim_show_pairing", liveHost, p.code);
    enter("pairing");
    scheduleLive();
  } catch (e) {
    enter("unpaired", (e as Error).message);
  }
});
$("pair-cancel").addEventListener("click", () => {
  pairing = null;
  enter("unpaired");
});
$("unpair-btn").addEventListener("click", () => {
  remote?.forget();
  lastOk = 0;
  enter("unpaired");
});

// ---------------------------------------------------------------- platform callbacks

sim.onPlatform = (event, arg, num) => {
  switch (event) {
    case "toggle_pin":
      if (liveOn && remote) {
        void remote.setPinned(arg, num === 1).then(pollLive);
      } else if (liveOn) {
        void fetch("/admin/api/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Claudette-Admin": "1" },
          body: JSON.stringify({ pins: [{ sessionId: arg, pinned: num === 1 }] }),
        }).then(pollLive);
      } else {
        pinOverrides.set(arg, num === 1);
        if (demoSnap) pushSnapshot(applyPins(demoSnap));
      }
      break;
    case "brightness":
      brightness = num;
      ($("brightness") as HTMLInputElement).value = String(num);
      canvas.style.filter = `brightness(${0.35 + (0.65 * brightness) / 100})`;
      break;
    case "reduce_motion":
      reduceMotion = num === 1;
      ($("motion") as HTMLInputElement).checked = reduceMotion;
      break;
    case "rotation":
      rotation = num & 3;
      store(ROTATION_KEY, String(rotation));
      showRotation();
      break;
    case "layout":
      tiles = num === 1;
      saveLayout(tiles ? "tiles" : "list");
      break;
    case "reconnect":
      if (liveOn) void pollLive();
      break;
    case "select_host": {
      // Walk through the pairing flow, just like the device does.
      const host = current?.onboarding?.step === "discover" ? current.onboarding.hosts[num] ?? "your Mac" : "your Mac";
      call("sim_show_progress", "Saying hello…", `Checking ${host}`);
      window.setTimeout(() => call("sim_show_pairing", host, String(100000 + Math.floor(Math.random() * 900000))), 900);
      window.setTimeout(() => call("sim_show_message", "Paired!", `I'll keep an eye on ${host} now.`, "Let's go"), 5000);
      break;
    }
    case "forget_host":
      runScenario(scenarios.find((s) => s.id === "onboard-discover")!);
      break;
    case "factory_reset":
      runScenario(scenarios.find((s) => s.id === "onboard-wifi")!);
      break;
    case "message_action":
      runScenario(scenarios[0]!);
      break;
  }
};

// ---------------------------------------------------------------- controls

($("brightness") as HTMLInputElement).addEventListener("input", (e) => {
  brightness = Number((e.target as HTMLInputElement).value);
  pushDevice();
});
const motion = $("motion") as HTMLInputElement;
motion.checked = reduceMotion;
motion.addEventListener("change", () => {
  reduceMotion = motion.checked;
  pushDevice();
});

// The board's BOOT button: a quick press turns the screen a quarter turn (same as firmware).
$("boot").addEventListener("click", () => {
  rotation = (rotation + 1) & 3;
  store(ROTATION_KEY, String(rotation));
  pushDevice();
});

const device = $("device");
document.querySelectorAll<HTMLButtonElement>(".zoom button").forEach((b) =>
  b.addEventListener("click", () => {
    device.style.setProperty("--zoom", b.dataset.zoom!);
    document.querySelectorAll(".zoom button").forEach((x) => x.classList.toggle("on", x === b));
  }),
);

pushDevice();
if (params.get("live") === "1") startLive();
else runScenario(scenarios.find((s) => s.id === params.get("scenario")) ?? scenarios[0]!);
