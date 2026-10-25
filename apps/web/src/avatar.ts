import { html } from "htm/preact";
import {
  accents,
  bodies,
  classicLook,
  extras,
  headwear,
  lookFor,
  palette,
  sprites,
  type Look,
} from "@claudette/lvgl-ui/sprites";
import type { Session } from "./api.js";

// The same pixel Claudettes as the device: same art, same palettes, same look per session id.

const FACE: Record<Session["state"], string> = {
  working: "face_idle",
  needs_attention: "face_alert",
  ready: "face_happy",
  failed: "face_dizzy",
  stopped: "face_sleep",
  unknown: "face_idle",
};

function colourMap(look: Look): Record<string, string> {
  const [o, b, h, s] = bodies[look.body]!.colours;
  const [p, q] = accents[look.accent]!.colours;
  return { ...palette, o, b, h, s, p, q };
}

/** One <rect> per horizontal run of the same colour keeps the SVG small. */
function rects(layers: string[], colours: Record<string, string>) {
  const out: { x: number; y: number; w: number; fill: string }[] = [];
  for (const name of layers) {
    const rows = sprites[name];
    if (!rows) continue;
    rows.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const key = row[x]!;
        let w = 1;
        while (row[x + w] === key) w++;
        if (key !== ".") out.push({ x, y, w, fill: colours[key] ?? "#000" });
        x += w;
      }
    });
  }
  return out;
}

export function Claudette(props: { id?: string; state?: Session["state"]; size?: number; title?: string }) {
  const look = props.id ? lookFor(props.id) : classicLook;
  const layers = [FACE[props.state ?? "ready"], headwear[look.hw]!, extras[look.extra]].filter(
    (l): l is string => Boolean(l),
  );
  const size = props.size ?? 40;
  return html`<svg
    class="claudette"
    viewBox="0 0 16 16"
    width=${size}
    height=${size}
    shape-rendering="crispEdges"
    role=${props.title ? "img" : undefined}
    aria-hidden=${props.title ? undefined : "true"}
  >
    ${props.title ? html`<title>${props.title}</title>` : null}
    ${rects(layers, colourMap(look)).map((r) => html`<rect x=${r.x} y=${r.y} width=${r.w} height="1" fill=${r.fill} />`)}
  </svg>`;
}
