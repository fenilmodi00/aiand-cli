// Attribution of keys an agent holds in its OWN credential store (omp's
// native `aiand` provider login) — the "unknown harness" bug: gateway /logs
// rows under such a key must attribute to the agent once the sync-time
// native-key sweep has run.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CLOSED_URL, cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-agent-native-keys-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_API_KEY;
});

function cfgDir(name) {
  const dir = join(tmpdir(), `aiand-native-${name}-${process.pid}`);
  mkdirSync(join(dir, "cfg"), { recursive: true });
  return dir;
}

test("recordNativeAgentKeys attributes a native key without baking it", async () => {
  const cfg = cfgDir("record");
  const { recordNativeAgentKeys, agentForMaskedKey, listAgentKeys } = await import(
    "../dist/api/agent-keys.js"
  );
  await withEnv({ AIAND_CONFIG_DIR: join(cfg, "cfg") }, async () => {
    const KEY = "sk-test-native-aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff";
    await recordNativeAgentKeys("omp", [KEY]);
    assert.equal(agentForMaskedKey("sk-test...ffff"), "omp");
    // Idempotent: sweeping twice must not duplicate the record.
    await recordNativeAgentKeys("omp", [KEY]);
    assert.equal(listAgentKeys().length, 1);
  });
});

test("cli: omp's own aiand login shows as omp in harness compare, not unknown", async () => {
  const cfg = join(cfgDir("compare"), "cfg");
  const home = join(cfgDir("compare"), "home");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(home, { recursive: true });

  // omp's native credential store: agent.db auth_credentials row for its own
  // `aiand` provider login (schema verified against a real ~/.omp/agent).
  const { DatabaseSync } = await import("node:sqlite");
  const ompAgentDir = join(home, ".omp", "agent");
  mkdirSync(ompAgentDir, { recursive: true });
  const db = new DatabaseSync(join(ompAgentDir, "agent.db"));
  db.exec(`CREATE TABLE auth_credentials (
    id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT,
    disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)`);
  const NATIVE_KEY = "sk-test-native-aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff";
  db.prepare(
    "INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("aiand", "api_key", JSON.stringify({ key: NATIVE_KEY }), null, null, 1, 1);
  db.close();

  writeFileSync(
    join(cfg, "agent-keys.json"),
    JSON.stringify({
      version: 1,
      keys: [{ agent: "claude", masked: "sk-claude...9999", fingerprint: "f".repeat(16), at: 1 }],
    }),
  );

  const { openStore, storePath } = await import("../dist/store/index.js");
  const { maskKey } = await import("../dist/api/agent-keys.js");
  const nativeMask = maskKey(NATIVE_KEY);
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
      "omp-1",
      "zai-org/glm-5.3",
      nativeMask,
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
    ins.run(
      "omp-2",
      "zai-org/glm-5.3",
      nativeMask,
      200,
      120,
      220,
      10,
      5,
      0,
      "0.001",
      0.001,
      "usd",
      new Date(base + 60_000).toISOString(),
      new Date().toISOString(),
    );
    ins.run(
      "cl-1",
      "zai-org/glm-5.3",
      "sk-claude...9999",
      200,
      100,
      200,
      10,
      5,
      0,
      "0.001",
      0.001,
      "usd",
      new Date(base + 120_000).toISOString(),
      new Date().toISOString(),
    );
    opened.db.close();
  });

  // Real flow, no --no-sync: the gateway is unreachable so the sync fails,
  // but the local native-key sweep must still run and attribute the rows.
  const run = await runCli(["harness", "compare", "--json"], {
    env: cliEnv({
      AIAND_CONFIG_DIR: cfg,
      AIAND_HOME: home,
      AIAND_API_KEY: "sk-test",
      AIAND_BASE_URL: CLOSED_URL,
    }),
  });
  assert.equal(run.code, 0, run.stdout);
  const parsed = JSON.parse(run.stdout);
  const harnesses = parsed.harnesses.map((h) => h.harness);
  assert.ok(harnesses.includes("omp"), `omp must appear, got: ${harnesses.join(", ")}`);
  assert.ok(!harnesses.includes("unknown"), `unknown must be gone, got: ${harnesses.join(", ")}`);
  const omp = parsed.harnesses.find((h) => h.harness === "omp");
  assert.equal(omp.requests, 2);
});

test("cli: sync's native-key sweep survives an unreadable agent store", async () => {
  // AIAND_HOME pointing at a dir with no omp install at all: the sweep must
  // silently contribute nothing and never break the sync callers.
  const cfg = join(cfgDir("sweep-empty"), "cfg");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "agent-keys.json"), JSON.stringify({ version: 1, keys: [] }));
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { listAgentKeys } = await import("../dist/api/agent-keys.js");
    assert.equal(listAgentKeys().length, 0);
  });
});

test("claude: a hand-written gateway env block without our marker attributes", async () => {
  const cfg = join(cfgDir("claude"), "cfg");
  const home = join(cfgDir("claude"), "home");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(cfg, "agent-keys.json"), JSON.stringify({ version: 1, keys: [] }));

  // User hand-wired Claude Code at the gateway with their own key — no
  // AIAND_MANAGED marker, so this is native, not CLI-baked.
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.aiand.com",
        ANTHROPIC_AUTH_TOKEN: "sk-test-claude-native-key-0000000000000001",
      },
    }),
  );

  await withEnv({ AIAND_CONFIG_DIR: cfg, AIAND_HOME: home }, async () => {
    const { nativeAiandKeys } = (await import("../dist/agents/registry.js")).AGENTS.find(
      (a) => a.id === "claude",
    );
    assert.ok(nativeAiandKeys, "claude adapter exposes the hook");
    const keys = await nativeAiandKeys();
    assert.deepEqual(keys, ["sk-test-claude-native-key-0000000000000001"]);
  });
});

test("claude: CLI-baked (marker) and non-gateway blocks are never swept", async () => {
  const cfg = join(cfgDir("claude-marked"), "cfg");
  const home = join(cfgDir("claude-marked"), "home");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  // Our own baked row: marker set — bakedKey/recordAgentKey own it.
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      env: {
        AIAND_MANAGED: "1",
        ANTHROPIC_BASE_URL: "https://api.aiand.com",
        ANTHROPIC_AUTH_TOKEN: "sk-test-claude-baked-key-000000000000000002",
      },
    }),
  );
  await withEnv({ AIAND_CONFIG_DIR: cfg, AIAND_HOME: home }, async () => {
    const claude = (await import("../dist/agents/registry.js")).AGENTS.find(
      (a) => a.id === "claude",
    );
    assert.deepEqual(await claude.nativeAiandKeys(), []);
  });
  // A foreign LLM pointed elsewhere: not ours to attribute.
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:8080",
        ANTHROPIC_AUTH_TOKEN: "sk-test-claude-foreign-key-00000000000000003",
      },
    }),
  );
  await withEnv({ AIAND_CONFIG_DIR: cfg, AIAND_HOME: home }, async () => {
    const claude = (await import("../dist/agents/registry.js")).AGENTS.find(
      (a) => a.id === "claude",
    );
    assert.deepEqual(await claude.nativeAiandKeys(), []);
  });
});

test("codex: a hand-written gateway provider with env_key attributes", async () => {
  const cfg = join(cfgDir("codex"), "cfg");
  const home = join(cfgDir("codex"), "home");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(cfg, "agent-keys.json"), JSON.stringify({ version: 1, keys: [] }));

  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "config.toml"),
    [
      'model_provider = "aiand"',
      "[model_providers.aiand]",
      'name = "ai& (self-configured)"',
      'base_url = "https://api.aiand.com/v1"',
      'wire_api = "responses"',
      'env_key = "MY_AIAND_KEY"',
    ].join("\n"),
  );

  await withEnv(
    {
      AIAND_CONFIG_DIR: cfg,
      AIAND_HOME: home,
      MY_AIAND_KEY: "sk-test-codex-native-0000000000000004",
    },
    async () => {
      const codex = (await import("../dist/agents/registry.js")).AGENTS.find(
        (a) => a.id === "codex",
      );
      assert.ok(codex.nativeAiandKeys, "codex adapter exposes the hook");
      assert.deepEqual(await codex.nativeAiandKeys(), ["sk-test-codex-native-0000000000000004"]);
    },
  );
});

test("codex: our auth-command profile and bearer tokens elsewhere are never swept", async () => {
  const cfg = join(cfgDir("codex-ours"), "cfg");
  const home = join(cfgDir("codex-ours"), "home");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  // Our own wiring: [model_providers.aiand.auth] command = "aiand".
  writeFileSync(
    join(home, ".codex", "aiand.config.toml"),
    [
      "[model_providers.aiand]",
      'base_url = "https://api.aiand.com/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.aiand.auth]",
      'command = "aiand"',
      'args = ["key", "export"]',
    ].join("\n"),
  );
  // A foreign provider with an inline bearer token, not at our gateway.
  writeFileSync(
    join(home, ".codex", "config.toml"),
    [
      "[model_providers.other]",
      'base_url = "https://api.example.com/v1"',
      'experimental_bearer_token = "sk-test-codex-foreign-00000000000000005"',
    ].join("\n"),
  );
  await withEnv({ AIAND_CONFIG_DIR: cfg, AIAND_HOME: home }, async () => {
    const codex = (await import("../dist/agents/registry.js")).AGENTS.find((a) => a.id === "codex");
    assert.deepEqual(await codex.nativeAiandKeys(), []);
  });
});

test("copilot: a hand-written gateway row with a pasted key attributes", async () => {
  const cfg = join(cfgDir("copilot"), "cfg");
  const home = join(cfgDir("copilot"), "home");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(cfg, "agent-keys.json"), JSON.stringify({ version: 1, keys: [] }));

  // User added an ai& row themselves in ~/.copilot/providers.json — no
  // AddedState record, so isOurRow is false and this is native, not baked.
  mkdirSync(join(home, ".copilot"), { recursive: true });
  writeFileSync(
    join(home, ".copilot", "providers.json"),
    JSON.stringify({
      providers: [
        {
          name: "aiand",
          type: "openai",
          wireApi: "completions",
          baseUrl: "https://api.aiand.com/v1",
          apiKey: "sk-test-copilot-native-0000000000000006",
        },
      ],
    }),
  );

  await withEnv({ AIAND_CONFIG_DIR: cfg, AIAND_HOME: home }, async () => {
    const copilot = (await import("../dist/agents/registry.js")).AGENTS.find(
      (a) => a.id === "copilot",
    );
    assert.ok(copilot.nativeAiandKeys, "copilot adapter exposes the hook");
    assert.deepEqual(await copilot.nativeAiandKeys(), ["sk-test-copilot-native-0000000000000006"]);
  });
});

test("copilot: non-gateway rows are never swept", async () => {
  const cfg = join(cfgDir("copilot-foreign"), "cfg");
  const home = join(cfgDir("copilot-foreign"), "home");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, ".copilot"), { recursive: true });
  writeFileSync(
    join(home, ".copilot", "providers.json"),
    JSON.stringify({
      providers: [
        {
          name: "other",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test-copilot-foreign-0000000000000007",
        },
      ],
    }),
  );
  await withEnv({ AIAND_CONFIG_DIR: cfg, AIAND_HOME: home }, async () => {
    const copilot = (await import("../dist/agents/registry.js")).AGENTS.find(
      (a) => a.id === "copilot",
    );
    assert.deepEqual(await copilot.nativeAiandKeys(), []);
  });
});

test("hermes: a hand-written gateway block with a .env key attributes", async () => {
  const cfg = join(cfgDir("hermes"), "cfg");
  const home = join(cfgDir("hermes"), "home");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(cfg, "agent-keys.json"), JSON.stringify({ version: 1, keys: [] }));

  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeFileSync(
    join(home, ".hermes", "config.yaml"),
    [
      "providers:",
      "  aiand:",
      "    name: aiand",
      '    base_url: "https://api.aiand.com/v1"',
      "    key_env: AIAND_HERMES_API_KEY",
      "    transport: chat_completions",
    ].join("\n"),
  );
  writeFileSync(
    join(home, ".hermes", ".env"),
    "AIAND_HERMES_API_KEY=sk-test-hermes-native-00000000000000008\n",
  );

  await withEnv({ AIAND_CONFIG_DIR: cfg, AIAND_HOME: home }, async () => {
    const hermes = (await import("../dist/agents/registry.js")).AGENTS.find(
      (a) => a.id === "hermes",
    );
    assert.ok(hermes.nativeAiandKeys, "hermes adapter exposes the hook");
    assert.deepEqual(await hermes.nativeAiandKeys(), ["sk-test-hermes-native-00000000000000008"]);
  });
});

test("hermes: our marked block is never swept as native", async () => {
  const cfg = join(cfgDir("hermes-marked"), "cfg");
  const home = join(cfgDir("hermes-marked"), "home");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeFileSync(
    join(home, ".hermes", "config.yaml"),
    [
      "providers:",
      "  aiand:",
      "    name: aiand",
      '    base_url: "https://api.aiand.com/v1"',
      "    key_env: AIAND_HERMES_API_KEY",
      '    managed_by: "aiand"',
    ].join("\n"),
  );
  writeFileSync(
    join(home, ".hermes", ".env"),
    "AIAND_HERMES_API_KEY=sk-test-hermes-baked-000000000000000009\n",
  );
  await withEnv({ AIAND_CONFIG_DIR: cfg, AIAND_HOME: home }, async () => {
    const hermes = (await import("../dist/agents/registry.js")).AGENTS.find(
      (a) => a.id === "hermes",
    );
    assert.deepEqual(await hermes.nativeAiandKeys(), []);
  });
});
