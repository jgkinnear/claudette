# Developing

## Layout

```text
apps/
  service/     Node + TypeScript companion service and `claudette` CLI
  web/         Mac settings page (Vite + Preact), served by the service at /
  simulator/   Browser shell around the WebAssembly build of the UI, served at /sim/ and on GitHub Pages
  firmware/    ESP32-S3 firmware (PlatformIO, Arduino core, LovyanGFX)
packages/
  protocol/    zod schemas = TypeScript types for the JSON snapshot, plus demo scenarios
  lvgl-ui/     The shared LVGL UI in C (screens, mascot, fonts, JSON → C model)
  test-fixtures/ Synthetic Claude CLI output, hook payloads and transcripts
docs/          Architecture, privacy & security, this file
```

## Toolchains

- Node 22+ and pnpm 10 for everything TypeScript.
- **Emscripten** for the simulator (`brew install emscripten`). LVGL itself is downloaded on the first build and
  checked against a pinned SHA-256 (`apps/simulator/scripts/fetch-lvgl.mjs`).
- **PlatformIO** for the firmware (`brew install platformio`).

## Everyday commands

```bash
pnpm dev:sim            # simulator at http://localhost:5180 (rebuilds the WASM, then Vite)
pnpm dev:service        # service on :3333 with the "tour" demo scenario
pnpm dev:service:real   # service on :3333 with your real Claude Code sessions
pnpm dev:web            # settings page with hot reload, proxied to :3333
pnpm test               # vitest: protocol + service (collector, ledger, tokens, security, settings merge)
pnpm test:visual        # Playwright: every scenario + taps, long-press, pages, settings
pnpm build:firmware     # compile the firmware
pnpm --filter @claudette/firmware merge   # single .bin + sha256 for esptool / web flashers
```

To see your real sessions in the simulator, run the service (`pnpm dev:service:real`, or the installed one), open
<http://localhost:3333/sim/?live=1> and pick **Live from my Mac**.

## Changing the UI

All screens live in `packages/lvgl-ui/src/cl_ui.c`. The look (colours, fonts, helpers) is in `cl_theme.c`, and the
mascot and helpers are in `cl_mascot.c`. Iterate in the simulator, then run `pnpm test:visual` and look at the diffs.
If a change is intentional, update the screenshots with
`pnpm --filter @claudette/simulator exec playwright test --update-snapshots`.

- **Pixel art** lives in `packages/lvgl-ui/scripts/sprites.mjs` as text grids. Run `pnpm --filter @claudette/lvgl-ui sprites`
  to regenerate the C images (4-bit indexed, pre-scaled).
- **Per-session looks** (body colour, headwear, accent colour, glasses/freckles) are defined next to the art in
  `sprites.mjs` (`bodies`, `accents`, `headwear`, `extras`, `lookFor`). The C side mirrors `lookFor` in
  `cl_look_for()` and recolours the 4-bit palettes at runtime. The Mac page imports the same file, and a
  Playwright test checks that the device and JS agree.
- **Fonts** are Nunito, converted with `lv_font_conv`. To change sizes or glyph ranges, edit
  `scripts/gen-fonts.mjs` and run `pnpm --filter @claudette/lvgl-ui fonts`.
- Keep the UI hardware-free. Anything that touches Wi-Fi, NVS or the panel goes through `cl_platform_t` callbacks.

## Changing the data

1. Edit `packages/protocol/src/schema.ts`.
2. Mirror it in `packages/lvgl-ui/include/cl_model.h` and `src/cl_model.c` (bounded sizes!).
3. If old clients can't read the new shape, bump `SCHEMA_VERSION` on both sides.
4. Add or adjust a scenario in `packages/protocol/src/scenarios.ts`. Every scenario is validated by the tests and
   rendered by the visual tests.

## Running the service against a sandbox

State, logs and the Claude config directory can all be redirected, which is handy for trying things without
touching your real setup:

```bash
CLAUDETTE_HOME=/tmp/cl-home CLAUDETTE_LOG_DIR=/tmp/cl-logs pnpm claudette start --port 3399
```

`setup` and `uninstall` also talk to `launchctl`, so test those through the unit tests (`apps/service/test/`),
which use temp directories and a fake `exec`, rather than by running them by hand.
