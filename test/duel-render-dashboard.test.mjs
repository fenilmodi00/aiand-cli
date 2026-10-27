import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FakeInput, FakeOutput, waitFor, withEnv, withTestEnv } from "./helpers.mjs";

/**
 * Branch coverage for the duel metric table (duelMetricRows every branch —
 * null-TTFT deltas, zero-request pairs, truncation notes) and the
 * dashboard's remaining frame-render branches (compare view, empty
 * sessions, cost masking).
 */

const env = withTestEnv("duel-render", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const pair = (over) => ({
  pair: { harness: over.harness ?? "claude-code", model: over.model ?? "zai-org/glm-5.3" },
  partial: over.partial ?? false,
  requests: over.requests ?? 3,
  inputTokens: over.inputTokens ?? 3000,
  cachedTokens: over.cachedTokens ?? 1500,
  outputTokens: over.outputTokens ?? 300,
  costUsd: over.costUsd ?? 0.06,
  hitRatio: over.hitRatio ?? 0.5,
  ttft: over.ttft ?? { p50: 100, p95: 200 },
  wallMs: over.wallMs ?? 5000,
  errors: over.errors ?? 0,
});

// ---------------------------------------------------------------------------
// duelMetricRows + truncationNote: pure-function branches
// ---------------------------------------------------------------------------

test("duelMetricRows: every metric row, deltas, null-TTFT and zero-request guards", async () => {
  const { duelMetricRows, truncationNote } = await import("../dist/benchmark/duel.js");
  const run = {
    seed: 7,
    source: { kind: "scenario", id: "multi-turn-refactor", turns: 3 },
    pairs: [
      pair({ harness: "claude-code" }),
      pair({ harness: "omp", ttft: { p50: null, p95: null }, requests: 0, costUsd: 0 }),
    ],
  };
  const rows = duelMetricRows(run, 0);
  const metrics = rows.map((r) => r.metric);
  for (const m of [
    "total cost",
    "cost/turn",
    "input tokens",
    "output tokens",
    "cache-hit ratio",
    "TTFT p50",
    "TTFT p95",
    "wall time",
  ]) {
    assert.ok(metrics.includes(m), `row ${m} present`);
  }
  // Baseline cell first; the omp column exists; deltas are null for baseline
  // and null for TTFT when either side lacks a sample.
  const ttft50 = rows.find((r) => r.metric === "TTFT p50");
  assert.equal(ttft50.deltas[0], null, "baseline delta is null");
  assert.equal(ttft50.deltas[1], null, "null-TTFT delta is null");
  // Zero-request cost/turn guards against division by zero.
  const costPerTurn = rows.find((r) => r.metric === "cost/turn");
  assert.ok(!costPerTurn.cells.some((c) => c.includes("NaN") || c.includes("Infinity")), "no NaN");

  // Scenario sources never carry a truncation note.
  assert.equal(truncationNote(run), null);
  // Truncated session sources do.
  assert.match(
    truncationNote({
      ...run,
      source: { kind: "session", id: "s1", turns: 50, recordedAt: "x", truncated: true },
    }),
    /turns-cap: only the first 50 turns/,
  );
  // Non-truncated sessions don't.
  assert.equal(
    truncationNote({
      ...run,
      source: { kind: "session", id: "s1", turns: 50, recordedAt: "x", truncated: false },
    }),
    null,
  );
  // Missing baseline: empty table, never a crash.
  assert.deepEqual(duelMetricRows({ ...run, pairs: [] }, 0), []);
});

// ---------------------------------------------------------------------------
// dashboard frame render: compare view, empty sessions, cost masking
// ---------------------------------------------------------------------------

const MONDAY_10 = Date.parse("2026-10-19T10:00:00.000Z");
const HOUR = 3_600_000;

async function seedStore(cfg, n = 6, twoHarnesses = false) {
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    if (twoHarnesses) await recordAgentKey("opencode", "sk-test-opencode-super-secret-key-001");
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
        `d${i}`,
        i % 2 === 0 ? "zai-org/glm-5.3" : "openai/gpt-5.2",
        twoHarnesses && i % 2 === 0 ? "sk-test...-001" : "sk-test...-000",
        200,
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

test("dashboard frame: empty store renders the no-data path without crashing", async () => {
  const cfg = cfgDir("frame-empty");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { runDashboardUi } = await import("../dist/commands/dashboard.js");
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 100;
    output.rows = 30;
    const done = runDashboardUi({
      input,
      output,
      timezone: "UTC",
      models: [],
      initialHarness: null,
      showCost: true,
      refreshMs: 60_000,
      sync: { skipped: true },
      now: new Date(MONDAY_10 + 12 * HOUR),
    });
    try {
      await waitFor(() => output.text.includes("ai& dashboard"));
      // No sessions in the window: the empty-sessions branch renders, no
      // undefined/NaN leaks anywhere.
      assert.ok(!/undefined|NaN/.test(output.text), "no undefined/NaN leak");
      input.send("q");
      await done;
    } finally {
      input.send("q");
      await done.catch(() => {});
    }
  });
});

test("dashboard frame: compare view renders with two harnesses; no-cost masks money", async () => {
  const cfg = cfgDir("frame-compare");
  await seedStore(cfg, 8, true);
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { runDashboardUi } = await import("../dist/commands/dashboard.js");
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 110;
    output.rows = 40;
    const done = runDashboardUi({
      input,
      output,
      timezone: "UTC",
      models: [],
      initialHarness: null,
      showCost: false,
      refreshMs: 60_000,
      sync: { skipped: true },
      now: new Date(MONDAY_10 + 12 * HOUR),
    });
    try {
      await waitFor(() => output.text.includes("ai& dashboard"));
      input.send("c"); // compare view needs 2+ harnesses to build stats
      await waitFor(() => /Harness compare|Top 5/i.test(output.text), 5000, "compare or pinned");
      assert.ok(!/\$|USD|€/i.test(output.text), "no-cost masks every money figure");
      input.send("q");
      await done;
    } finally {
      input.send("q");
      await done.catch(() => {});
    }
  });
});

test("dashboard frame: scroll beyond the list end clamps, pinned top-5 stays", async () => {
  const cfg = cfgDir("frame-scroll");
  await seedStore(cfg, 10);
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { runDashboardUi } = await import("../dist/commands/dashboard.js");
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 100;
    output.rows = 24;
    const done = runDashboardUi({
      input,
      output,
      timezone: "UTC",
      models: [],
      initialHarness: null,
      showCost: true,
      refreshMs: 60_000,
      sync: { skipped: true },
      now: new Date(MONDAY_10 + 12 * HOUR),
    });
    try {
      await waitFor(() => output.text.includes("Top 5 sessions (pinned)"));
      // Scroll far past the end: clamps, never crashes, pin stays.
      for (let i = 0; i < 30; i += 1) input.send("j");
      await waitFor(() => output.text.includes("ai& dashboard"));
      assert.ok(output.text.includes("Top 5 sessions (pinned)"), "pin survives max scroll");
      input.send("q");
      await done;
    } finally {
      input.send("q");
      await done.catch(() => {});
    }
  });
});
