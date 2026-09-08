import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
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

/** Plant a POSIX-sh `claude` stub on the temp bin dir so detection finds it. */
function plantClaudeStub() {
  const script = join(stubBin, "claude");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  chmodSync(script, 0o755);
}

/** A non-trivial original settings.json a user might have before wiring. */
const ORIGINAL_SETTINGS = '{\n  "opts": {},\n  "model": "claude-sonnet-4-5"\n}\n';
const settingsPath = () => join(home, ".claude", "settings.json");

// --- Tests -------------------------------------------------------------------

test("bare init non-TTY, one detected: hint names the agent", async () => {
  plantClaudeStub();
  const { code, stderr } = await runCli(["init"], { withStubs: true });
  assert.equal(code, 1);
  assert.match(stderr, /aiand init claude/);
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

test("init claude wires on; init --off claude and claude off restore byte-identical", async () => {
  // Plant an original config, then wire on, snapshot the on-state bytes for
  // reference, and verify BOTH teardown paths restore the original exactly.
  plantClaudeStub();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), ORIGINAL_SETTINGS);

  // Wire on via `init claude`.
  const onResult = await runCli(["init", "claude"], { withStubs: true });
  assert.equal(onResult.code, 0);
  const wiredBytes = readFileSync(settingsPath(), "utf8");
  assert.notEqual(wiredBytes, ORIGINAL_SETTINGS, "wiring should rewrite settings.json");
  assert.match(wiredBytes, /api\.aiand\.com/);

  // Path A: `aiand claude off` restores the original bytes.
  const offA = await runCli(["claude", "off"], { withStubs: true });
  assert.equal(offA.code, 0);
  assert.equal(readFileSync(settingsPath(), "utf8"), ORIGINAL_SETTINGS);

  // Wire back on, then Path B: `init --off claude` restores identically.
  const onAgain = await runCli(["init", "claude"], { withStubs: true });
  assert.equal(onAgain.code, 0);
  assert.notEqual(readFileSync(settingsPath(), "utf8"), ORIGINAL_SETTINGS);

  const offB = await runCli(["init", "--off", "claude"], { withStubs: true });
  assert.equal(offB.code, 0);
  assert.equal(readFileSync(settingsPath(), "utf8"), ORIGINAL_SETTINGS);
});