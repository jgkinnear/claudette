# Architecture

```text
 Claude Code on your Mac
   │ claude agents --json --all  (polled every 5 s)
   │ SubagentStart/Stop hooks    (HTTP hooks → loopback)
   │ transcript usage records    (read-only, incremental)
   │ status line (opt-in)        (context % + rate limits)
   ▼
 Companion service (apps/service, Node + TypeScript)
   ├─ collector + normaliser → cached Snapshot (packages/protocol)
   ├─ device API      /api/v1/*      LAN, bearer token per paired device
   ├─ admin API + UI  /admin/*, /    loopback only (apps/web)
   ├─ hook intake     /hooks/claude  loopback only + hook secret
   └─ mDNS advert     _claudette._tcp
   ▼  Wi-Fi (HTTP, trusted LAN)
 ESP32-S3 firmware (apps/firmware) ── shared LVGL UI (packages/lvgl-ui) ── WASM simulator (apps/simulator)
```

mDNS advertises `_claudette._tcp` with TXT `v=1`, `name=<host name>` and
`id=<hostId>`. The display only re-adopts a host whose `id` matches the one it
paired with, so its token never goes to another machine.

**The host owns the intelligence, the display owns the presentation.** The
firmware never sees transcripts, paths or raw Claude session IDs. It gets a
small, bounded JSON snapshot.

## Data model

`packages/protocol/src/schema.ts` defines the protocol (zod schemas, which are
also the TypeScript types). `packages/lvgl-ui/include/cl_model.h` is its bounded C
mirror. If you change one, change the other and bump `SCHEMA_VERSION`.

| Value | Source | When unavailable |
|---|---|---|
| Session list + state | `claude agents --json --all` | collection status `error`, message shown |
| Needs-you reason | `waitingFor` (live process) or background `state=blocked` | `null` |
| Subagents | `SubagentStart` / `SubagentStop` HTTP hooks | `active: null`, quality `unavailable` |
| Session tokens | transcript `message.usage`, deduplicated by message id | `null` |
| Context % | opt-in status line `context_window.used_percentage` | `null` |
| 5h / 7d limits | opt-in status line `rate_limits` | `rateLimits: null` |

State mapping:

| Claude | Claudette |
|---|---|
| `state=working`, or `status=busy` | `working` |
| `state=blocked`, or `status=waiting` (`waitingFor`) | `needs_attention` |
| `state=done`, or `status=idle` | `ready` |
| `state=failed` / `state=stopped` | `failed` / `stopped` |
| interactive session with no live process | `stopped` |
| anything else | `unknown` |

**Tokens.** `sessionTotal` is input + output + cache-creation tokens, summed
over distinct API responses (main thread plus subagents). Cache reads are
reported separately as `cacheRead` because they are re-reads of context rather than new
work, and they would swamp the number. "Today" is the same sum for responses
timestamped on the host's local calendar day.

## HTTP API

The service listens on port `3333` (configurable) on all interfaces, so the
device can reach it. Each route group has its own access rule.

### Device API (LAN): `Authorization: Bearer <device token>`

| Route | Method | Notes |
|---|---|---|
| `/api/v1/health` | GET | Public. `{schemaVersion, service:"claudette", version, hostName, ready}` |
| `/api/v1/status` | GET | Snapshot. `?view=device` trims to ≤ 12 sessions (pinned first), names ≤ 40 bytes |
| `/api/v1/sessions` | GET | `{schemaVersion, generatedAt, sessions}` |
| `/api/v1/preferences` | GET/PATCH | `{pins:[{sessionId, pinned}]}`, which changes Claudette favourites only |
| `/api/v1/pair/request` | POST | Public, rate-limited. `PairRequest` → `{pairingId, code, expiresAt}` |
| `/api/v1/pair/complete` | POST | Public, rate-limited. `{pairingId, pairSecret}` → `pending / approved{token} / denied / expired` |

Tokens are 32 random bytes (base64url). The service stores only their SHA-256
and compares in constant time. Failed bearer auth is limited to 30/min/IP.
Pairing requests expire after 5 minutes, at most 5 can be pending at once,
`/pair/request` allows 10 requests/min/IP and `/pair/complete` allows 40/min/IP
(the device polls it). Five wrong codes deny a request. An unknown, expired or
already-collected `pairingId` returns `{status:"expired"}`, and a wrong
`pairSecret` returns 403.

### Admin API (loopback only): `/admin/api/*`

Requests must come from `127.0.0.1`/`::1` **and** carry a `Host` of
`localhost:<port>` or `127.0.0.1:<port>` (DNS-rebinding guard). Mutating requests
also need `Content-Type: application/json` and `X-Claudette-Admin: 1`, which
forces a CORS preflight that the service never approves.

| Route | Method | Purpose |
|---|---|---|
| `/admin/api/status` | GET | Full snapshot (the web UI and live simulator use this) |
| `/admin/api/preferences` | GET/PATCH | GET → `{pinOrder, aliases}`; PATCH accepts `{pins?, pinOrder?, aliases?}`, with aliases as `{[sessionId]: string \| null}` |
| `/admin/api/pairing` | GET | Pending pairing requests (device name, age, never the code) |
| `/admin/api/pairing/:id/approve` | POST | `{code}`: the user types the code shown on the device |
| `/admin/api/pairing/:id/deny` | POST | |
| `/admin/api/devices` | GET | Paired devices (name, created, last seen) |
| `/admin/api/devices/:id` | DELETE | Revoke |
| `/admin/api/doctor` | GET | Diagnostics: Claude CLI, hooks, status line, mDNS, port |

### Hook intake (loopback only): `POST /hooks/claude`

Claude Code posts hook payloads here directly (`"type": "http"` hooks), with
header `X-Claudette-Hook: <secret>`. Only `hook_event_name`, `session_id`,
`agent_id` and `agent_type` are read. Everything else (messages, prompts, tool input)
is dropped on arrival and never stored. The opt-in status line command posts
`session_id`, `context_window.used_percentage` and `rate_limits` to
`POST /hooks/statusline` under the same rules.

## Which sessions are listed

Every session `claude agents --json --all` reports (live processes, plus background sessions), and every
session pinned in Claudette. When a pinned session disappears from Claude's list, the service keeps it as `stopped`,
using details remembered in `preferences.json` (`remembered`, local only). That survives restarts and is forgotten
on unpin. Order (`compareSessions` in `packages/protocol/src/order.ts`, shared by the service, the simulator and
therefore the device): `needs_attention` first (even above pins), then pinned in pin order, then `working`,
`ready`, `failed`, `unknown`, `stopped`, each newest first.

## Subagent reconciliation

Hooks can be missed, for example while the service is down or when a session is interrupted. The ledger therefore
clears a session's subagents when the session stops, fails, ends or disappears. It also clears a subagent if a `Stop`
hook arrived after that subagent started and the parent has stayed idle for 30 s. Anything left unmatched for 30
minutes is dropped. If the service started after the session, counts are marked `partial`.

## Device lifecycle

1. **No Wi-Fi saved.** The device starts a WPA2 setup access point (`Claudette-XXXX`
   with a random password shown on screen as text and a QR code) and a captive
   portal where you choose the Wi-Fi network. It also has an optional manual host field.
2. **Discover.** The device browses `_claudette._tcp`. If it finds one host, it asks you to confirm it.
   If it finds several, you pick one.
3. **Pair.** `POST /pair/request` returns a 6-digit code, which the device shows. You type it
   into `http://localhost:3333` on the Mac. The device polls `/pair/complete`
   with its secret and stores the token in NVS.
4. **Run.** The device polls `GET /api/v1/status?view=device` every 3 s, with jitter
   and backoff. A failure marks the data *stale*, and after 15 s without data the
   display shows *offline*. It re-resolves mDNS when it comes back. A 401 means the
   device was revoked, so it re-pairs.

## Security model (v1)

- LAN-only. The service never opens router ports and needs no internet.
- Device traffic is **plain HTTP on your LAN**. Anyone sniffing a shared Wi-Fi
  network could read a device token. That token can only read the dashboard
  (session names and states) and toggle favourites. Use Claudette on networks
  you trust. Session aliases let you hide real session names.
- Admin and hook routes are loopback-only. Discovery (mDNS) is never trusted on
  its own, because pairing needs physical sight of the device's code.
- Secrets (device tokens, hook secret, Wi-Fi password) never go in URLs or logs.
  On the Mac they live under `~/Library/Application Support/Claudette` (mode 0700/0600).
  On the device they live in NVS.
- The service is read-only toward Claude Code. Setup only *adds* Claudette-owned hook
  entries (with a backup), and uninstall removes only those.
