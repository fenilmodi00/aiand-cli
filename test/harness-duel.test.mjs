import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { cliEnv, FAKE_API_KEY, runCli, withMockGateway, withTestEnv } from "./helpers.mjs";

/**
 * Ticket #82 — `aiand harness duel` (personal A/B shape replay, D2) and
 * `aiand harness latency` (TTFT A/B, D3).
 *
 * Everything offline: the transports are stubs (the #67 recorded-engine
 * pattern — a deterministic prefix-cache simulator), the clock is injected,
 * and the store tests seed an isolated AIAND_CONFIG_DIR. No test trusts an
 * X-Cost value as ground truth; determinism tests compare two runs to each
 * other, and the golden fixture pins the seeded run's own output.
 */

const env = withTestEnv("harness-duel", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const {
  mulberry32,
  parsePair,
  parsePairs,
  resolveBaseline,
  extractShape,
  shapeToScenario,
  runDuel,
  duelMetricRows,
  shapeSourceFooter,
  truncationNote,
  measureTransport,
} = await import("../dist/benchmark/duel.js");
const { historicalTtft, MIN_HISTORICAL_SAMPLES, runLatency, HARNESS_AGENT_ALIASES } = await import(
  "../dist/benchmark/latency-ab.js"
);
const { findBenchScenario } = await import("../dist/benchmark/scenarios.js");

const SESSION = {
  profile: { name: "default", apiUrl: "https://gateway.invalid", authUrl: "", model: undefined },
  token: "duel-test",
  credential: null,
};

const SCENARIO = findBenchScenario("multi-turn-refactor");
const PAIRS = [
  { harness: "claude-code", model: "test/model" },
  { harness: "omp", model: "test/model" },
];

/** A fixed clock: every request takes exactly 50ms. */
const fixedNow = () => {
  let ticks = 0;
  return () => {
    ticks += 50;
    return 1_000_000 + ticks;
  };
};

/**
 * The deterministic prefix-cache transport (the #67 recorded pattern): a
 * request hits when an earlier request is a block-exact prefix, tokens are
 * messages × 64, and X-Cost is a deterministic function of the request
 * index — never treated as ground truth by the tests, only ever compared
 * between two runs.
 */
function deterministicTransport() {
  const entries = [];
  let requests = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const anthropic = String(url).includes("/v1/messages");
    const messages = anthropic
      ? [JSON.stringify(body.system), ...body.messages.map(JSON.stringify)]
      : body.messages.map(JSON.stringify);
    let matched = 0;
    for (const entry of entries) {
      if (entry.length > messages.length) continue;
      if (entry.every((line, i) => line === messages[i])) matched = Math.max(matched, entry.length);
    }
    entries.push(messages);
    const promptTokens = messages.length * 64;
    const cachedTokens = Math.floor((matched * 64) / 128) * 128;
    requests += 1;
    const usage = anthropic
      ? {
          input_tokens: promptTokens - cachedTokens,
          output_tokens: 8,
          cache_read_input_tokens: cachedTokens,
        }
      : {
          prompt_tokens: promptTokens,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: cachedTokens },
        };
    return new Response(JSON.stringify({ usage }), {
      status: 200,
      headers: { "X-Cost": (requests * 0.000001).toFixed(8), "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, count: () => requests };
}

async function seedDuel(pairs = PAIRS, scenario = SCENARIO) {
  const transport = deterministicTransport();
  const run = await runDuel({
    session: SESSION,
    scenario,
    pairs,
    seed: 7,
    source: { kind: "scenario", id: scenario.id, turns: scenario.turns.length },
    fetchImpl: transport.fetchImpl,
    now: fixedNow(),
  });
  return { run, transport };
}

// ---------------------------------------------------------------------------
// Pair parsing
// ---------------------------------------------------------------------------

describe("pair parsing", () => {
  test("a --pair value parses into harness + model", () => {
    assert.deepEqual(parsePair("harness=claude-code,model=zai-org/glm-5.3", []), {
      harness: "claude-code",
      model: "zai-org/glm-5.3",
    });
  });

  test("an unknown harness lists the valid layouts and known models", () => {
    assert.throws(
      () => parsePair("harness=bogus,model=x", ["known/model"]),
      (error) => {
        assert.match(error.message, /bogus/);
        assert.match(error.hint, /claude-code/);
        assert.match(error.hint, /known\/model/);
        return true;
      },
    );
  });

  test("an unknown model with a known catalog lists the models", () => {
    assert.throws(
      () => parsePair("harness=omp,model=nope", ["known/model"]),
      (error) => error.hint.includes("known/model"),
    );
  });

  test("a duel needs at least two pairs", () => {
    assert.throws(() => parsePairs(["harness=omp,model=m"], []), /At least 2 --pair values/);
  });

  test("--baseline resolves by index, name and spec; default is the first pair", () => {
    assert.equal(resolveBaseline(undefined, PAIRS), 0);
    assert.equal(resolveBaseline("2", PAIRS), 1);
    assert.equal(resolveBaseline("omp", PAIRS), 1);
    assert.equal(resolveBaseline("harness=omp,model=test/model", PAIRS), 1);
    assert.throws(() => resolveBaseline("9", PAIRS), /Unknown --baseline/);
  });
});

// ---------------------------------------------------------------------------
// Shape extraction — metadata only, never content
// ---------------------------------------------------------------------------

describe("session shape extraction", () => {
  const rows = [
    { created_at: "2026-10-20T10:00:00Z", input_tokens: 1200, output_tokens: 100 },
    { created_at: "2026-10-20T10:01:00Z", input_tokens: 2400, output_tokens: 80 },
    { created_at: "2026-10-20T10:02:00Z", input_tokens: 3600, output_tokens: 60 },
  ];

  test("the curve is the cumulative input tokens per turn, plus output per turn", () => {
    const shape = extractShape("abc123", rows, 50);
    assert.equal(shape.sessionId, "abc123");
    assert.equal(shape.truncated, false);
    assert.equal(shape.recordedAt, "2026-10-20T10:00:00Z");
    assert.deepEqual(
      shape.turns,
      rows.map((r) => ({ inputTokens: r.input_tokens, outputTokens: r.output_tokens })),
    );
  });

  test("--turns-cap truncates with an explicit flag", () => {
    const shape = extractShape("abc123", rows, 2);
    assert.equal(shape.turns.length, 2);
    assert.equal(shape.truncated, true);
  });

  test("the shape carries no field a prompt could hide in", () => {
    const shape = extractShape("abc123", rows, 50);
    const json = JSON.stringify(shape);
    assert.equal(JSON.parse(json).turns.length, 3);
    // Only numeric token fields and the id/timestamp survive serialization.
    for (const turn of JSON.parse(json).turns) {
      assert.deepEqual(Object.keys(turn).sort(), ["inputTokens", "outputTokens"]);
      assert.ok(Number.isInteger(turn.inputTokens));
      assert.ok(Number.isInteger(turn.outputTokens));
    }
    assert.ok(
      !/[a-z]{12,}/i.test(
        json.replace(
          /abc123|2026-10-20T10:00:00Z|inputTokens|outputTokens|sessionId|recordedAt|truncated|turns/g,
          "",
        ),
      ),
    );
  });

  test("an empty session is a clear error, not a zero-turn replay", () => {
    assert.throws(() => extractShape("abc123", [], 50), /no requests to replay/);
  });
});

// ---------------------------------------------------------------------------
// Seeded filler
// ---------------------------------------------------------------------------

describe("seeded filler", () => {
  test("mulberry32 is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    assert.deepEqual(Array.from({ length: 10 }, a), Array.from({ length: 10 }, b));
  });

  test("same seed → identical scenario; different seed → different filler", () => {
    const shape = extractShape("s", rows3(), 50);
    const a = JSON.stringify(shapeToScenario(shape, 7));
    const b = JSON.stringify(shapeToScenario(shape, 7));
    const c = JSON.stringify(shapeToScenario(shape, 8));
    assert.equal(a, b, "same seed is byte-identical");
    assert.notEqual(a, c, "a different seed changes the filler");
  });

  test("follow-up turns track the growth curve's deltas", () => {
    const shape = extractShape("s", rows3(), 50);
    const scenario = shapeToScenario(shape, 1);
    assert.equal(scenario.turns.length, 3);
    // Deltas of 1200/2400 tokens → the second turn's filler is about twice
    // the third's absence... the curve here is strictly growing, so every
    // follow-up is non-trivial and roughly sized (4 chars ≈ 1 token).
    assert.ok(scenario.turns[1].length > 1000);
    assert.ok(scenario.turns[2].length > 1000);
  });

  function rows3() {
    return [
      { created_at: "2026-10-20T10:00:00Z", input_tokens: 2000, output_tokens: 100 },
      { created_at: "2026-10-20T10:01:00Z", input_tokens: 3200, output_tokens: 100 },
      { created_at: "2026-10-20T10:02:00Z", input_tokens: 4400, output_tokens: 100 },
    ];
  }
});

// ---------------------------------------------------------------------------
// The duel run — determinism, abort, report
// ---------------------------------------------------------------------------

describe("runDuel", () => {
  test("same seed + shape + pairs → byte-identical results (determinism)", async () => {
    const a = await seedDuel();
    const b = await seedDuel();
    assert.equal(JSON.stringify(a.run), JSON.stringify(b.run));
  });

  test("the append-only layout hits the cache; the duel report reflects it", async () => {
    const { run } = await seedDuel();
    assert.equal(run.pairs.length, 2);
    assert.equal(run.pairs[0].pair.harness, "claude-code");
    assert.ok(run.pairs[0].cachedTokens > 0, "append-only layout caches");
    assert.equal(run.pairs[0].partial, false);
    assert.equal(run.pairs[0].requests, SCENARIO.turns.length);
    assert.equal(run.pairs[0].errors, 0);
    assert.equal(run.pairs[0].ttft.p50, 50, "the fixed clock sets TTFT");
  });

  test("each pair gets its own transport, so pairs cannot share cache", async () => {
    // One transport for BOTH pairs would let the second pair inherit the
    // first's cache; runDuel builds one per pair by construction.
    const shared = deterministicTransport();
    const run = await runDuel({
      session: SESSION,
      scenario: SCENARIO,
      pairs: [PAIRS[0], PAIRS[0]],
      seed: 1,
      source: { kind: "scenario", id: SCENARIO.id, turns: SCENARIO.turns.length },
      fetchImpl: shared.fetchImpl,
      now: fixedNow(),
    });
    // With a shared cache the second run of the same layout would start
    // hitting from turn 1; the duel isolates them, so the totals match.
    assert.equal(run.pairs[0].cachedTokens, run.pairs[1].cachedTokens);
  });

  test("an abort stops cleanly and marks the pair partial", async () => {
    let calls = 0;
    const transport = deterministicTransport();
    const run = await runDuel({
      session: SESSION,
      scenario: SCENARIO,
      pairs: PAIRS,
      seed: 1,
      source: { kind: "scenario", id: SCENARIO.id, turns: SCENARIO.turns.length },
      fetchImpl: transport.fetchImpl,
      now: fixedNow(),
      shouldAbort: () => ++calls > 2,
    });
    const first = run.pairs[0];
    assert.equal(first.partial, true, "the interrupted pair is partial");
    assert.ok(first.requests < SCENARIO.turns.length, "it stopped mid-run");
    assert.equal(run.pairs.length, 1, "later pairs are not started");
  });

  test("a failing pair is partial and does not kill the other pairs", async () => {
    const run = await runDuel({
      session: SESSION,
      scenario: SCENARIO,
      pairs: PAIRS,
      seed: 1,
      source: { kind: "scenario", id: SCENARIO.id, turns: SCENARIO.turns.length },
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
      now: fixedNow(),
    });
    assert.equal(run.pairs[0].partial, true);
    assert.equal(run.pairs[0].requests, 0);
    assert.equal(run.pairs[1].partial, true);
  });
});

describe("duel report", () => {
  test("metric rows carry per-pair cells and deltas vs the baseline", async () => {
    const { run } = await seedDuel();
    const rows = duelMetricRows(run, 0);
    const metrics = rows.map((r) => r.metric);
    assert.deepEqual(metrics, [
      "total cost",
      "cost/turn",
      "input tokens",
      "output tokens",
      "cache-hit ratio",
      "TTFT p50",
      "TTFT p95",
      "wall time",
      "errors",
    ]);
    for (const row of rows) {
      assert.equal(row.cells.length, 2);
      assert.equal(row.deltas.length, 2);
      assert.equal(row.deltas[0], null, "the baseline has no delta");
      assert.ok(typeof row.deltas[1] === "string");
    }
    const cost = rows[0];
    assert.match(cost.cells[0], /^\$/);
    assert.match(cost.deltas[1], /^[+−±]\$/);
  });

  test("the shape-source footer and truncation note", () => {
    const sessionRun = {
      seed: 7,
      source: {
        kind: "session",
        id: "abc",
        turns: 5,
        recordedAt: "2026-10-20T10:00:00Z",
        truncated: true,
      },
      pairs: [],
    };
    assert.match(shapeSourceFooter(sessionRun), /session abc \(5 turns/);
    assert.match(shapeSourceFooter(sessionRun), /real prompts never left this machine/);
    assert.match(truncationNote(sessionRun), /truncated to --turns-cap/);
    const scenarioRun = {
      seed: 7,
      source: { kind: "scenario", id: "x", turns: 4 },
      pairs: [],
    };
    assert.match(shapeSourceFooter(scenarioRun), /scenario x/);
    assert.equal(truncationNote(scenarioRun), null);
  });

  test("golden fixture: the seeded duel's JSON is pinned (D4 basis)", async () => {
    const scenario = findBenchScenario("read-summarize-file");
    const transport = deterministicTransport();
    const run = await runDuel({
      session: SESSION,
      scenario,
      pairs: [
        { harness: "claude-code", model: "pinned/model" },
        { harness: "omp", model: "pinned/model" },
      ],
      seed: 7,
      source: { kind: "scenario", id: scenario.id, turns: scenario.turns.length },
      fetchImpl: transport.fetchImpl,
      now: () => 42_000,
    });
    // Pin the full run: if the pipeline, layout shapes, or simulator change,
    // this diff goes red on purpose.
    assert.equal(
      JSON.stringify(run),
      JSON.stringify({
        seed: 7,
        source: { kind: "scenario", id: "read-summarize-file", turns: 1 },
        pairs: [
          {
            pair: { harness: "claude-code", model: "pinned/model" },
            partial: false,
            requests: 1,
            inputTokens: 256,
            cachedTokens: 0,
            outputTokens: 8,
            costUsd: 0.000001,
            hitRatio: 0,
            ttft: { p50: 0, p95: 0 },
            wallMs: 0,
            errors: 0,
          },
          {
            pair: { harness: "omp", model: "pinned/model" },
            partial: false,
            requests: 1,
            inputTokens: 256,
            cachedTokens: 0,
            outputTokens: 8,
            costUsd: 0.000002,
            hitRatio: 0,
            ttft: { p50: 0, p95: 0 },
            wallMs: 0,
            errors: 0,
          },
        ],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// measureTransport
// ---------------------------------------------------------------------------

describe("measureTransport", () => {
  test("records durations, counts errors, honors abort", async () => {
    let aborted = false;
    const transport = measureTransport(async () => new Response("{}", { status: 500 }), {
      now: fixedNow(),
      shouldAbort: () => aborted,
    });
    await transport
      .fetchImpl("https://gateway.invalid/x", { method: "POST", body: "{}" })
      .catch(() => {});
    assert.equal(transport.durations.length, 1);
    assert.equal(transport.errors(), 1);
    aborted = true;
    await assert.rejects(() =>
      transport.fetchImpl("https://gateway.invalid/x", { method: "POST", body: "{}" }),
    );
    assert.equal(transport.aborted(), true);
  });
});

// ---------------------------------------------------------------------------
// Latency A/B
// ---------------------------------------------------------------------------

describe("historical TTFT", () => {
  test("under the min-sample guard it refuses (no fabricated percentiles)", () => {
    assert.equal(historicalTtft([]), null);
    assert.equal(historicalTtft([{ ttft_ms: 10 }, { ttft_ms: 20 }]), null);
    assert.equal(MIN_HISTORICAL_SAMPLES, 5);
  });

  test("enough samples produce store-order percentiles", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ ttft_ms: 100 + i * 100 }));
    const hist = historicalTtft(rows);
    assert.equal(hist.n, 5);
    assert.equal(hist.p50, 300);
    assert.ok(hist.p90 > hist.p50);
    assert.ok(hist.p95 >= hist.p90);
  });

  test("null ttft rows are dropped, not zeroed", () => {
    assert.equal(
      historicalTtft([{ ttft_ms: null }, { ttft_ms: 1 }, { ttft_ms: 2 }, { ttft_ms: 3 }]),
      null,
    );
  });

  test("only the real harnesses map to store agents", () => {
    assert.equal(HARNESS_AGENT_ALIASES["claude-code"], "claude");
    assert.equal(HARNESS_AGENT_ALIASES.omp, "omp");
    assert.equal(HARNESS_AGENT_ALIASES["rebuilt-system"], undefined);
  });

  test("the latency loop measures per-request TTFT deterministically", async () => {
    const scenario = findBenchScenario("read-summarize-file");
    const transport = deterministicTransport();
    const results = await runLatency({
      session: SESSION,
      scenario,
      pairs: PAIRS,
      fetchImpl: transport.fetchImpl,
      now: fixedNow(),
    });
    assert.equal(results.length, 2);
    assert.equal(results[0].turns, 1);
    assert.equal(results[0].ttft.p50, 50);
    assert.equal(results[0].partial, false);
  });
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

describe("aiand harness duel / latency (CLI)", () => {
  test("help mentions the new subcommands", async () => {
    const { code, stdout } = await runCli(["harness", "--help"], {
      env: cliEnv({ AIAND_CONFIG_DIR: cfgDir("help") }),
    });
    assert.equal(code, 0);
    assert.match(stdout, /harness duel/);
    assert.match(stdout, /harness latency/);
  });

  test("duel refuses to run billed requests without --yes on a non-TTY", async () => {
    const { code, stderr } = await runCli(
      [
        "harness",
        "duel",
        "--scenario",
        "multi-turn-refactor",
        "--pair",
        "harness=claude-code,model=m",
        "--pair",
        "harness=omp,model=m",
      ],
      { env: cliEnv({ AIAND_CONFIG_DIR: cfgDir("noyes") }), stdin: "ignore" },
    );
    assert.equal(code, 1);
    assert.match(stderr, /--yes/);
  });

  test("an invalid --pair lists the valid layouts", async () => {
    const { code, stderr } = await runCli(
      [
        "harness",
        "duel",
        "--scenario",
        "multi-turn-refactor",
        "--pair",
        "harness=bogus,model=m",
        "--pair",
        "harness=omp,model=m",
        "--yes",
      ],
      { env: cliEnv({ AIAND_CONFIG_DIR: cfgDir("badpair") }), stdin: "ignore" },
    );
    assert.equal(code, 1);
    assert.match(stderr, /claude-code/);
    assert.match(stderr, /bogus/);
  });

  test("duel requires exactly one shape source", async () => {
    const { code, stderr } = await runCli(["harness", "duel", "--yes"], {
      env: cliEnv({ AIAND_CONFIG_DIR: cfgDir("nosource") }),
      stdin: "ignore",
    });
    assert.equal(code, 1);
    assert.match(stderr, /exactly one shape source/);
  });

  test("duel runs a scenario against the mock gateway and saves markdown", async () => {
    await withMockGateway(async ({ url }) => {
      const cfg = cfgDir("duel-gw");
      const savePath = join(env.dir, "duel-out.md");
      const { code, stdout } = await runCli(
        [
          "harness",
          "duel",
          "--scenario",
          "read-summarize-file",
          "--pair",
          "harness=omp,model=zai-org/glm-5.3",
          "--pair",
          "harness=omp,model=zai-org/glm-5.3",
          "--yes",
          "--no-sync",
          "--save",
          savePath,
        ],
        {
          env: cliEnv({
            AIAND_CONFIG_DIR: cfg,
            AIAND_HOME: join(cfg, "home"),
            AIAND_API_KEY: FAKE_API_KEY,
            AIAND_BASE_URL: url,
            NO_COLOR: "1",
          }),
          stdin: "ignore",
        },
      );
      assert.equal(code, 0, stdout);
      assert.match(stdout, /harness duel/);
      assert.match(stdout, /omp × zai-org\/glm-5\.3/);
      assert.match(stdout, /real prompts never left this machine/);
      const saved = readFileSync(savePath, "utf8");
      assert.match(saved, /harness duel — shape replay/);
      assert.match(saved, /\| metric \|/);
    });
  });

  test("latency reports live percentiles and `insufficient data` history", async () => {
    await withMockGateway(async ({ url }) => {
      const cfg = cfgDir("latency-gw");
      const { code, stdout } = await runCli(
        [
          "harness",
          "latency",
          "--pair",
          "harness=omp,model=zai-org/glm-5.3",
          "--turns",
          "2",
          "--no-sync",
        ],
        {
          env: cliEnv({
            AIAND_CONFIG_DIR: cfg,
            AIAND_HOME: join(cfg, "home"),
            AIAND_API_KEY: FAKE_API_KEY,
            AIAND_BASE_URL: url,
            NO_COLOR: "1",
          }),
          stdin: "ignore",
        },
      );
      assert.equal(code, 0, stdout);
      assert.match(stdout, /latency A\/B/);
      assert.match(stdout, /insufficient data/);
      assert.match(stdout, /measured/);
    });
  });

  test("latency --json carries provenance labels and the insufficient-data status", async () => {
    await withMockGateway(async ({ url }) => {
      const cfg = cfgDir("latency-json");
      const { code, stdout } = await runCli(
        [
          "harness",
          "latency",
          "--pair",
          "harness=omp,model=zai-org/glm-5.3",
          "--turns",
          "1",
          "--no-sync",
          "--json",
        ],
        {
          env: cliEnv({
            AIAND_CONFIG_DIR: cfg,
            AIAND_HOME: join(cfg, "home"),
            AIAND_API_KEY: FAKE_API_KEY,
            AIAND_BASE_URL: url,
            NO_COLOR: "1",
          }),
          stdin: "ignore",
        },
      );
      assert.equal(code, 0, stdout);
      const payload = JSON.parse(stdout);
      assert.equal(
        payload.provenance.liveTtft,
        "measured(per-request duration around the gateway round trip)",
      );
      assert.equal(payload.provenance.historicalTtft, "gateway-billed (store ttft_ms rows)");
      assert.equal(payload.pairs[0].historical.status, "insufficient data");
      assert.equal(payload.pairs[0].live.turns, 1);
    });
  });
});
