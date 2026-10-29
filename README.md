<p align="center"><img src="docs/images/hero.png" alt="Claudette showing Claude Code sessions, a session that needs you, and running subagents" width="900"></p>

# Claudette

A tiny, cute desk display for [Claude Code](https://code.claude.com). It shows your favourite sessions, which ones
are **working**, which **need you**, how many subagents (her *little helpers*) are out, and how many tokens you've
used today. It runs on a small ESP32-S3 touchscreen that sits next to your keyboard, powered from any USB charger.

- **Local-first.** A small service on your Mac reads Claude Code's own status locally. No cloud, no API key.
- **One UI, two runtimes.** The same LVGL C code runs on the device and in your browser.

**[▶ Try it in your browser](https://jgkinnear.github.io/claudette/)**: the real device UI, compiled to WebAssembly,
with demo data. To see your own sessions there, run `npx get-claudette start` on your Mac, choose **Live from my Mac**
and approve the pairing code at <http://localhost:3333>. No hardware needed.

> Claudette is an unofficial hobby project. It is not affiliated with or endorsed by Anthropic.

---

## Build your own

### What you need

| | |
|---|---|
| **Display** | A [Freenove ESP32-S3 Display](https://docs.freenove.com/projects/fnk0104/en/latest/) with a 320×480 touchscreen: the **4.0" (FNK0104S)** or the **3.5" (FNK0104N)**. Both have 16 MB flash and 8 MB PSRAM. Check which size you have: they need different firmware builds. |
| **Cable** | A USB-C *data* cable, needed once for flashing. Afterwards any USB charger will do. |
| **Computer** | A Mac with Claude Code installed, [Node.js 22+](https://nodejs.org) and [pnpm](https://pnpm.io) |
| **Tools** | [PlatformIO Core](https://platformio.org/install/cli) (`brew install platformio`) |

### 1. Set up your Mac

```bash
npx get-claudette
```

This installs the companion service and walks you through setup, which:

- checks for Node and the `claude` CLI, explains what it will read, and asks before changing anything;
- backs up `~/.claude/settings.json`, then **adds** a few small HTTP hooks (subagent start/stop, questions, plus
  stop/end for tidying up). It never replaces your existing hooks or status line, and it can offer an optional
  status line for context % and plan limits;
- installs a LaunchAgent so the service starts at login (no `sudo`), and opens <http://localhost:3333>.

`npx get-claudette status`, `doctor`, `logs` and `uninstall` are there when you need them. Just want to try it without
changing anything? `npx get-claudette start` runs it until you close the terminal.

<details>
<summary>Running from a clone instead</summary>

From the repo (step 2), `pnpm setup:mac` builds the service and runs the same setup from that folder, so keep the
clone where it is. `pnpm claudette status` and friends work from there.
</details>

### 2. Get the code

```bash
git clone https://github.com/jgkinnear/claudette.git
cd claudette
pnpm install
```

### 3. Flash the display

Plug the board in with the data cable, then run the command for your board:

```bash
pnpm flash          # 4.0" FNK0104S
pnpm flash:3.5in    # 3.5" FNK0104N
```

The first build downloads the ESP32 toolchain (a few hundred MB). If the port isn't found, hold **BOOT**, tap **RST**,
and run it again. `pnpm monitor` shows the serial log.

### 4. Join Wi-Fi and pair

1. The display shows a setup network (`Claudette-XXXX`) with a password and a QR code. Join it from your phone, and the
   setup page pops up. Choose your Wi-Fi.
2. The display finds your Mac on the network (via Bonjour). Tap it.
3. It shows a 6-digit code. Type it into <http://localhost:3333> on your Mac.

That's it. Unplug it from the Mac and power it from any USB charger. If your network blocks discovery (office or guest
Wi-Fi), enter your Mac's address manually in the setup page. Recovery, pins and troubleshooting are in
[apps/firmware/README.md](apps/firmware/README.md).

## Using it

- **What's listed:** every Claude Code session that's running right now, plus anything you've pinned. Anything that
  **needs you** (a permission prompt or a question) always comes first, with a pulsing amber card. Pinned sessions are
  next, in your order. They stay listed (as *Stopped*) even after Claude stops their process. Then come working
  sessions, then the rest, most recent first. If that leaves fewer than 6, sessions closed in the last 4 hours fill
  the gaps (as *Stopped*, newest first). The Claude desktop app only keeps a few sessions running at once, so this
  keeps the ones you just used in view. Older history isn't listed unless you pin it.
- **List or tiles:** the button next to the gear switches between big cards plus a compact list, and a grid of
  equal tiles. The display remembers your choice.
- **Portrait or landscape:** a quick press of the board's **BOOT** button (or Settings → Screen → Rotate) turns the UI a
  quarter turn at a time (portrait, landscape,
  and both upside-down variants). In landscape, navigation moves to a rail on the left.
- **Usage at a glance:** a strip along the bottom shows today's tokens and your 5-hour and weekly limits as bars
  (the limits need the optional Claudette status line, and Claude Code only runs status lines in the terminal, not
  the desktop app).
- **Tap** a session for details. **Long-press** it to pin it to the home screen. Pins only affect Claudette's display and
  never change Claude Code's own pinning.
- **Every session gets its own Claudette.** Body colour, headwear and extras are picked from a hash of the session,
  so a session always looks the same on the display and on the Mac page.
- **Swipe** or use the bottom bar to move between **Home**, **Agents** and **Usage**.
- On the Mac page you can pin, reorder and nickname sessions (nicknames are handy if real names are sensitive),
  approve or unpair displays, and see diagnostics.

| On screen | Meaning |
|---|---|
| **Working** (sage, bobbing, sparkles) | Claude is busy |
| **Needs you** (amber, "!" bubble) | Blocked on a permission prompt or a question |
| **Ready** (cup of tea) | Finished. Waiting for your next prompt |
| **Error** / **Stopped** | A background session failed or was stopped |
| **Sleeping** (Zzz) | The display can't reach your Mac. Last seen time shown |
| **Context** | How full a session's context window is (needs the optional status line) |
| **Tokens** | Work done this session: input + output + cache writes. Cache reads are shown separately |

## How it works

```mermaid
flowchart LR
    subgraph mac["Your Mac"]
        cc["Claude Code sessions"]
        svc["Claudette service<br/>(Node, runs at login)"]
        web["Settings page<br/>localhost:3333"]
        cc -- "claude agents --json<br/>(every 5 s)" --> svc
        cc -- "hooks: subagents and<br/>what it's asking" --> svc
        cc -- "transcripts<br/>(token counts only)" --> svc
        svc --- web
    end
    subgraph desk["On your desk"]
        dev["Claudette display<br/>ESP32-S3 + LVGL"]
    end
    sim["Browser simulator<br/>same UI as WebAssembly"]
    svc -. "Bonjour: _claudette._tcp" .-> dev
    dev -- "paired, polls a small JSON snapshot<br/>over Wi-Fi every 3 s" --> svc
    sim -. "demo data or live from your Mac" .-> svc
```

The service polls `claude agents --json --all` for session states and receives Claude Code's hooks for subagents and
for what a waiting session is asking. It also reads token counts and context size from local transcripts (numbers only). The display polls a small authenticated JSON snapshot
every few seconds. Details: [docs/architecture.md](docs/architecture.md).

## Privacy & security

- Nothing leaves your network. The display only ever receives session names, states and counts. It never sees prompts,
  code, file paths or transcript contents.
- Displays must be paired with a code you type on the Mac. Tokens are stored hashed, and you can revoke them.
- The admin page and hook endpoints only answer requests from the Mac itself.
- The live demo site pairs like a display does, using a code you approve. The service only lets that site (and local dev
  servers) call the display API from a browser; the admin API never answers browser pages.
- Display traffic is plain HTTP on your LAN, so use it on networks you trust.

More detail is in [docs/privacy-security.md](docs/privacy-security.md).

## Hacking on it

```bash
pnpm dev:sim        # the device UI in your browser (needs Emscripten: brew install emscripten)
pnpm dev:service    # companion service with demo data, no Claude Code needed
pnpm dev:web        # the Mac settings page (proxies to the service)
pnpm test           # protocol + service tests
pnpm test:visual    # Playwright screenshots of every simulator scenario
```

See [docs/developing.md](docs/developing.md) for the repo layout and how the pieces fit.

## Limitations

- macOS only for the service, for now. Linux and Windows need a startup adapter and mDNS support.
- One Mac per display. One board is supported so far, but adding another is mostly a pin table
  (see the firmware README).
- Context % and plan limits only show up if you enable the optional Claudette status line.
- Firmware updates are over USB. Over-the-air updates aren't implemented.
- The token totals come from Claude Code's local transcripts, which aren't a stable public format. If they change,
  Claudette shows "unavailable" rather than wrong numbers.

## Credits

Original pixel art and code: MIT ([LICENSE](LICENSE)). Built with [LVGL](https://lvgl.io) (MIT),
[LovyanGFX](https://github.com/lovyan03/LovyanGFX) (FreeBSD), [jsmn](https://github.com/zserge/jsmn) (MIT) and
[zod](https://zod.dev) (MIT). Text uses [Nunito](https://github.com/googlefonts/nunito), and icons use Montserrat from LVGL,
both under the SIL Open Font License ([OFL.txt](packages/lvgl-ui/src/fonts/OFL.txt)).
