import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const binName = "aiand";
const binPath = pkg.bin?.[binName];
assert.ok(binPath, `package.json must declare bin.${binName} (npm links the CLI from it)`);

const binUrl = new URL(`../${binPath}`, import.meta.url);
const stats = statSync(binUrl);
assert.ok(stats.isFile(), `${binPath} is missing — run npm run build`);

const firstLine = readFileSync(binUrl, "utf8").split("\n", 1)[0];
assert.equal(
  firstLine,
  "#!/usr/bin/env node",
  `${binPath} must start with a node shebang, got: ${firstLine}`,
);
assert.ok(stats.mode & 0o111, `${binPath} is not executable (mode ${stats.mode.toString(8)})`);

const reported = execFileSync(process.execPath, [fileURLToPath(binUrl), "--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
assert.equal(
  reported,
  pkg.version,
  `${binName} --version printed "${reported}" but package.json says "${pkg.version}"`,
);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { COMMANDS } = await import(
  pathToFileURL(join(repoRoot, "dist", "commands", "index.js")).href
);
assert.ok(Array.isArray(COMMANDS), "dist/commands/index.js must export COMMANDS");
assert.ok(COMMANDS.length >= 15, `expected at least 15 commands, got ${COMMANDS.length}`);
for (const command of COMMANDS) {
  assert.ok(command.name, "each command needs a name");
  assert.ok(command.summary, `command ${command.name} needs a summary`);
  assert.equal(typeof command.run, "function", `command ${command.name} needs a run function`);
}

// CI installs a pinned OpenCode, Pi, omp and Copilot for the live tests;
// each must be the release the CLI's install hint names, or the two
// drift apart silently.
const { OPENCODE_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "opencode", "adapter.js")).href
);
const { PI_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "pi", "adapter.js")).href
);
const { OMP_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "omp", "install.js")).href
);
const { COPILOT_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "copilot", "adapter.js")).href
);
const { DSH_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "dsh", "adapter.js")).href
);
const ciYml = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
// One entry per pinned agent install in ci.yml: `regex` captures the pin,
// `expected` is the version the adapter exports, `label` is the
// pin-not-found message, `message` builds the mismatch text from the pin.
const PINS = [
  {
    label: "ci.yml should install a pinned opencode-ai",
    regex: /opencode-ai@([0-9A-Za-z.+-]+)/g,
    expected: OPENCODE_VERSION,
    message: (pin) =>
      `ci.yml installs opencode-ai@${pin} but src/agents/opencode/adapter.ts pins ${OPENCODE_VERSION}`,
  },
  {
    label: "ci.yml should install a pinned pi-coding-agent",
    regex: /pi-coding-agent@([0-9A-Za-z.+-]+)/g,
    expected: PI_VERSION,
    message: (pin) =>
      `ci.yml installs pi-coding-agent@${pin} but src/agents/pi/adapter.ts pins ${PI_VERSION}`,
  },
  // omp installs as a pinned release asset (omp-linux-x64 /
  // omp-windows-x64.exe) from the vX.Y.Z release, digest-checked in
  // ci.yml. Each platform is checked separately so one losing its pin
  // can't hide behind the other's.
  {
    label: "ci.yml should install a pinned omp on Linux via the release asset",
    regex: /oh-my-pi\/releases\/download\/v([0-9.]+)\/omp-linux-x64/g,
    expected: OMP_VERSION,
    message: (pin) =>
      `ci.yml pins the omp-linux-x64 asset at v${pin} on Linux but src/agents/omp/install.ts pins ${OMP_VERSION}`,
  },
  {
    label: "ci.yml should install a pinned omp on Windows via the release asset",
    regex: /oh-my-pi\/releases\/download\/v([0-9.]+)\/omp-windows-x64\.exe/g,
    expected: OMP_VERSION,
    message: (pin) =>
      `ci.yml pins the omp-windows-x64.exe asset at v${pin} on Windows but src/agents/omp/install.ts pins ${OMP_VERSION}`,
  },
  {
    label: "ci.yml should install a pinned @github/copilot",
    regex: /@github\/copilot@([0-9A-Za-z.+-]+)/g,
    expected: COPILOT_VERSION,
    message: (pin) =>
      `ci.yml pins @github/copilot@${pin} but the install hint names ${COPILOT_VERSION}`,
  },
  {
    label: "ci.yml should install a pinned @deepseek-ai/dsh",
    regex: /@deepseek-ai\/dsh@([0-9A-Za-z.+-]+)/g,
    expected: DSH_VERSION,
    message: (pin) =>
      `ci.yml installs @deepseek-ai/dsh@${pin} but src/agents/dsh/adapter.ts pins ${DSH_VERSION}`,
  },
];
for (const { label, regex, expected, message } of PINS) {
  const pins = [...ciYml.matchAll(regex)].map((m) => m[1]);
  assert.ok(pins.length > 0, label);
  for (const pin of pins) {
    assert.equal(pin, expected, message(pin));
  }
}
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
assert.deepEqual(
  runtimeDeps,
  [],
  `the CLI ships no runtime dependencies; found: ${runtimeDeps.join(", ")}`,
);

// Exact versions only: a range lets a fresh install pick up a release nobody
// reviewed. `.npmrc` sets save-exact so `npm install <pkg>` pins by default.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ranged = Object.entries(pkg.devDependencies ?? {}).filter(([, v]) => !EXACT_VERSION.test(v));
assert.deepEqual(
  ranged,
  [],
  `pin devDependencies to exact versions; found: ${ranged.map(([n, v]) => `${n}@${v}`).join(", ")}`,
);

console.log(`check-dist ok: ${binName} v${pkg.version}, 0 runtime deps`);
