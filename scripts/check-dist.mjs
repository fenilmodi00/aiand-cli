
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
  `${binPath} must start with a node shebang, got: ${firstLine}`
);
assert.ok(stats.mode & 0o111, `${binPath} is not executable (mode ${stats.mode.toString(8)})`);

const reported = execFileSync(process.execPath, [binUrl.pathname, "--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
assert.equal(
  reported,
  pkg.version,
  `${binName} --version printed "${reported}" but package.json says "${pkg.version}"`
);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { COMMANDS } = await import(pathToFileURL(join(repoRoot, "dist", "commands", "index.js")).href);
assert.ok(Array.isArray(COMMANDS), "dist/commands/index.js must export COMMANDS");
assert.ok(COMMANDS.length >= 15, `expected at least 15 commands, got ${COMMANDS.length}`);
for (const command of COMMANDS) {
  assert.ok(command.name, "each command needs a name");
  assert.ok(command.summary, `command ${command.name} needs a summary`);
  assert.equal(typeof command.run, "function", `command ${command.name} needs a run function`);
}

const runtimeDeps = Object.keys(pkg.dependencies ?? {});
assert.deepEqual(
  runtimeDeps,
  [],
  `the CLI ships no runtime dependencies; found: ${runtimeDeps.join(", ")}`
);

console.log(`check-dist ok: ${binName} v${pkg.version}, 0 runtime deps`);
