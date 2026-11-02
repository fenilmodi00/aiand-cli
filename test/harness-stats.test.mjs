import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLOSED_URL, cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

/**
 * Ticket #64 — `aiand harness stats` / `harness compare` on the real workload.
 * Pure aggregation tests import the built module; CLI tests seed a real store
 * under an isolated AIAND_CONFIG_DIR and drive dist/index.js with --no-sync.
 */

// One file-level env (withTestEnv registers FILE hooks); each test gets its
// own config subdir so stores/key maps never bleed between tests.
const env = withTestEnv("harness-stats", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const HOUR = 60 * 60 * 1000;
const baseTime = Date.parse("2026-10-20T10:00:00.000Z");

function iso(offsetMs) {
  return new Date(baseTime + offsetMs).toISOString();
}

function row(overrides) {
  return {
    model: "zai-org/glm-5.3",
    api_key: "sk-test-claude...aaaa",
    created_at: iso(0),
    input_tokens: 1000,
    output_tokens: 100,
    cached_tokens: 500,
    cost_value: 0.01,
    currency: "usd",
    status_code: 200,
    ttft_ms: 300,
    ...overrides,
  };
}

import { WINNER_MARKER } from "../dist/obs/harness-stats.js";

async function loadEngine() {
  return import("../dist/obs/harness-stats.js");
}

function seedRequests(db, rows) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
      "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) {
    insert.run(
      r.id,
      r.model,
      r.api_key,
      r.status_code,
      r.ttft_ms,
      null,
      r.input_tokens,
      r.output_tokens,
      r.cached_tokens,
      String(r.cost_value),
      r.cost_value,
      r.currency,
      r.created_at,
      r.created_at,
    );
  }
}

test("percentile uses linear interpolation between closest ranks", async () => {
  const { percentile } = await loadEngine();
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10, 20], 0), 10);
  assert.equal(percentile([10, 20], 1), 20);
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.9), 7);
});

test("verdict thresholds are cacheVerdict's, via the shared function", async () => {
  const { buildHarnessStats } = await loadEngine();
  const { cacheVerdict } = await import("../dist/api/cache-report.js");

  // The shared verdict law itself (ticket: <5 warn, <0.2 bad, <0.5 warn, else good).
  const group = (requests, cached, input) => ({
    key: "x",
    requests,
    inputTokens: input,
    cachedTokens: cached,
    outputTokens: 0,
    costUsd: 0,
  });
  assert.equal(cacheVerdict(group(4, 900, 1000)), "warn");
  assert.equal(cacheVerdict(group(6, 100, 1000)), "bad");
  assert.equal(cacheVerdict(group(6, 400, 1000)), "warn");
  assert.equal(cacheVerdict(group(6, 600, 1000)), "good");

  // …and harness stats route through it: <5 requests → warn.
  const few = buildHarnessStats(
    Array.from({ length: 4 }, (_, i) =>
      row({ id: `a${i}`, created_at: iso(i * 60_000), cached_tokens: 900 }),
    ),
  );
  assert.equal(few.harnesses.length, 1);
  assert.equal(few.harnesses[0].verdict, "warn");

  const many = buildHarnessStats(
    Array.from({ length: 6 }, (_, i) =>
      row({ id: `b${i}`, created_at: iso(i * 60_000), cached_tokens: 900 }),
    ),
  );
  assert.equal(many.harnesses[0].verdict, "good");
});

test("mixed-model sessions are excluded AND counted, never assigned", async () => {
  const cfg = cfgDir("mixed");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { recordAgentKey, maskKey } = await import("../dist/api/agent-keys.js");
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-0001");
    const claudeMask = maskKey("sk-test-claude-super-secret-key-000");
    const opencodeMask = maskKey("sk-test-opencode-super-secret-0001");

    const { buildHarnessStats } = await loadEngine();
    const rows = [
      // claude session 1: single model, 3 requests
      row({ id: "c1", api_key: claudeMask, created_at: iso(0) }),
      row({ id: "c2", api_key: claudeMask, created_at: iso(60_000) }),
      row({ id: "c3", api_key: claudeMask, created_at: iso(120_000) }),
      // claude session 2 (after a long gap): TWO models → mixed, excluded
      row({ id: "m1", api_key: claudeMask, created_at: iso(20 * HOUR), model: "zai-org/glm-5.3" }),
      row({
        id: "m2",
        api_key: claudeMask,
        created_at: iso(20 * HOUR + 60_000),
        model: "openai/gpt-5.2",
      }),
      // opencode session: single model, 2 requests
      row({
        id: "o1",
        api_key: opencodeMask,
        created_at: iso(0),
        input_tokens: 2000,
        cached_tokens: 1800,
      }),
      row({
        id: "o2",
        api_key: opencodeMask,
        created_at: iso(60_000),
        input_tokens: 2000,
        cached_tokens: 1800,
      }),
    ];
    const stats = buildHarnessStats(rows);

    assert.equal(stats.provenance.excludedMixed, 1);
    assert.equal(stats.excluded.length, 1);
    assert.equal(stats.excluded[0].models.length, 2);
    // OBS-LT-4: the excluded session's gateway-billed spend, one definition.
    assert.deepEqual(stats.excludedMixed, {
      sessions: 1,
      requests: 2,
      tokens: { in: 2000, out: 200, cached: 1000 },
      cost: 0.02,
      currency: "usd",
    });

    const claude = stats.harnesses.find((h) => h.harness === "claude");
    const opencode = stats.harnesses.find((h) => h.harness === "opencode");
    assert.ok(claude && opencode, "both attributed harnesses present");
    // Neither harness's totals include the mixed session's rows.
    assert.equal(claude.requests, 3);
    assert.equal(claude.sessions, 1);
    assert.equal(opencode.requests, 2);
    assert.equal(opencode.sessions, 1);
  });
});

test("errorRate counts non-2xx excluding 429; null status is not an error (#88)", async () => {
  const { buildHarnessStats } = await loadEngine();
  const rows = [
    row({ id: "r1", created_at: iso(0), status_code: 429 }),
    row({ id: "r2", created_at: iso(60_000), status_code: 500 }),
    // 3xx is non-2xx, so it is an error per the pair-stats rule (#88).
    row({ id: "r3", created_at: iso(120_000), status_code: 302 }),
    row({ id: "r4", created_at: iso(180_000), status_code: null }),
    ...Array.from({ length: 6 }, (_, i) =>
      row({ id: `ok${i}`, created_at: iso(240_000 + i * 60_000) }),
    ),
  ];
  const harness = buildHarnessStats(rows).harnesses[0];
  assert.equal(harness.requests, 10);
  // 429 excluded (gateway pressure), 302 + 500 counted, null unknown: 2/10.
  assert.ok(Math.abs(harness.errorRate - 0.2) < 1e-9); // #88
});

test("samples reconcile: the listed sessions are exactly the aggregates' input", async () => {
  const { buildHarnessStats } = await loadEngine();
  const rows = [
    row({ id: "s1", created_at: iso(0), cost_value: 0.1, cached_tokens: 900 }),
    row({ id: "s1b", created_at: iso(60_000), cost_value: 0.2, cached_tokens: 900 }),
    row({ id: "s2", created_at: iso(3 * HOUR), cost_value: 0.3, cached_tokens: 900 }),
    row({ id: "s2b", created_at: iso(3 * HOUR + 60_000), cost_value: 0.9, cached_tokens: 900 }),
  ];
  const stats = buildHarnessStats(rows);
  const harness = stats.harnesses[0];
  assert.equal(harness.samples.length, 2);
  const sampleCostSum = harness.samples.reduce((sum, s) => sum + (s.cost ?? 0), 0);
  assert.ok(Math.abs(sampleCostSum - (harness.cost ?? 0)) < 1e-9);
  // Sessions cost 0.3 and 1.2 → p50 = 0.75, p90 = 0.3 + 0.9·0.9 = 1.11.
  assert.ok(Math.abs((harness.costPerSession.p50 ?? 0) - 0.75) < 1e-9);
  assert.ok(Math.abs((harness.costPerSession.p90 ?? 0) - 1.11) < 1e-9);
});

test("cohort seam narrows rows without touching the aggregation", async () => {
  const { buildHarnessStats } = await loadEngine();
  const rows = [
    row({ id: "x1", model: "zai-org/glm-5.3", created_at: iso(0) }),
    // Far enough apart to be its own session, so the two models never mix.
    row({ id: "x2", model: "openai/gpt-5.2", created_at: iso(20 * HOUR) }),
  ];
  const all = buildHarnessStats(rows);
  assert.equal(all.harnesses.length, 1);
  assert.equal(all.harnesses[0].requests, 2);
  const narrowed = buildHarnessStats(rows, { cohort: (r) => r.model === "zai-org/glm-5.3" });
  assert.equal(narrowed.harnesses[0].requests, 1);
});

test("compare verdicts gate on CI separation (#147)", async () => {
  const { compareVerdicts } = await loadEngine();
  const make = (harness, over = {}) => ({
    harness,
    requests: 10,
    sessions: 2,
    tokens: { in: 1, out: 1, cached: 1 },
    cost: 1,
    currency: "usd",
    costPerSession: { p50: 0.5, p90: 1, ci95: null },
    ttft: { p50: 400, p95: 900 },
    cacheHitRatio: 0.8,
    errorRate: 0.1,
    verdict: "good",
    ci95: {
      costPerSessionP50: { lo: 0.3, hi: 0.7 },
      ttftP50: { lo: 300, hi: 500 },
      ttftP95: null,
      cacheHitRatio: { lo: 0.7, hi: 0.9 },
      errorRate: { lo: 0.05, hi: 0.2 },
      cleanRate: null,
      toolErrorRate: null,
    },
    samples: [],
    ...over,
  });
  // Disjoint CIs → decisive winners.
  const rows = [
    make("a", {
      errorRate: 0.15,
      ci95: {
        costPerSessionP50: { lo: 0.45, hi: 0.7 },
        ttftP50: { lo: 300, hi: 500 },
        ttftP95: null,
        cacheHitRatio: { lo: 0.7, hi: 0.9 },
        errorRate: { lo: 0.09, hi: 0.25 },
        cleanRate: null,
        toolErrorRate: null,
      },
    }),
    make("b", {
      costPerSession: { p50: 0.2, p90: 1 },
      ttft: { p50: 200, p95: 500 },
      cacheHitRatio: 0.4,
      errorRate: 0.03,
      ci95: {
        costPerSessionP50: { lo: 0.05, hi: 0.35 },
        ttftP50: { lo: 150, hi: 250 },
        ttftP95: null,
        cacheHitRatio: { lo: 0.2, hi: 0.6 },
        errorRate: { lo: 0.005, hi: 0.08 },
        cleanRate: null,
        toolErrorRate: null,
      },
    }),
  ];
  const verdicts = compareVerdicts(rows);
  assert.equal(verdicts.costPerSessionP50.winner, "b");
  assert.deepEqual(verdicts.costPerSessionP50.tied, []);
  assert.equal(verdicts.errorRate.winner, "b");
  assert.equal(verdicts.cacheHitRatio.winner, "a");
  assert.equal(verdicts.ttftP50.winner, "b");
  // Overlapping CIs → no winner, tied = both harnesses, sorted.
  const overlap = compareVerdicts([
    make("y", { ci95: { ...make("y").ci95, costPerSessionP50: { lo: 0.1, hi: 0.6 } } }),
    make("x", {
      costPerSession: { p50: 0.2, p90: 1 },
      ci95: { ...make("x").ci95, costPerSessionP50: { lo: 0.05, hi: 0.55 } },
    }),
  ]);
  assert.equal(overlap.costPerSessionP50.winner, null);
  assert.deepEqual(overlap.costPerSessionP50.tied, ["x", "y"]);
  // All-null metric → no winner, empty tie.
  const nulls = compareVerdicts([
    { ...rows[0], ttft: { p50: null, p95: null }, ci95: { ...rows[0].ci95, ttftP50: null } },
    { ...rows[1], ttft: { p50: null, p95: null }, ci95: { ...rows[1].ci95, ttftP50: null } },
  ]);
  assert.equal(nulls.ttftP50.winner, null);
  assert.deepEqual(nulls.ttftP50.tied, []);
  // No rows at all → all verdicts empty.
  const none = compareVerdicts([]);
  for (const v of Object.values(none)) {
    assert.equal(v.winner, null);
    assert.deepEqual(v.tied, []);
  }
});

test("cli: stats --json schema, attribution, and mixed exclusion on a seeded store", async () => {
  const cfg = cfgDir("cli");
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey, maskKey } = await import("../dist/api/agent-keys.js");
  let claudeMask;
  let opencodeMask;
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-0001");
    claudeMask = maskKey("sk-test-claude-super-secret-key-000");
    opencodeMask = maskKey("sk-test-opencode-super-secret-0001");
  });

  const rows = [
    ...Array.from({ length: 6 }, (_, i) =>
      row({ id: `c${i}`, api_key: claudeMask, created_at: iso(i * 60_000), cached_tokens: 900 }),
    ),
    // mixed-model session on the claude key
    row({ id: "mx1", api_key: claudeMask, created_at: iso(20 * HOUR), model: "zai-org/glm-5.3" }),
    row({
      id: "mx2",
      api_key: claudeMask,
      created_at: iso(20 * HOUR + 60_000),
      model: "openai/gpt-5.2",
    }),
    ...Array.from({ length: 6 }, (_, i) =>
      row({
        id: `o${i}`,
        api_key: opencodeMask,
        created_at: iso(i * 60_000),
        input_tokens: 2000,
        cached_tokens: 100,
        status_code: i === 4 ? 500 : 200,
      }),
    ),
  ];

  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok, "store opens under the test config dir");
    seedRequests(opened.db, rows);
    opened.db.close();
  });

  const { code, stdout } = await runCli(["harness", "stats", "--no-sync", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(code, 0, `stats exits 0\n${stdout}`);
  const payload = JSON.parse(stdout);
  assert.ok(payload.provenance, "provenance block present");
  assert.deepEqual(Object.keys(payload.provenance).sort(), [
    "excludedMixed",
    "labels",
    "range",
    "sessionization",
    "storeWatermark",
    "timezone",
  ]);
  assert.equal(payload.provenance.excludedMixed, 1);
  assert.equal(payload.provenance.sessionization.confidence, "heuristic");
  const claude = payload.harnesses.find((h) => h.harness === "claude");
  const opencode = payload.harnesses.find((h) => h.harness === "opencode");
  assert.ok(claude && opencode, "both harnesses attributed via the key map");
  assert.equal(claude.requests, 6);
  assert.equal(claude.samples.length, 1);
  assert.equal(opencode.requests, 6);
  assert.ok(Math.abs(opencode.errorRate - 1 / 6) < 1e-9);
  for (const field of [
    "requests",
    "sessions",
    "tokens",
    "cost",
    "currency",
    "costPerSession",
    "ttft",
    "cacheHitRatio",
    "errorRate",
    "verdict",
  ]) {
    assert.ok(field in claude, `field ${field} present per requirement 6`);
  }
  // OBS-LT-4: the mixed session's gateway-billed spend rides the payload.
  assert.deepEqual(payload.excludedMixedSpend, {
    sessions: 1,
    requests: 2,
    tokens: { in: 2000, out: 200, cached: 1000 },
    cost: 0.02,
    currency: "usd",
  });
});

// #109: the excluded mixed-model spend line renders when present, absent without one.
test("cli: excluded mixed-model spend line renders when present, absent without one (OBS-LT-4)", async () => {
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  // With a mixed session: stats, compare, and matrix all show the line.
  const withCfg = cfgDir("cli");
  const stats = await runCli(["harness", "stats", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: withCfg }),
  });
  assert.equal(stats.code, 0);
  assert.match(stats.stdout, /excluded mixed-model spend \(1 session\(s\), gateway-billed/);
  assert.match(stats.stdout, /\$0\.0200/);

  const compare = await runCli(["harness", "compare", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: withCfg }),
  });
  assert.equal(compare.code, 0);
  assert.match(compare.stdout, /excluded mixed-model spend \(1 session\(s\), gateway-billed/);

  const matrix = await runCli(["harness", "matrix", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: withCfg }),
  });
  assert.equal(matrix.code, 0);
  // Matrix attributes mixed sessions per model now — no exclusion line.
  assert.ok(!matrix.stdout.includes("excluded mixed-model spend"));

  // --no-cost hides the cost figure but keeps the line.
  const noCost = await runCli(["harness", "stats", "--no-sync", "--no-cost"], {
    env: cliEnv({ AIAND_CONFIG_DIR: withCfg }),
  });
  assert.equal(noCost.code, 0);
  assert.match(noCost.stdout, /excluded mixed-model spend \(1 session\(s\), gateway-billed/);
  assert.ok(!noCost.stdout.includes("$0.0200"), "no-cost hides the cost figure");

  // Without a mixed session: no line anywhere.
  const plainCfg = cfgDir("no-mixed");
  await withEnv({ AIAND_CONFIG_DIR: plainCfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
  });
  const plainMask = await withEnv({ AIAND_CONFIG_DIR: plainCfg }, async () =>
    (await import("../dist/api/agent-keys.js")).maskKey("sk-test-claude-super-secret-key-000"),
  );
  await withEnv({ AIAND_CONFIG_DIR: plainCfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    seedRequests(
      opened.db,
      Array.from({ length: 6 }, (_, i) =>
        row({ id: `p${i}`, api_key: plainMask, created_at: iso(i * 60_000) }),
      ),
    );
    opened.db.close();
  });
  const plain = await runCli(["harness", "stats", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: plainCfg }),
  });
  assert.equal(plain.code, 0);
  assert.ok(!plain.stdout.includes("excluded mixed-model spend"), "no line without mixed");
});

test("cli: compare marks winners and errors below two harnesses", async () => {
  const cfg = cfgDir("compare");
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey, maskKey } = await import("../dist/api/agent-keys.js");
  let maskA;
  let maskB;
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-0001");
    maskA = maskKey("sk-test-claude-super-secret-key-000");
    maskB = maskKey("sk-test-opencode-super-secret-0001");
  });

  const rows = [
    ...Array.from({ length: 6 }, (_, i) =>
      row({
        id: `a${i}`,
        api_key: maskA,
        created_at: iso(i * 60_000),
        cached_tokens: 900,
        ttft_ms: 400,
      }),
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      row({
        id: `b${i}`,
        api_key: maskB,
        created_at: iso(i * 60_000),
        cached_tokens: 100,
        input_tokens: 2000,
        ttft_ms: 200,
        cost_value: 0.001,
      }),
    ),
  ];
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    seedRequests(opened.db, rows);
    opened.db.close();
  });

  const compare = await runCli(["harness", "compare", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(compare.code, 0);
  assert.ok(compare.stdout.includes("▸"), "winner marker present");
  assert.ok(compare.stdout.includes("harness compare"), "header present");

  const single = await runCli(["harness", "compare", "--no-sync", "--agent", "claude"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.notEqual(single.code, 0, "single-harness compare exits non-zero");
  assert.match(single.stderr, /at least 2 harnesses/);

  const samples = await runCli(
    ["harness", "stats", "--no-sync", "--samples", "--agent", "claude"],
    {
      env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
    },
  );
  assert.equal(samples.code, 0);
  assert.ok(samples.stdout.includes("samples"), "samples section header");
  assert.ok(/[0-9a-f]{16}/.test(samples.stdout), "a session id is listed");

  // #90: compare mode renders the sample list too — help no longer lies.
  const compareSamples = await runCli(["harness", "compare", "--no-sync", "--samples"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(compareSamples.code, 0);
  assert.ok(compareSamples.stdout.includes("samples"), "samples section header in compare");
  assert.ok(/[0-9a-f]{16}/.test(compareSamples.stdout), "a session id is listed in compare");
});

test("cli: the synthetic benchmark path still dispatches", async () => {
  const cfg = cfgDir("list");
  const list = await runCli(["harness", "--list-scenarios"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(list.code, 0);
  assert.ok(list.stdout.includes("multi-turn-refactor"));
  const statsHelp = await runCli(["harness", "stats", "--help"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(statsHelp.code, 0);
  assert.ok(statsHelp.stdout.includes("harness stats"));
});

test("cli: a stray positional on harness subcommands is a usage error", async () => {
  const cfg = cfgDir("stray-positional");
  for (const args of [
    ["harness", "stats", "nope"],
    ["harness", "compare", "nope"],
    ["harness", "matrix", "nope"],
    ["harness", "import", "nope"],
  ]) {
    const run = await runCli(args, { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
    assert.equal(run.code, 1, `${args.join(" ")}\n${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /Unknown argument "nope"/);
  }
});

// #88: crafted data (1×429, 1×500, 113×200) must yield the IDENTICAL
// errorRate from `harness stats` and `harness matrix` — one shared
// error-count definition (non-2xx minus 429) on every harness surface.
test("cli: stats and matrix report the same errorRate for the same rows (#88)", async () => {
  const cfg = cfgDir("error-parity");
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
  });
  const mask = await import("../dist/api/agent-keys.js").then((m) =>
    m.maskKey("sk-test-claude-super-secret-key-000"),
  );

  const rows = [
    row({ id: "p429", api_key: mask, created_at: iso(0), status_code: 429 }),
    row({ id: "p500", api_key: mask, created_at: iso(60_000), status_code: 500 }),
    ...Array.from({ length: 113 }, (_, i) =>
      row({ id: `pok${i}`, api_key: mask, created_at: iso(120_000 + i * 60_000) }),
    ),
  ];
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    seedRequests(opened.db, rows);
    opened.db.close();
  });

  const stats = await runCli(["harness", "stats", "--no-sync", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(stats.code, 0, `stats exits 0\n${stats.stdout}`);
  const matrix = await runCli(["harness", "matrix", "--no-sync", "--json", "--unpriced"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(matrix.code, 0, `matrix exits 0\n${matrix.stdout}`);

  const statsRate = JSON.parse(stats.stdout).harnesses[0].errorRate;
  const pair = JSON.parse(matrix.stdout).pairs.find((p) => p.harness === "claude");
  assert.ok(pair, "matrix pair present");
  // 1 error (500) / 115 requests — 429 excluded by the shared definition.
  assert.ok(Math.abs(statsRate - 1 / 115) < 1e-9, `stats errorRate 1/115, got ${statsRate}`); // #88
  assert.equal(pair.errorRate, statsRate, "matrix errorRate identical to stats"); // #88
});

// #91: branch coverage for the CLI guards the #85/#88/#90 work added —
// the fail-open sync warning arms, the mixed-session exclusion render, and
// the shared window parse's --last/--since combination.
test("cli: a failed auto-sync warns (code visible) and the stats still render (#85)", async () => {
  const cfg = cfgDir("sync-warn");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
  });
  // Env key against a closed gateway: openSession succeeds, syncStore fails
  // with code network — the `!result.ok` arm of the fail-open sync block.
  const run = await runCli(["harness", "stats"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: "sk-test", AIAND_BASE_URL: CLOSED_URL }),
  });
  assert.equal(run.code, 0, run.stdout);
  assert.match(run.stderr, /store sync failed \(network\): Could not reach/);
  assert.ok(run.stdout.includes("harness stats"));
});

test("cli: --include-mixed renders the excluded-sessions table (#90)", async () => {
  const cfg = cfgDir("include-mixed");
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  let mask;
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    mask = (await import("../dist/api/agent-keys.js")).maskKey(
      "sk-test-claude-super-secret-key-000",
    );
  });
  const rows = [
    // One clean session…
    ...Array.from({ length: 5 }, (_, i) =>
      row({ id: `im${i}`, api_key: mask, created_at: iso(i * 60_000) }),
    ),
    // …and one mixed-model session: excluded from aggregates, listed with
    // --include-mixed (both the cost and the no-cost column arms).
    row({ id: "imx1", api_key: mask, created_at: iso(3 * HOUR), model: "zai-org/glm-5.3" }),
    row({
      id: "imx2",
      api_key: mask,
      created_at: iso(3 * HOUR + 60_000),
      model: "openai/gpt-5.2",
    }),
  ];
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    seedRequests(opened.db, rows);
    opened.db.close();
  });

  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };
  const plain = await runCli(["harness", "stats", "--no-sync"], base);
  assert.equal(plain.code, 0, plain.stdout);
  assert.match(plain.stdout, /excluded: 1 mixed-model session/);

  const withTable = await runCli(["harness", "stats", "--no-sync", "--include-mixed"], base);
  assert.equal(withTable.code, 0, withTable.stdout);
  assert.match(withTable.stdout, /mixed-model sessions \(excluded from all aggregates\)/);
  assert.ok(/[0-9a-f]{16}/.test(withTable.stdout), "the excluded session id is listed");

  const noCost = await runCli(
    ["harness", "stats", "--no-sync", "--include-mixed", "--no-cost"],
    base,
  );
  assert.equal(noCost.code, 0, noCost.stdout);
  assert.match(noCost.stdout, /mixed-model sessions \(excluded from all aggregates\)/);
});

test("cli: --last combined with --since/--until pins both window edges", async () => {
  const cfg = cfgDir("window-edges");
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  let mask;
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    mask = (await import("../dist/api/agent-keys.js")).maskKey(
      "sk-test-claude-super-secret-key-000",
    );
  });
  const rows = Array.from({ length: 6 }, (_, i) =>
    row({ id: `w${i}`, api_key: mask, created_at: iso(i * 60_000) }),
  );
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    seedRequests(opened.db, rows);
    opened.db.close();
  });

  // --last sets the near edge; --since/--until then override both edges
  // (parseWindowFlags' last-then-since/then-until fallthrough).
  const run = await runCli(
    [
      "harness",
      "stats",
      "--no-sync",
      "--json",
      "--last",
      "30d",
      "--since",
      "2026-10-19",
      "--until",
      "2026-10-21",
    ],
    { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) },
  );
  assert.equal(run.code, 0, run.stdout);
  const payload = JSON.parse(run.stdout);
  assert.match(payload.provenance.range.since, /2026-10-19/);
  assert.match(payload.provenance.range.until, /2026-10-21/);
  const claude = payload.harnesses.find((h) => h.harness === "claude");
  assert.ok(claude, "harness present");
  assert.equal(claude.requests, 6, "all rows sit inside the pinned window");
});

// #100: an empty (future) window is an honest empty answer, exit 0 — the same
// contract `recommend` already follows — in both text and --json modes.
test("cli: compare on an empty window exits 0 with an explicit empty result (#100)", async () => {
  const cfg = cfgDir("compare-empty");
  // No rows at all: an empty store.

  const plain = await runCli(["harness", "compare", "--no-sync", "--last", "30d"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(plain.code, 0, `exit 0 on an empty window\n${plain.stderr}`);
  assert.match(plain.stdout, /no requests in this window/);
  assert.match(plain.stdout, /widen --last|store --sync/);

  // A future --since filters out rows that exist: same contract.
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { openStore, storePath } = await import("../dist/store/index.js");
    const { recordAgentKey } = await import("../dist/api/agent-keys.js");
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    const mask = (await import("../dist/api/agent-keys.js")).maskKey(
      "sk-test-claude-super-secret-key-000",
    );
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    seedRequests(opened.db, [
      row({ id: "c0", api_key: mask, created_at: iso(0) }),
      row({ id: "c1", api_key: mask, created_at: iso(60_000) }),
    ]);
    opened.db.close();
  });
  const future = await runCli(["harness", "compare", "--no-sync", "--since", "2099-01-01"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(future.code, 0, `exit 0 on a future window\n${future.stderr}`);
  assert.match(future.stdout, /no requests in this window/);

  const asJson = await runCli(
    ["harness", "compare", "--no-sync", "--since", "2099-01-01", "--json"],
    { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) },
  );
  assert.equal(asJson.code, 0, asJson.stderr);
  const empty = JSON.parse(asJson.stdout);
  assert.equal(empty.provenance.emptyWindow, true, "explicit empty marker in --json");
  assert.deepEqual(empty.harnesses, []);
});

// #101: help synopsis, options, and behavior tell one --last story; the
// `harness recommend` alias accepts the documented flags.
test("#101 compare/stats/matrix synopsis shows no fake --last default; harness recommend alias takes documented flags", async () => {
  const cfg = cfgDir("help-story");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = (await import("../dist/store/index.js")).openStore(
      (await import("../dist/store/index.js")).storePath(),
    );
    assert.ok(opened.ok);
    seedRequests(
      opened.db,
      Array.from({ length: 6 }, (_, i) => row({ id: `s101-${i}`, created_at: iso(i * 60_000) })),
    );
    opened.db.close();
  });

  // The synopses never present a --last value as the default; the options
  // line states the real default (all stored history).
  for (const args of [
    ["harness", "--help"],
    ["harness", "stats", "--help"],
    ["harness", "compare", "--help"],
    ["harness", "matrix", "--help"],
  ]) {
    const h = await runCli(args, { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
    assert.equal(h.code, 0);
    assert.ok(
      !/\[--last \d+[dhw]\]/.test(h.stdout),
      `no fake default in synopsis: ${args.join(" ")}\n${h.stdout}`,
    );
  }

  // The alias route accepts the documented flags (same parse as recommend).
  for (const flagArgs of [
    ["harness", "recommend", "--no-sync"],
    ["harness", "recommend", "--no-sync", "--last", "30d"],
    ["harness", "recommend", "--no-sync", "--range", "30d"],
    ["harness", "recommend", "--no-sync", "--sort", "ttft"],
    ["harness", "recommend", "--no-sync", "--top", "3"],
    ["harness", "recommend", "--no-sync", "--harness", "claude"],
    ["harness", "recommend", "--no-sync", "--json"],
  ]) {
    const r = await runCli(flagArgs, { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
    assert.equal(r.code, 0, `${flagArgs.join(" ")}: ${r.stderr}`);
    assert.ok(r.stdout.length > 0);
  }
});

// ---------------------------------------------------------------------------
// #130 (T3): behavioral columns — coverage gating, n= rendering, winners,
// cohort filter, --json shape.
// ---------------------------------------------------------------------------

import { normalizeEnvelope } from "../dist/agents/envelope.js";
import { insertEnvelope } from "../dist/store/envelopes.js";

/** Five v2 envelope turns for `agent` with per-tool outcomes + terminals. */
function v2Envelope(toolErrors, terminal) {
  const outcomes = [
    { name: "Bash", ok: toolErrors < 1 },
    { name: "Edit", ok: true },
  ];
  return normalizeEnvelope({
    tools: outcomes.map((o) => o.name),
    toolOutcomes: outcomes,
    terminal,
    editTargets: ["/repo/src/a.ts"],
    projectRoot: "/repo",
  });
}

async function seedBehavioralStore(cfg) {
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey, maskKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-0001");
  });
  const claudeMask = await withEnv({ AIAND_CONFIG_DIR: cfg }, async () =>
    maskKey("sk-test-claude-super-secret-key-000"),
  );
  const opencodeMask = await withEnv({ AIAND_CONFIG_DIR: cfg }, async () =>
    maskKey("sk-test-opencode-super-secret-0001"),
  );
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    // 6 requests per harness, far enough apart to be one session each.
    seedRequests(opened.db, [
      ...Array.from({ length: 6 }, (_, i) =>
        row({ id: `bc${i}`, api_key: claudeMask, created_at: iso(i * 60_000) }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        row({ id: `bo${i}`, api_key: opencodeMask, created_at: iso(i * 60_000) }),
      ),
    ]);
    // claude: 5 v2 envelopes, one errored tool call, mix of terminals.
    const claudeTerminals = ["clean", "clean", "clean", "clean", "errored"];
    for (let i = 0; i < 5; i += 1) {
      insertEnvelope(opened.db, {
        agent: "claude",
        model: "zai-org/glm-5.3",
        apiKey: claudeMask,
        createdAt: iso(i * 60_000 + 30_000),
        envelope: v2Envelope(i === 0 ? 1 : 0, claudeTerminals[i]),
      });
    }
    // opencode: 5 v1 envelopes (no outcomes) → behavioral uncovered.
    for (let i = 0; i < 5; i += 1) {
      insertEnvelope(opened.db, {
        agent: "opencode",
        model: "zai-org/glm-5.3",
        apiKey: opencodeMask,
        createdAt: iso(i * 60_000 + 30_000),
        envelope: normalizeEnvelope({ tools: ["Edit"], editTargets: ["/repo/src/a.ts"] }),
      });
    }
    opened.db.close();
  });
  return { claudeMask, opencodeMask };
}

test("#130 behavioral columns are gated on envelope coverage; covered cells carry n=", async () => {
  const cfg = cfgDir("behavioral");
  await seedBehavioralStore(cfg);
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };
  const run = await runCli(["harness", "compare", "--no-sync"], base);
  assert.equal(run.code, 0, run.stderr);
  // Coverage line: 10 covered turns / 12 requests.
  assert.match(
    run.stdout,
    /behavioral columns: envelopes 83% of turns \(10\/12\), imported 0 session\(s\) across 0 harness\(es\), uncovered → —/,
  );
  // claude (v2): tool-err with bracket + n=; opencode (v1): v2-gated cells are
  // —, one-shot still computable from the edit walk — cells, never zeros.
  assert.match(
    run.stdout,
    /▸ 10\.0% \[[\d.]+%–[\d.]+%\] \(n=5\)/,
    "covered tool-err cell with CI bracket and n",
  );
  // one-shot has no CI surface, so it never carries a winner marker.
  assert.ok(!/▸ 100\.0%/.test(run.stdout), "one-shot without a CI gets no ▸");
  assert.match(run.stdout, / 100\.0% \(n=5\)/, "one-shot still renders honestly");
  assert.ok(run.stdout.includes("—"), "uncovered cells render em-dashes");
});

test("#130 compare without any envelope data degrades to the coverage line only", async () => {
  const cfg = cfgDir("behavioral-none");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { recordAgentKey, maskKey } = await import("../dist/api/agent-keys.js");
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-0001");
    const claudeMask = maskKey("sk-test-claude-super-secret-key-000");
    const opencodeMask = maskKey("sk-test-opencode-super-secret-0001");
    const opened = (await import("../dist/store/index.js")).openStore(
      (await import("../dist/store/index.js")).storePath(),
    );
    assert.ok(opened.ok);
    seedRequests(opened.db, [
      ...Array.from({ length: 6 }, (_, i) =>
        row({ id: `pn${i}`, api_key: claudeMask, created_at: iso(i * 60_000) }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        row({ id: `qn${i}`, api_key: opencodeMask, created_at: iso(i * 60_000) }),
      ),
    ]);
    opened.db.close();
  });
  const run = await runCli(["harness", "compare", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(run.code, 0, run.stderr);
  assert.match(
    run.stdout,
    /behavioral columns: envelopes 0% of turns \(0\/12\), imported 0 session\(s\) across 0 harness\(es\), uncovered → —/,
  );
  // No behavioral column headers at all when nothing is covered.
  assert.ok(!run.stdout.includes("TOOL-ERR"));
  assert.ok(!run.stdout.includes("tool-err"));
});

test("#130 compare --json carries behavioral fields, provenance label, and coverage", async () => {
  const cfg = cfgDir("behavioral-json");
  await seedBehavioralStore(cfg);
  const run = await runCli(["harness", "compare", "--no-sync", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(run.code, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.ok(payload.behavioralCoverage);
  assert.equal(payload.behavioralCoverage.covered, 10);
  assert.equal(payload.behavioralCoverage.total, 12);
  const claude = payload.harnesses.find((h) => h.harness === "claude");
  const opencode = payload.harnesses.find((h) => h.harness === "opencode");
  assert.equal(claude.behavioral.envelopeTurns, 5);
  // 1 errored tool call of 10 (Bash+Edit on each of 5 turns).
  assert.ok(Math.abs(claude.behavioral.toolErrorRate - 0.1) < 1e-9);
  // Each turn is a shell turn (Bash) → edits after turn 1 are retries.
  assert.ok(Math.abs(claude.behavioral.oneShotRate - 0.2) < 1e-9);
  assert.ok(Math.abs(claude.behavioral.retryRate - 0.8) < 1e-9);
  assert.equal(claude.behavioral.sessions.clean, 4);
  assert.equal(claude.behavioral.sessions.errored, 1);
  assert.equal(claude.behavioral.turnsToSuccess, 1);
  assert.equal(claude.labels.behavioral, "heuristic(one-shot/retry envelope rule)");
  // v1 harness: v2-gated rates null (never zeros); the edit walk still runs.
  assert.equal(opencode.behavioral.toolErrorRate, null);
  assert.equal(opencode.behavioral.missedCatchRate, null);
  assert.ok(Math.abs(opencode.behavioral.oneShotRate - 1) < 1e-9);
  assert.equal(opencode.behavioral.envelopeTurns, 5);
  // No terminals on v1 → the split is all-zero with no invented outcome.
  assert.deepEqual(opencode.behavioral.sessions, { clean: 0, aborted: 0, errored: 0 });
});

test("#130 behavioral winner eligibility: uncovered harness never wins", async () => {
  const { compareVerdicts } = await loadEngine();
  const ci95 = {
    costPerSessionP50: { lo: 0.3, hi: 0.7 },
    ttftP50: { lo: 300, hi: 500 },
    ttftP95: null,
    cacheHitRatio: { lo: 0.7, hi: 0.9 },
    errorRate: { lo: 0.05, hi: 0.2 },
    cleanRate: null,
    toolErrorRate: null,
  };
  const covered = {
    harness: "covered",
    requests: 10,
    sessions: 2,
    tokens: { in: 1, out: 1, cached: 1 },
    cost: 1,
    currency: "usd",
    costPerSession: { p50: 0.5, p90: 1, ci95: null },
    ttft: { p50: 400, p95: 900 },
    cacheHitRatio: 0.8,
    errorRate: 0.1,
    verdict: "good",
    ci95,
    behavioral: {
      toolErrorRate: 0.2,
      oneShotRate: 0.5,
      retryRate: 0.5,
      missedCatchRate: 0.1,
      turnsToSuccess: 3,
      sessions: { clean: 2, aborted: 0, errored: 0 },
      envelopeTurns: 5,
    },
    samples: [],
  };
  const uncovered = {
    ...covered,
    harness: "uncovered",
    ci95: { ...ci95, toolErrorRate: null },
    behavioral: {
      toolErrorRate: null,
      oneShotRate: null,
      retryRate: null,
      missedCatchRate: null,
      turnsToSuccess: null,
      sessions: null,
      envelopeTurns: 0,
    },
  };
  const verdicts = compareVerdicts([covered, uncovered]);
  // No interval on the covered side (n < 5 outcomes) and none on the
  // uncovered side, and one-shot/missed-catch/turns have no CI surface at
  // all: separation is unprovable, so no metric crowns a winner.
  assert.equal(verdicts.toolErrorRate.winner, null);
  assert.equal(verdicts.oneShotRate.winner, null);
  assert.equal(verdicts.missedCatchRate.winner, null);
  assert.equal(verdicts.turnsToSuccess.winner, null);
  // No covered cells at all → no behavioral winners.
  const none = compareVerdicts([uncovered, { ...uncovered, harness: "also-none" }]);
  assert.equal(none.toolErrorRate.winner, null);
  assert.equal(none.oneShotRate.winner, null);
});

test("#130 --cohort narrows to the classifier category and states the exclusion", async () => {
  const cfg = cfgDir("behavioral-cohort");
  await seedBehavioralStore(cfg);
  // All envelopes carry Edit only → "Coding" via the deterministic classifier.
  const run = await runCli(["harness", "compare", "--no-sync", "--cohort", "Coding"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /cohort Coding: \d+ of \d+ request\(s\) match — excluded, not folded/);
  const bad = await runCli(["harness", "compare", "--no-sync", "--cohort", "Bogus"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /Unknown cohort/);
});

// #146: imported behavioral markers — precedence, stats columns, coverage
// split, JSON shape. No import → `—` plus the backfill instruction.
// ---------------------------------------------------------------------------

/** Insert one imported marker row directly (the reader round-trips it). */
async function seedImportedMarker(cfg, overrides) {
  return withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { openStore, storePath } = await import("../dist/store/index.js");
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    const row = {
      dedup_key: `k${overrides.dedup_key ?? Math.random()}`,
      harness: "claude",
      session_id: "imported-ses-1",
      kind: "tool",
      tool_name: null,
      outcome: "ok",
      seq: 0,
      at: "2026-10-29T10:00:00.000Z",
      imported_at: "2026-10-30T00:00:00.000Z",
      ...overrides,
    };
    opened.db
      .prepare(
        "INSERT OR IGNORE INTO imported_artifacts " +
          "(dedup_key, harness, session_id, kind, tool_name, outcome, seq, at, imported_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.dedup_key,
        row.harness,
        row.session_id,
        row.kind,
        row.tool_name,
        row.outcome,
        row.seq,
        row.at,
        row.imported_at,
      );
    opened.db.close();
  });
}

test("#146 buildHarnessStats derives imported behavioral stats with envelope precedence", async () => {
  const { buildHarnessStats, MIN_BEHAVIORAL_TURNS } = await loadEngine();
  const imported = [
    // claude: 2 sessions; 3 tool calls (1 error), compaction, terminals.
    {
      dedup_key: "c1",
      harness: "claude",
      session_id: "s1",
      kind: "tool",
      tool_name: null,
      outcome: "ok",
      seq: 0,
      at: "2026-10-29T10:00:00.000Z",
      imported_at: "2026-10-30T00:00:00.000Z",
    },
    {
      dedup_key: "c2",
      harness: "claude",
      session_id: "s1",
      kind: "tool",
      tool_name: null,
      outcome: "error",
      seq: 1,
      at: "2026-10-29T10:01:00.000Z",
      imported_at: "2026-10-30T00:00:00.000Z",
    },
    {
      dedup_key: "c3",
      harness: "claude",
      session_id: "s1",
      kind: "compaction",
      tool_name: null,
      outcome: null,
      seq: null,
      at: null,
      imported_at: "2026-10-30T00:00:00.000Z",
    },
    {
      dedup_key: "c4",
      harness: "claude",
      session_id: "s1",
      kind: "terminal",
      tool_name: null,
      outcome: "clean",
      seq: null,
      at: "2026-10-29T10:02:00.000Z",
      imported_at: "2026-10-30T00:00:00.000Z",
    },
    {
      dedup_key: "c5",
      harness: "claude",
      session_id: "s2",
      kind: "tool",
      tool_name: null,
      outcome: "ok",
      seq: 0,
      at: "2026-10-29T11:00:00.000Z",
      imported_at: "2026-10-30T00:00:00.000Z",
    },
    {
      dedup_key: "c6",
      harness: "claude",
      session_id: "s2",
      kind: "terminal",
      tool_name: null,
      outcome: "errored",
      seq: null,
      at: "2026-10-29T11:01:00.000Z",
      imported_at: "2026-10-30T00:00:00.000Z",
    },
    // codex: session with terminals but no tools → toolErrorRate null.
    {
      dedup_key: "x1",
      harness: "codex",
      session_id: "t1",
      kind: "terminal",
      tool_name: null,
      outcome: "aborted",
      seq: null,
      at: "2026-10-29T12:00:00.000Z",
      imported_at: "2026-10-30T00:00:00.000Z",
    },
  ];
  // Rows attributed through a wired key map (the same discipline the CLI
  // tests use), so request rows and imported markers share the harness id.
  const stats = await withEnv({ AIAND_CONFIG_DIR: cfgDir("engine-precedence") }, async () => {
    const { recordAgentKey, maskKey } = await import("../dist/api/agent-keys.js");
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    const claudeMask = maskKey("sk-test-claude-super-secret-key-000");
    return buildHarnessStats(
      [
        row({ id: "i1", api_key: claudeMask, created_at: iso(0) }),
        row({ id: "i2", api_key: claudeMask, created_at: iso(HOUR) }),
      ],
      { importedMarkers: imported },
    );
  });
  const claude = stats.harnesses.find((h) => h.harness === "claude");
  assert.ok(claude, "claude harness row exists");

  // claude: 3 tool calls, 1 error → 1/3; 2 terminals (clean + errored) →
  // cleanRate 1/2; compactions 1; 2 imported sessions.
  assert.equal(claude.behavioral.behavioralSource, "imported");
  assert.ok(Math.abs(claude.behavioral.toolErrorRate - 1 / 3) < 1e-9);
  assert.equal(claude.behavioral.toolCalls, 3);
  assert.equal(claude.behavioral.compactions, 1);
  assert.equal(claude.behavioral.importedSessions, 2);
  assert.deepEqual(claude.behavioral.sessions, { clean: 1, aborted: 0, errored: 1 });
  assert.ok(Math.abs(claude.behavioral.cleanRate - 0.5) < 1e-9);
  // Import-only: one-shot/retry/missed-catch/turns-to-success stay null.
  assert.equal(claude.behavioral.oneShotRate, null);
  assert.equal(claude.behavioral.retryRate, null);
  assert.equal(claude.behavioral.missedCatchRate, null);
  assert.equal(claude.behavioral.turnsToSuccess, null);
  assert.equal(claude.behavioral.envelopeTurns, 0);
  // codex (terminal-only import, no codex requests → tested via the coverage
  // split; per-harness derivation of a terminal-only session is asserted in
  // the CLI test below with a wired key map).

  // Coverage split: imported side counts sessions/harnesses, never summed
  // into the envelope turns.
  assert.deepEqual(stats.behavioralCoverage.imported, { sessions: 3, harnesses: 2 });
  assert.equal(stats.behavioralCoverage.envelopes.covered, 0);

  // Precedence: with ≥ MIN_BEHAVIORAL_TURNS envelope turns, envelopes win and
  // imports add nothing (no double count); below the gate, imported applies.
  const envelopes = (n) =>
    Array.from({ length: n }, (_, _i) => ({
      agent: "claude",
      model: null,
      envelope: {
        tools: ["Bash", "Edit"],
        edit_targets: [],
        toolOutcomes: [{ name: "Bash", ok: true }],
        terminal: "clean",
      },
    }));
  const build = async (cfg, turnCount) =>
    withEnv({ AIAND_CONFIG_DIR: cfgDir(cfg) }, async () => {
      const { recordAgentKey, maskKey } = await import("../dist/api/agent-keys.js");
      await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
      const claudeMask = maskKey("sk-test-claude-super-secret-key-000");
      return buildHarnessStats(
        [
          row({ id: "i1", api_key: claudeMask, created_at: iso(0) }),
          row({ id: "i2", api_key: claudeMask, created_at: iso(HOUR) }),
        ],
        { envelopes: envelopes(turnCount), importedMarkers: imported },
      );
    });
  const both = await build("engine-both", MIN_BEHAVIORAL_TURNS);
  const bothClaude = both.harnesses.find((h) => h.harness === "claude");
  assert.equal(bothClaude.behavioral.behavioralSource, "envelope");
  assert.equal(bothClaude.behavioral.envelopeTurns, MIN_BEHAVIORAL_TURNS);
  assert.equal(bothClaude.behavioral.toolCalls, 5);
  assert.equal(bothClaude.behavioral.compactions, null);
  assert.equal(bothClaude.behavioral.importedSessions, 0);
  // ...but the imported coverage split still reports the rows.
  assert.deepEqual(both.behavioralCoverage.imported, { sessions: 3, harnesses: 2 });
  // And a harness BELOW the envelope gate falls through to imported.
  const fallback = await build("engine-fallback", MIN_BEHAVIORAL_TURNS - 1);
  assert.equal(
    fallback.harnesses.find((h) => h.harness === "claude").behavioral.behavioralSource,
    "imported",
  );
});

test("#146 harness stats shows imported tool-error + terminal split; one-shot stays —", async () => {
  const cfg2 = cfgDir("imported-stats2");
  await withEnv({ AIAND_CONFIG_DIR: cfg2 }, async () => {
    const { recordAgentKey, maskKey } = await import("../dist/api/agent-keys.js");
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-0001");
    const claudeMask = maskKey("sk-test-claude-super-secret-key-000");
    const opened = (await import("../dist/store/index.js")).openStore(
      (await import("../dist/store/index.js")).storePath(),
    );
    assert.ok(opened.ok);
    seedRequests(opened.db, [
      ...Array.from({ length: 6 }, (_, i) =>
        row({ id: `is${i}`, api_key: claudeMask, created_at: iso(i * 60_000) }),
      ),
    ]);
    opened.db.close();
  });
  // claude imported markers: 3 tool calls (m1..m3), 1 error, clean terminal.
  await seedImportedMarker(cfg2, {
    dedup_key: "m1",
    harness: "claude",
    session_id: "a",
    kind: "tool",
    outcome: "error",
    seq: 0,
    tool_name: "Bash",
  });
  await seedImportedMarker(cfg2, {
    dedup_key: "m2",
    harness: "claude",
    session_id: "a",
    kind: "tool",
    outcome: "ok",
    seq: 1,
  });
  await seedImportedMarker(cfg2, {
    dedup_key: "m3",
    harness: "claude",
    session_id: "a",
    kind: "tool",
    outcome: "ok",
    seq: 2,
  });
  await seedImportedMarker(cfg2, {
    dedup_key: "m4",
    harness: "claude",
    session_id: "a",
    kind: "compaction",
  });
  await seedImportedMarker(cfg2, {
    dedup_key: "m5",
    harness: "claude",
    session_id: "a",
    kind: "terminal",
    outcome: "clean",
    at: "2026-10-29T10:05:00.000Z",
  });

  const run = await runCli(["harness", "stats", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg2 }),
  });
  assert.equal(run.code, 0, run.stderr);
  // Tool-error 33.3% (1 of 3 tool calls, n=3 by toolCalls), clean 100% (n=1 terminal).
  assert.match(run.stdout, /33\.3% \(n=3\)/);
  assert.match(run.stdout, /100\.0% \(n=1\)/);
  assert.match(run.stdout, /1\/0\/0/); // outcome split
  assert.match(run.stdout, /imported 1 session\(s\) across 1 harness\(es\)/);
  // One-shot column renders — for the import-only harness (never a zero).
  const jsonRun = await runCli(["harness", "stats", "--no-sync", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg2 }),
  });
  assert.equal(jsonRun.code, 0, jsonRun.stderr);
  const jsonPayload = JSON.parse(jsonRun.stdout);
  const jsonClaude = jsonPayload.harnesses.find((h) => h.harness === "claude");
  assert.equal(jsonClaude.behavioral.behavioralSource, "imported");
  assert.equal(jsonClaude.behavioral.oneShotRate, null);
  assert.equal(jsonClaude.behavioral.retryRate, null);
  assert.equal(jsonClaude.behavioral.missedCatchRate, null);
  assert.equal(jsonClaude.behavioral.turnsToSuccess, null);
  assert.ok(Math.abs(jsonClaude.behavioral.toolErrorRate - 1 / 3) < 1e-9);
  assert.equal(jsonClaude.behavioral.toolCalls, 3);
  assert.equal(jsonClaude.behavioral.compactions, 1);
  assert.equal(jsonClaude.behavioral.importedSessions, 1);
  assert.equal(jsonClaude.behavioral.cleanRate, 1);
  assert.equal(jsonClaude.labels.behavioral, "heuristic(imported harness markers)");
});

test("#146 no imported markers: coverage line carries the backfill instruction", async () => {
  const cfg = cfgDir("imported-none");
  await seedBehavioralStore(cfg);
  const run = await runCli(["harness", "compare", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /imported 0 session\(s\) across 0 harness\(es\)/);
  assert.match(run.stdout, /backfill with `aiand harness import`/);
});

test("#146 envelope + imported for the same harness: envelope count wins, no double count", async () => {
  const cfg = cfgDir("imported-both");
  await seedBehavioralStore(cfg); // claude already has 5 v2 envelopes
  await seedImportedMarker(cfg, {
    dedup_key: "b1",
    harness: "claude",
    session_id: "b",
    kind: "tool",
    outcome: "error",
    seq: 0,
  });
  await seedImportedMarker(cfg, {
    dedup_key: "b2",
    harness: "claude",
    session_id: "b",
    kind: "terminal",
    outcome: "errored",
    at: "2026-10-29T10:06:00.000Z",
  });
  const run = await runCli(["harness", "compare", "--no-sync", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(run.code, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  const claude = payload.harnesses.find((h) => h.harness === "claude");
  assert.equal(claude.behavioral.behavioralSource, "envelope");
  // Envelope numbers unchanged: 10 tool calls (5 turns × 2), 5 turns.
  assert.equal(claude.behavioral.toolCalls, 10);
  assert.equal(claude.behavioral.envelopeTurns, 5);
  assert.equal(claude.behavioral.compactions, null);
  assert.equal(claude.behavioral.importedSessions, 0);
  // Coverage keeps the split without summing.
  assert.equal(payload.behavioralCoverage.envelopes.covered, 10);
  assert.equal(payload.behavioralCoverage.imported.sessions, 1);
  assert.equal(payload.behavioralCoverage.imported.harnesses, 1);
  // Compare wins still work: imported-covered harness competes on tool-err.
  const verdicts = (await import("../dist/obs/harness-stats.js")).compareVerdicts(
    payload.harnesses,
  );
  assert.equal(verdicts.toolErrorRate.winner, "claude");
});

// ---------------------------------------------------------------------------
// #147: confidence intervals + evidence-gated verdicts
// ---------------------------------------------------------------------------

test("#147 evidence module: deterministic CIs, null semantics, no deps", async () => {
  const ev = await import("../dist/obs/evidence.js");
  // Wilson known values (same fixture as compare-table's).
  const ci = ev.wilson95(8, 10);
  assert.ok(Math.abs(ci.lo - 0.4901) < 0.001 && Math.abs(ci.hi - 0.9433) < 0.001);
  assert.equal(ev.wilson95(0, 0), null);
  // < 2 values → null for every bootstrap.
  assert.equal(ev.percentileBootstrap([5], 0.5), null);
  assert.equal(ev.percentileBootstrap([], 0.5), null);
  assert.equal(ev.bootstrapRatio([1], [1]), null);
  assert.equal(ev.bootstrapDelta([1], [2], "mean"), null);
  // Deterministic per seed: same seed → byte-identical; different seed → likely different.
  const values = [1.1, 2.3, 0.7, 3.9, 2.8, 1.5, 4.2, 2.2];
  const a = ev.percentileBootstrap(values, 0.5, { seed: 42 });
  const b = ev.percentileBootstrap(values, 0.5, { seed: 42 });
  assert.deepEqual(a, b);
  const c = ev.percentileBootstrap(values, 0.5, { seed: 43 });
  assert.notDeepEqual(a, c);
  // The interval brackets the point estimate's neighborhood and never throws on zeros.
  const p50 = 2.25; // linear-interpolated p50 of values
  assert.ok(a.lo <= p50 && p50 <= a.hi, `CI [${a.lo}, ${a.hi}] covers p50 ${p50}`);
  assert.equal(ev.bootstrapRatio([0, 0, 0, 0, 0], [0, 0, 0, 0, 0], { seed: 1 }), null);
  // seedFromString is FNV-1a, unsigned, deterministic.
  assert.equal(ev.seedFromString("claude"), ev.seedFromString("claude"));
  assert.equal(ev.seedFromString("claude"), 0xe1fc8517); // FNV-1a("claude")
  // mulberry32 determinism: fresh generators with the same seed emit the same sequence.
  const seq = (seed) => {
    const r = ev.mulberry32(seed);
    return [r(), r(), r()];
  };
  assert.deepEqual(seq(7), seq(7));
  assert.notDeepEqual(seq(7), seq(8));
});

test("#147 harness rows carry ci95 only at n >= 5; below it every field is null", async () => {
  const { buildHarnessStats } = await loadEngine();
  const seed = (n, id) =>
    Array.from({ length: n }, (_, i) =>
      row({ id: `${id}${i}`, created_at: iso(i * 20 * 60_000), ttft_ms: 300 + i * 10 }),
    );
  const few = buildHarnessStats(seed(4, "f"));
  assert.equal(few.harnesses.length, 1);
  assert.deepEqual(few.harnesses[0].ci95, {
    costPerSessionP50: null,
    ttftP50: null,
    ttftP95: null,
    cacheHitRatio: null,
    errorRate: null,
    cleanRate: null,
    toolErrorRate: null,
  });
  const many = buildHarnessStats(seed(6, "m"));
  const ci = many.harnesses[0].ci95;
  assert.ok(ci.costPerSessionP50 && ci.ttftP50 && ci.ttftP95 && ci.cacheHitRatio && ci.errorRate);
  assert.equal(ci.cleanRate, null, "no terminal info → null clean-rate CI");
  assert.equal(ci.toolErrorRate, null, "no behavioral source → null tool-err CI");
  // Deterministic across calls: same store shape → identical intervals.
  const again = buildHarnessStats(seed(6, "m"));
  assert.deepEqual(again.harnesses[0].ci95, ci);
});

test("#147 compare: overlapping fixture → no ▸ and the exact tie line; disjoint → one ▸", async () => {
  const cfg = cfgDir("ci-overlap");
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey, maskKey } = await import("../dist/api/agent-keys.js");
  let maskA;
  let maskB;
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-0001");
    maskA = maskKey("sk-test-claude-super-secret-key-000");
    maskB = maskKey("sk-test-opencode-super-secret-0001");
  });
  // Nearly identical workloads → every bootstrap CI overlaps. Sessions spaced
  // 20 min apart so each harness has 6 real session costs to bootstrap over;
  // per-session cost jitter keeps the intervals wide enough to cross.
  const mk = (id, mask, drift) =>
    Array.from({ length: 6 }, (_, i) =>
      row({
        id: `${id}${i}`,
        api_key: mask,
        created_at: iso(i * 20 * 60_000),
        cost_value: 0.01 + drift + (i % 2 === 0 ? 0.004 : -0.003),
        ttft_ms: 300 + drift * 1000 + (i % 2 === 0 ? 40 : -30),
        cached_tokens: 500,
        input_tokens: 1000,
      }),
    );
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    seedRequests(opened.db, [...mk("oa", maskA, 0), ...mk("ob", maskB, 0.0005)]);
    opened.db.close();
  });
  const overlap = await runCli(["harness", "compare", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(overlap.code, 0, overlap.stderr);
  // No ▸ on any cell — the only marker is the legend line's own.
  const withoutLegend = overlap.stdout
    .split("\n")
    .filter((line) => !line.includes(`${WINNER_MARKER} =`))
    .join("\n");
  assert.ok(!withoutLegend.includes("▸"), "no winner marker when every CI overlaps");
  assert.ok(
    overlap.stdout.includes("cost/session: tied — not distinguishable yet (claude, opencode)"),
    `tie footer present:\n${overlap.stdout}`,
  );
  // Repeated runs: byte-identical output.
  const repeat = await runCli(["harness", "compare", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(repeat.stdout, overlap.stdout, "repeated runs are byte-identical");

  // Disjoint: wildly different workloads → at least one decisive ▸ and no tie line.
  const cfg2 = cfgDir("ci-disjoint");
  await withEnv({ AIAND_CONFIG_DIR: cfg2 }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-0001");
    maskA = maskKey("sk-test-claude-super-secret-key-000");
    maskB = maskKey("sk-test-opencode-super-secret-0001");
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    seedRequests(opened.db, [...mk("da", maskA, 0), ...mk("db", maskB, 0.5)]);
    opened.db.close();
  });
  const disjoint = await runCli(["harness", "compare", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg2 }),
  });
  assert.equal(disjoint.code, 0, disjoint.stderr);
  // Cost and ttft CIs are disjoint → exactly those two cells carry ▸.
  const cellLines = disjoint.stdout
    .split("\n")
    .filter((line) => line.startsWith("claude") || line.startsWith("opencode"));
  assert.ok(
    cellLines.some((line) => line.includes("▸ 0.0105")),
    "cost winner marked",
  );
  assert.ok(
    cellLines.some((line) => line.includes("▸ 305ms")),
    "ttft winner marked",
  );
  assert.ok(!disjoint.stdout.includes("cost/session: tied"), "no cost tie when CIs are disjoint");
  assert.ok(
    disjoint.stdout.includes("errors: tied — not distinguishable yet (claude, opencode)"),
    "identical error-free workloads honestly tie",
  );
});

test("#147 compare --json keeps existing fields and adds ci95; clean rate Wilson over terminals", async () => {
  const cfg = cfgDir("ci-json");
  await seedBehavioralStore(cfg);
  await seedImportedMarker(cfg, {
    dedup_key: "t1",
    harness: "claude",
    session_id: "x",
    kind: "tool",
    outcome: "error",
    seq: 0,
  });
  const run = await runCli(["harness", "compare", "--no-sync", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(run.code, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  for (const harness of payload.harnesses) {
    assert.ok(harness.ci95, "ci95 present");
    assert.deepEqual(Object.keys(harness.ci95).sort(), [
      "cacheHitRatio",
      "cleanRate",
      "costPerSessionP50",
      "errorRate",
      "toolErrorRate",
      "ttftP50",
      "ttftP95",
    ]);
    assert.ok(harness.requests !== undefined && harness.behavioral !== undefined);
  }
  const claude = payload.harnesses.find((h) => h.harness === "claude");
  // 6 requests → Wilson CI on the error rate; envelope terminals = 5 → clean CI.
  assert.ok(
    claude.ci95.errorRate &&
      claude.ci95.errorRate.lo <= claude.errorRate &&
      claude.errorRate <= claude.ci95.errorRate.hi,
  );
  // Envelope terminals: 4 clean of 5 → n=5 qualifies; point estimate 0.8.
  assert.ok(claude.behavioral.cleanRate !== null);
  assert.ok(
    claude.ci95.cleanRate && Math.abs(claude.ci95.cleanRate.hi - 0.9637768390302125) < 1e-9,
    "Wilson upper at 4/5",
  );
  // Envelope source wins: 10 tool outcomes (1 error) → toolErrorRate 0.1,
  // n=10 → CI exists; the imported marker contributes nothing (never summed).
  assert.ok(Math.abs(claude.behavioral.toolErrorRate - 0.1) < 1e-9);
  assert.ok(
    claude.ci95.toolErrorRate &&
      claude.ci95.toolErrorRate.lo < 0.1 &&
      0.1 < claude.ci95.toolErrorRate.hi,
  );
  // v1 harness: no terminals → cleanRate null, no CI, never 0.
  const opencode = payload.harnesses.find((h) => h.harness === "opencode");
  assert.equal(opencode.behavioral.cleanRate, null);
  assert.equal(opencode.ci95.cleanRate, null);
});

// ---------------------------------------------------------------------------
// #155: TPS stays out of the harness scorecard JSON
// ---------------------------------------------------------------------------

test("#155 harness stats/compare --json carry no avgTps; TPS is dashboard-only", async () => {
  const cfg = cfgDir("tps-json-excluded");
  await seedBehavioralStore(cfg);
  for (const args of [
    ["harness", "stats", "--no-sync", "--json"],
    ["harness", "compare", "--no-sync", "--json"],
  ]) {
    const run = await runCli(args, { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
    assert.equal(run.code, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.ok(payload.harnesses.length > 0, `${args[1]} returns rows`);
    for (const harness of payload.harnesses) {
      assert.ok(!("avgTps" in harness), `${args.join(" ")} row has no avgTps key`);
    }
    // The whole payload mentions no avgTps anywhere (no nested leak).
    assert.ok(!run.stdout.includes("avgTps"), `${args.join(" ")} payload free of avgTps`);
  }
});

// ---------------------------------------------------------------------------
// #151 baseline regression watch (stateless two-window screen)
// ---------------------------------------------------------------------------

/** N one-request sessions, spaced 20 min (distinct under the 10-min gap). */
function windowRows(prefix, startIso, options = {}) {
  const { n = 10, cost = 0.01, ttft = 300, status = 200 } = options;
  const start = Date.parse(startIso);
  return Array.from({ length: n }, (_, index) =>
    row({
      id: `${prefix}-${index}`,
      created_at: new Date(start + index * 20 * 60_000).toISOString(),
      cost_value: cost,
      ttft_ms: ttft,
      status_code: status,
    }),
  );
}

function terminalMarker(sessionId, outcome, at) {
  return {
    dedup_key: `marker-${sessionId}`,
    harness: "unknown",
    session_id: sessionId,
    kind: "terminal",
    tool_name: null,
    outcome,
    seq: 0,
    at,
    imported_at: at,
  };
}

test("#151 unit: doubled cost over n>=10 is a regression, n=3 is skipped", async () => {
  const { buildRegressionReport } = await import("../dist/obs/regression.js");
  const baseline = windowRows("base", "2026-10-19T00:00:00.000Z", { cost: 0.01 });
  const current = windowRows("cur", "2026-10-20T00:00:00.000Z", { cost: 0.02 });
  const report = buildRegressionReport(current, baseline, { gapMinutes: 10 });

  const cost = report.rows.find((r) => r.metric === "costPerSession");
  assert.ok(cost, "cost row screened");
  assert.equal(cost.verdict, "regression");
  assert.equal(cost.delta.toFixed(4), "0.0100");
  assert.ok(cost.ci95.lo > 0, "delta CI excludes 0");
  assert.deepEqual(cost.n, { current: 10, baseline: 10 });
  assert.equal(report.regressions.length, 1);
  assert.equal(report.rows.find((r) => r.metric === "ttftP95").verdict, "no change");
  assert.equal(report.rows.find((r) => r.metric === "errorRate").verdict, "no change");

  const few = buildRegressionReport(
    windowRows("cur", "2026-10-20T00:00:00.000Z", { n: 3, cost: 0.02 }),
    windowRows("base", "2026-10-19T00:00:00.000Z", { n: 3, cost: 0.01 }),
  );
  assert.equal(few.insufficient, 1);
  assert.equal(few.rows.length, 0);
  assert.equal(few.regressions.length, 0);
});

test("#151 unit: imported clean rate improves only when both windows have coverage", async () => {
  const { buildRegressionReport } = await import("../dist/obs/regression.js");
  const baseline = windowRows("base", "2026-10-19T00:00:00.000Z", { n: 5 });
  const current = windowRows("cur", "2026-10-20T00:00:00.000Z", { n: 5 });
  const baselineMarkers = Array.from({ length: 5 }, (_, i) =>
    terminalMarker(`b-${i}`, "errored", "2026-10-19T00:00:00.000Z"),
  );
  const currentMarkers = Array.from({ length: 5 }, (_, i) =>
    terminalMarker(`c-${i}`, "clean", "2026-10-20T00:00:00.000Z"),
  );
  const report = buildRegressionReport(current, baseline, {
    gapMinutes: 10,
    importedCurrent: currentMarkers,
    importedBaseline: baselineMarkers,
  });
  const clean = report.rows.find((r) => r.metric === "cleanRate");
  assert.ok(clean, "clean rate screened");
  assert.equal(clean.verdict, "improvement");
  assert.equal(clean.delta, 1);
  assert.equal(
    report.rows.some((r) => r.metric === "toolErrorRate"),
    false,
  );
});

test("#151 compare --baseline previous: section, JSON, exit codes, empty baseline", async () => {
  const cfg = cfgDir("baseline-two-window");
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { maskKey, recordAgentKey } = await import("../dist/api/agent-keys.js");
  const key = "sk-test-claude-super-secret-key-000";
  let mask;
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", key);
    mask = maskKey(key);
  });
  const withMask = (rows) => rows.map((entry) => ({ ...entry, api_key: mask }));
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    seedRequests(opened.db, [
      ...withMask(windowRows("base", "2026-10-19T00:00:00.000Z", { cost: 0.01 })),
      ...withMask(windowRows("cur", "2026-10-20T00:00:00.000Z", { cost: 0.02 })),
    ]);
    opened.db.close();
  });

  const envForCli = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };
  const args = [
    "harness",
    "compare",
    "--no-sync",
    "--since",
    "2026-10-20T00:00:00.000Z",
    "--until",
    "2026-10-21T00:00:00.000Z",
    "--baseline",
    "previous",
  ];

  const compared = await runCli(args, envForCli);
  assert.equal(compared.code, 0, compared.stderr);
  assert.match(compared.stdout, /regression vs baseline/);
  assert.match(compared.stdout, /costPerSession/);
  assert.match(compared.stdout, /regression: 1 metric\(s\) worse/);
  assert.match(compared.stdout, /screening, not proof/);

  const failed = await runCli([...args, "--fail-on-regression"], envForCli);
  assert.equal(failed.code, 1, failed.stderr);

  const jsoned = await runCli([...args, "--json"], envForCli);
  assert.equal(jsoned.code, 0, jsoned.stderr);
  const payload = JSON.parse(jsoned.stdout);
  assert.equal(payload.baseline.range.until, "2026-10-20T00:00:00.000Z");
  assert.ok(payload.baseline.regressions >= 1);
  assert.ok(
    payload.baseline.rows.some(
      (entry) => entry.metric === "costPerSession" && entry.verdict === "regression",
    ),
  );

  // No requests in the baseline hour → exit 30 with a clear message.
  const empty = await runCli([...args.slice(0, 7), "--baseline", "1h"], envForCli);
  assert.equal(empty.code, 30, empty.stderr);
  assert.match(empty.stderr, /no requests in the baseline window/);

  // Unbounded current window → exit 30 before reading rows.
  const unbounded = await runCli(
    ["harness", "compare", "--no-sync", "--baseline", "previous"],
    envForCli,
  );
  assert.equal(unbounded.code, 30);
  assert.match(unbounded.stderr, /bounded current window/);
});
