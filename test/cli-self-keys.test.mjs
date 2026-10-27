// OBS-LT-1 (#106): the CLI's own traffic must attribute to a first-class
// harness label ("aiand-cli") even with an empty agent-keys.json — the
// "unknown harness" bug for fresh installs. The store sync self-records the
// key the CLI authenticates with; agents wired with the same key still win.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CLOSED_URL, cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-self-keys-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_API_KEY;
});

// Long enough for a real mask (head + tail), shaped like a gateway key.
const CLI_KEY = "sk-self-1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff77779953";
const FOREIGN_MASK = "sk-foreign...9999";

function cfgDir(name) {
  const dir = join(tmpdir(), `aiand-self-${name}-${process.pid}`);
  mkdirSync(join(dir, "cfg"), { recursive: true });
  return dir;
}

function freshAgentKeys(cfg) {
  writeFileSync(join(cfg, "agent-keys.json"), JSON.stringify({ version: 1, keys: [] }));
}

async function seedRequest(cfg, id, apiKey) {
  const { openStore, storePath } = await import("../dist/store/index.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    const ins = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const base = Date.now() - 3600_000;
    ins.run(
      id,
      "zai-org/glm-5.3",
      apiKey,
      200,
      100,
      200,
      10,
      5,
      0,
      "0.001",
      0.001,
      "usd",
      new Date(base).toISOString(),
      new Date().toISOString(),
    );
    opened.db.close();
  });
}

async function sessionsJson(cfg, home) {
  // Real flow, no --no-sync: the gateway is unreachable so the sync fails,
  // but the local sweep (self-key recording included) must still run and
  // attribute the rows — same seam as the native-key sweep. AIAND_HOME is
  // sandboxed so the adapter native sweep cannot read a real agent store.
  const run = await runCli(["sessions", "--json"], {
    env: cliEnv({
      AIAND_CONFIG_DIR: cfg,
      AIAND_HOME: home,
      AIAND_API_KEY: CLI_KEY,
      AIAND_BASE_URL: CLOSED_URL,
    }),
  });
  assert.equal(run.code, 0, run.stdout);
  return JSON.parse(run.stdout).sessions;
}

test("own-key traffic on a fresh store shows as aiand-cli, not unknown", async () => {
  const cfg = join(cfgDir("self"), "cfg");
  const home = join(cfgDir("self"), "home");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(home, { recursive: true });
  freshAgentKeys(cfg);
  const { maskKey } = await import("../dist/api/agent-keys.js");
  await seedRequest(cfg, "self-1", maskKey(CLI_KEY));

  const sessions = await sessionsJson(cfg, home);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].harness, "aiand-cli");

  // The mapping persisted into agent-keys.json for every later read.
  const { listAgentKeys, agentForMaskedKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    assert.deepEqual(listAgentKeys().map((k) => k.agent), ["aiand-cli"]);
    assert.equal(agentForMaskedKey(maskKey(CLI_KEY)), "aiand-cli");
  });
});

test("foreign keys stay unknown after the self sweep", async () => {
  const cfg = join(cfgDir("foreign"), "cfg");
  const home = join(cfgDir("foreign"), "home");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(home, { recursive: true });
  freshAgentKeys(cfg);
  const { maskKey } = await import("../dist/api/agent-keys.js");
  await seedRequest(cfg, "own-1", maskKey(CLI_KEY));
  await seedRequest(cfg, "foreign-1", FOREIGN_MASK);

  const sessions = await sessionsJson(cfg, home);
  const harnesses = sessions.map((s) => s.harness).sort();
  assert.deepEqual(harnesses, ["aiand-cli", "unknown"]);
});

test("an agent wired with the same key wins over the self label", async () => {
  const cfg = join(cfgDir("agent-wins"), "cfg");
  const home = join(cfgDir("agent-wins"), "home");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(home, { recursive: true });
  const { maskKey } = await import("../dist/api/agent-keys.js");
  const mask = maskKey(CLI_KEY);
  writeFileSync(
    join(cfg, "agent-keys.json"),
    JSON.stringify({
      version: 1,
      keys: [{ agent: "claude", masked: mask, fingerprint: "f".repeat(16), at: 1 }],
    }),
  );
  await seedRequest(cfg, "shared-1", mask);

  const sessions = await sessionsJson(cfg, home);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].harness, "claude", "agent label must beat the self entry");
  // The self record must not have been added as a duplicate claim for this
  // key's label choice: the key map may hold both, but reads resolve claude.
  const { agentsForMaskedKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    assert.deepEqual(agentsForMaskedKey(mask), ["claude"]);
  });
});
