// Regenerates the LVGL bitmap fonts in src/fonts from Nunito (SIL OFL 1.1).
// Output is committed, so you only need this when changing sizes or glyphs.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../src/fonts");
const fontDir = path.join(path.dirname(require.resolve("@fontsource/nunito/package.json")), "files");
const conv = require.resolve("lv_font_conv/lv_font_conv.js");

const TEXT = "0x20-0x7E,0xA0-0xFF,0x2013-0x2014,0x2018-0x201D,0x2022,0x2026,0x00B7";
const fonts = [
  { name: "cl_font_12", weight: 700, size: 12, range: TEXT, symbols_from: 14 },
  { name: "cl_font_14", weight: 700, size: 14, range: TEXT, symbols_from: 14 },
  { name: "cl_font_16", weight: 800, size: 16, range: TEXT, symbols_from: 16 },
  { name: "cl_font_20", weight: 800, size: 20, range: TEXT, symbols_from: 20 },
  { name: "cl_font_28", weight: 900, size: 28, range: TEXT, symbols_from: 20 },
  { name: "cl_font_44", weight: 900, size: 44, symbols: "0123456789.,:%-–—kKMB " },
];

for (const f of fonts) {
  const args = [
    conv, "--bpp", "4", "--size", String(f.size), "--format", "lvgl", "--no-compress",
    "--font", path.join(fontDir, `nunito-latin-${f.weight}-normal.woff`),
    ...(f.range ? ["--range", f.range] : ["--symbols", f.symbols]),
    "--lv-include", "lvgl.h", "--lv-font-name", f.name,
    "-o", path.join(out, `${f.name}.c`),
  ];
  execFileSync(process.execPath, args, { stdio: "inherit" });
  const file = path.join(out, `${f.name}.c`);
  // Keep local paths out of the committed header comment.
  let src = readFileSync(file, "utf8").split(fontDir + path.sep).join("").split(out + path.sep).join("");
  // LV_SYMBOL_* icons come from LVGL's built-in Montserrat via the fallback chain.
  if (f.symbols_from) src = src.replace(".fallback = NULL,", `.fallback = &lv_font_montserrat_${f.symbols_from},`);
  writeFileSync(file, src);
  console.log(`generated ${f.name}`);
}
