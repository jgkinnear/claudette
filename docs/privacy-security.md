# Privacy & security

Claudette may end up on lots of desks, so here is exactly what it touches.

## What the Mac service reads

| Source | What is used | What is ignored |
|---|---|---|
| `claude agents --json --all` | session state, name, start time, kind, `waitingFor` | everything else |
| Subagent hooks (HTTP, loopback) | `hook_event_name`, `session_id`, `agent_id`, `agent_type` | messages, prompts, tool input are dropped on arrival |
| Transcripts `~/.claude/projects/**.jsonl` | only lines containing `"usage"`: message id, timestamp, token counts | all message content is never parsed into memory |
| Optional status line | `session_id`, `context_window.used_percentage`, `rate_limits` | everything else |

The service never writes to Claude Code's data and never runs Claude commands, except for reading
`claude agents`. Setup only **adds** Claudette-owned entries to `~/.claude/settings.json`, after a timestamped backup,
and `claudette uninstall` removes only those.

## What the display receives

A trimmed snapshot: display names (or your nicknames), states, counts and token totals. Session IDs are opaque
hashes. Paths, prompts, code and transcript text are never sent. If a session name is sensitive, give it a nickname on
the Mac page.

## Secrets and where they live

| Secret | Where | Notes |
|---|---|---|
| Device tokens | Mac: `~/Library/Application Support/Claudette/devices.json` (only the SHA-256 is stored) | revoke on the Mac page |
| Device token | Display: NVS flash | wiped by factory reset |
| Hook secret | Mac: Claudette config + `~/.claude/settings.json` | blocks other local apps' casual posts; anyone who can read your settings can read it |
| Wi-Fi password | Display: NVS flash | never logged |

Claudette's folder is mode `0700` and its files `0600`. Logs are scrubbed, and tokens, codes and passwords are never
written to the Mac log or the serial console. Nothing secret lives in this repository. `apps/firmware/include/secrets.h`
(optional, for dev Wi-Fi) is gitignored.

## Network model

- **The admin page, admin API and hook endpoints** only answer `127.0.0.1`/`::1` with a `localhost` Host header
  (to block DNS rebinding). Changes also need an `X-Claudette-Admin` header and a JSON body, which browsers can't send
  cross-site without a CORS preflight, and the service never approves one.
- **The device API** is on your LAN and needs a per-device bearer token. Pairing needs you to type the 6-digit code
  shown on the display. Codes expire after 5 minutes, five wrong guesses cancel the request, and the request is rate
  limited. A random secret binds the request to the device that made it, so another device on the network can't
  collect the token.
- **mDNS** is only used to find the Mac, never to trust it. The display only re-adopts a host whose advertised ID
  matches the one it paired with.
- **Transport is plain HTTP.** On a shared or untrusted network, someone sniffing traffic could read a device token
  and see session names and states (the token can't do anything else except toggle Claudette favourites). Use
  Claudette on networks you trust. TLS with certificate pinning at pairing time is on the roadmap.
- Nothing is exposed to the internet, and Claudette never opens router ports.

## Reporting a problem

Please open a GitHub issue. For anything sensitive, use GitHub's private vulnerability reporting on this repo.
