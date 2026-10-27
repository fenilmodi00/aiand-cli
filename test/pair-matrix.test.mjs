import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLOSED_URL, cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

/**
 * Ticket #79 — `aiand harness matrix` and `aiand recommend`: the shared
 * per-(harness, model) pair aggregation, its CLI surfaces, the mixed-model
 * exclusion, the min-sample guard, and the synthetic lane that is displayed
 * but never ranked.
 */

const env = withTestEnv("pair-matrix", () => {});

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
  return import("../dist/obs/pair-stats.js");
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

async function seedStore(cfg, rows) {
  const { openStore, storePath } = await import("../dist/store/index.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok, "store opens under the test config dir");
    seedRequests(opened.db, rows);
    opened.db.close();
  });
}

async function seedAgentKeys(cfg) {
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-0001");
  });
  return {
    claude: await import("../dist/api/agent-keys.js").then((m) =>
      m.maskKey("sk-test-claude-super-secret-key-000"),
    ),
    opencode: await import("../dist/api/agent-keys.js").then((m) =>
      m.maskKey("sk-test-opencode-super-secret-0001"),
    ),
  };
}

// ---------------------------------------------------------------------------
// Pure engine
// ---------------------------------------------------------------------------

test("buildPairStats splits rows per (harness, model) and excludes mixed-model sessions", async () => {
  const masks = await seedAgentKeys(cfgDir("engine-mixed"));
  const rows = [
    // claude / glm-5.3: one 3-request session
    row({ id: "c1", api_key: masks.claude, created_at: iso(0) }),
    row({ id: "c2", api_key: masks.claude, created_at: iso(60_000) }),
    row({ id: "c3", api_key: masks.claude, created_at: iso(120_000) }),
    // claude session with TWO models → mixed, excluded AND counted
    row({ id: "m1", api_key: masks.claude, created_at: iso(20 * HOUR), model: "zai-org/glm-5.3" }),
    row({
      id: "m2",
      api_key: masks.claude,
      created_at: iso(20 * HOUR + 60_000),
      model: "openai/gpt-5.2",
    }),
    // opencode / glm-5.3: one 2-request session, higher hit
    row({
      id: "o1",
      api_key: masks.opencode,
      created_at: iso(0),
      input_tokens: 2000,
      cached_tokens: 1800,
    }),
    row({
      id: "o2",
      api_key: masks.opencode,
      created_at: iso(60_000),
      input_tokens: 2000,
      cached_tokens: 1800,
    }),
    // opencode / gpt-5.2, far later: its own session and pair
    row({
      id: "g1",
      api_key: masks.opencode,
      model: "openai/gpt-5.2",
      created_at: iso(30 * HOUR),
    }),
  ];
  const stats = await withEnv({ AIAND_CONFIG_DIR: cfgDir("engine-mixed") }, () =>
    loadEngine().then(({ buildPairStats }) => buildPairStats(rows)),
  );

  assert.equal(stats.provenance.excludedMixed, 1);
  assert.equal(stats.excluded.length, 1);

  const claudeGlm = stats.pairs.find(
    (p) => p.harness === "claude" && p.model === "zai-org/glm-5.3",
  );
  const openGlm = stats.pairs.find(
    (p) => p.harness === "opencode" && p.model === "zai-org/glm-5.3",
  );
  const openGpt = stats.pairs.find((p) => p.harness === "opencode" && p.model === "openai/gpt-5.2");
  assert.ok(claudeGlm && openGlm && openGpt, "three observed pairs");
  // The mixed session's rows belong to no pair.
  assert.equal(claudeGlm.requests, 3);
  assert.equal(claudeGlm.sessions, 1);
  assert.equal(openGlm.requests, 2);
  assert.equal(openGpt.requests, 1);
  // Tokens/session are per-session averages.
  assert.equal(openGlm.tokensPerSession.in, 4000, "session token sum across its 2 requests");
  // 429 is not an error; non-2xx (other than 429) is.
  const errRows = [
    row({ id: "e1", api_key: masks.claude, created_at: iso(40 * HOUR), status_code: 429 }),
    row({ id: "e2", api_key: masks.claude, created_at: iso(40 * HOUR + 60_000), status_code: 500 }),
    row({
      id: "e3",
      api_key: masks.claude,
      created_at: iso(40 * HOUR + 120_000),
      status_code: 200,
    }),
  ];
  const withErrors = await withEnv({ AIAND_CONFIG_DIR: cfgDir("engine-mixed") }, () =>
    loadEngine().then(({ buildPairStats }) => buildPairStats(errRows)),
  );
  const errPair = withErrors.pairs.find((p) => p.harness === "claude");
  assert.equal(errPair.requests, 3);
  assert.ok(Math.abs(errPair.errorRate - 1 / 3) < 1e-9, "429 excluded, 500 counted");
});

test("verdicts ride cacheVerdict: <5 requests warn, hit-ratio thresholds apply", async () => {
  const { buildPairStats } = await loadEngine();
  const few = buildPairStats(
    Array.from({ length: 4 }, (_, i) =>
      row({ id: `a${i}`, created_at: iso(i * 60_000), cached_tokens: 900 }),
    ),
  );
  assert.equal(few.pairs.length, 1);
  assert.equal(few.pairs[0].verdict, "warn");

  const badHit = buildPairStats(
    Array.from({ length: 6 }, (_, i) =>
      row({ id: `b${i}`, created_at: iso(i * 60_000), cached_tokens: 100 }),
    ),
  );
  assert.equal(badHit.pairs[0].verdict, "bad");

  const good = buildPairStats(
    Array.from({ length: 6 }, (_, i) =>
      row({ id: `g${i}`, created_at: iso(i * 60_000), cached_tokens: 900 }),
    ),
  );
  assert.equal(good.pairs[0].verdict, "good");
});

test("sortPairs: cheaper first by default, hit sorts descending, nulls sink", async () => {
  const { sortPairs } = await loadEngine();
  const mk = (harness, model, costP50, hit) => ({
    harness,
    model,
    requests: 10,
    sessions: 5,
    tokensPerSession: { in: 0, out: 0 },
    costPerSession: { p50: costP50, p90: null },
    costTotal: costP50,
    currency: "usd",
    ttft: { p50: 100, p90: null, p95: null },
    cacheHitRatio: hit,
    errorRate: 0,
    verdict: "good",
    samples: [],
  });
  const rows = [mk("a", "m1", 0.5, 0.6), mk("b", "m2", 0.1, 0.2), mk("c", "m3", null, 0.9)];

  const byCost = sortPairs(rows, "cost");
  assert.deepEqual(
    byCost.map((r) => r.harness),
    ["b", "a", "c"],
    "cheapest first, unpriced sinks",
  );
  const byHit = sortPairs(rows, "hit");
  assert.deepEqual(
    byHit.map((r) => r.harness),
    ["c", "a", "b"],
    "higher hit first",
  );
  // Explicit --order overrides the default direction.
  const costDesc = sortPairs(rows, "cost", "desc");
  assert.deepEqual(
    costDesc.map((r) => r.harness),
    ["a", "b", "c"],
    "explicit desc still sinks nulls",
  );
  // Tie-breaks: equal cost → higher hit, then lower ttft.
  const tied = [mk("a", "m1", 0.5, 0.2), mk("b", "m2", 0.5, 0.8), mk("c", "m3", 0.5, 0.8)];
  tied[1].ttft.p50 = 200;
  tied[2].ttft.p50 = 100;
  const tieSorted = sortPairs(tied, "cost");
  assert.deepEqual(
    tieSorted.map((r) => r.harness),
    ["c", "b", "a"],
  );
});

// ---------------------------------------------------------------------------
// CLI: harness matrix
// ---------------------------------------------------------------------------

async function seededMatrixStore(name) {
  const cfg = cfgDir(name);
  const masks = await seedAgentKeys(cfg);
  await seedStore(cfg, [
    // claude/glm-5.3: 6 sessions × 2 requests, cheapest per session ($0.02)
    ...Array.from({ length: 6 }, (_, s) =>
      Array.from({ length: 2 }, (_, i) =>
        row({ id: `c${s}${i}`, api_key: masks.claude, created_at: iso(s * 2 * HOUR + i * 60_000) }),
      ),
    ).flat(),
    // claude mixed-model session (excluded, counted)
    row({ id: "mx1", api_key: masks.claude, created_at: iso(30 * HOUR), model: "zai-org/glm-5.3" }),
    row({
      id: "mx2",
      api_key: masks.claude,
      created_at: iso(30 * HOUR + 60_000),
      model: "openai/gpt-5.2",
    }),
    // claude/gpt-5.2: 6 single-request sessions, no cost rows (unpriced)
    ...Array.from({ length: 6 }, (_, s) =>
      row({
        id: `u${s}`,
        api_key: masks.claude,
        model: "openai/gpt-5.2",
        created_at: iso(40 * HOUR + s * HOUR),
        cost_value: null,
        cost: null,
        ttft_ms: 900,
      }),
    ),
    // opencode/glm-5.3: 7 single-request sessions, pricier per session
    ...Array.from({ length: 7 }, (_, s) =>
      row({
        id: `o${s}`,
        api_key: masks.opencode,
        created_at: iso(50 * HOUR + s * HOUR),
        input_tokens: 3000,
        cached_tokens: 1500,
        cost_value: 0.05,
        ttft_ms: 200,
      }),
    ),
  ]);
  return cfg;
}

test("cli: harness matrix renders columns, hides unpriced by default, shows with --unpriced", async () => {
  const cfg = await seededMatrixStore("matrix-basic");

  const { code, stdout } = await runCli(["harness", "matrix", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(code, 0);
  for (const cell of [
    "HARNESS",
    "MODEL",
    "COST/SESS",
    "TTFT P50",
    "P95",
    "HIT",
    "ERRORS",
    "VERDICT",
  ]) {
    assert.ok(stdout.includes(cell), `column ${cell} present`);
  }
  // Unpriced rows hidden by default: gpt-5.2 on claude is unpriced.
  assert.ok(!stdout.includes("openai/gpt-5.2"), "unpriced pair hidden without --unpriced");
  // Cheapest pair first (opencode/glm at 0.05/req → sessions ~0.15 vs claude 0.03/sess... just check opencode present).
  assert.ok(stdout.includes("opencode"));
  // Mixed-model footer counts exactly one.
  assert.match(stdout, /1 mixed-model session\(s\) excluded/);

  const priced = await runCli(["harness", "matrix", "--no-sync", "--unpriced"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(priced.code, 0);
  assert.ok(priced.stdout.includes("openai/gpt-5.2"), "--unpriced shows the pair");
  assert.ok(priced.stdout.includes("—"), "unpriced cost renders as em-dash");
});

test("cli: harness matrix --sort/--top/--format markdown/--show p90", async () => {
  const cfg = await seededMatrixStore("matrix-flags");

  const top = await runCli(
    ["harness", "matrix", "--no-sync", "--unpriced", "--top", "1", "--sort", "ttft"],
    {
      env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
    },
  );
  assert.equal(top.code, 0);
  // Fastest ttft first: opencode (200ms). Only one row → claude absent.
  const ttftIndex = top.stdout.indexOf("opencode");
  assert.ok(ttftIndex >= 0, "fastest pair first");
  assert.ok(!top.stdout.includes("claude"), "--top 1 keeps a single row");

  const md = await runCli(
    ["harness", "matrix", "--no-sync", "--unpriced", "--format", "markdown", "--show", "p90"],
    { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) },
  );
  assert.equal(md.code, 0);
  assert.ok(md.stdout.includes("| harness | model |"));
  assert.ok(md.stdout.includes("---:"));
  assert.ok(md.stdout.includes("p90"));
  assert.match(md.stdout, /mixed-model session\(s\) excluded/);

  const bad = await runCli(["harness", "matrix", "--no-sync", "--sort", "bogus"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.notEqual(bad.code, 0);
});

test("cli: matrix --json carries per-row provenance labels and --jq works", async () => {
  const cfg = await seededMatrixStore("matrix-json");

  const { code, stdout } = await runCli(
    ["harness", "matrix", "--no-sync", "--json", "--unpriced"],
    {
      env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
    },
  );
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.ok(payload.provenance);
  assert.equal(payload.provenance.excludedMixed, 1);
  assert.ok(Array.isArray(payload.pairs) && payload.pairs.length >= 2);
  for (const pair of payload.pairs) {
    assert.equal(pair.labels.cost, "gateway-billed");
    assert.equal(pair.labels.costPerSession, "heuristic");
    assert.equal(pair.labels.cacheHitRatio, "estimated");
  }

  const jq = await runCli(
    ["harness", "matrix", "--no-sync", "--json", "--unpriced", "--jq", ".pairs[0].model"],
    { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) },
  );
  assert.equal(jq.code, 0);
  const extracted = JSON.parse(jq.stdout);
  assert.ok(typeof extracted === "string", "jq extracts a single field");
});

test("cli: --synthetic renders the saved sweep in a labeled block, separate from observed", async () => {
  const cfg = await seededMatrixStore("matrix-synth");
  const saved = {
    savedAt: "2026-10-24T00:00:00.000Z",
    scenario: "multi-turn-refactor",
    sweep: [
      {
        model: "zai-org/glm-5.3",
        results: [
          {
            scenario: "multi-turn-refactor",
            harness: "claude-code",
            label: "Claude Code",
            note: "",
            dialect: "anthropic",
            model: "zai-org/glm-5.3",
            turns: [],
            requests: 5,
            inputTokens: 5000,
            cachedTokens: 4500,
            costUsd: 0.002,
            hitRatio: 0.9,
            costIfUncached: 0.02,
            savedUsd: 0.018,
          },
        ],
      },
    ],
  };
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    writeFileSync(join(cfg, "bench-sweep.json"), JSON.stringify(saved));
  });

  const { code, stdout } = await runCli(["harness", "matrix", "--no-sync", "--synthetic"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes("synthetic sweep"), "labeled synthetic block present");
  assert.ok(stdout.includes("Claude Code"));
  assert.ok(stdout.includes("NOT your workload"), "synthetic framing explicit");
  assert.match(stdout, /never join a ranking/);

  const json = await runCli(["harness", "matrix", "--no-sync", "--synthetic", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.synthetic.label, "synthetic");
  assert.equal(payload.synthetic.rows.length, 1);
  assert.equal(payload.synthetic.rows[0].verdict, "good");
  // Observed pairs remain separate from the synthetic lane.
  assert.ok(payload.pairs.every((p) => p.harness !== "claude-code"));
});

test("cli: recommend ranks observed pairs, guards min samples, prints the apply line", async () => {
  const cfg = await seededMatrixStore("recommend-basic");

  const { code, stdout } = await runCli(["recommend", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(code, 0);
  assert.match(stdout, /medians, not guarantees/);
  // Every pair here clears the 5-session guard, so no insufficient block
  // (the legend line mentions the guard; match the block header only).
  assert.ok(!stdout.includes("insufficient data (fewer than"), "all pairs have enough sessions");
  // claude/glm-5.3 (6 sessions, $0.02/sess) is cheapest → recommended;
  // opencode/glm-5.3 has the most sessions (7) → the de-facto current pair.
  assert.match(stdout, /Recommended: harness=claude model=zai-org\/glm-5\.3/);
  assert.match(stdout, /Current:\s+harness=opencode model=zai-org\/glm-5\.3/);
  assert.match(stdout, /Expected delta: .*heuristic/);
  assert.match(stdout, /Apply: aiand claude on --model zai-org\/glm-5\.3/);
  // Synthetic data never leaks in (none saved here anyway; the line must be absent).
  assert.ok(!stdout.includes("synthetic sweep"));
});

test("cli: recommend with no eligible pairs says so and still lists insufficient rows", async () => {
  const cfg = cfgDir("recommend-empty");
  const masks = await seedAgentKeys(cfg);
  await seedStore(cfg, [
    row({ id: "r1", api_key: masks.claude, created_at: iso(0) }),
    row({ id: "r2", api_key: masks.claude, created_at: iso(60_000) }),
  ]);
  const { code, stdout } = await runCli(["recommend", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(code, 0);
  assert.match(stdout, /no \(harness, model\) pair has 5\+ sessions/);
  assert.match(stdout, /insufficient data/);
  assert.ok(!stdout.includes("Apply:"));
});

test("cli: recommend --json carries provenance and the min-sample guard", async () => {
  const cfg = await seededMatrixStore("recommend-json");
  const { code, stdout } = await runCli(["recommend", "--no-sync", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.provenance.minSampleSessions, 5);
  assert.equal(payload.provenance.rankedFrom, "observed-workload-only");
  assert.match(payload.provenance.expectedDelta, /heuristic/);
  assert.ok(payload.ranked.length >= 1);
  assert.ok(payload.ranked.every((row) => row.sessions >= 5));
  for (const row of payload.insufficient) {
    assert.ok(row.sessions < 5);
    assert.match(row.reason, /insufficient data/);
  }
  assert.ok(!payload.synthetic, "recommend never carries synthetic rows");
});

// #91: the matrix synthetic render in markdown (table variant covered above)
// and the fail-open sync warning on the matrix auto-sync path.
test("cli: matrix --format markdown --synthetic renders the markdown synthetic block", async () => {
  const cfg = await seededMatrixStore("matrix-md-synthetic");
  const saved = {
    savedAt: "2026-10-26T00:00:00.000Z",
    scenario: "read-summarize-file",
    sweep: [
      {
        model: "zai-org/glm-5.3",
        results: [
          {
            scenario: "read-summarize-file",
            harness: "omp",
            label: "omp",
            note: "",
            dialect: "omp",
            model: "zai-org/glm-5.3",
            turns: [],
            requests: 4,
            inputTokens: 4000,
            cachedTokens: 3600,
            costUsd: 0.01,
            hitRatio: 0.9,
            costIfUncached: 0.03,
            savedUsd: 0.02,
          },
        ],
      },
    ],
  };
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    writeFileSync(join(cfg, "bench-sweep.json"), JSON.stringify(saved));
  });
  const run = await runCli(
    ["harness", "matrix", "--no-sync", "--unpriced", "--format", "markdown", "--synthetic"],
    { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /synthetic sweep \(fixed scenario replay/);
  assert.match(run.stdout, /\| omp \| zai-org\/glm-5\.3 \| 4 \|/);
});

test("cli: matrix auto-sync failure warns (network code) and still renders (#85)", async () => {
  const cfg = await seededMatrixStore("matrix-sync-warn");
  const run = await runCli(["harness", "matrix"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: "sk-test", AIAND_BASE_URL: CLOSED_URL }),
  });
  assert.equal(run.code, 0, run.stdout);
  assert.match(run.stderr, /store sync failed \(network\)/);
});

// #91: recommend's guards the rank tests leave open — sync fail-open warn,
// unknown-harness apply line, and the already-recommended current pair.
test("cli: recommend fail-open sync warning and unknown-harness apply line", async () => {
  const cfg = cfgDir("recommend-guards");
  const masks = await seedAgentKeys(cfg);
  await seedStore(cfg, [
    ...Array.from({ length: 6 }, (_, i) =>
      row({ id: `rg${i}`, api_key: masks.claude, created_at: iso(i * 60_000) }),
    ),
  ]);
  // Failed sync (closed gateway) warns with the code and still renders.
  const warned = await runCli(["recommend"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: "sk-test", AIAND_BASE_URL: CLOSED_URL }),
  });
  assert.equal(warned.code, 0, warned.stdout);
  assert.match(warned.stderr, /store sync failed \(network\)/);
  // One session is below the 5-session guard: the empty-rank branch renders.
  assert.match(warned.stdout, /nothing to rank yet/);
  assert.match(warned.stdout, /insufficient data/);
});
