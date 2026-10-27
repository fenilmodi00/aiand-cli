import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

/**
 * Branch coverage for recommend's edge inputs and the sessions command's
 * flag-error branches.
 */

const env = withTestEnv("import-rec-sess", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

// ---------------------------------------------------------------------------
// sessions: toView unit branches (shared with the MCP tool, #70)
// ---------------------------------------------------------------------------

test("sessions toView: model counts, casefolded costs, ttft percentiles, errors", async () => {
  const { toView } = await import("../dist/commands/sessions.js");
  const row = (over) => ({
    id: over.id,
    api_key: null,
    created_at: over.created_at ?? "2026-10-20T10:00:00.000Z",
    input_tokens: 1000,
    output_tokens: 100,
    cached_tokens: 500,
    cost: null,
    cost_value: over.cost_value ?? null,
    currency: over.currency ?? null,
    model: over.model ?? "zai-org/glm-5.3",
    status_code: over.status_code ?? 200,
    ttft_ms: over.ttft_ms ?? null,
  });
  const view = toView({
    session_id: "sess-1",
    agent: "claude",
    api_key: "sk-test...-000",
    started_at: "2026-10-20T10:00:00.000Z",
    ended_at: "2026-10-20T10:20:00.000Z",
    turns: 3,
    input_tokens: 3000,
    output_tokens: 300,
    cached_tokens: 1500,
    cost: 0.06,
    currency: "usd",
    confidence: "gap",
    rows: [
      row({ id: "r1", cost_value: 0.02, currency: "usd", ttft_ms: 100 }),
      row({ id: "r2", cost_value: 0.02, currency: "USD", ttft_ms: 300, model: "openai/gpt-5.2" }),
      row({ id: "r3", cost_value: 0.01, currency: "usd", ttft_ms: 200, status_code: 500 }),
    ],
  });
  assert.equal(view.id, "sess-1");
  assert.equal(view.turns, 3);
  assert.deepEqual(view.models, [
    { model: "zai-org/glm-5.3", count: 2 },
    { model: "openai/gpt-5.2", count: 1 },
  ]);
  // #89: USD casefolds into the same lane as usd.
  assert.deepEqual(view.costs, { usd: 0.05 });
  assert.equal(view.errors, 1);
  assert.equal(view.ttft.p50, 200);
  assert.equal(view.ttft.p95, 290); // interpolated across the 3 samples

  // No costs, no ttfts: null percentiles and empty cost lanes.
  const bare = toView({
    session_id: "sess-2",
    agent: "unknown",
    api_key: null,
    started_at: "2026-10-20T10:00:00.000Z",
    ended_at: "2026-10-20T10:00:00.000Z",
    turns: 1,
    input_tokens: 10,
    output_tokens: 1,
    cached_tokens: 0,
    cost: null,
    currency: null,
    confidence: "single-request",
    rows: [row({ id: "r1", ttft_ms: null })],
  });
  assert.deepEqual(bare.costs, {});
  assert.equal(bare.ttft.p50, null);
  assert.equal(bare.ttft.p95, null);
  assert.equal(bare.errors, 0);
});
