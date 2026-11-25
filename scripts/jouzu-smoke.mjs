// Live Jouzu smoke: a real pinned `jouzu` binary accepting the config
// `aiand jouzu on` generates in Jouzu's own agent dir (Jouzu runs Pi on
// that dir, so Pi's TypeBox schema for models.json applies here too) and a
// headless --print round-trip through the loopback double, launched the way
// `aiand jouzu` launches it.
//
// Run by CI after scripts/pi-smoke.mjs (the build job installs the pinned
// jouzu). No real gateway, no key, no Shisa account: the double serves
// /v1/models and /v1/chat/completions.
//
// Requires: dist/index.js built, `jouzu` on PATH. Exits non-zero on any failure.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSmokeDouble } from "./smoke-double.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");

const S = mkdtempSync(join(tmpdir(), "aiand-jouzu-smoke-"));
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
  const env = {
    ...process.env,
    HOME: home,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: join(S, "cfg"),
    AIAND_API_KEY: "sk-e2e-jouzu-smoke-key-000000000000",
    AIAND_BASE_URL: baseUrl,
    // Jouzu's whole root in the sandbox: config, state, sessions, cache.
    JOUZU_HOME: join(S, "jouzu"),
    // No self-update, no first-run Pi import offer.
    JOUZU_NO_UPDATE: "1",
    JOUZU_NO_PI_IMPORT: "1",
    NO_COLOR: "1",
  };
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  delete env.SHISA_API_KEY;

  // 1. Wire with the real CLI.
  const on = JSON.parse(
    execFileSync(process.execPath, [DIST, "jouzu", "on", "--json"], { env, encoding: "utf8" }),
  );
  if (on.state === "on" && on.files.every((file) => file.startsWith(join(S, "jouzu", "agent"))))
    process.stdout.write("PASS aiand jouzu on writes into JOUZU_HOME/agent\n");
  else fail(`aiand jouzu on: ${JSON.stringify(on)}`);

  // 2. The real jouzu accepts the generated config and lists our model.
  try {
    const listing = execFileSync("jouzu", ["--list-models"], {
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (listing.includes("zai-org/glm-5.3"))
      process.stdout.write("PASS jouzu --list-models lists the aiand model\n");
    else fail(`jouzu --list-models output lacked the model:\n${listing}`);
  } catch (error) {
    fail(`jouzu --list-models rejected the config: ${error.stderr ?? error.message}`);
  }

  // 3. Headless round-trip through `aiand jouzu`, so the args open adds
  //    (openExtras) reach the real binary, not a hand-written copy of them.
  try {
    const printed = execFileSync(process.execPath, [DIST, "jouzu", "--print", "Say hi"], {
      env,
      encoding: "utf8",
      timeout: 180_000,
    });
    // Jouzu keeps Pi's thinking clamp: medium is not published, so high.
    if (printed.includes("echo:zai-org/glm-5.3:effort=high"))
      process.stdout.write("PASS aiand jouzu --print sends high on the aiand provider\n");
    else fail(`aiand jouzu --print round-trip did not send the clamped level:\n${printed}`);
  } catch (error) {
    fail(`aiand jouzu --print round-trip failed: ${error.stderr ?? error.message}`);
  }

  // 4. A Pi subcommand stays a subcommand: open adds no flags in front of
  //    it, which would turn it into a chat prompt.
  try {
    const listed = execFileSync(process.execPath, [DIST, "jouzu", "list"], {
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (listed.includes("No packages installed") && !listed.includes("echo:"))
      process.stdout.write("PASS aiand jouzu list runs Pi's list command\n");
    else fail(`aiand jouzu list did not run Pi's list command:\n${listed}`);
  } catch (error) {
    fail(`aiand jouzu list failed: ${error.stderr ?? error.message}`);
  }
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  doubleChild?.kill();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
