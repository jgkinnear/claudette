// Claudette's pixel art. Original artwork for this project (MIT, like the code).
// Each sprite is a grid of palette keys; "." is transparent.

export const palette = {
  o: "#4A2A22", // outline
  b: "#D97757", // body terracotta
  h: "#EFA488", // highlight
  s: "#B85C40", // shade
  e: "#2B1B17", // eyes
  w: "#FFF6EC", // eye shine
  c: "#F08C7A", // blush
  m: "#7A3426", // mouth
  p: "#F28FAD", // bow
  q: "#C9607F", // bow shade
  k: "#F5EBDD", // cream
  t: "#C8B8A4", // cream shade
  g: "#8FB996", // sage
  G: "#5E8A66", // sage dark
  a: "#E8B04A", // amber
  A: "#A87A22", // amber dark
  r: "#E07A6A", // coral
  z: "#9AA3B2", // grey
  Z: "#5D6676", // grey dark
};

// Body template; rows are swapped in per face (row index -> string).
// Headwear (the classic bow, hats…) is a separate overlay so every session can wear something different.
const BODY = [
  "................",
  "................",
  "....oooooooo....",
  "...obbbbbbbbo...",
  "..obhhbbbbbbbo..",
  "..obhbbbbbbbbo..",
  "..obbbbbbbbbbo..",
  "..obwebbbbwebo..",
  "..obeebbbbeebo..",
  "..obcbbbbbbcbo..",
  "..obbbbmmbbbbo..",
  "..osbbbbbbbbso..",
  "...osbbbbbbso...",
  "....oooooooo....",
  "....oo....oo....",
  "................",
];
const face = (rows) => BODY.map((r, i) => rows[i] ?? r);
const pad16 = (rows) => [...rows, ...Array(16 - rows.length).fill("................")];

export const sprites = {
  face_idle: face({}),
  face_blink: face({ 7: "..obbbbbbbbbbo.." }),
  face_happy: face({
    7: "..obebbbbbbebo..",
    8: "..oebebbbbebeo..",
    10: "..obbbmbbmbbbo..",
    11: "..osbbbmmbbbso..",
  }),
  face_alert: face({
    10: "..obbbbmmbbbbo..",
    11: "..osbbbmmbbbso..",
  }),
  face_sleep: face({ 7: "..obbbbbbbbbbo..", 10: "..obbbbbbbbbbo.." }),
  face_dizzy: face({
    6: "..oebebbbbebeo..",
    7: "..obebbbbbbebo..",
    8: "..oebebbbbebeo..",
    10: "..obbbmmmmbbbo..",
  }),

  // Headwear and extras: 16×16 overlays aligned to the face grid.
  // p/q are recoloured per look (accent / accent shade); o/b/h/s follow the body.
  hw_bow: pad16([
    "................",
    "..........qp.pq.",
    "..........ppqpp.",
    "..........qp.pq.",
  ]),
  hw_beanie: pad16([
    ".......oo.......",
    "......okko......",
    "....oppppppo....",
    "...oppppppppo...",
    "..oqqqqqqqqqqo..",
  ]),
  hw_party: pad16([
    "...........k....",
    "..........opo...",
    ".........oqppo..",
    "........oppqppo.",
  ]),
  hw_headphones: pad16([
    "................",
    ".....oooooo.....",
    "....oqqqqqqo....",
    "...oq......qo...",
    "..oq........qo..",
    "..oq........qo..",
    ".opp........ppo.",
    ".opp........ppo.",
    ".opp........ppo.",
    "..oo........oo..",
  ]),
  ex_glasses: pad16([
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "...zzzz..zzzz...",
    "...z..z..z..z...",
    "...z..zzzz..z...",
    "...zzzz..zzzz...",
  ]),
  ex_freckles: pad16([
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "...s.s....s.s...",
  ]),

  // Accessories (drawn next to / on top of the face)
  tea: [
    "..z.z...",
    "...z.z..",
    "........",
    "okkkkko.",
    "okttkkoo",
    "okkkkkoo",
    ".okkko..",
    "..ooo...",
  ],
  bang: [
    ".oooooo.",
    "okkkkkko",
    "okkaakko",
    "okkaakko",
    "okkaakko",
    "okkkkkko",
    "okkaakko",
    ".oooooo.",
    "..oo....",
  ],
  zzz: [
    ".....zzz",
    "......z.",
    ".....zzz",
    "zzzz....",
    "..z.....",
    ".z......",
    "zzzz....",
  ],
  sparkle1: [
    "...a...",
    "...a...",
    ".aakaa.",
    "...a...",
    "...a...",
  ],
  sparkle2: [
    ".......",
    "...k...",
    "..kak..",
    "...k...",
    ".......",
  ],
  question: [
    ".zzzz.",
    "zZ..Zz",
    "....Zz",
    "..zZz.",
    "..zz..",
    "......",
    "..zz..",
  ],
  // A tiny helper for each running subagent.
  helper: [
    "........",
    "..oooo..",
    ".oggggo.",
    "oggggggo",
    "ogeggego",
    "oggggggo",
    ".oGGGGo.",
    "..o..o..",
  ],
  helper_hop: [
    "..oooo..",
    ".oggggo.",
    "oggggggo",
    "ogeggego",
    "oggggggo",
    ".oGGGGo.",
    "..o..o..",
    "........",
  ],
  // Layout toggle icons (header).
  ico_grid: [
    "ttt.ttt.",
    "ttt.ttt.",
    "ttt.ttt.",
    "........",
    "ttt.ttt.",
    "ttt.ttt.",
    "ttt.ttt.",
    "........",
  ],
  ico_list: [
    "tt.ttttt",
    "tt.ttttt",
    "........",
    "tt.ttttt",
    "tt.ttttt",
    "........",
    "tt.ttttt",
    "tt.ttttt",
  ],
  heart: [
    ".pp.pp.",
    "pqppppp",
    "pppppqp",
    ".ppppp.",
    "..ppp..",
    "...p...",
  ],
};

// Which sprites are emitted at which integer scales.
export const builds = [
  {
    names: ["face_idle", "face_blink", "face_happy", "face_alert", "face_sleep", "face_dizzy",
      "hw_bow", "hw_beanie", "hw_party", "hw_headphones", "ex_glasses", "ex_freckles"],
    scales: [2, 3, 5],
    recolour: true,
  },
  { names: ["tea", "bang", "zzz", "sparkle1", "sparkle2", "question", "heart"], scales: [2, 3] },
  { names: ["helper", "helper_hop", "ico_grid", "ico_list"], scales: [2] },
];

// ---------------------------------------------------------------- looks
// Every session gets its own Claudette, picked from a hash of its (already opaque) id.
// The same table drives the device, the simulator and the Mac page. Colours stay away
// from the state colours (amber = needs you, coral = error, sage = helpers).

/** Palette slots that a look recolours, in this order, at indices 1..6 of every recolourable sprite. */
export const RECOLOUR_KEYS = ["o", "b", "h", "s", "p", "q"];

/** [outline, body, highlight, shade] */
export const bodies = [
  { name: "terracotta", colours: ["#4A2A22", "#D97757", "#EFA488", "#B85C40"] },
  { name: "peach", colours: ["#5A3324", "#F0A07A", "#F8C6A9", "#CC7D58"] },
  { name: "plum", colours: ["#3A1F30", "#A8678F", "#C996B3", "#7F4A6B"] },
  { name: "slate", colours: ["#26304A", "#7A93C4", "#A8BDE3", "#5A72A3"] },
  { name: "lilac", colours: ["#342848", "#B49BD9", "#D6C8F0", "#8C74B5"] },
  { name: "cocoa", colours: ["#33201A", "#9C6B55", "#C0927B", "#7A4E3B"] },
  { name: "teal", colours: ["#1E3A3F", "#5FA8B3", "#92CDD5", "#448590"] },
  { name: "vanilla", colours: ["#4A3D2E", "#E9D8C0", "#F8F0E2", "#C7B293"] },
];

/** [accent, accent shade] — bows, hats and headphones. */
export const accents = [
  { name: "pink", colours: ["#F28FAD", "#C9607F"] },
  { name: "sky", colours: ["#8EC5F0", "#5A93C4"] },
  { name: "cream", colours: ["#F5EBDD", "#C8B8A4"] },
  { name: "lavender", colours: ["#C3A6F0", "#8F72C4"] },
];

/** Accents that would vanish against a body: bump to the next accent. */
export const clashes = { vanilla: ["cream"], lilac: ["lavender"], slate: ["sky"] };

export const headwear = ["hw_bow", "hw_beanie", "hw_party", "hw_headphones"];
/** Two "none" slots make plain faces the most common. */
export const extras = [null, null, "ex_glasses", "ex_freckles"];

/** FNV-1a, 32-bit, over the UTF-8 bytes of the id. Mirrored in cl_mascot.c. */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The look for a session id. Mirrored in cl_mascot.c (cl_look_for). */
export function lookFor(id) {
  const h = fnv1a(id);
  const body = h % bodies.length;
  const hw = (h >>> 3) % headwear.length;
  let accent = (h >>> 5) % accents.length;
  if ((clashes[bodies[body].name] ?? []).includes(accents[accent].name)) accent = (accent + 1) % accents.length;
  const extra = (h >>> 7) % extras.length;
  return { body, hw, accent, extra };
}

/** The classic Claudette: terracotta with a pink bow. Used for her own header and setup screens. */
export const classicLook = { body: 0, hw: 0, accent: 0, extra: 0 };
