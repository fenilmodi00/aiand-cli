import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { cliEnv, runCli, withTestEnv } from "./helpers.mjs";

// OBS-P3-5 (#77): calibrated forecast v2 — Gamma-process Monte Carlo with a
// rectified-Gaussian rate (claumon MODEL.tex v2.2), plus `forecast bench`
// (CRPS / pinball / coverage / bias + the [δ, δ²] calibration regression).

const box = withTestEnv("aiand-forecast-v2-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_HOME = dir;
  process.env.AIAND_NO_SYNC = "1";
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_NO_WARN;
  delete process.env.AIAND_BASE_URL;
});

const v2 = () => import("../dist/obs/forecast-v2.js");

/** Pinned "now": 2026-03-20T12:00Z. The month has 11+ prior days of room. */
const NOW_MS = Date.UTC(2026, 2, 20, 12, 0, 0);
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

let seq = 0;
/** A row `msAgo` before NOW, in USD. */
function row(msAgo, cost, overrides = {}) {
  seq += 1;
  return {
    id: `v2-${String(seq).padStart(5, "0")}`,
    api_key: "sk-abcd...1234",
    created_at: new Date(NOW_MS - msAgo).toISOString(),
    latency_ms: null,
    cost: String(cost),
    cost_value: cost,
    currency: "usd",
    ...overrides,
  };
}

/** Deterministic LCG for fixture generation (independent of the PRNG under test). */
function lcg(seed) {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

/**
 * A constant-rate fixture: `cost` every `everyHours` (5-minute default so
 * the 30-minute OLS window is densely sampled and the known rate is
 * recovered), for `days` days back from NOW. Known answer: the true rate is
 * cost/everyHours per hour.
 */
function constantRateRows(cost, everyHours = 5 / 60, days = 5) {
  const rows = [];
  for (let h = everyHours; h <= days * 24; h += everyHours) {
    rows.push(row(h * HOUR_MS, cost));
  }
  return rows;
}

// -- seeded randomness ----------------------------------------------------------

describe("PRNG", () => {
  test("mulberry32 is deterministic for a seed and stable across calls", async () => {
    const { mulberry32 } = await v2();
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());
    assert.deepEqual(seqA, seqB);
    for (const u of seqA) {
      assert.ok(u >= 0 && u < 1);
    }
    const c = mulberry32(43);
    assert.notDeepEqual(
      seqA.slice(0, 5),
      Array.from({ length: 5 }, () => c()),
    );
  });

  test("hashSeed maps a window id to a stable 32-bit seed", async () => {
    const { hashSeed } = await v2();
    assert.equal(hashSeed("forecast-v2:2026-03"), hashSeed("forecast-v2:2026-03"));
    assert.notEqual(hashSeed("forecast-v2:2026-03"), hashSeed("forecast-v2:2026-04"));
  });

  test("gammaSample matches its mean and variance, and never draws negative", async () => {
    const { gammaSample, mulberry32 } = await v2();
    const rng = mulberry32(7);
    const n = 200_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const x = gammaSample(rng, 2, 3); // mean 6, variance 18
      assert.ok(x >= 0);
      sum += x;
      sumSq += x * x;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    assert.ok(Math.abs(mean - 6) < 0.1, `mean ${mean} vs 6`);
    assert.ok(Math.abs(variance - 18) < 1.2, `variance ${variance} vs 18`);
  });

  test("gammaSample handles shape < 1 via the boost transform", async () => {
    const { gammaSample, mulberry32 } = await v2();
    const rng = mulberry32(11);
    const n = 200_000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += gammaSample(rng, 0.5, 2); // mean 1
    assert.ok(Math.abs(sum / n - 1) < 0.03, `mean ${sum / n} vs 1`);
  });

  test("quantile: nearest rank, empty → null", async () => {
    const { quantile } = await v2();
    assert.equal(quantile([], 0.5), null);
    assert.equal(quantile([3, 1, 2], 0.5), 2);
    assert.equal(quantile([3, 1, 2], 0.9), 3);
    assert.equal(quantile([5], 0.1), 5);
  });
});

// -- rate estimate + prior ------------------------------------------------------

describe("OLS rate + window prior", () => {
  test("buildSnapshots are monotone cumulative spend over the trailing 30 min", async () => {
    const { buildSnapshots } = await v2();
    const rows = [row(5 * 60_000, 0.5), row(20 * 60_000, 0.2), row(40 * 60_000, 9)];
    const snaps = buildSnapshots(rows, NOW_MS);
    assert.equal(snaps.length, 7); // 5-min grid, inclusive endpoint
    for (let i = 1; i < snaps.length; i++) {
      assert.ok(snaps[i].cumulative >= snaps[i - 1].cumulative);
    }
    assert.equal(snaps[snaps.length - 1].cumulative, 0.7); // 40-min-old row outside
  });

  test("olsRate recovers the true slope of a linear ramp; null below 2 points", async () => {
    const { olsRate } = await v2();
    assert.equal(olsRate([]), null);
    const snaps = [
      { atMs: 0, cumulative: 0 },
      { atMs: HOUR_MS, cumulative: 2 },
      { atMs: 2 * HOUR_MS, cumulative: 4 },
      { atMs: 3 * HOUR_MS, cumulative: 6 },
    ];
    const rate = olsRate(snaps);
    assert.ok(rate);
    assert.ok(Math.abs(rate.ratePerHour - 2) < 1e-9);
    assert.ok(rate.sePerHour < 1e-9); // exact line, no residuals
  });

  test("windowPrior: per-day rates from COMPLETED days only, noise-corrected variance", async () => {
    const { windowPrior } = await v2();
    // Yesterday spend 10 (10 rows), day before spend 20 (10 rows); today excluded.
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push(row((24 + i) * HOUR_MS, 1));
    for (let i = 0; i < 10; i++) rows.push(row((48 + i) * HOUR_MS, 2));
    rows.push(row(1 * HOUR_MS, 999)); // today — must not enter the prior
    const prior = windowPrior(rows, NOW_MS);
    assert.ok(prior);
    assert.equal(prior.windows, 2);
    assert.ok(Math.abs(prior.mean - 15) < 1e-9);
    assert.ok(prior.variance > 0);
    assert.ok(prior.noiseCorrection > 0);
  });

  test("windowPrior: no completed days → null (flat prior fallback)", async () => {
    const { windowPrior } = await v2();
    assert.equal(windowPrior([row(1 * HOUR_MS, 5)], NOW_MS), null);
  });

  test("conjugateUpdate: flat prior defers to the observation; finite prior blends", async () => {
    const { conjugateUpdate } = await v2();
    assert.deepEqual(conjugateUpdate(0, Number.POSITIVE_INFINITY, 5, 1), { mean: 5, variance: 1 });
    const post = conjugateUpdate(10, 1, 0, 1);
    assert.ok(Math.abs(post.mean - 5) < 1e-12);
    assert.ok(Math.abs(post.variance - 0.5) < 1e-12);
  });
});

// -- the Monte Carlo ------------------------------------------------------------

describe("simulate + forecastV2", () => {
  test("same seed → byte-identical output; different seed differs", async () => {
    const { simulate } = await v2();
    const rows = constantRateRows(0.05, 5 / 60, 5);
    const input = { rows, now: new Date(NOW_MS), seed: 123, horizonHours: 24 };
    const a = simulate(input);
    const b = simulate(input);
    assert.deepEqual(a.sample, b.sample);
    assert.deepEqual(a.etas, b.etas);
    const c = simulate({ ...input, seed: 124 });
    assert.notDeepEqual(a.sample, c.sample);
  });

  test("forecastV2 on a constant-rate fixture: rate recovered, CI ordered, uncapped utilization", async () => {
    const { forecastV2 } = await v2();
    const rows = constantRateRows(0.05); // true rate $14.40/day
    const result = forecastV2({ rows, now: new Date(NOW_MS), seed: 7, budget: 2 });
    assert.equal(result.verdict, "ok");
    // True rate $14.40/day = $0.60/h; the posterior sits within the OLS
    // quantization tolerance of it.
    assert.ok(result.rate.value > 0.3 && result.rate.value < 0.75, `rate ${result.rate.value}`);
    assert.ok(result.projectedMonthEnd);
    assert.ok(result.projectedMonthEnd.value > result.currentSpend);
    const { low, high } = result.ci80;
    assert.ok(low !== null && high !== null && low <= result.projectedMonthEnd.value);
    assert.ok(high >= result.projectedMonthEnd.value);
    // Tiny budget → projected utilization is projected DEMAND, uncapped above 1.
    assert.ok(result.projectedUtilization > 1, `utilization ${result.projectedUtilization}`);
  });

  test("ETA median + CI when the budget is clearly reachable; nil when pNever >= 0.5", async () => {
    const { forecastV2 } = await v2();
    const rows = constantRateRows(0.05);
    const reachable = forecastV2({ rows, now: new Date(NOW_MS), seed: 7, budget: 90 });
    assert.ok(reachable.eta, "expected a finite ETA");
    assert.ok(reachable.eta.medianHours > 0);
    assert.ok(reachable.eta.lowHours <= reachable.eta.medianHours);
    assert.ok(reachable.eta.medianHours <= reachable.eta.highHours);
    assert.ok(reachable.pNever < 0.5);

    const unreachable = forecastV2({ rows, now: new Date(NOW_MS), seed: 7, budget: 1e9 });
    assert.equal(unreachable.eta, null);
    assert.equal(unreachable.pNever, 1);

    // Already over budget → there is no threshold left to reach.
    const exceeded = forecastV2({ rows, now: new Date(NOW_MS), seed: 7, budget: 1 });
    assert.equal(exceeded.eta, null);
  });

  test("thin history (no OLS, no completed windows) → insufficient-data, never a fabricated rate", async () => {
    const { forecastV2 } = await v2();
    const result = forecastV2({ rows: [], now: new Date(NOW_MS), seed: 7, budget: 100 });
    assert.equal(result.verdict, "insufficient-data");
    assert.equal(result.projectedMonthEnd, null);
    assert.equal(result.eta, null);
  });

  test("#77 golden fixture: identical store + seed → identical JSON, twice", async () => {
    const { forecastV2 } = await v2();
    const rows = constantRateRows(0.05, 5 / 60, 4);
    const a = JSON.stringify(forecastV2({ rows, now: new Date(NOW_MS), seed: 99, budget: 20 }));
    const b = JSON.stringify(forecastV2({ rows, now: new Date(NOW_MS), seed: 99, budget: 20 }));
    assert.equal(a, b);
    // The default seed derives from the window id: same window, no explicit
    // seed → still reproducible.
    const c = JSON.stringify(forecastV2({ rows, now: new Date(NOW_MS), budget: 20 }));
    const d = JSON.stringify(forecastV2({ rows, now: new Date(NOW_MS), budget: 20 }));
    assert.equal(c, d);
  });

  test("v2 provenance: projections are estimated(calibrated Monte Carlo v2...), rate is heuristic", async () => {
    const { forecastV2 } = await v2();
    const rows = constantRateRows(0.05, 5 / 60, 4);
    const result = forecastV2({ rows, now: new Date(NOW_MS), seed: 7, budget: 20 });
    assert.match(result.rate.provenance.kind, /heuristic/);
    assert.match(result.projectedMonthEnd.provenance.kind, /estimated/);
    assert.match(result.projectedMonthEnd.provenance.source, /Monte Carlo v2/);
  });
});

// -- the bench ------------------------------------------------------------------

/**
 * ON/OFF fixture: `days` days of alternating active days ($1 spread over the
 * day) and fully silent days (no rows at all). On a silent day's anchor the
 * 30-minute window is a genuine plateau — the rectified variant stalls to
 * exact-zero paths (its q10 covers the 0 actual), while the plain-Gaussian
 * variant leaks positive spend and misses.
 */
function onOffRows(days) {
  const rng = lcg(20260320);
  const rows = [];
  for (let d = days; d >= 1; d--) {
    if (d % 2 === 0) continue; // silent day
    let spent = 0;
    while (spent < 1) {
      const frac = rng();
      rows.push(row(d * DAY_MS - frac * DAY_MS, 0.05));
      spent += 0.05;
    }
  }
  return rows;
}

describe("forecast bench", () => {
  test("v1 bench: point forecast scored with CRPS/pinball/coverage/bias, deterministic", async () => {
    const { bench } = await v2();
    const rows = constantRateRows(0.05, 5 / 60, 20);
    const input = {
      rows,
      now: new Date(NOW_MS),
      model: "v1",
      horizonHours: 24,
      windows: 8,
      seed: 5,
    };
    const a = bench(input);
    const b = bench(input);
    assert.ok(a.ok && b.ok);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
    assert.equal(a.result.windows.length, 8);
    // Constant rate → v1's point forecast is near-exact on every window
    // (within the boundary-row rounding of the trailing-window attribution).
    assert.ok(Math.abs(a.result.metrics.bias) < 0.1, `bias ${a.result.metrics.bias}`);
    for (const w of a.result.windows) {
      assert.ok(Math.abs(w.actual - w.point) < 0.2, `point ${w.point} vs actual ${w.actual}`);
    }
  });

  test("v2 bench: all four metrics + regression coefficients, deterministic per seed", async () => {
    const { bench } = await v2();
    const rows = constantRateRows(0.05, 5 / 60, 20);
    const input = {
      rows,
      now: new Date(NOW_MS),
      model: "v2",
      horizonHours: 24,
      windows: 8,
      seed: 5,
    };
    const a = bench(input);
    const b = bench(input);
    assert.ok(a.ok && b.ok);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
    const { metrics, regression } = a.result;
    for (const value of [
      metrics.crps,
      metrics.pinball10,
      metrics.pinball50,
      metrics.pinball90,
      metrics.coverage,
      metrics.bias,
    ]) {
      assert.ok(Number.isFinite(value));
    }
    // Constant rate, tight posterior → the actual sits inside the 80% CI.
    assert.ok(metrics.coverage >= 0.75, `coverage ${metrics.coverage}`);
    assert.equal(typeof regression.intercept, "number");
    assert.equal(typeof regression.delta, "number");
    assert.equal(typeof regression.deltaSq, "number");
  });

  test("#77 miscalibration detection: the plain-Gaussian (no rectification) variant measurably worsens coverage on plateau data", async () => {
    const { bench } = await v2();
    const rows = onOffRows(30);
    const rectified = bench({
      rows,
      now: new Date(NOW_MS),
      model: "v2",
      seed: 5,
      horizonHours: 24,
      windows: 10,
    });
    const gaussian = bench({
      rows,
      now: new Date(NOW_MS),
      model: "v2",
      seed: 5,
      horizonHours: 24,
      windows: 10,
      rectify: false,
    });
    assert.ok(rectified.ok && gaussian.ok);
    assert.ok(
      rectified.result.metrics.coverage > gaussian.result.metrics.coverage,
      `rectified ${rectified.result.metrics.coverage} should beat plain-Gaussian ${gaussian.result.metrics.coverage}`,
    );
    // And the gaussian variant is strictly worse on the silent anchors: it
    // never falls inside on a zero day, the rectified variant does.
    assert.ok(gaussian.result.metrics.coverage < 0.5);
  });

  test("bench refusal: no scoreable history → insufficient-history", async () => {
    const { bench } = await v2();
    const result = bench({
      rows: [row(1 * HOUR_MS, 1)],
      now: new Date(NOW_MS),
      model: "v2",
      windows: 5,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.windows, 0);
  });
});

// -- the CLI surface ------------------------------------------------------------

function seedStore(rows) {
  mkdirSync(box.dir, { recursive: true });
  return import("node:sqlite").then(async ({ DatabaseSync }) => {
    const { MIGRATIONS } = await import("../dist/store/migrations/index.js");
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(join(box.dir, `store.db${suffix}`), { force: true });
    }
    const db = new DatabaseSync(join(box.dir, "store.db"));
    try {
      for (const migration of MIGRATIONS) db.exec(migration.sql);
      const insert = db.prepare(
        "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, " +
          "latency_ms, input_tokens, output_tokens, cached_tokens, cost, cost_value, " +
          "currency, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      rows.forEach((r, i) => {
        insert.run(
          `v2cli-${i}`,
          "test/model",
          "sk-abcd...1234",
          200,
          120,
          null,
          1000,
          300,
          400,
          String(r.cost_value),
          r.cost_value,
          "usd",
          r.created_at,
          new Date().toISOString(),
        );
      });
    } finally {
      db.close();
    }
  });
}

function cli(args, extraEnv = {}) {
  return runCli(args, { env: cliEnv({ ...extraEnv }) });
}

const UNTIL = "2026-03-20T12:00:00Z";

describe("forecast CLI · v2 + bench", () => {
  test("forecast --model v2 --json: 80% CI, ETA fields, seeded reproducibility (golden)", async () => {
    const rows = constantRateRows(0.05, 5 / 60, 12).map((r, i) => ({ ...r, id: `g-${i}` }));
    await seedStore(rows);
    await cli(["config", "set", "budget.monthly", "5000"]);
    const args = ["forecast", "--model", "v2", "--json", "--seed", "42", "--until", UNTIL];
    const a = await cli(args);
    const b = await cli(args);
    assert.equal(a.code, 0);
    assert.equal(a.stdout, b.stdout); // byte-identical golden output

    const payload = JSON.parse(a.stdout);
    assert.equal(payload.model, "v2");
    assert.equal(payload.verdict, "on-pace");
    assert.equal(payload.current_spend.provenance, "gateway-billed");
    assert.ok(payload.ci80.low <= payload.projected_month_end.value);
    assert.ok(payload.projected_month_end.value <= payload.ci80.high);
    assert.equal(payload.seed, 42);
    assert.equal(payload.draws, 500);
    assert.ok(payload.projected_utilization > 0);
    assert.ok(payload.eta === null || payload.eta.medianHours > 0);

    // Human table renders the v2 rows.
    const human = await cli(["forecast", "--model", "v2", "--seed", "42", "--until", UNTIL]);
    assert.match(human.stdout, /Forecast \(v2 calibrated Monte Carlo\)/);
    assert.match(human.stdout, /80% credible interval/);
    assert.match(human.stdout, /seed 42/);
  });

  test("#77 overshoot > 100% renders unclamped in all v2 outputs", async () => {
    const rows = constantRateRows(2, 0.5, 8).map((r, i) => ({ ...r, id: `o-${i}` }));
    await seedStore(rows);
    await cli(["config", "set", "budget.monthly", "5"]);
    const r = await cli(["forecast", "--model", "v2", "--json", "--seed", "42", "--until", UNTIL]);
    const payload = JSON.parse(r.stdout);
    assert.ok(payload.projected_utilization > 1, `utilization ${payload.projected_utilization}`);
    assert.ok(payload.ci80.high > payload.budget, "CI high must be uncapped above the budget");

    const human = await cli(["forecast", "--model", "v2", "--seed", "42", "--until", UNTIL]);
    assert.match(human.stdout, /overshoot — uncapped/);
    assert.match(human.stdout, /verdict/);
  });

  test("forecast bench (CLI): scores a store with history; --json carries metrics + regression", async () => {
    const rows = onOffRows(25).map((r, i) => ({ ...r, id: `b-${i}` }));
    await seedStore(rows);
    let r = await cli([
      "forecast",
      "bench",
      "--model",
      "v2",
      "--seed",
      "5",
      "--until",
      UNTIL,
      "--windows",
      "6",
    ]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Forecast bench · model v2 · 6 daily windows/);
    assert.match(r.stdout, /80% coverage/);
    assert.match(r.stdout, /bias \(mean signed error\)/);
    assert.match(r.stdout, /calibration regression of e² on \[δ, δ²\]/);
    assert.match(r.stdout, /verdict: /);

    r = await cli([
      "forecast",
      "bench",
      "--model",
      "v2",
      "--json",
      "--seed",
      "5",
      "--until",
      UNTIL,
      "--windows",
      "6",
    ]);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.model, "v2");
    assert.equal(typeof payload.metrics.crps, "number");
    assert.equal(typeof payload.metrics.coverage, "number");
    assert.ok(payload.windows.length === 6);
    assert.ok(payload.regression.verdict.length > 0);

    // v1 is scoreable too, for comparison.
    r = await cli(["forecast", "bench", "--model", "v1", "--until", UNTIL, "--windows", "6"]);
    assert.match(r.stdout, /model v1/);
  });

  test("forecast --model nonsense is rejected; bench flags are validated", async () => {
    let r = await cli(["forecast", "--model", "v3"]);
    assert.equal(r.code, 1);
    r = await cli(["forecast", "bench", "--horizon-hours", "0"]);
    assert.equal(r.code, 1);
    r = await cli(["forecast", "frobnicate"]);
    assert.equal(r.code, 1);
  });

  // #101: v2 honors the documented 2-hour span gate — 59 minutes of one
  // afternoon never projects a month.
  test("#101 v2 reports indeterminate when the trailing window has under 2 hours of data", async () => {
    const { forecastV2 } = await v2();
    // Dense 5-minute rows but only 59 minutes of history: above the OLS
    // window, far under the 2h span gate.
    const rows = constantRateRows(0.05, 5 / 60).filter(
      (r) => Date.parse(r.created_at) >= NOW_MS - 59 * 60_000,
    );
    assert.equal(
      forecastV2({ rows, now: new Date(NOW_MS), seed: 7, budget: 20 }).verdict,
      "insufficient-data",
    );

    // Crossing the 2h gate flips to a projection.
    const ok = constantRateRows(0.05, 5 / 60).filter(
      (r) => Date.parse(r.created_at) >= NOW_MS - 3 * HOUR_MS,
    );
    assert.equal(
      forecastV2({ rows: ok, now: new Date(NOW_MS), seed: 7, budget: 20 }).verdict,
      "ok",
    );
  });

  test("#101 v2 CLI renders indeterminate for a 59-minute window; help states the gate + --until pinning", async () => {
    const rows = constantRateRows(0.05, 5 / 60)
      .filter((r) => Date.parse(r.created_at) >= NOW_MS - 59 * 60_000)
      .map((r, i) => ({ ...r, id: `thin-${i}` }));
    await seedStore(rows);
    await cli(["config", "set", "budget.monthly", "20"]);
    const r = await cli(["forecast", "--model", "v2", "--json", "--until", UNTIL]);
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.verdict, "no-data"); // insufficient-data maps to the no-data verdict
    assert.equal(payload.projected_month_end, null);

    const human = await cli(["forecast", "--model", "v2", "--until", UNTIL]);
    assert.match(human.stdout, /indeterminate/);

    const help = await cli(["forecast", "--help"]);
    assert.match(help.stdout, /fewer than 2 hours of data/);
    assert.match(help.stdout, /pin\s+--until/);
  });
});
