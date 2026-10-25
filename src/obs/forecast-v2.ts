import { DAY_MS, HOUR_MS, MINUTE_MS } from "../time.js";
import {
  attributedSpend,
  burnRate,
  type ForecastRow,
  MIN_7D_SPAN_DAYS,
  MIN_24H_SPAN_HOURS,
  monthWindow,
} from "./forecast.js";
import { estimated, heuristic, type Labeled, labeled } from "./provenance.js";

/**
 * Calibrated forecast v2 — Gamma-process Monte Carlo (feature catalog E2,
 * ticket #77). Normative spec: claumon `internal/forecast/MODEL.tex` v2.2
 * (2026-07-30), ported to aiand's budget-utilization series (store request
 * rows instead of utilization snapshots).
 *
 * The model, point by point:
 *
 *  1. Rate estimate: OLS slope of CUMULATIVE spend over the last 30 minutes
 *     of 5-minute snapshots → the current instantaneous rate ($/h).
 *  2. Prior: normal-normal conjugate prior from past COMPLETED UTC-day
 *     windows — per-window rate = day spend (window units per day), variance
 *     = the across-window sample variance CORRECTED for within-window path
 *     noise (the stochasticity of a day's own increments would otherwise be
 *     double-counted as prior uncertainty). Zero completed windows → a flat
 *     (infinite-variance) prior, so the OLS observation alone decides — the
 *     thin-history fallback.
 *  3. Path model: Gamma-process increments — every increment is non-negative,
 *     so paths are monotone non-decreasing usage bounded below by current
 *     cumulative spend. Increment variance = mean (unit over-dispersion).
 *  4. Rate draw: the v2.2 RECTIFIED-GAUSSIAN fix — each path draws its rate
 *     from the posterior Gaussian floored at zero. Negative draws become
 *     exact-zero-rate paths (plateaus), which is what lifted claumon's 80%
 *     LOSO coverage 55%→89%.
 *  5. Monte Carlo: K=500 seeded draws, 5-minute steps to the horizon → the
 *     80% credible interval of spend at horizon. Values are UNCAPPED:
 *     projected spend above the budget is projected demand, never clamped.
 *  6. ETA-to-threshold: median ETA + 80% CI over the paths that reach the
 *     threshold; NIL when P(never reaching) >= 0.5 — an ETA that probably
 *     never happens is not reported.
 *  7. Determinism: mulberry32, seeded explicitly (`--seed`) or from the
 *     window id (the forecast month, `YYYY-MM`) — identical inputs and seed
 *     give byte-identical outputs (golden-fixture tested).
 *
 * Provenance (#68 discipline): current spend stays `gateway-billed` upstream;
 * every v2 projection is `estimated("calibrated Monte Carlo v2 (Gamma
 * process, rectified-Gaussian rate)")`; the posterior rate is
 * `heuristic("forecast v2 rate (OLS 30-min + conjugate prior)")` because it
 * depends on the windowing heuristic.
 */

/** Monte Carlo path count (MODEL.tex v2.2: K=500). */
export const MC_DRAWS = 500;
/** Step size of the simulated paths, in minutes. */
export const STEP_MINUTES = 5;
/** Length of the OLS rate window, in minutes. */
export const OLS_WINDOW_MINUTES = 30;
/** The credible-interval level the model publishes. */
export const CI_LEVEL = 0.8;
/** Increment over-dispersion: increment variance = DISPERSION x mean. */
export const INCREMENT_DISPERSION = 1;
/** Absolute observation-SD floor, day units (one cent per day of resolution). */
export const OBS_SD_FLOOR = 0.01;

export const RATE_PROVENANCE_V2 = heuristic("forecast v2 rate (OLS 30-min + conjugate prior)");
export const PROJECTION_PROVENANCE_V2 = estimated(
  "calibrated Monte Carlo v2 (Gamma process, rectified-Gaussian rate)",
);

// ---------------------------------------------------------------------------
// Seeded randomness (hand-rolled, zero deps)
// ---------------------------------------------------------------------------

/** FNV-1a: a string seed (window id) to a 32-bit integer. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32 (T. VanDenHouten, public domain): a 32-bit seeded PRNG used
 * because it is short, well-documented, and passes basic statistical sanity —
 * enough for a 500-path Monte Carlo, and fully deterministic across runs and
 * platforms (pure 32-bit integer math).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller (one uniform pair per draw, cos form). */
export function standardNormal(rng: () => number): number {
  const u1 = rng();
  const u2 = rng();
  if (u1 <= 0) return 0; // u1 = 0 has probability ~2^-32; keep it finite
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Gamma sample via Marsaglia-Tsang (2000). Shape >= 1 uses the direct
 * algorithm; shape < 1 uses the boost transform x = g^(1/shape) with an
 * extra uniform. Deterministic given the rng stream.
 */
export function gammaSample(rng: () => number, shape: number, scale: number): number {
  if (!(shape > 0)) return 0;
  if (shape < 1) {
    const u = Math.max(rng(), 1e-12);
    return gammaSample(rng, shape + 1, scale) * u ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = standardNormal(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = rng();
    const lhs = u * u * u;
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(lhs) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/** Nearest-rank quantile of a sample (ascending); null for empty input. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] as number;
}

// ---------------------------------------------------------------------------
// Rate estimate: OLS over the trailing snapshot window
// ---------------------------------------------------------------------------

export type Snapshot = { atMs: number; cumulative: number };

/**
 * Cumulative-spend snapshots on the 5-minute grid over the trailing
 * `OLS_WINDOW_MINUTES`, inclusive of `nowMs`. Monotone by construction
 * (spend only accumulates). Point rows with no latency count at their
 * timestamp, exactly like `attributedSpend`.
 */
export function buildSnapshots(
  rows: readonly ForecastRow[],
  nowMs: number,
  stepMinutes = STEP_MINUTES,
  windowMinutes = OLS_WINDOW_MINUTES,
): Snapshot[] {
  const step = stepMinutes * MINUTE_MS;
  const start = nowMs - windowMinutes * MINUTE_MS;
  const snaps: Snapshot[] = [];
  for (let t = start; t < nowMs; t += step) snaps.push({ atMs: t, cumulative: 0 });
  snaps.push({ atMs: nowMs, cumulative: 0 });
  for (const snap of snaps) {
    snap.cumulative = attributedSpend(rows, start, snap.atMs + 1);
  }
  return snaps;
}

export type OlsRate = { ratePerHour: number; sePerHour: number; points: number };

/**
 * OLS slope of cumulative spend against time (hours), with the slope's
 * standard error from the residuals. Needs >= 2 distinct time points and a
 * positive total move — a flat plateau reports rate 0 with the residual
 * spread as its error, which is exactly the honest answer for a stall.
 */
export function olsRate(snapshots: readonly Snapshot[]): OlsRate | null {
  const n = snapshots.length;
  if (n < 2) return null;
  const t0 = snapshots[0]!.atMs;
  const xs = snapshots.map((s) => (s.atMs - t0) / HOUR_MS);
  const ys = snapshots.map((s) => s.cumulative);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
    sxy += (xs[i]! - my) * (ys[i]! - my);
  }
  if (sxx <= 0) return null;
  const slope = sxy / sxx;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const resid = ys[i]! - my - slope * (xs[i]! - mx);
    sse += resid * resid;
  }
  const se2 = sse / (n - 2) / sxx;
  return { ratePerHour: slope, sePerHour: Math.sqrt(Math.max(0, se2)), points: n };
}

// ---------------------------------------------------------------------------
// Prior from past completed windows + conjugate update
// ---------------------------------------------------------------------------

export type WindowPrior = {
  mean: number;
  variance: number;
  windows: number;
  /** Mean within-window (path-noise) variance that was subtracted out. */
  noiseCorrection: number;
};

/** How many 5-min steps the prior-windows fallback requires at minimum. */
const PRIOR_FLOOR_RATIO = 0.5;

/**
 * Normal-normal prior from past COMPLETED UTC-day windows: per-window rate =
 * the day's attributed spend (window units per day). The across-window sample
 * variance is corrected for within-window stochasticity: each window's own
 * path noise contributes ≈ rate²/n_d (n_d = its active 5-minute increments),
 * and that average is subtracted before the prior variance is fixed, with a
 * floor at PRIOR_FLOOR_RATIO x the correction so the prior never claims more
 * certainty than one window's own noise.
 */
export function windowPrior(
  rows: readonly ForecastRow[],
  nowMs: number,
  stepMinutes = STEP_MINUTES,
): WindowPrior | null {
  const step = stepMinutes * MINUTE_MS;
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const byDay = new Map<number, { spend: number; active: number }>();
  for (const row of rows) {
    const cost = costValue(row);
    if (cost === null) continue;
    const at = Date.parse(row.created_at);
    if (Number.isNaN(at) || at >= todayStart) continue;
    const day = Math.floor(at / DAY_MS) * DAY_MS;
    const entry = byDay.get(day) ?? { spend: 0, active: 0 };
    entry.spend += cost;
    byDay.set(day, entry);
  }
  // Active increments per day: 5-min buckets that contain any cost-bearing row.
  const activeBuckets = new Map<number, Set<number>>();
  for (const row of rows) {
    if (costValue(row) === null) continue;
    const at = Date.parse(row.created_at);
    if (Number.isNaN(at) || at >= todayStart) continue;
    const day = Math.floor(at / DAY_MS) * DAY_MS;
    let set = activeBuckets.get(day);
    if (!set) {
      set = new Set();
      activeBuckets.set(day, set);
    }
    set.add(Math.floor((at - day) / step));
  }
  if (byDay.size === 0) return null;

  const rates = [...byDay.entries()].map(([day, entry]) => {
    const active = Math.max(1, activeBuckets.get(day)?.size ?? 1);
    return { rate: entry.spend, noise: (entry.spend * entry.spend) / active };
  });
  const mean = rates.reduce((a, r) => a + r.rate, 0) / rates.length;
  const correction = rates.reduce((a, r) => a + r.noise, 0) / rates.length;
  let variance: number;
  if (rates.length < 2) {
    variance = Math.max(correction, 1e-12);
  } else {
    const spread =
      rates.reduce((a, r) => a + (r.rate - mean) * (r.rate - mean), 0) / (rates.length - 1);
    variance = Math.max(spread - correction, PRIOR_FLOOR_RATIO * correction, 1e-12);
  }
  return { mean, variance, windows: rates.length, noiseCorrection: correction };
}

/** Normal-normal conjugate update: prior (m0, v0) x observation (m1, v1).
 * A non-finite prior variance is the flat prior: the observation decides. */
export function conjugateUpdate(
  priorMean: number,
  priorVariance: number,
  obsMean: number,
  obsVariance: number,
): { mean: number; variance: number } {
  if (!(priorVariance > 0) || !Number.isFinite(priorVariance)) {
    return { mean: obsMean, variance: obsVariance };
  }
  if (!(obsVariance > 0)) return { mean: priorMean, variance: priorVariance };
  const weight = priorVariance / (priorVariance + obsVariance);
  return {
    mean: priorMean + weight * (obsMean - priorMean),
    variance: (1 - weight) * priorVariance,
  };
}

function costValue(row: ForecastRow): number | null {
  if (typeof row.cost_value === "number" && Number.isFinite(row.cost_value)) return row.cost_value;
  if (row.cost === null) return null;
  const parsed = Number(row.cost);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// The Monte Carlo
// ---------------------------------------------------------------------------

export type SimulateInput = {
  rows: readonly ForecastRow[];
  /** "Now": the forecast origin. */
  now: Date;
  /** Explicit seed, or null to derive it from the window id (the UTC month). */
  seed?: number | string | null;
  /** Path count (default MC_DRAWS). */
  draws?: number;
  /** Rectify the Gaussian rate draw at zero (the v2.2 fix; default true). */
  rectify?: boolean;
  /** Simulated future-spend horizon in hours. */
  horizonHours: number;
  /** Threshold spend (within the horizon) for ETA; null → no ETA. */
  thresholdSpend?: number | null;
};

export type Simulation = {
  seed: number;
  draws: number;
  stepMinutes: number;
  horizonHours: number;
  /** End-of-horizon cumulative (future) spend sample, one entry per path. */
  sample: number[];
  /** Hours until the threshold per reaching path, in path order; ETAs only. */
  etas: number[];
  /** Fraction of paths that never reach the threshold. */
  pNever: number;
  rate: {
    ols: number | null;
    se: number | null;
    prior: WindowPrior | null;
    mean: number;
    sd: number;
  };
};

/**
 * The core simulator: posterior rate (OLS x prior), then per path a
 * rectified-Gaussian rate and a Gamma-process walk of 5-minute increments.
 * Fully deterministic for a given (rows, now, seed, options).
 */
export function simulate(input: SimulateInput): Simulation {
  const nowMs = input.now.getTime();
  const draws = input.draws ?? MC_DRAWS;
  const rectify = input.rectify ?? true;
  const stepMs = STEP_MINUTES * MINUTE_MS;
  const steps = Math.max(1, Math.round((input.horizonHours * HOUR_MS) / stepMs));
  const horizonHours = (steps * stepMs) / HOUR_MS;

  const snaps = buildSnapshots(input.rows, nowMs);
  const ols = olsRate(snaps);
  const prior = windowPrior(input.rows, nowMs);

  // An all-flat snapshot window is a genuine plateau observation ONLY when
  // there is any data at all; with literally no rows and no completed
  // windows there is nothing to forecast from — refuse (never fabricate).
  const hasRecentSpend = snaps.some((s) => s.cumulative > 0);

  // Observation: the OLS slope with its standard error (a flat window is a
  // rate-0 observation — the plateau case); no observation at all → the
  // prior alone decides; neither → a degenerate zero simulation.
  let obsMean = 0;
  let obsVar = 1;
  if (ols !== null && (hasRecentSpend || prior !== null)) {
    obsMean = ols.ratePerHour * 24; // day units, matching the prior
    // Observation-variance floor: (a) spend arrives as discrete steps on the
    // sample grid, so the 30-minute OLS slope carries a phase error on the
    // order of half a step — |rate| x step/2 / window; (b) an ABSOLUTE
    // measurement-resolution floor (one cent per day) so a flat plateau is a
    // rate≈0 observation with width, not a degenerate certainty — that width
    // is what lets the rectified rate draw stall paths to exact zero.
    const sdFloor = Math.max(
      (Math.abs(obsMean) * STEP_MINUTES) / (2 * OLS_WINDOW_MINUTES),
      OBS_SD_FLOOR,
    );
    obsVar = Math.max((ols.sePerHour * 24) ** 2, sdFloor * sdFloor);
  } else if (prior !== null) {
    obsMean = prior.mean;
    obsVar = prior.variance;
  } else {
    return zeroSimulation(resolveSeed(input.seed, input.now), draws, horizonHours);
  }
  const post = conjugateUpdate(
    prior?.mean ?? 0,
    prior?.variance ?? Number.POSITIVE_INFINITY,
    obsMean,
    obsVar,
  );
  const postSd = Math.sqrt(Math.max(0, post.variance));

  const seed = resolveSeed(input.seed, input.now);
  const rng = mulberry32(seed);
  const threshold = input.thresholdSpend ?? null;
  const sample: number[] = [];
  const etas: number[] = [];
  let never = 0;

  for (let k = 0; k < draws; k++) {
    let rate: number = post.mean + postSd * standardNormal(rng);
    if (rectify) rate = Math.max(0, rate);
    let cumulative = 0;
    let etaHours: number | null = null;
    for (let s = 0; s < steps; s++) {
      if (rate <= 0) break; // zero-rate path: an exact plateau
      // rate is in day units: per-step mean = rate x (horizonHours/24)/steps.
      const meanStep = (rate * horizonHours) / (24 * steps);
      const shape = meanStep / INCREMENT_DISPERSION;
      cumulative += gammaSample(rng, shape, INCREMENT_DISPERSION);
      if (threshold !== null && etaHours === null && cumulative >= threshold) {
        etaHours = ((s + 1) * stepMs) / HOUR_MS;
      }
    }
    if (!rectify) {
      // Non-rectified variant (the deliberately miscalibrated v2.1 shape):
      // Gaussian increments floored at zero — small negative rates still
      // leak positive spend instead of stalling, which is the coverage bug.
      // Recomputed only when the rate went negative.
      if (rate < 0) {
        cumulative = 0;
        etaHours = null;
        const sdStep = Math.sqrt(Math.max(0, (Math.abs(rate) * horizonHours) / (24 * steps)));
        for (let s = 0; s < steps; s++) {
          cumulative += Math.max(0, sdStep * standardNormal(rng));
          if (threshold !== null && etaHours === null && cumulative >= threshold) {
            etaHours = ((s + 1) * stepMs) / HOUR_MS;
          }
        }
      }
    }
    sample.push(cumulative);
    if (threshold !== null) {
      if (etaHours === null) never += 1;
      else etas.push(etaHours);
    }
  }

  return {
    seed,
    draws,
    stepMinutes: STEP_MINUTES,
    horizonHours,
    sample,
    etas,
    pNever: threshold === null ? 0 : never / draws,
    rate: {
      ols: ols?.ratePerHour ?? null,
      se: ols?.sePerHour ?? null,
      prior,
      mean: post.mean / 24, // back to per-hour for reporting
      sd: postSd / 24,
    },
  };
}

function zeroSimulation(seed: number, draws: number, horizonHours: number): Simulation {
  return {
    seed,
    draws,
    stepMinutes: STEP_MINUTES,
    horizonHours,
    sample: new Array<number>(draws).fill(0),
    etas: [],
    pNever: 1,
    rate: { ols: null, se: null, prior: null, mean: 0, sd: 0 },
  };
}

/** Explicit seed wins; otherwise the window id (UTC month) seeds the stream. */
function resolveSeed(seed: number | string | null | undefined, now: Date): number {
  if (typeof seed === "number") return seed >>> 0;
  if (typeof seed === "string") return hashSeed(seed);
  const { startMs } = monthWindow(now);
  return hashSeed(`forecast-v2:${new Date(startMs).toISOString().slice(0, 7)}`);
}

// ---------------------------------------------------------------------------
// The v2 forecast surface
// ---------------------------------------------------------------------------

export type ForecastV2Input = {
  rows: readonly ForecastRow[];
  now: Date;
  seed?: number | string | null;
  budget: number | null;
  draws?: number;
  rectify?: boolean;
};

export type ForecastV2Result = {
  verdict: "ok" | "insufficient-data";
  currentSpend: number;
  /** Posterior rate per hour, with provenance. */
  rate: Labeled<number>;
  rateOls: number | null;
  rateSe: number | null;
  priorWindows: number | null;
  /** Point (median) projected spend at month end, UNCAPPED, with provenance. */
  projectedMonthEnd: Labeled<number> | null;
  /** The 80% credible interval of month-end spend, uncapped. */
  ci80: { low: number | null; high: number | null };
  /** ETA to budget: median + 80% CI in hours, null when pNever >= 0.5. */
  eta: { medianHours: number; lowHours: number; highHours: number } | null;
  pNever: number;
  /** Projected utilization at month end (median / budget) — uncapped above 1. */
  projectedUtilization: number | null;
  seed: number;
  draws: number;
  stepMinutes: number;
};

/**
 * The full v2 projection to the END OF THE CURRENT UTC MONTH (the v1 window),
 * reusing the v1 month-window convention. Thin data → `insufficient-data`
 * (never a fabricated rate); a zero-budget / no-budget forecast still
 * projects spend, just without utilization or ETA.
 */
export function forecastV2(input: ForecastV2Input): ForecastV2Result {
  const nowMs = input.now.getTime();
  const { startMs, endMs } = monthWindow(input.now);
  const currentSpend = attributedSpend(input.rows, startMs, endMs);
  const horizonHours = Math.max(1, (endMs - nowMs) / HOUR_MS);
  const remaining = input.budget !== null ? Math.max(0, input.budget - currentSpend) : null;

  const sim = simulate({
    rows: input.rows,
    now: input.now,
    seed: input.seed,
    draws: input.draws,
    rectify: input.rectify,
    horizonHours,
    thresholdSpend: remaining !== null && remaining > 0 ? remaining : null,
  });

  const hasData =
    input.rows.some((r) => {
      const cost = typeof r.cost_value === "number" ? r.cost_value : Number(r.cost);
      return Number.isFinite(cost) && cost > 0;
    }) || (sim.rate.prior?.windows ?? 0) > 0;
  if (!hasData) {
    return {
      verdict: "insufficient-data",
      currentSpend,
      rate: labeled(0, RATE_PROVENANCE_V2),
      rateOls: null,
      rateSe: null,
      priorWindows: sim.rate.prior?.windows ?? null,
      projectedMonthEnd: null,
      ci80: { low: null, high: null },
      eta: null,
      pNever: 1,
      projectedUtilization: null,
      seed: sim.seed,
      draws: sim.draws,
      stepMinutes: sim.stepMinutes,
    };
  }

  const monthEndSample = sim.sample.map((future) => currentSpend + future);
  const median = quantile(monthEndSample, 0.5) ?? currentSpend;
  const eta =
    remaining !== null && remaining > 0 && sim.pNever < 0.5 && sim.etas.length > 0
      ? {
          medianHours: (quantile(sim.etas, 0.5) ?? 0) as number,
          lowHours: (quantile(sim.etas, (1 - CI_LEVEL) / 2) ?? 0) as number,
          highHours: (quantile(sim.etas, 1 - (1 - CI_LEVEL) / 2) ?? 0) as number,
        }
      : null;

  return {
    verdict: "ok",
    currentSpend,
    rate: labeled(sim.rate.mean, RATE_PROVENANCE_V2),
    rateOls: sim.rate.ols,
    rateSe: sim.rate.se,
    priorWindows: sim.rate.prior?.windows ?? null,
    projectedMonthEnd: labeled(median, PROJECTION_PROVENANCE_V2),
    ci80: {
      low: quantile(monthEndSample, (1 - CI_LEVEL) / 2),
      high: quantile(monthEndSample, 1 - (1 - CI_LEVEL) / 2),
    },
    eta,
    pNever: input.budget === null ? 0 : sim.pNever,
    projectedUtilization: input.budget !== null && input.budget > 0 ? median / input.budget : null,
    seed: sim.seed,
    draws: sim.draws,
    stepMinutes: sim.stepMinutes,
  };
}

// ---------------------------------------------------------------------------
// The bench: replay past windows and score the forecaster
// ---------------------------------------------------------------------------

export type BenchModel = "v1" | "v2";

export type BenchWindow = {
  /** The forecast origin (anchor), ISO. */
  anchor: string;
  /** The scored horizon end, ISO. */
  horizonEnd: string;
  horizonHours: number;
  /** Actual spend in (anchor, horizonEnd] — gateway-billed rows. */
  actual: number;
  /** The forecaster's point estimate. */
  point: number;
  ciLow: number;
  ciHigh: number;
  /** Whether the actual fell inside the published 80% interval. */
  hit: boolean;
  /** Continuous ranked probability score (empirical, lower is better). */
  crps: number;
};

export type BenchRegression = {
  intercept: number;
  /** Coefficient on δ (forecast minus actual). */
  delta: number;
  /** Coefficient on δ². */
  deltaSq: number;
  verdict: string;
};

export type BenchResult = {
  model: BenchModel;
  seed: number;
  draws: number;
  horizonHours: number;
  windows: BenchWindow[];
  metrics: {
    crps: number;
    pinball10: number;
    pinball50: number;
    pinball90: number;
    coverage: number;
    bias: number;
  };
  regression: BenchRegression;
};

export type BenchInput = {
  rows: readonly ForecastRow[];
  /** Bench "now": anchors are laid out backwards from here. */
  now: Date;
  model: BenchModel;
  seed?: number | string | null;
  /** Horizon of each scored forecast, in hours. */
  horizonHours?: number;
  /** Number of replayed windows (daily anchors). */
  windows?: number;
  rectify?: boolean;
};

export const DEFAULT_BENCH_HORIZON_HOURS = 24;
export const DEFAULT_BENCH_WINDOWS = 10;

/**
 * Deterministic replay anchors: 12:00 UTC on each of the last `windows`
 * complete days before `now`, newest first is reversed to chronological.
 */
export function benchAnchors(nowMs: number, windows: number): number[] {
  const anchors: number[] = [];
  const todayNoon = Math.floor(nowMs / DAY_MS) * DAY_MS + 12 * HOUR_MS;
  for (let i = 1; i <= windows; i++) anchors.push(todayNoon - i * DAY_MS);
  return anchors.reverse();
}

/**
 * Score CRPS/pinball/coverage/bias of a model over replayed daily windows,
 * offline, from the local store rows alone. Each window forecasts the spend
 * of (anchor, anchor + horizon] from rows strictly before the anchor; the
 * actual is the attributed spend of that interval. Deterministic given the
 * same rows + seed.
 *
 * The calibration regression is weighted least squares of the squared error
 * e² on [δ, δ²] (δ = point − actual), per MODEL.tex — a positive δ²
 * coefficient means the intervals are too thin (errors grow faster than the
 * spread predicts); a positive δ coefficient means a systematic lag. Weights
 * are uniform: our windows are all the same size.
 */
export type BenchOutput =
  | { ok: true; result: BenchResult }
  | { ok: false; reason: "insufficient-history"; windows: number };

export function bench(input: BenchInput): BenchOutput {
  const horizonHours = input.horizonHours ?? DEFAULT_BENCH_HORIZON_HOURS;
  const count = input.windows ?? DEFAULT_BENCH_WINDOWS;
  const horizonMs = horizonHours * HOUR_MS;
  const anchors = benchAnchors(input.now.getTime(), count);
  const rows: BenchWindow[] = [];
  let lastSeed: number = resolveSeed(input.seed ?? null, input.now);

  for (const anchorMs of anchors) {
    const endMs = anchorMs + horizonMs;
    if (endMs > input.now.getTime()) continue; // horizon must be fully observed
    const history = input.rows.filter((row) => {
      const at = Date.parse(row.created_at);
      return !Number.isNaN(at) && at < anchorMs;
    });
    const actual = attributedSpend(input.rows, anchorMs + 1, endMs);
    if (history.length === 0) continue;

    let point: number;
    let ciLow: number;
    let ciHigh: number;
    let sample: number[];
    if (input.model === "v2") {
      const sim = simulate({
        rows: history,
        now: new Date(anchorMs),
        seed: input.seed,
        rectify: input.rectify,
        horizonHours,
      });
      lastSeed = sim.seed;
      sample = sim.sample;
      point = quantile(sample, 0.5) ?? 0;
      ciLow = quantile(sample, (1 - CI_LEVEL) / 2) ?? 0;
      ciHigh = quantile(sample, 1 - (1 - CI_LEVEL) / 2) ?? 0;
    } else {
      // v1 has no distribution: a degenerate point forecast. The headline
      // rate (24h preferred, 7d fallback, same min-span rules) times the
      // horizon IS the forecast; the interval is the point itself.
      const rate24 = burnRate(history, 24 * HOUR_MS, anchorMs, MIN_24H_SPAN_HOURS * HOUR_MS);
      const rate7d = burnRate(history, 7 * DAY_MS, anchorMs, MIN_7D_SPAN_DAYS * DAY_MS);
      const headline = rate24.ok ? rate24 : rate7d;
      point = headline.ok ? headline.value.value * horizonHours : 0;
      sample = [point];
      ciLow = point;
      ciHigh = point;
    }

    rows.push({
      anchor: new Date(anchorMs).toISOString(),
      horizonEnd: new Date(endMs).toISOString(),
      horizonHours,
      actual,
      point,
      ciLow,
      ciHigh,
      hit: actual >= ciLow && actual <= ciHigh,
      crps: empiricalCrps(sample, actual),
    });
  }

  if (rows.length === 0) {
    return { ok: false, reason: "insufficient-history", windows: 0 };
  }
  const crps = mean(rows.map((r) => r.crps));
  const pinball = (q: number) => mean(rows.map((r) => pinballLoss(q, r.point, r.actual)));
  const deltas = rows.map((r) => r.point - r.actual);
  return {
    ok: true,
    result: {
      model: input.model,
      seed: lastSeed,
      draws: input.model === "v2" ? MC_DRAWS : 1,
      horizonHours,
      windows: rows,
      metrics: {
        crps,
        pinball10: pinball(0.1),
        pinball50: pinball(0.5),
        pinball90: pinball(0.9),
        coverage: rows.filter((r) => r.hit).length / rows.length,
        bias: mean(deltas),
      },
      regression: calibrationRegression(deltas),
    },
  };
}

/** Empirical CRPS: mean|x - y| - 0.5 x mean|x - x'| (exact for a sample). */
export function empiricalCrps(sample: readonly number[], actual: number): number {
  const n = sample.length;
  if (n === 0) return Math.abs(actual);
  let term1 = 0;
  for (const x of sample) term1 += Math.abs(x - actual);
  term1 /= n;
  let term2 = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) term2 += Math.abs(sample[i]! - sample[j]!);
  }
  term2 /= 2 * n * n;
  return term1 - term2;
}

/** Pinball (quantile) loss of forecast `x` for the q-quantile against actual y. */
export function pinballLoss(q: number, x: number, y: number): number {
  const u = y - x;
  return u >= 0 ? q * u : (q - 1) * u;
}

/** Plain (here: uniformly weighted) LS of e² on the design [1, δ, δ²]. */
export function calibrationRegression(deltas: readonly number[]): BenchRegression {
  const n = deltas.length;
  if (n < 3) {
    return {
      intercept: 0,
      delta: 0,
      deltaSq: 0,
      verdict: `too few windows (${n}) to run the calibration regression`,
    };
  }
  // Normal equations for beta = (X'X)^-1 X'y, y_i = delta_i^2.
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let t0 = 0;
  let t1 = 0;
  let t2 = 0;
  for (const d of deltas) {
    const d2 = d * d;
    const y = d2;
    s0 += 1;
    s1 += d;
    s2 += d2;
    s3 += d2 * d;
    s4 += d2 * d2;
    t0 += y;
    t1 += d * y;
    t2 += d2 * y;
  }
  const beta = solve3([s0, s1, s2, s1, s2, s3, s2, s3, s4], [t0, t1, t2]) ?? [0, 0, 0];
  const [intercept = 0, delta = 0, deltaSq = 0] = beta;
  return {
    intercept,
    delta,
    deltaSq,
    verdict: regressionVerdict(intercept, delta, deltaSq, deltas),
  };
}

/** The plain-language verdict the ticket asks the regression to print. */
function regressionVerdict(
  intercept: number,
  delta: number,
  deltaSq: number,
  deltas: readonly number[],
): string {
  const scale = Math.max(1e-12, Math.sqrt(mean(deltas.map((d) => d * d))));
  const dRel = delta / scale;
  const d2Rel = deltaSq;
  if (d2Rel > 0.5) {
    return "miscalibrated: squared errors grow faster than the forecast spread — intervals are too narrow";
  }
  if (Math.abs(dRel) > 0.5) {
    return dRel > 0
      ? "systematically under-forecasting: error grows with the miss"
      : "systematically over-forecasting: error grows with the miss";
  }
  if (intercept > scale * scale) {
    return "large irreducible error floor independent of the forecast";
  }
  return "no systematic miscalibration detected";
}

/** Solve a 3x3 linear system by Gaussian elimination with partial pivoting. */
function solve3(a: number[], b: number[]): number[] | null {
  const m = [
    [a[0]!, a[1]!, a[2]!, b[0]!],
    [a[3]!, a[4]!, a[5]!, b[1]!],
    [a[6]!, a[7]!, a[8]!, b[2]!],
  ];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-300) return null;
    const tmp = m[col]!;
    m[col] = m[pivot]!;
    m[pivot] = tmp;
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const f = m[row]![col]! / m[col]![col]!;
      for (let k = col; k < 4; k++) m[row]![k]! -= f * m[col]![k]!;
    }
  }
  return [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
