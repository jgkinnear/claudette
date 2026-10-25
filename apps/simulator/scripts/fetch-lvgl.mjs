// Downloads the pinned LVGL release into .cache/ and verifies its checksum.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LVGL_VERSION = "9.6.0";
const SHA256 = "b20ee3acc1bba13c62d854f9ebd62e4c51e0b443b1e0225892e86442defa84df";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cache = path.join(root, ".cache");

export async function ensureLvgl() {
  const dir = path.join(cache, `lvgl-${LVGL_VERSION}`);
  if (existsSync(path.join(dir, "lvgl.h"))) return dir;
  mkdirSync(cache, { recursive: true });
  const tarball = path.join(cache, `lvgl-${LVGL_VERSION}.tar.gz`);
  if (!existsSync(tarball)) {
    console.log(`Downloading LVGL ${LVGL_VERSION}…`);
    const res = await fetch(`https://github.com/lvgl/lvgl/archive/refs/tags/v${LVGL_VERSION}.tar.gz`);
    if (!res.ok) throw new Error(`LVGL download failed: ${res.status}`);
    writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  }
  const sum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (sum !== SHA256) throw new Error(`LVGL checksum mismatch (${sum}); delete ${tarball} and retry`);
  execFileSync("tar", ["xzf", tarball, "-C", cache]);
  return dir;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(await ensureLvgl());
