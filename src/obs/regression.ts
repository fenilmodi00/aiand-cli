import { sessionizeRows } from "../store/sessions.js";
import { bootstrapDelta, type CI95, seedFromString } from "./evidence.js";
import {
  buildHarnessStats,
  errorCount,
  type HarnessRequestRow,
  type HarnessStats,
  type HarnessStatsOptions,
  percentile,
} from "./harness-stats.js";

/**
 * #151 baseline regression watch: compare the current window against the
 * immediately preceding one of equal length. Stateless by design — no saved
 * snapshot, no daemon, no new state; the caller supplies both windows.
 *
 * Discipline mirrors harness stats / pair stats: session windows are the
 * time-gap heuristic, a mixed-model session contributes one sample per model
 * slice, behavioural rates follow the envelope > imported precedence, and a
 * value is only compared when BOTH windows have at least 5 samples behind it.
 * The delta CI is a seeded percentile bootstrap over independent resamples —
 * sessions are not paired across windows. Verdicts are screening, not proof.
 */

/** The tracked metrics. cleanRate is the one where UP is good. */
export type RegressionMetric =
  | "costPerSession"
  | "ttftP95"
  | "errorRate"
  | "cleanRate"
  | "toolErrorRate";

export type RegressionVerdict =
  | "regression"
  | "improvement"
  | "no change"
  | "noise — not distinguishable";

/** One (harness, model, metric) comparison; `delta = current - baseline`. */
export type RegressionRow = {
  harness: string;
  /** `*` for harness-level behavioural metrics (markers carry no model). */
  model: string;
  metric: RegressionMetric;
  current: number;
  baseline: number;
  delta: number;
  /** 95% CI on the delta (seeded percentile bootstrap). */
  ci95: CI95;
  verdict: RegressionVerdict;
  n: { current: number; baseline: number };
};

export type RegressionReport = {
  rows: RegressionRow[];
  regressions: RegressionRow[];
  improvements: RegressionRow[];
  /** (harness, model) pairs present in both windows but below the n>=5 gate. */
  insufficient: number;
  /** Metric comparisons that passed the gate (rows.length). */
  screened: number;
};

export type RegressionOptions = {
  gapMinutes?: number;
  cohort?: (row: HarnessRequestRow) => boolean;
  envelopesCurrent?: HarnessStatsOptions["envelopes"];
  envelopesBaseline?: HarnessStatsOptions["envelopes"];
  importedCurrent?: HarnessStatsOptions["importedMarkers"];
  importedBaseline?: HarnessStatsOptions["importedMarkers"];
  /** Per-window timezone for the envelope/imported readers; metrics never use it. */
  timezone?: string;
};

/** Both windows need this many samples behind a value before it is screened. */
export const MIN_REGRESSION_SAMPLES = 5;

type Slice = {
  harness: string;
  model: string;
  sessions: number;
  requests: number;
  costs: number[];
  ttfts: number[];
  errors: number[];
};

const pairKey = (harness: string, model: string): string => `${harness}\n${model}`;

/**
 * Group one window's requests per (harness, model). Harness attribution and
 * mixed-model slicing reuse `sessionizeRows`, the same source `buildPairStats`
 * reads — never a second sessionization convention.
 */
function sliceWindow(rows: readonly HarnessRequestRow[], gapMinutes: number): Map<string, Slice> {
  const slices = new Map<string, Slice>();
  for (const session of sessionizeRows(rows, gapMinutes)) {
    const models = [...new Set(session.rows.map((row) => row.model))].sort();
    for (const model of models) {
      const sliceRows = session.rows.filter((row) => row.model === model);
      const key = pairKey(session.agent, model);
      const slice = slices.get(key) ?? {
        harness: session.agent,
        model,
        sessions: 0,
        requests: 0,
        costs: [],
        ttfts: [],
        errors: [],
      };
      slice.sessions += 1;
      slice.requests += sliceRows.length;
      const costRows = sliceRows.filter((row) => typeof row.cost_value === "number");
      if (costRows.length > 0) {
        slice.costs.push(costRows.reduce((sum, row) => sum + (row.cost_value ?? 0), 0));
      }
      for (const row of sliceRows) {
        if (row.ttft_ms !== null) slice.ttfts.push(row.ttft_ms);
        slice.errors.push(errorCount([row]));
      }
      slices.set(key, slice);
    }
  }
  return slices;
}

/** Sign convention: cost, latency, and error rates DOWN are good; clean UP is good. */
function classify(metric: RegressionMetric, delta: number, ci: CI95): RegressionVerdict {
  if (delta === 0) return "no change";
  if (ci.lo <= 0 && ci.hi >= 0) return "noise — not distinguishable";
  const upIsGood = metric === "cleanRate";
  if (delta > 0 === upIsGood) return "improvement";
  return "regression";
}

/** Push a metric row when both sides carry enough samples; return true when screened. */
function compareMetric(
  out: RegressionRow[],
  metric: RegressionMetric,
  harness: string,
  model: string,
  current: number[],
  baseline: number[],
  stat: "mean" | "p50" | "p95",
  value: (values: readonly number[]) => number | null,
): boolean {
  if (current.length < MIN_REGRESSION_SAMPLES || baseline.length < MIN_REGRESSION_SAMPLES) {
    return false;
  }
  const currentValue = value(current);
  const baselineValue = value(baseline);
  if (currentValue === null || baselineValue === null) return false;
  const ci95 = bootstrapDelta(current, baseline, stat, {
    seed: seedFromString(`${harness}/${model}/${metric}`),
  });
  if (ci95 === null) return false;
  const delta = currentValue - baselineValue;
  out.push({
    harness,
    model,
    metric,
    current: currentValue,
    baseline: baselineValue,
    delta,
    ci95,
    verdict: classify(metric, delta, ci95),
    n: { current: current.length, baseline: baseline.length },
  });
  return true;
}

/** Binary samples from {successes, total} — order is irrelevant to a bootstrap. */
function binary(successes: number, total: number): number[] {
  return Array.from({ length: total }, (_, index) => (index < successes ? 1 : 0));
}

/** One harness's behavioural samples from the window's envelope/imported stats. */
function behaviorOf(
  harness: string,
  stats: HarnessStats,
): { clean: number[]; tool: number[] } | null {
  const row = stats.harnesses.find((h) => h.harness === harness);
  if (!row) return null;
  const sessions = row.behavioral.sessions;
  const terminals = sessions === null ? 0 : sessions.clean + sessions.aborted + sessions.errored;
  return {
    clean: sessions === null ? [] : binary(sessions.clean, terminals),
    tool: row.behavioral.toolOutcomes === null ? [] : [...row.behavioral.toolOutcomes],
  };
}

/**
 * Build the two-window regression report. Pure and deterministic: the same
 * rows and options always return the same rows in the same order.
 */
export function buildRegressionReport(
  currentRows: readonly HarnessRequestRow[],
  baselineRows: readonly HarnessRequestRow[],
  options: RegressionOptions = {},
): RegressionReport {
  const gapMinutes = options.gapMinutes ?? 10;
  const scope = (rows: readonly HarnessRequestRow[]): readonly HarnessRequestRow[] =>
    options.cohort ? rows.filter(options.cohort) : rows;
  const currentSlices = sliceWindow(scope(currentRows), gapMinutes);
  const baselineSlices = sliceWindow(scope(baselineRows), gapMinutes);

  const rows: RegressionRow[] = [];
  let insufficient = 0;
  for (const [key, current] of currentSlices) {
    const baseline = baselineSlices.get(key);
    if (!baseline) continue;
    if (current.sessions < MIN_REGRESSION_SAMPLES || baseline.sessions < MIN_REGRESSION_SAMPLES) {
      insufficient += 1;
      continue;
    }
    compareMetric(
      rows,
      "costPerSession",
      current.harness,
      current.model,
      current.costs,
      baseline.costs,
      "p50",
      (values) => percentile(values, 0.5),
    );
    compareMetric(
      rows,
      "ttftP95",
      current.harness,
      current.model,
      current.ttfts,
      baseline.ttfts,
      "p95",
      (values) => percentile(values, 0.95),
    );
    compareMetric(
      rows,
      "errorRate",
      current.harness,
      current.model,
      current.errors,
      baseline.errors,
      "mean",
      mean,
    );
  }

  const statsOptions = (
    envelopes: RegressionOptions["envelopesCurrent"],
    imported: RegressionOptions["importedCurrent"],
  ): HarnessStatsOptions => ({
    gapMinutes,
    timezone: options.timezone,
    envelopes,
    importedMarkers: imported,
  });
  const currentStats = buildHarnessStats(
    scope(currentRows),
    statsOptions(options.envelopesCurrent, options.importedCurrent),
  );
  const baselineStats = buildHarnessStats(
    scope(baselineRows),
    statsOptions(options.envelopesBaseline, options.importedBaseline),
  );
  for (const harness of currentStats.harnesses.map((row) => row.harness)) {
    if (!baselineStats.harnesses.some((row) => row.harness === harness)) continue;
    const current = behaviorOf(harness, currentStats);
    const baseline = behaviorOf(harness, baselineStats);
    if (current === null || baseline === null) continue;
    compareMetric(rows, "cleanRate", harness, "*", current.clean, baseline.clean, "mean", mean);
    compareMetric(rows, "toolErrorRate", harness, "*", current.tool, baseline.tool, "mean", mean);
  }

  const regressions = rows.filter((row) => row.verdict === "regression");
  const improvements = rows.filter((row) => row.verdict === "improvement");
  return { rows, regressions, improvements, insufficient, screened: rows.length };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
