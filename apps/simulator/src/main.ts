import { scenarios, sortSessions, type Scenario, type Snapshot } from "@claudette/protocol";

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
function toScreen(e: PointerEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  const x = Math.round(((e.clientX - r.left) / r.width) * W);
  const y = Math.round(((e.clientY - r.top) / r.height) * H);
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
let hostLabel = "Demo MacBook";
let modeLabel = "Demo mode";
function pushDevice() {
  call("sim_set_device", brightness, reduceMotion ? 1 : 0, hostLabel, modeLabel, tiles ? 1 : 0);
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

let liveTimer: number | undefined;
let lastOk = 0;
let liveSnap: Snapshot | undefined;

async function pollLive() {
  try {
    const res = await fetch("/admin/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    liveSnap = (await res.json()) as Snapshot;
    lastOk = Date.now();
    hostLabel = liveSnap.host.displayName;
    pushSnapshot(liveSnap);
    setLink(0, 0);
    statusEl.textContent = `Live: ${liveSnap.sessions.length} session${liveSnap.sessions.length === 1 ? "" : "s"}`;
  } catch {
    const age = lastOk ? (Date.now() - lastOk) / 1000 : 0;
    setLink(!lastOk || Date.now() - lastOk > OFFLINE_AFTER_MS ? 2 : 1, age);
    statusEl.textContent = lastOk ? "Live: reconnecting…" : "Can't reach the Claudette service on this computer";
  }
}

function startLive() {
  window.clearInterval(demoTimer);
  current = undefined;
  modeLabel = "Live (this computer)";
  pushDevice();
  call("sim_show_dashboard");
  $("mode-live").classList.add("on");
  $("mode-demo").classList.remove("on");
  $("live-pane").hidden = false;
  $("demo-pane").hidden = true;
  params.set("live", "1");
  params.delete("scenario");
  history.replaceState(null, "", `?${params}`);
  void pollLive();
  liveTimer = window.setInterval(pollLive, POLL_MS);
}

function stopLive() {
  window.clearInterval(liveTimer);
  liveTimer = undefined;
  $("mode-live").classList.remove("on");
  $("mode-demo").classList.add("on");
  $("live-pane").hidden = true;
  $("demo-pane").hidden = false;
}

$("mode-live").addEventListener("click", startLive);
$("mode-demo").addEventListener("click", () => runScenario(current ?? scenarios[0]!));

// ---------------------------------------------------------------- platform callbacks

sim.onPlatform = (event, arg, num) => {
  switch (event) {
    case "toggle_pin":
      if (liveTimer) {
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
    case "layout":
      tiles = num === 1;
      saveLayout(tiles ? "tiles" : "list");
      break;
    case "reconnect":
      if (liveTimer) void pollLive();
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
