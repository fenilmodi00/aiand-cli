import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLOSED_URL, cliEnv, FAKE_API_KEY, runCli, withEnv, withTestEnv } from "./helpers.mjs";

/**
 * Branch-hardening pass (final consolidation of the observability epic):
 * broad flag/filter/failure sweeps over the command surfaces whose branch
 * coverage lagged — heatmap, wrapped, overview, report, recommend, mcp,
 * store. Behavior-level: exit codes and output presence, not internals.
 */

const env = withTestEnv("branch-hardening", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const base = Date.parse("2026-10-19T10:00:00.000Z");

function iso(offsetMs) {
  return new Date(base + offsetMs).toISOString();
}

async function seedStore(cfg, rows) {
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      insert.run(
        r.id,
        r.model ?? "zai-org/glm-5.3",
        r.api_key ?? null,
        r.status ?? 200,
        r.ttft ?? 300,
        r.latency ?? null,
        r.input ?? 1000,
        r.output ?? 100,
        r.cached ?? 500,
        r.cost === null ? null : String(r.cost),
        r.cost,
        r.currency === null ? null : (r.currency ?? "usd"),
        r.created_at ?? iso(0),
        r.created_at ?? iso(0),
      );
    }
    opened.db.close();
  });
}

const CLAUDE_MASK_PLACEHOLDER = "sk-test-claude-super-secret-key-000";

function standardRows() {
  return [
    { id: "a1", cost: 0.02 },
    { id: "a2", cost: 0.03, created_at: iso(60_000) },
    { id: "a3", cost: 0.04, created_at: iso(120_000), model: "openai/gpt-5.2" },
    { id: "a4", cost: null, currency: null, created_at: iso(180_000) },
    { id: "a5", cost: 0.05, currency: "eur", created_at: iso(240_000) },
  ];
}

// ---------------------------------------------------------------------------
// heatmap: flag/filter/metric/window sweeps
// ---------------------------------------------------------------------------

test("heatmap: window flags, filters, metrics, and mixed-currency rows", async () => {
  const cfg = cfgDir("heat-flags");
  const { maskKey } = await import("../dist/api/agent-keys.js");
  const mask = await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    return maskKey(CLAUDE_MASK_PLACEHOLDER);
  });
  await seedStore(
    cfg,
    standardRows().map((r) => ({ ...r, api_key: mask })),
  );

  const cases = [
    ["heatmap", "--no-sync"],
    ["heatmap", "--no-sync", "--metric", "requests"],
    ["heatmap", "--no-sync", "--since", "2026-10-18", "--until", "2026-10-20"],
    ["heatmap", "--no-sync", "--last", "7d", "--timezone", "Asia/Tokyo"],
    ["heatmap", "--no-sync", "--range", "30days"],
    ["heatmap", "--no-sync", "--harness", "claude"],
    ["heatmap", "--no-sync", "--harness", "claude", "--harness", "opencode"],
    ["heatmap", "--no-sync", "--model", "openai/*"],
    ["heatmap", "--no-sync", "--model", "zai-org/*", "--metric", "requests"],
    ["heatmap", "--no-sync", "--range", "24h"],
  ];
  for (const args of cases) {
    const { code, stdout, stderr } = await runCli(args, { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
    assert.equal(code, 0, `${args.join(" ")} exits 0\n${stderr}${stdout}`);
    assert.ok(stdout.includes("Mon"), `${args.join(" ")} renders the grid`);
  }

  // Unknown timezone / unknown metric are user errors, not crashes.
  const badTz = await runCli(["heatmap", "--no-sync", "--timezone", "Mars/Olympus"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.notEqual(badTz.code, 0);
  const badMetric = await runCli(["heatmap", "--no-sync", "--metric", "vibes"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.notEqual(badMetric.code, 0);
});

test("heatmap: sync attempt against a dead gateway warns and still renders", async () => {
  const cfg = cfgDir("heat-deadgw");
  await seedStore(cfg, standardRows());
  const { code, stdout, stderr } = await runCli(["heatmap", "--base-url", CLOSED_URL], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: FAKE_API_KEY }),
  });
  assert.equal(code, 0, "fail-open: the heatmap renders despite the dead gateway");
  assert.ok(stdout.includes("Mon"));
  assert.ok(/sync/i.test(stderr), "the sync failure is surfaced on stderr");
});

// ---------------------------------------------------------------------------
// wrapped: format/window/cost/sync branches
// ---------------------------------------------------------------------------

test("wrapped: window flags, formats, no-cost, json, and dead-gateway sync", async () => {
  const cfg = cfgDir("wrapped-flags");
  await seedStore(cfg, standardRows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  for (const args of [
    ["wrapped", "--no-sync", "--last", "7d"],
    ["wrapped", "--no-sync", "--range", "7days"],
    ["wrapped", "--no-sync", "--since", "2026-10-18", "--until", "2026-10-21"],
    ["wrapped", "--no-sync", "--last", "4w", "--format", "markdown"],
    ["wrapped", "--no-sync", "--last", "4w", "--json"],
    ["wrapped", "--no-sync", "--last", "4w", "--no-cost", "--format", "markdown"],
  ]) {
    const { code, stdout } = await runCli(args, base);
    assert.equal(code, 0, args.join(" "));
    assert.ok(stdout.length > 0);
  }

  const dead = await runCli(["wrapped", "--base-url", CLOSED_URL], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: FAKE_API_KEY }),
  });
  assert.equal(dead.code, 0, "wrapped survives a dead gateway (fail-open sync)");

  const badTz = await runCli(["wrapped", "--no-sync", "--timezone", "Not/AZone"], base);
  assert.notEqual(badTz.code, 0);
});

// ---------------------------------------------------------------------------
// overview + report + recommend: section/format/filter branches
// ---------------------------------------------------------------------------

test("overview: sections, filters, formats, empty and unknown-agent states", async () => {
  const cfg = cfgDir("overview-flags");
  await seedStore(cfg, standardRows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  for (const args of [
    ["overview", "--no-sync"],
    ["overview", "--no-sync", "--sections", "totals,by-harness"],
    ["overview", "--no-sync", "--sections", "models,daily"],
    ["overview", "--no-sync", "--sections", "busiest,budget"],
    ["overview", "--no-sync", "--last", "2w"],
    ["overview", "--no-sync", "--no-cost"],
    ["overview", "--no-sync", "--json"],
    ["overview", "--no-sync", "--json", "--sections", "totals"],
    ["overview", "--no-sync", "--harness", "claude"],
    ["overview", "--no-sync", "--harness", "nobody-here"],
    ["overview", "--no-sync", "--model", "openai/*"],
    ["overview", "--no-sync", "--timezone", "America/New_York"],
  ]) {
    const { code, stdout } = await runCli(args, base);
    assert.equal(code, 0, args.join(" "));
    assert.ok(stdout.length > 0);
  }

  const empty = cfgDir("overview-empty");
  const none = await runCli(["overview", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: empty }),
  });
  assert.equal(none.code, 0);
});

test("report: theme/out/sections variants write a self-contained file", async () => {
  const cfg = cfgDir("report-flags");
  await seedStore(cfg, standardRows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  for (const args of [
    ["report", "--no-sync"],
    ["report", "--no-sync", "--theme", "dark"],
    ["report", "--no-sync", "--theme", "auto"],
    ["report", "--no-sync", "--sections", "timeseries,matrix"],
    ["report", "--no-sync", "--sections", "sessions,budget"],
    ["report", "--no-sync", "--top", "3"],
    ["report", "--no-sync", "--last", "4w"],
  ]) {
    const { code, stdout } = await runCli(args, base);
    assert.equal(code, 0, args.join(" "));
    assert.ok(
      /wrote/i.test(stdout) || stdout.includes(".html"),
      `report names its output: ${stdout}`,
    );
  }

  const empty = cfgDir("report-empty");
  const none = await runCli(["report", "--no-sync"], { env: cliEnv({ AIAND_CONFIG_DIR: empty }) });
  assert.equal(none.code, 0);
});

test("recommend: sort/top/harness/json/insufficient-data branches", async () => {
  const cfg = cfgDir("recommend-flags");
  await seedStore(cfg, standardRows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  for (const args of [
    ["recommend", "--no-sync"],
    ["recommend", "--no-sync", "--sort", "ttft"],
    ["recommend", "--no-sync", "--sort", "hit"],
    ["recommend", "--no-sync", "--sort", "errors"],
    ["recommend", "--no-sync", "--top", "1"],
    ["recommend", "--no-sync", "--harness", "claude"],
    ["recommend", "--no-sync", "--range", "30d"],
    ["recommend", "--no-sync", "--json"],
    ["recommend", "--no-sync", "--last", "1m"], // tiny window: insufficient data path
  ]) {
    const { code, stdout } = await runCli(args, base);
    assert.equal(code, 0, args.join(" "));
    assert.ok(stdout.length > 0);
  }
});

// ---------------------------------------------------------------------------
// mcp + store commands: help/sync/json branches
// ---------------------------------------------------------------------------

test("mcp command: help exits clean without starting a server", async () => {
  const cfg = cfgDir("mcp-help");
  const { code, stdout } = await runCli(["mcp", "--help"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(code, 0);
  assert.ok(/mcp/i.test(stdout));
});

test("store command: status/sync/json/no-sync and dead-gateway fail-open", async () => {
  const cfg = cfgDir("store-flags");
  await seedStore(cfg, standardRows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  const status = await runCli(["store", "--no-sync"], base);
  assert.equal(status.code, 0);

  const statusJson = await runCli(["store", "--no-sync", "--json"], base);
  assert.equal(statusJson.code, 0);
  assert.doesNotThrow(() => JSON.parse(statusJson.stdout));

  const dead = await runCli(["store", "sync", "--base-url", CLOSED_URL], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: FAKE_API_KEY }),
  });
  assert.equal(dead.code, 0, "sync against a dead gateway warns, exits 0");

  const deadJson = await runCli(["store", "sync", "--json", "--base-url", CLOSED_URL], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: FAKE_API_KEY }),
  });
  assert.equal(deadJson.code, 0);

  const empty = cfgDir("store-empty");
  const none = await runCli(["store", "--no-sync"], { env: cliEnv({ AIAND_CONFIG_DIR: empty }) });
  assert.equal(none.code, 0);
});
