// Builds the publishable get-claudette package:
//   dist/cli.js            the companion service + CLI, bundled with its dependencies (one file)
//   dist/get-claudette.js  `npx get-claudette` entry: no command means "setup"
//   web/                   the Mac settings page (apps/web)
//   sim/                   the simulator (apps/simulator), served at /sim/
// Build the web page and simulator first: pnpm build && pnpm build:sim
import { build } from "esbuild";
import { chmodSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(pkg, "../..");
const need = {
  web: path.join(root, "apps/web/dist/index.html"),
  sim: path.join(root, "apps/simulator/dist/index.html"),
};

if (process.argv.includes("--check")) {
  // prepublishOnly: refuse to publish an incomplete package.
  const missing = ["dist/cli.js", "dist/get-claudette.js", "web/index.html", "sim/index.html"].filter(
    (f) => !existsSync(path.join(pkg, f)),
  );
  if (missing.length) {
    console.error(`✗ get-claudette isn't built (missing ${missing.join(", ")}). Run: pnpm --filter get-claudette build`);
    process.exit(1);
  }
  console.log("✓ get-claudette is built");
  process.exit(0);
}

for (const [name, file] of Object.entries(need)) {
  if (!existsSync(file)) {
    console.error(`✗ ${name} isn't built (${path.relative(root, file)}). Run: pnpm build && pnpm build:sim`);
    process.exit(1);
  }
}

for (const dir of ["dist", "web", "sim"]) rmSync(path.join(pkg, dir), { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, "apps/service/src/cli.ts")],
  outfile: path.join(pkg, "dist/cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "linked",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
writeFileSync(
  path.join(pkg, "dist/get-claudette.js"),
  '#!/usr/bin/env node\n// `npx get-claudette` with no command runs setup; anything else is passed through to `claudette`.\nglobalThis.__claudetteDefaultCommand = "setup";\nawait import("./cli.js");\n',
);
for (const f of ["dist/cli.js", "dist/get-claudette.js"]) chmodSync(path.join(pkg, f), 0o755);

cpSync(path.dirname(need.web), path.join(pkg, "web"), { recursive: true });
cpSync(path.dirname(need.sim), path.join(pkg, "sim"), { recursive: true });
cpSync(path.join(root, "LICENSE"), path.join(pkg, "LICENSE"));

const { version } = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8"));
console.log(`✓ get-claudette ${version} built`);
