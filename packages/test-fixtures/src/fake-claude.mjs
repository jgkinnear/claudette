#!/usr/bin/env node
// A fake `claude` CLI for tests. Never talks to anything real.
//   claude --version                 -> prints a version line
//   claude agents --json --all       -> prints $FAKE_CLAUDE_AGENTS_FILE (or "[]")
// FAKE_CLAUDE_FAIL=1 makes every command exit 1.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_FAIL === "1") {
  process.stderr.write("fake claude: simulated failure\n");
  process.exit(1);
}
if (args.includes("--version")) {
  process.stdout.write("2.1.191 (Claude Code)\n");
  process.exit(0);
}
if (args[0] === "agents" && args.includes("--json")) {
  const file = process.env.FAKE_CLAUDE_AGENTS_FILE;
  process.stdout.write(file ? readFileSync(file, "utf8") : "[]");
  process.exit(0);
}
process.stderr.write(`fake claude: unsupported args ${args.join(" ")}\n`);
process.exit(2);
