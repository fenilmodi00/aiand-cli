import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withTestEnv } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

// --- Shared temp env ---------------------------------------------------------
let home, cfg, stubBin, bin;
const env = withTestEnv("aiand-init-polish-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  stubBin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  mkdirSync(stubBin, { recursive: true });

  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = "sk-test-not-real";
  process.env.AIAND_BASE_URL = "https://fixture.test";

  // Seed a fresh catalog cache so agentOn never touches the network.
  const model = (id, price) => ({
    id,
    name: id,
    object: "model",
    created: 1,
    owned_by: "fixture",
    provider: "fixture",
    context_window: 1000,
    capabilities: ["tools"],
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: price,
    output_per_1m: price,
    cached_input_per_1m: null,
  });
  writeFileSync(
    join(cfg, "model-catalog.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://fixture.test",
      models: [model("zai-org/glm-5.3", "1"), model("other/model", "2")],
    })
  );

  // Seed the last-good OpenCode model map so `on` never touches the network:
  // the api.json fetch fails offline and falls back to this cache.
  writeFileSync(
    join(cfg, "opencode-api.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://fixture.test",
      models: { "zai-org/glm-5.3": { id: "zai-org/glm-5.3", name: "GLM 5.3" } },
    })
  );

  bin = join(dirname(import.meta.dirname), "dist", "index.js");
});

// --- Helpers -----------------------------------------------------------------

/**
 * Spawn the built CLI in a subprocess. `detectBinary` shells out to `which`,
 * so the child PATH decides what is "installed". The default PATH picks up the
 * real system binaries plus any stub dir; a PATH of the node dir only makes
 * `which` itself unresolvable, which detectBinary treats as "not installed",
 * giving a clean zero-detected machine.
 */
const runCli = async (args, { withStubs = false, env = {} } = {}) => {
  const path = withStubs
    ? `${stubBin}:${process.env.PATH}`
    : (env.PATH ?? process.env.PATH);
  try {
    const { stdout, stderr } = await execFileAsync("node", [bin, ...args], {
      env: {
        ...process.env,
        PATH: path,
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: cfg,
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

/** Plant a POSIX-sh `opencode` stub on the temp bin dir so detection finds it. */
function plantOpencodeStub() {
  const script = join(stubBin, "opencode");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  chmodSync(script, 0o755);
}

/** A non-trivial original opencode.json a user might have before wiring. */
const ORIGINAL_SETTINGS = '{\n  "theme": "dark"\n}\n';
const settingsPath = () => join(home, ".config", "opencode", "opencode.json");

// --- Tests -------------------------------------------------------------------

test("bare init non-TTY, one detected: hint names the agent", async () => {
  plantOpencodeStub();
  const { code, stderr } = await runCli(["init"], { withStubs: true });
  assert.equal(code, 1);
  assert.match(stderr, /aiand init opencode/);
});

test("bare init non-TTY, zero detected: actionable no-agents hint", async () => {
  // PATH = node dir only: `which` has nothing to resolve, so no agent is found.
  const { code, stderr } = await runCli(["init"], { env: { PATH: dirname(process.execPath) } });
  assert.equal(code, 1);
  assert.match(stderr, /No coding agents detected on this machine\./);
  assert.match(stderr, /Install one and re-run aiand init\./);
});

test("init --json with zero detected: {agents:[], message} shape", async () => {
  const { code, stdout } = await runCli(["init", "--json"], {
    env: { PATH: dirname(process.execPath) },
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.agents, []);
  assert.equal(
    parsed.message,
    "No coding agents detected on this machine. Install one and re-run aiand init."
  );
});

test("init --off with no routed agents -> friendly no-op, exit 0", async () => {
  // Clean env: nothing snapshotted, nothing active -> nothing to turn off.
  const { code, stdout, stderr } = await runCli(["init", "--off"]);
  assert.equal(code, 0);
  assert.match(stdout, /No agents are currently wired to ai&\./);
});

test("init --off ignores leftover snapshots once the agent is already off", async () => {
  plantOpencodeStub();
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(settingsPath(), ORIGINAL_SETTINGS);
  const on = await runCli(["init", "opencode"], { withStubs: true });
  assert.equal(on.code, 0);
  const off = await runCli(["init", "--off", "opencode"], { withStubs: true });
  assert.equal(off.code, 0);
  // Snapshot remains for restore --force; bare init --off must not treat
  // that as still routed.
  const again = await runCli(["init", "--off"]);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /No agents are currently wired to ai&\./);
});

function assertAiandStripped(raw) {
  const config = JSON.parse(raw);
  assert.equal(config["x-aiand"], undefined);
  assert.equal(config["x-aiand-previous-model"], undefined);
  assert.equal(config.provider?.aiand, undefined);
  assert.equal(config.enabled_providers, undefined);
  assert.equal(config.disabled_providers, undefined);
  return config;
}

test("init opencode wires on; init --off opencode and opencode off strip our keys", async () => {
  plantOpencodeStub();
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(settingsPath(), ORIGINAL_SETTINGS);

  const onResult = await runCli(["init", "opencode"], { withStubs: true });
  assert.equal(onResult.code, 0);
  const wiredBytes = readFileSync(settingsPath(), "utf8");
  assert.notEqual(wiredBytes, ORIGINAL_SETTINGS, "wiring should rewrite opencode.json");
  assert.match(wiredBytes, /aiand\/zai-org\/glm-5\.3/);
  assert.equal(JSON.parse(wiredBytes).enabled_providers, undefined);

  const offA = await runCli(["opencode", "off"], { withStubs: true });
  assert.equal(offA.code, 0);
  // Untouched since on: surgical off must return the pre-aiand bytes exactly.
  assert.equal(readFileSync(settingsPath(), "utf8"), ORIGINAL_SETTINGS);
  assertAiandStripped(readFileSync(settingsPath(), "utf8"));
  assert.match(offA.stdout, /is off/);
  assert.doesNotMatch(offA.stdout, /previous config was restored/);

  const onAgain = await runCli(["init", "opencode"], { withStubs: true });
  assert.equal(onAgain.code, 0);
  assert.notEqual(readFileSync(settingsPath(), "utf8"), ORIGINAL_SETTINGS);
  const offB = await runCli(["init", "--off", "opencode"], { withStubs: true });
  assert.equal(offB.code, 0);
  // Re-wired from the subtracted original with no edits: byte-identical again.
  assert.equal(readFileSync(settingsPath(), "utf8"), ORIGINAL_SETTINGS);
  assert.equal(assertAiandStripped(readFileSync(settingsPath(), "utf8")).theme, "dark");
});

test("init --all wires the detected agent", async () => {
  plantOpencodeStub();
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), ORIGINAL_SETTINGS);
  // Hermetic PATH: stubs + which + node only. System-wide agent binaries
  // (a dev machine or CI image with real installs, possibly sharing a dir
  // with node itself) must not leak into detection and change what --all
  // wires — so resolve node through the stub dir too.
  try {
    symlinkSync(process.execPath, join(stubBin, "node"));
  } catch {
    // Already linked by an earlier run in this process.
  }
  const hermeticPath = [stubBin, "/usr/bin"].join(":");
  const { code, stdout } = await runCli(["init", "--all", "--json"], {
    env: { PATH: hermeticPath },
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  const byId = Object.fromEntries(parsed.agents.map((row) => [row.agent, row]));
  assert.equal(byId.opencode.state, "on", "wiring agent still wires");
  const off = await runCli(["init", "--off"], { env: { PATH: hermeticPath } });

  assert.equal(off.code, 0);
  assert.equal(assertAiandStripped(readFileSync(settingsPath(), "utf8")).theme, "dark");
});

test("opencode on --base-url trailing slash still hits the trimmed catalog cache", async () => {
  plantOpencodeStub();
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), ORIGINAL_SETTINGS);
  const { code, stderr } = await runCli(
    ["opencode", "on", "--base-url", "https://fixture.test/"],
    { withStubs: true },
  );
  assert.equal(code, 0, stderr);
});

test("init --all puts a failed agent's reason on stderr", async () => {
  plantOpencodeStub();
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify({
      provider: {
        aiand: {
          options: { baseURL: "https://foreign.example.com/v1", apiKey: "sk-foreign-1" },
        },
      },
    }) + "\n",
  );
  try {
    symlinkSync(process.execPath, join(stubBin, "node"));
  } catch {
    // Already linked by an earlier run in this process.
  }
  const hermeticPath = [stubBin, "/usr/bin"].join(":");
  const { code, stdout, stderr } = await runCli(["init", "--all"], {
    env: { PATH: hermeticPath },
  });
  assert.equal(code, 1);
  assert.match(stderr, /does not manage/);
  assert.doesNotMatch(stdout, /does not manage/);
});

test("on → user edits the file → off keeps their edit", async () => {
  plantOpencodeStub();
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(settingsPath(), ORIGINAL_SETTINGS);

  const onResult = await runCli(["init", "opencode"], { withStubs: true });
  assert.equal(onResult.code, 0);
  const wired = JSON.parse(readFileSync(settingsPath(), "utf8"));
  wired.autoupdate = true;
  writeFileSync(settingsPath(), `${JSON.stringify(wired, null, 2)}\n`);

  const off = await runCli(["opencode", "off"], { withStubs: true });
  assert.equal(off.code, 0);
  const after = assertAiandStripped(readFileSync(settingsPath(), "utf8"));
  assert.equal(after.theme, "dark");
  assert.equal(after.autoupdate, true);
});

test("restore --force puts the snapshot back; restore without --force refuses", async () => {
  plantOpencodeStub();
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(settingsPath(), ORIGINAL_SETTINGS);

  const onResult = await runCli(["init", "opencode"], { withStubs: true });
  assert.equal(onResult.code, 0);

  const refused = await runCli(["restore", "opencode"], { withStubs: true });
  assert.notEqual(refused.code, 0);
  assert.match(`${refused.stderr}${refused.stdout}`, /--force/);

  const restored = await runCli(["restore", "opencode", "--force"], { withStubs: true });
  assert.equal(restored.code, 0);
  assert.equal(readFileSync(settingsPath(), "utf8"), ORIGINAL_SETTINGS);
});

test("init --profile bakes that profile's key", async () => {
  plantOpencodeStub();
  process.env.AIAND_KEY_STORAGE = "plaintext";
  const { saveCredential } = await import("../dist/config.js");
  await saveCredential("work", { access_token: "sk-work-profile-1", origin: "paste" });
  mkdirSync(dirname(settingsPath()), { recursive: true });

  const { code } = await runCli(["init", "opencode", "--profile", "work"], {
    withStubs: true,
    env: { AIAND_API_KEY: "", AIAND_KEY_STORAGE: "plaintext" },
  });
  assert.equal(code, 0);
  const config = JSON.parse(readFileSync(settingsPath(), "utf8"));
  assert.equal(config.provider.aiand.options.apiKey, "sk-work-profile-1");
});