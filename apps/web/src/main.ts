import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { html } from "htm/preact";
import { api, ApiError, type Device, type Doctor, type PairingRequest, type Preferences, type Session, type Snapshot } from "./api.js";
import { Claudette } from "./avatar.js";
import { ago, duration, tokens, until } from "./format.js";
import "./styles.css";

// ------------------------------------------------------------------ polling

function usePoll<T>(fn: () => Promise<T>, ms: number): { data: T | null; error: Error | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const refresh = useCallback(() => {
    fnRef
      .current()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e));
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      if (!document.hidden) refresh();
    }, ms);
    return () => clearInterval(t);
  }, [ms, refresh]);
  return { data, error, refresh };
}

function useTick(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ------------------------------------------------------------------ bits

// Her own header shows the classic Claudette; every session gets its own look (see avatar.ts).
const MOOD_STATE = { happy: "ready", sleepy: "stopped", alert: "needs_attention" } as const;
const Mascot = ({ mood = "happy" }: { mood?: keyof typeof MOOD_STATE }) =>
  html`<span class="mascot ${mood}"><span class="mascot-body"><${Claudette} state=${MOOD_STATE[mood]} size=${48} /></span></span>`;

const STATE: Record<Session["state"], { label: string; icon: string; blurb: string }> = {
  working: { label: "Working", icon: "●", blurb: "Busy little helper" },
  needs_attention: { label: "Needs you", icon: "!", blurb: "Waiting on you" },
  ready: { label: "Ready", icon: "☕", blurb: "Ready for the next prompt" },
  failed: { label: "Error", icon: "✕", blurb: "Something went wrong" },
  stopped: { label: "Stopped", icon: "■", blurb: "Having a nap" },
  unknown: { label: "Unknown", icon: "?", blurb: "Not sure what it's up to" },
};

const StateChip = ({ state }: { state: Session["state"] }) =>
  html`<span class="chip state-${state}"><span class="chip-icon" aria-hidden="true">${STATE[state].icon}</span>${STATE[state].label}</span>`;

function Card(props: { title: string; subtitle?: string; class?: string; children?: unknown; actions?: unknown }) {
  return html`<section class="card ${props.class ?? ""}">
    <header class="card-head">
      <div>
        <h2>${props.title}</h2>
        ${props.subtitle ? html`<p class="muted">${props.subtitle}</p>` : null}
      </div>
      ${props.actions ?? null}
    </header>
    ${props.children}
  </section>`;
}

// ------------------------------------------------------------------ sessions

function SessionRow(props: {
  s: Session;
  alias: string | undefined;
  now: number;
  canUp: boolean;
  canDown: boolean;
  onPin: (pinned: boolean) => void;
  onMove: (dir: -1 | 1) => void;
  onAlias: (alias: string | null) => void;
}) {
  const { s, now } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const since = duration(s.stateSince, now);
  const helpers = s.subagents.active;
  const save = (e: Event) => {
    e.preventDefault();
    props.onAlias(draft.trim() ? draft.trim() : null);
    setEditing(false);
  };
  return html`<li class="session state-${s.state}">
    <button
      class="icon-btn pin ${s.pinned ? "on" : ""}"
      title=${s.pinned ? "Unpin from your Claudette" : "Pin to your Claudette"}
      aria-pressed=${s.pinned}
      onClick=${() => props.onPin(!s.pinned)}
    >
      ${s.pinned ? "★" : "☆"}
    </button>
    <span class="avatar"><${Claudette} id=${s.id} state=${s.state} size=${40} /></span>
    <div class="session-main">
      ${editing
        ? html`<form class="alias-form" onSubmit=${save}>
            <input
              class="input"
              value=${draft}
              maxLength=${64}
              placeholder="A nickname for this session"
              onInput=${(e: Event) => setDraft((e.target as HTMLInputElement).value)}
              autoFocus
            />
            <button class="btn small" type="submit">Save</button>
            <button class="btn small ghost" type="button" onClick=${() => setEditing(false)}>Cancel</button>
          </form>`
        : html`<div class="session-title">
            <span class="name" title=${s.displayName}>${s.displayName}</span>
            ${props.alias ? html`<span class="tag">nickname</span>` : null}
            ${s.kind === "background" ? html`<span class="tag">background</span>` : null}
          </div>`}
      <div class="session-meta">
        <${StateChip} state=${s.state} />
        ${s.state === "needs_attention" && s.needsAttentionReason
          ? html`<span class="reason">${s.needsAttentionReason}</span>`
          : html`<span class="muted">${STATE[s.state].blurb}${since ? ` · ${since}` : ""}</span>`}
      </div>
      <div class="session-stats">
        <span title="Active subagents (from Claude Code hooks)">
          ${helpers === null
            ? html`<span class="muted">helpers: —</span>`
            : html`🐾 ${helpers} helper${helpers === 1 ? "" : "s"}${s.subagents.types.length ? html` <span class="muted">(${s.subagents.types.join(", ")})</span>` : null}`}
        </span>
        <span title="Session tokens: input + output + cache writes. Cache reads are counted separately.">
          Tokens ${tokens(s.tokens.sessionTotal)}
          ${s.tokens.cacheRead !== null ? html`<span class="muted"> · ${tokens(s.tokens.cacheRead)} cache reads</span>` : null}
        </span>
        ${s.context.usedPercent !== null
          ? html`<span class="ctx" title="Context window in use right now (not lifetime tokens)">
              Context <span class="bar"><span style=${`width:${Math.round(s.context.usedPercent)}%`}></span></span>
              ${Math.round(s.context.usedPercent)}%
            </span>`
          : null}
        <span class="muted">active ${ago(s.lastActivityAt, now)}</span>
      </div>
    </div>
    <div class="session-actions">
      ${s.pinned
        ? html`<button class="icon-btn" title="Move up" disabled=${!props.canUp} onClick=${() => props.onMove(-1)}>↑</button>
            <button class="icon-btn" title="Move down" disabled=${!props.canDown} onClick=${() => props.onMove(1)}>↓</button>`
        : null}
      <button
        class="icon-btn"
        title="Give it a nickname (shown on the device instead of the real name)"
        onClick=${() => {
          setDraft(props.alias ?? s.displayName);
          setEditing(true);
        }}
      >
        ✎
      </button>
      ${props.alias ? html`<button class="icon-btn" title="Clear nickname" onClick=${() => props.onAlias(null)}>↺</button>` : null}
    </div>
  </li>`;
}

function Sessions(props: { snap: Snapshot; prefs: Preferences | null; onChanged: () => void; toast: (m: string) => void }) {
  const now = useTick(5000);
  const { snap, prefs } = props;
  const pinned = snap.sessions.filter((s) => s.pinned).sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
  const rest = snap.sessions.filter((s) => !s.pinned);
  const run = (p: Promise<unknown>) =>
    p.then(props.onChanged).catch((e: Error) => props.toast(e.message));
  const move = (id: string, dir: -1 | 1) => {
    const order = pinned.map((s) => s.id);
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    void run(api.patchPreferences({ pinOrder: order }));
  };
  const row = (s: Session, i: number, list: Session[]) => html`<${SessionRow}
    key=${s.id}
    s=${s}
    alias=${prefs?.aliases[s.id]}
    now=${now}
    canUp=${i > 0}
    canDown=${i < list.length - 1}
    onPin=${(p: boolean) => run(api.patchPreferences({ pins: [{ sessionId: s.id, pinned: p }] }))}
    onMove=${(d: -1 | 1) => move(s.id, d)}
    onAlias=${(a: string | null) => run(api.patchPreferences({ aliases: { [s.id]: a } }))}
  />`;
  const counts = {
    working: snap.sessions.filter((s) => s.state === "working").length,
    needs: snap.sessions.filter((s) => s.state === "needs_attention").length,
  };
  return html`<${Card}
    title="Sessions"
    subtitle=${snap.sessions.length
      ? `${counts.working} working${counts.needs ? ` · ${counts.needs} need${counts.needs === 1 ? "s" : ""} you` : ""} · ${snap.sessions.length} total`
      : undefined}
  >
    ${snap.sessions.length === 0
      ? html`<div class="empty">
          <${Mascot} mood="sleepy" />
          <p>No Claude sessions right now. Start <code>claude</code> in a terminal and it'll pop up here.</p>
        </div>`
      : html`
          <h3 class="section-label">Pinned to your Claudette</h3>
          ${pinned.length
            ? html`<ul class="sessions">${pinned.map(row)}</ul>`
            : html`<p class="muted hint">Tap ☆ to pin a favourite. Pinned sessions show first on the device.</p>`}
          ${rest.length
            ? html`<h3 class="section-label">Everything else</h3>
                <ul class="sessions">${rest.map(row)}</ul>`
            : null}
        `}
  <//>`;
}

// ------------------------------------------------------------------ pairing

function PairingRow(props: { r: PairingRequest; onDone: () => void; toast: (m: string) => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const approve = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.approve(props.r.id, code);
      props.toast(`Paired with ${props.r.deviceName} ✿`);
      props.onDone();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  const deny = async () => {
    await api.deny(props.r.id).catch(() => {});
    props.onDone();
  };
  return html`<li class="pair">
    <div>
      <strong>${props.r.deviceName}</strong>
      <span class="muted"> · firmware ${props.r.firmwareVersion || "?"} · asked ${ago(props.r.createdAt)}</span>
    </div>
    <form class="pair-form" onSubmit=${approve}>
      <label class="sr-only" for=${`code-${props.r.id}`}>Code shown on the device</label>
      <input
        id=${`code-${props.r.id}`}
        class="input code"
        inputmode="numeric"
        autocomplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength=${6}
        placeholder="••••••"
        value=${code}
        onInput=${(e: Event) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, "").slice(0, 6))}
      />
      <button class="btn" type="submit" disabled=${busy || code.length !== 6}>Approve</button>
      <button class="btn ghost" type="button" onClick=${deny}>Deny</button>
    </form>
    ${err ? html`<p class="error-text">${err}</p>` : null}
  </li>`;
}

function Pairing(props: { requests: PairingRequest[] | null; onChanged: () => void; toast: (m: string) => void }) {
  const reqs = props.requests ?? [];
  return html`<${Card}
    title="Pair a Claudette"
    class=${reqs.length ? "highlight" : ""}
    subtitle=${reqs.length
      ? "Type the 6-digit code your Claudette is showing."
      : "Turn on your Claudette and pick this Mac. It'll show a code, and the request will appear here."}
  >
    ${reqs.length
      ? html`<ul class="pairs">${reqs.map((r) => html`<${PairingRow} key=${r.id} r=${r} onDone=${props.onChanged} toast=${props.toast} />`)}</ul>`
      : html`<p class="muted hint">No devices waiting right now.</p>`}
  <//>`;
}

function Devices(props: { devices: Device[] | null; onChanged: () => void; toast: (m: string) => void }) {
  const list = props.devices ?? [];
  const revoke = async (d: Device) => {
    if (!window.confirm(`Unpair "${d.name}"? It will need to pair again to show your sessions.`)) return;
    await api.revoke(d.id).catch((e: Error) => props.toast(e.message));
    props.onChanged();
  };
  return html`<${Card} title="Paired devices">
    ${list.length === 0
      ? html`<p class="muted hint">None yet. Your Claudette will show up here once it's paired.</p>`
      : html`<ul class="devices">
          ${list.map(
            (d) => html`<li key=${d.id}>
              <div>
                <strong>${d.name}</strong>
                <div class="muted small">
                  paired ${new Date(d.createdAt).toLocaleDateString()} · last seen ${ago(d.lastSeenAt)}
                  ${d.firmwareVersion ? ` · fw ${d.firmwareVersion}` : ""}
                </div>
              </div>
              <button class="btn ghost danger small" onClick=${() => revoke(d)}>Unpair</button>
            </li>`,
          )}
        </ul>`}
  <//>`;
}

// ------------------------------------------------------------------ usage + diagnostics

function Usage(props: { snap: Snapshot }) {
  const { snap } = props;
  const rl = snap.rateLimits;
  const win = (label: string, w: { usedPercent: number; resetsAt: string | null } | null) =>
    w
      ? html`<div class="meter">
          <div class="meter-head"><span>${label}</span><span>${Math.round(w.usedPercent)}%</span></div>
          <span class="bar wide"><span style=${`width:${Math.round(w.usedPercent)}%`}></span></span>
          ${w.resetsAt ? html`<div class="muted small">resets in ${until(w.resetsAt)}</div>` : null}
        </div>`
      : null;
  return html`<${Card} title="Today">
    <div class="big-number" title="Input + output + cache-write tokens across all sessions today (cache reads not included)">
      ${tokens(snap.dailyUsage.tokens)}
      <span class="muted small"> tokens</span>
    </div>
    ${rl
      ? html`<div class="meters">${win("5-hour window", rl.fiveHour)}${win("7-day window", rl.sevenDay)}</div>`
      : html`<p class="muted small">Rate-limit windows appear when the Claudette status line is installed (optional).</p>`}
  <//>`;
}

function Diagnostics(props: { doctor: Doctor | null; snap: Snapshot | null }) {
  const d = props.doctor;
  return html`<${Card} title="Diagnostics" subtitle=${d ? `v${d.info.version} · port ${d.info.port}` : undefined}>
    ${d
      ? html`<ul class="checks">
          ${d.checks.map(
            (c) => html`<li class=${c.ok === true ? "ok" : c.ok === false ? "bad" : "info"}>
              <span class="check-icon" aria-hidden="true">${c.ok === true ? "✓" : c.ok === false ? "✕" : "·"}</span>
              <div>
                <div>${c.label}</div>
                <div class="muted small">${c.detail}</div>
                ${c.ok === false && c.fix ? html`<div class="fix small">→ ${c.fix}</div>` : null}
              </div>
            </li>`,
          )}
        </ul>`
      : html`<p class="muted">Checking…</p>`}
    ${props.snap ? html`<p class="muted small">Last session poll: ${ago(props.snap.collection.lastSessionPollAt)}</p>` : null}
  <//>`;
}

// ------------------------------------------------------------------ app

function App() {
  const status = usePoll(api.status, 3000);
  const prefs = usePoll(api.preferences, 5000);
  const pairing = usePoll(api.pairing, 2000);
  const devices = usePoll(api.devices, 5000);
  const doctor = usePoll(api.doctor, 15000);
  const [toastMsg, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const snap = status.data;
  const down = status.error !== null;
  const needs = snap?.sessions.some((s) => s.state === "needs_attention") ?? false;
  const mood = down ? "sleepy" : needs ? "alert" : "happy";
  const refreshPrefs = () => {
    status.refresh();
    prefs.refresh();
  };
  const refreshPairing = () => {
    pairing.refresh();
    devices.refresh();
  };
  const coll = snap?.collection;

  useEffect(() => {
    const n = pairing.data?.requests.length ?? 0;
    document.title = n ? `(${n}) Claudette: pair request` : needs ? "Claudette · needs you" : "Claudette";
  }, [pairing.data, needs]);

  return html`
    <header class="top">
      <div class="brand">
        <${Mascot} mood=${mood} />
        <div>
          <h1>Claudette</h1>
          <p class="muted">${snap ? snap.host.displayName : "your desk companion"}</p>
        </div>
      </div>
      <div class="top-right">
        ${down
          ? html`<span class="pill bad">Can't reach the service</span>`
          : coll
            ? html`<span class="pill ${coll.status}" title=${coll.message ?? ""}>
                ${coll.status === "healthy" ? "All good" : coll.message ?? coll.status}
              </span>`
            : null}
        ${doctor.data?.info.simulatorAvailable ? html`<a class="btn ghost" href="/sim/" target="_blank" rel="noopener">Live simulator ↗</a>` : null}
      </div>
    </header>
    ${doctor.data?.info.mode === "mock"
      ? html`<div class="banner">Demo mode: these sessions are made up. Run <code>claudette start</code> without <code>--mock</code> for the real thing.</div>`
      : null}
    ${down
      ? html`<div class="banner bad">
          Claudette's service isn't answering. Try <code>claudette restart</code>, or <code>claudette doctor</code> to see what's up.
        </div>`
      : null}
    <main class="grid">
      <div class="col">
        ${(pairing.data?.requests.length ?? 0) > 0
          ? html`<${Pairing} requests=${pairing.data!.requests} onChanged=${refreshPairing} toast=${setToast} />`
          : null}
        ${snap ? html`<${Sessions} snap=${snap} prefs=${prefs.data} onChanged=${refreshPrefs} toast=${setToast} />` : html`<${Card} title="Sessions"><p class="muted">Loading…</p><//>`}
      </div>
      <div class="col side">
        ${snap ? html`<${Usage} snap=${snap} />` : null}
        ${(pairing.data?.requests.length ?? 0) === 0
          ? html`<${Pairing} requests=${pairing.data?.requests ?? []} onChanged=${refreshPairing} toast=${setToast} />`
          : null}
        <${Devices} devices=${devices.data?.devices ?? null} onChanged=${refreshPairing} toast=${setToast} />
        <${Diagnostics} doctor=${doctor.data} snap=${snap} />
      </div>
    </main>
    <footer class="foot muted small">
      Claudette reads Claude Code session states and token counts on this Mac. Nothing leaves your network.
      Not affiliated with Anthropic.
    </footer>
    ${toastMsg ? html`<div class="toast" role="status">${toastMsg}</div>` : null}
  `;
}

render(html`<${App} />`, document.getElementById("app")!);
