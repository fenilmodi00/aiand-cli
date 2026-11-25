// Live Pi smoke: the only proof stubs cannot give — a real pinned `pi`
// binary accepting the config `aiand pi on` generates (models.json is
// TypeBox-validated upstream, so schema drift breaks here first) and a
// headless --print round-trip through the loopback mock gateway.
//
// Run by CI after scripts/e2e.mjs (the build job installs the pinned
// @earendil-works/pi-coding-agent). No real gateway, no key: the loopback
// double serves /v1/models and /v1/chat/completions, per the repo rule that
// CLI-error coverage drives through the mock gateway.
//
// Requires: dist/index.js built, `pi` on PATH. Exits non-zero on any failure.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSmokeDouble } from "./smoke-double.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");

const S = mkdtempSync(join(tmpdir(), "aiand-pi-smoke-"));
let doubleChild;
let failed = false;

function fail(message) {
  process.stderr.write(`FAIL ${message}\n`);
  failed = true;
}

try {
  const double = await startSmokeDouble(S);
  doubleChild = double.child;
  const { baseUrl } = double;

  const home = join(S, "home");
  const cfg = join(S, "cfg");
  const env = {
    ...process.env,
    HOME: home,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: cfg,
    AIAND_API_KEY: "sk-e2e-pi-smoke-key-0000000000000000",
    AIAND_BASE_URL: baseUrl,
    // The real pi, never a stub. HOME points at the sandbox so pi reads
    // the config aiand pi on wrote (~/.pi/agent under it).
    PATH: process.env.PATH,
  };
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;

  // 1. Wire with the real CLI.
  const on = JSON.parse(
    execFileSync(process.execPath, [DIST, "pi", "on", "--json"], { env, encoding: "utf8" }),
  );
  if (on.state === "on") process.stdout.write("PASS aiand pi on\n");
  else fail(`aiand pi on: ${JSON.stringify(on)}`);

  // 2. The real pi accepts our generated config and lists our model.
  try {
    const listing = execFileSync("pi", ["--list-models"], {
      env: { ...env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 120_000,
    });
    if (listing.includes("zai-org/glm-5.3"))
      process.stdout.write("PASS pi --list-models lists the aiand model\n");
    else fail(`pi --list-models output lacked the model:\n${listing}`);
  } catch (error) {
    fail(`pi --list-models rejected the config: ${error.stderr ?? error.message}`);
  }

  // 3. Headless round-trip: a real request through the gateway dialect.
  try {
    const printed = execFileSync(
      "pi",
      ["--print", "--provider", "aiand", "--model", "zai-org/glm-5.3", "Say hi"],
      { env: { ...env, NO_COLOR: "1" }, encoding: "utf8", timeout: 180_000 },
    );
    if (printed.includes("echo:zai-org/glm-5.3:effort=high"))
      process.stdout.write("PASS pi --print sends high, the next published level above medium\n");
    else fail(`pi --print round-trip did not send the clamped level:\n${printed}`);
  } catch (error) {
    fail(`pi --print round-trip failed: ${error.stderr ?? error.message}`);
  }
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  doubleChild?.kill();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
