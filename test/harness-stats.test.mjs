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

test("compare winners pick the right harness per metric", async () => {
  const { compareWinners } = await loadEngine();
  const rows = [
    {
      harness: "a",
      requests: 10,
      sessions: 2,
      tokens: { in: 1, out: 1, cached: 1 },
      cost: 1,
      currency: "usd",
      costPerSession: { p50: 0.5, p90: 1 },
      ttft: { p50: 400, p95: 900 },
      cacheHitRatio: 0.8,
      errorRate: 0.1,
      verdict: "good",
      samples: [],
    },
    {
      harness: "b",
      requests: 10,
      sessions: 2,
      tokens: { in: 1, out: 1, cached: 1 },
      cost: 2,
      currency: "usd",
      costPerSession: { p50: 0.2, p90: 1 },
      ttft: { p50: 200, p95: 500 },
      cacheHitRatio: 0.4,
      errorRate: 0.05,
      verdict: "warn",
      samples: [],
    },
  ];
  const winners = compareWinners(rows);
  assert.equal(winners.costPerSessionP50, "b");
  assert.equal(winners.errorRate, "b");
  assert.equal(winners.cacheHitRatio, "a");
  assert.equal(winners.ttftP50, "b");
  // All-null metric → no winner.
  const nulls = compareWinners([
    { ...rows[0], ttft: { p50: null, p95: null } },
    { ...rows[1], ttft: { p50: null, p95: null } },
  ]);
  assert.equal(nulls.ttftP50, null);
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
  assert.match(matrix.stdout, /excluded mixed-model spend \(1 session\(s\), gateway-billed/);

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
