#!/usr/bin/env node
/**
 * Build the firmware and merge bootloader + partition table + boot_app0 + app
 * into one image that flashes at offset 0x0 (for the browser web flasher and
 * `esptool.py write_flash 0x0 <file>`). Writes:
 *
 *   dist/claudette-<env>.bin          merged image
 *   dist/claudette-<env>.bin.sha256   "<hex>  <file>" (sha256sum format)
 *   dist/claudette-<env>.json         version, board, size, sha256
 *
 * Usage: node scripts/merge.mjs [env]   (default env: freenove-s3-4in)
 * Uses PlatformIO's own esptool (tool-esptoolpy); no separate install needed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.argv[2] || "freenove-s3-4in";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pio = process.env.PIO || "pio";

/* Must match the board settings in platformio.ini (DIO, 80 MHz, 16 MB). */
const CHIP = "esp32s3";
const FLASH_MODE = "dio";
const FLASH_FREQ = "80m";
const FLASH_SIZE = "16MB";

function run(args, opts = {}) {
  return execFileSync(pio, args, { cwd: root, stdio: "inherit", ...opts });
}

const boardConfig = readFileSync(join(root, "include", "board_config.h"), "utf8");
const version = /#define CLAUDETTE_FW_VERSION "([^"]+)"/.exec(boardConfig)?.[1] ?? "0.0.0";

console.log(`Building ${env} (firmware ${version})…`);
run(["run", "-e", env]);

const meta = JSON.parse(
  execFileSync(pio, ["project", "metadata", "-e", env, "--json-output"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
)[env];
if (!meta?.extra?.flash_images || !meta.prog_path) {
  console.error("Could not read flash layout from `pio project metadata`.");
  process.exit(1);
}

const images = [
  ...meta.extra.flash_images,
  { offset: meta.extra.application_offset, path: meta.prog_path.replace(/\.elf$/, ".bin") },
];

const distDir = join(root, "dist");
mkdirSync(distDir, { recursive: true });
const name = `claudette-${env}.bin`;
const out = join(distDir, name);

console.log("Merging:");
for (const img of images) console.log(`  ${img.offset.padEnd(8)} ${img.path}`);

run([
  "pkg",
  "exec",
  "--package",
  "tool-esptoolpy",
  "--",
  "esptool.py",
  "--chip",
  CHIP,
  "merge_bin",
  "-o",
  out,
  "--flash_mode",
  FLASH_MODE,
  "--flash_freq",
  FLASH_FREQ,
  "--flash_size",
  FLASH_SIZE,
  ...images.flatMap((img) => [img.offset, img.path]),
]);

const bin = readFileSync(out);
const sha256 = createHash("sha256").update(bin).digest("hex");
writeFileSync(`${out}.sha256`, `${sha256}  ${name}\n`);
writeFileSync(
  join(distDir, `claudette-${env}.json`),
  JSON.stringify(
    { name: "Claudette", version, board: env, chipFamily: "ESP32-S3", file: name, offset: 0, size: statSync(out).size, sha256 },
    null,
    2,
  ) + "\n",
);

console.log(`\n${name}  ${bin.length} bytes\nsha256 ${sha256}`);
