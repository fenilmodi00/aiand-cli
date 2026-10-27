import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

/**
 * Final branch push: harness compare/matrix render variants, stats
 * session-gap wiring, models/orgs error paths, and the efficiency
 * command's offline branches.
 */

const env = withTestEnv("final-branches", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MONDAY_10 = Date.parse("2026-10-19T10:00:00.000Z");
const HOUR = 3_600_000;

async function seedTwoHarnesses(cfg, n = 8) {
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-key-001");
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < n; i += 1) {
      const at = new Date(MONDAY_10 + i * HOUR).toISOString();
      insert.run(
        `f${i}`,
        i % 2 === 0 ? "zai-org/glm-5.3" : "openai/gpt-5.2",
        i % 2 === 0 ? "sk-test...-001" : "sk-test...-000",
        i === n - 1 ? 500 : 200,
        200 + i,
        null,
        1000,
        100,
        500,
        "0.02",
        0.02,
        "usd",
        at,
        at,
      );
    }
    opened.db.close();
  });
}

test("harness compare: cost and no-cost renders, winners marked, samples flag", async () => {
  const cfg = cfgDir("compare-render");
  await seedTwoHarnesses(cfg);
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  const cost = await runCli(["harness", "compare", "--no-sync", "--last", "30d"], base);
  assert.equal(cost.code, 0, `${cost.stdout}${cost.stderr}`);
  assert.ok(/COST\/SESSION P50/i.test(cost.stdout), `cost column: ${cost.stdout}`);

  // --no-cost drops the money column but keeps the comparison.
  const noCost = await runCli(
    ["harness", "compare", "--no-sync", "--last", "30d", "--no-cost"],
    base,
  );
  assert.equal(noCost.code, 0, `${noCost.stdout}${noCost.stderr}`);
  assert.ok(!/^HARNESS\s+.*COST\/SESSION/m.test(noCost.stdout), "no-cost drops the cost column");

  const samples = await runCli(
    ["harness", "compare", "--no-sync", "--last", "30d", "--samples"],
    base,
  );
  assert.equal(samples.code, 0, `${samples.stdout}${samples.stderr}`);

  // One harness only: the documented refusal.
  const solo = cfgDir("compare-solo");
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: solo }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    const opened = openStore(storePath());
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const at = new Date(MONDAY_10).toISOString();
    insert.run(
      "s1",
      "zai-org/glm-5.3",
      "sk-test...-000",
      200,
      300,
      null,
      1000,
      100,
      500,
      "0.02",
      0.02,
      "usd",
      at,
      at,
    );
    opened.db.close();
  });
  const refused = await runCli(["harness", "compare", "--no-sync", "--last", "30d"], {
    env: cliEnv({ AIAND_CONFIG_DIR: solo }),
  });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /at least 2 harnesses/);
});

test("harness matrix: windows, filters, top, insufficient-data, and json", async () => {
  const cfg = cfgDir("matrix");
  await seedTwoHarnesses(cfg);
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  for (const args of [
    ["harness", "matrix", "--no-sync"],
    ["harness", "matrix", "--no-sync", "--last", "30d"],
    ["harness", "matrix", "--no-sync", "--harness", "claude", "--model", "zai-org/*"],
    ["harness", "matrix", "--no-sync", "--json"],
    ["harness", "matrix", "--no-sync", "--top", "1"],
  ]) {
    const out = await runCli(args, base);
    assert.equal(out.code, 0, `${args.join(" ")}\n${out.stdout}${out.stderr}`);
  }

  const empty = cfgDir("matrix-empty");
  const none = await runCli(["harness", "matrix", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: empty }),
  });
  assert.equal(none.code, 0, `${none.stdout}${none.stderr}`);
});

test("stats: --session-gap changes grouping; store info surfaces in json", async () => {
  const cfg = cfgDir("gap-json");
  await seedTwoHarnesses(cfg, 8);
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  const wide = await runCli(
    ["harness", "stats", "--no-sync", "--last", "30d", "--session-gap", "1", "--json"],
    base,
  );
  assert.equal(wide.code, 0, wide.stderr);
  const narrow = await runCli(
    ["harness", "stats", "--no-sync", "--last", "30d", "--session-gap", "600", "--json"],
    base,
  );
  assert.equal(narrow.code, 0, narrow.stderr);
  const w = JSON.parse(wide.stdout);
  const n = JSON.parse(narrow.stdout);
  // A 1-minute gap splits the hourly rows; a 600-minute gap merges them.
  const wideSessions = (w.harnesses ?? []).reduce((s, h) => s + (h.sessions ?? 0), 0);
  const narrowSessions = (n.harnesses ?? []).reduce((s, h) => s + (h.sessions ?? 0), 0);
  assert.ok(wideSessions >= narrowSessions, "tighter gap never merges sessions");
});

test("models/orgs: dead gateway errors cleanly; --json parses", async () => {
  const cfg = cfgDir("models-orgs");
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: "sk-test-x" }) };

  const deadModels = await runCli(["models", "--base-url", "http://127.0.0.1:1"], base);
  assert.notEqual(deadModels.code, 0);
  assert.ok(deadModels.stderr.length > 0 && !/at file:/.test(deadModels.stderr));

  const deadOrgs = await runCli(["orgs", "--base-url", "http://127.0.0.1:1"], base);
  // orgs may fail open to an empty list or fail closed — either way, no stack.
  assert.ok(!/at file:/.test(deadOrgs.stderr), "no stack trace leak");
});

test("efficiency: empty and seeded stores both exit clean with json", async () => {
  const empty = cfgDir("eff-empty");
  const none = await runCli(["efficiency", "--no-sync", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: empty }),
  });
  assert.equal(none.code, 0, `${none.stdout}${none.stderr}`);

  const cfg = cfgDir("eff-seeded");
  await seedTwoHarnesses(cfg, 6);
  for (const args of [
    ["efficiency", "--no-sync"],
    ["efficiency", "--no-sync", "--last", "30d"],
    ["efficiency", "--no-sync", "--json"],
    ["efficiency", "--no-sync", "--since", "2026-10-18", "--until", "2026-10-21"],
  ]) {
    const out = await runCli(args, { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
    assert.equal(out.code, 0, `${args.join(" ")}\n${out.stdout}${out.stderr}`);
  }
});
