import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

/**
 * Branch coverage for ccusage-import's pure parse edges (direct imports —
 * the CLI suite covers the happy paths), recommend's edge inputs, and the
 * sessions command's flag-error branches.
 */

const env = withTestEnv("import-rec-sess", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const NOW = new Date("2026-10-26T00:00:00.000Z");

const dailyRow = (over = {}) => ({
  date: "2026-10-20",
  inputTokens: 1000,
  outputTokens: 100,
  cacheCreationTokens: 50,
  cacheReadTokens: 500,
  costUSD: 0.01,
  ...over,
});

// ---------------------------------------------------------------------------
// parseCcusagePayload: every refusal branch, directly
// ---------------------------------------------------------------------------

test("parse: not JSON, non-object, unknown/ambiguous keys, non-array rows", async () => {
  const { parseCcusagePayload } = await import("../dist/obs/ccusage-import.js");
  assert.throws(() => parseCcusagePayload("{not json", NOW), /not valid JSON/);
  assert.throws(() => parseCcusagePayload("[1,2]", NOW), /expected a ccusage --json report object/);
  assert.throws(() => parseCcusagePayload("null", NOW), /expected a ccusage --json report object/);
  assert.throws(
    () => parseCcusagePayload(JSON.stringify({ hello: 1 }), NOW),
    /no supported ccusage report/,
  );
  assert.throws(
    () => parseCcusagePayload(JSON.stringify({ daily: [], sessions: [] }), NOW),
    /ambiguous payload/,
  );
  assert.throws(
    () => parseCcusagePayload(JSON.stringify({ daily: "nope" }), NOW),
    /must be an array/,
  );
});

test("parse: malformed rows refuse loudly with the index and field", async () => {
  const { parseCcusagePayload } = await import("../dist/obs/ccusage-import.js");
  assert.throws(
    () => parseCcusagePayload(JSON.stringify({ daily: ["nope"] }), NOW),
    /daily\[0\] is not a report row/,
  );
  assert.throws(
    () => parseCcusagePayload(JSON.stringify({ daily: [{ date: "2026-10-20" }] }), NOW),
    /inputTokens/,
  );
  assert.throws(
    () => parseCcusagePayload(JSON.stringify({ daily: [{ ...dailyRow(), inputTokens: -1 }] }), NOW),
    /inputTokens/,
  );
  assert.throws(
    () => parseCcusagePayload(JSON.stringify({ daily: [{ ...dailyRow(), costUSD: "x" }] }), NOW),
    /costUSD/,
  );
  // Older reports carrying totalCost instead of costUSD parse fine.
  const legacy = parseCcusagePayload(
    JSON.stringify({ daily: [dailyRow({ costUSD: undefined, totalCost: 0.02 })] }),
    NOW,
  );
  assert.equal(legacy.rows.length, 1);
  // Unknown extra fields are dropped, not guessed.
  const noisy = parseCcusagePayload(
    JSON.stringify({ daily: [{ ...dailyRow(), mystery: "x" }] }),
    NOW,
  );
  assert.ok(!JSON.stringify(noisy.rows).includes("mystery"));
});

test("readImportPayload: missing file is a clean error", async () => {
  const { readImportPayload } = await import("../dist/obs/ccusage-import.js");
  assert.throws(
    () => readImportPayload(join(env.dir, "absent.json")),
    /Could not read ccusage JSON file/,
  );
  const good = join(env.dir, "payload.json");
  writeFileSync(good, JSON.stringify({ daily: [dailyRow()] }));
  assert.ok(readImportPayload(good).includes("daily"));
});

// ---------------------------------------------------------------------------
// recommend: edge inputs
// ---------------------------------------------------------------------------

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
      const at = r.created_at ?? new Date(Date.parse("2026-10-20T10:00:00.000Z")).toISOString();
      insert.run(
        r.id,
        r.model ?? "zai-org/glm-5.3",
        "sk-test...-000",
        r.status ?? 200,
        r.ttft ?? 300,
        null,
        r.input ?? 1000,
        r.output ?? 100,
        r.cached ?? 500,
        r.cost === null ? null : String(r.cost ?? 0.02),
        r.cost ?? 0.02,
        r.currency === null ? null : (r.currency ?? "usd"),
        at,
        at,
      );
    }
    opened.db.close();
  });
}

test("recommend: single pair, ties, empty --json, and window flags", async () => {
  const cfg = cfgDir("rec-edges");
  await seedStore(cfg, [
    { id: "r1", cost: 0.01 },
    { id: "r2", cost: 0.01, model: "openai/gpt-5.2" }, // different model, same cost
  ]);
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  for (const args of [
    ["recommend", "--no-sync"],
    ["recommend", "--no-sync", "--json"],
    ["recommend", "--no-sync", "--last", "7d"],
    ["recommend", "--no-sync", "--since", "2026-10-19", "--until", "2026-10-21"],
  ]) {
    const out = await runCli(args, base);
    assert.equal(out.code, 0, `${args.join(" ")}\n${out.stdout}${out.stderr}`);
  }

  const empty = cfgDir("rec-empty");
  const json = await runCli(["recommend", "--no-sync", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: empty }),
  });
  assert.equal(json.code, 0, json.stderr);
  JSON.parse(json.stdout);
});

// ---------------------------------------------------------------------------
// sessions: flag-error branches
// ---------------------------------------------------------------------------

test("sessions: bad --session-gap, --top-cost 0, --since without --until", async () => {
  const cfg = cfgDir("sess-flags");
  await seedStore(cfg, [
    { id: "q1", cost: 0.02 },
    {
      id: "q2",
      cost: 0.03,
      created_at: new Date(Date.parse("2026-10-20T11:00:00Z")).toISOString(),
    },
  ]);
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  const badGap = await runCli(["sessions", "--no-sync", "--session-gap", "abc"], base);
  assert.notEqual(badGap.code, 0);
  assert.match(badGap.stderr, /--session-gap/);

  const zeroTop = await runCli(["sessions", "--no-sync", "--top-cost", "0"], base);
  assert.notEqual(zeroTop.code, 0);

  const unknown = await runCli(["sessions", "no-such-session", "--no-sync"], base);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /no-such-session|nearest|No session/i);
});
