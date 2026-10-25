// Compiles LVGL + the shared Claudette UI + wasm/sim_main.c to WebAssembly.
// Objects are cached in .cache/sim-obj and rebuilt only when sources change.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureLvgl } from "./fetch-lvgl.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const root = path.resolve(app, "../..");
const ui = path.join(root, "packages/lvgl-ui");
const objDir = path.join(root, ".cache/sim-obj");
const outDir = path.join(app, "public/wasm");
const release = !process.argv.includes("--debug");

const lvgl = await ensureLvgl();

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

const sources = [
  ...walk(path.join(lvgl, "src"), ".c"),
  ...walk(path.join(ui, "src"), ".c"),
  path.join(app, "wasm/sim_main.c"),
];
const cflags = [
  release ? "-O2" : "-O0",
  "-DLV_CONF_INCLUDE_SIMPLE",
  `-I${path.join(ui, "include")}`,
  `-I${path.join(ui, "src")}`,
  `-I${lvgl}`,
  "-Wno-deprecated-declarations",
  "-Wno-#warnings",
];
const confStamp = statSync(path.join(ui, "include/lv_conf.h")).mtimeMs;

mkdirSync(objDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

let built = 0;
const objects = [];
const queue = sources.map((src) => {
  const obj = path.join(objDir, createHash("sha1").update(src + cflags.join(" ")).digest("hex").slice(0, 16) + ".o");
  objects.push(obj);
  return { src, obj };
});
const stale = queue.filter(({ src, obj }) => {
  if (!existsSync(obj)) return true;
  const o = statSync(obj).mtimeMs;
  // lvgl-ui headers change often; rebuild our own sources whenever any of them changes.
  const deps = src.startsWith(lvgl) ? [confStamp] : [confStamp, ...walk(path.join(ui, "src"), ".h").map((h) => statSync(h).mtimeMs), ...walk(path.join(ui, "include"), ".h").map((h) => statSync(h).mtimeMs)];
  return statSync(src).mtimeMs > o || deps.some((d) => d > o);
});

const workers = Math.max(2, os.cpus().length);
let next = 0;
async function worker() {
  while (next < stale.length) {
    const { src, obj } = stale[next++];
    await run("emcc", [...cflags, "-c", src, "-o", obj]).catch((e) => {
      console.error(`\n✗ ${path.relative(root, src)}\n${e.stderr || e.message}`);
      process.exit(1);
    });
    built++;
    if (built % 50 === 0 || built === stale.length) process.stdout.write(`  compiled ${built}/${stale.length}\n`);
  }
}
console.log(`Compiling ${stale.length} of ${queue.length} sources with ${workers} workers…`);
await Promise.all(Array.from({ length: workers }, worker));

const exported = [
  "sim_init", "sim_tick", "sim_pointer", "sim_framebuffer", "sim_set_snapshot", "sim_set_link", "sim_set_device",
  "sim_show_dashboard", "sim_show_wifi", "sim_show_progress", "sim_show_hosts", "sim_show_pairing", "sim_show_message",
  "sim_debug_hit", "sim_debug_look", "malloc", "free",
].map((s) => `_${s}`);
await run("emcc", [
  release ? "-O2" : "-O0",
  ...objects,
  "-o", path.join(outDir, "claudette.mjs"),
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sENVIRONMENT=web",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sINITIAL_MEMORY=33554432",
  `-sEXPORTED_FUNCTIONS=${exported.join(",")}`,
  "-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8",
]).catch((e) => {
  console.error(e.stderr || e.message);
  process.exit(1);
});
console.log(`✓ wrote ${path.relative(root, outDir)}/claudette.{mjs,wasm}`);
