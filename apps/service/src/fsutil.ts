import { mkdirSync, writeFileSync, renameSync, readFileSync, chmodSync, existsSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Create a private directory (0700) if needed. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
}

/**
 * Atomically replace `file` with `data`: write a sibling temp file with the
 * requested mode, fsync via writeFileSync's flush, then rename over the target.
 */
export function atomicWrite(file: string, data: string, mode = 0o600): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, data, { mode, flush: true });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

export function atomicWriteJson(file: string, value: unknown, mode = 0o600): void {
  atomicWrite(file, JSON.stringify(value, null, 2) + "\n", mode);
}

export function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
