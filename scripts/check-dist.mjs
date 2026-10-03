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

// CI installs a pinned OpenCode for the live tests; it must be the release
// the CLI's install hint names, or the two drift apart silently.
const { OPENCODE_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "opencode", "adapter.js")).href
);
const ciYml = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
const ciPins = [...ciYml.matchAll(/opencode-ai@([0-9A-Za-z.+-]+)/g)].map((m) => m[1]);
assert.ok(ciPins.length > 0, "ci.yml should install a pinned opencode-ai");
for (const pin of ciPins) {
  assert.equal(
    pin,
    OPENCODE_VERSION,
    `ci.yml installs opencode-ai@${pin} but src/agents/opencode/adapter.ts pins ${OPENCODE_VERSION}`,
  );
}

// Same contract for Prime Agent: the pinned release asset (digest-checked in
// ci.yml) is the release the install hint downloads.
const { PRIME_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "prime", "install.js")).href
);
const primePins = [...ciYml.matchAll(/prime-agent\/releases\/download\/v([0-9A-Za-z.+-]+)\//g)].map(
  (m) => m[1],
);
assert.ok(primePins.length > 0, "ci.yml should install a pinned prime-agent");
for (const pin of primePins) {
  assert.equal(
    pin,
    PRIME_VERSION,
    `ci.yml installs prime-agent ${pin} but src/agents/prime/install.ts pins ${PRIME_VERSION}`,
  );
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
