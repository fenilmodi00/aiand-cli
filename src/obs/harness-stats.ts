import { cacheVerdict } from "../api/cache-report.js";
import { type SessionRequestRow, sessionizeRows } from "../store/sessions.js";
import type { ProvenanceLabel } from "./provenance.js";
import { estimated, formatLabel, gatewayBilled, heuristic } from "./provenance.js";

/** The input shape of the shared verdict function (its thresholds are law). */
type VerdictGroup = Parameters<typeof cacheVerdict>[0];

/**
 * Harness stats & compare over the user's REAL workload (feature catalog C1,
 * C6; ticket #64).
 *
 * Everything here is computed from gateway-verbatim store rows: token sums and
 * costs are `gateway-billed` (input INCLUDES cached — never adjusted), ratios
 * and percentiles are `estimated(...)`, and anything session-derived rides the
 * #66 time-gap heuristic. Sessions whose model mix spans more than one model
 * are EXCLUDED from per-harness aggregates and counted explicitly — never
 * silently assigned to a harness (CodeBurn cohorts discipline).
 */

/** Store row shape this module consumes (superset of `SessionRequestRow`). */
export type HarnessRequestRow = SessionRequestRow & {
  model: string;
  status_code: number | null;
  ttft_ms: number | null;
};

/** One session behind the aggregates — the inspectable `--samples` entry. */
export type SessionSample = {
  session_id: string;
  agent: string;
  turns: number;
  cost: number | null;
  currency: string | null;
  models: string[];
  started_at: string;
};

/** One harness row of `aiand harness stats` / `compare`. */
export type HarnessStatsRow = {
  harness: string;
  requests: number;
  sessions: number;
  tokens: { in: number; out: number; cached: number };
  cost: number | null;
  currency: string | null;
  costPerSession: { p50: number | null; p90: number | null };
  ttft: { p50: number | null; p95: number | null };
  cacheHitRatio: number;
  errorRate: number;
  verdict: "good" | "warn" | "bad";
  /** Every non-mixed session that fed the aggregates (the --samples list). */
  samples: SessionSample[];
};

export type HarnessStatsOptions = {
  gapMinutes?: number;
  timezone?: string;
  storeWatermark?: string | null;
  range?: { since: string | null; until: string | null };
  /**
   * The C6 cohort seam: a row-level predicate a future classification layer
   * (C3) can pass to narrow "same kind of work" without rewriting this
   * aggregation. Unused today — reserved by ticket #64.
   */
  cohort?: (row: HarnessRequestRow) => boolean;
};

export type HarnessStats = {
  provenance: {
    range: { since: string | null; until: string | null };
    timezone: string;
    storeWatermark: string | null;
    excludedMixed: number;
    sessionization: { method: "time-gap"; gapMinutes: number; confidence: "heuristic" };
    labels: Record<string, string>;
  };
  harnesses: HarnessStatsRow[];
  /** Mixed-model sessions excluded from every aggregate above. */
  excluded: SessionSample[];
};

/**
 * Percentile with linear interpolation between closest ranks (the method used
 * for every p50/p90/p95 here): sort ascending, index = p · (n − 1), interpolate
 * between floor and ceil neighbors. Deterministic; empty input → null.
 */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = fraction * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low] ?? null;
  const weight = index - low;
  return (sorted[low] ?? 0) * (1 - weight) + (sorted[high] ?? 0) * weight;
}

/**
 * Aggregate per-harness stats from store rows. Deterministic; pure. Mixed-model
 * sessions are excluded from every aggregate and returned separately so callers
 * can print the explicit exclusion count.
 */
export function buildHarnessStats(
  rows: readonly HarnessRequestRow[],
  options: HarnessStatsOptions = {},
): HarnessStats {
  const gapMinutes = options.gapMinutes ?? 10;
  const scoped = options.cohort ? rows.filter(options.cohort) : rows;
  const details = sessionizeRows(scoped, gapMinutes);

  const excluded: SessionSample[] = [];
  const byHarness = new Map<string, { rows: HarnessRequestRow[]; sessions: SessionSample[] }>();

  for (const session of details) {
    const models = [...new Set(session.rows.map((row) => row.model))].sort();
    const sample: SessionSample = {
      session_id: session.session_id,
      agent: session.agent,
      turns: session.turns,
      cost: session.cost,
      currency: session.currency,
      models,
      started_at: session.started_at,
    };
    // Cohorts discipline (C6): a session whose model mix spans models belongs
    // to no single harness workload picture — excluded AND counted, never
    // assigned.
    if (models.length > 1) {
      excluded.push(sample);
      continue;
    }
    const bucket = byHarness.get(session.agent) ?? { rows: [], sessions: [] };
    bucket.rows.push(...session.rows);
    bucket.sessions.push(sample);
    byHarness.set(session.agent, bucket);
  }

  const harnesses: HarnessStatsRow[] = [...byHarness.entries()]
    .map(([harness, bucket]) => {
      const requests = bucket.rows.length;
      const inputTokens = bucket.rows.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0);
      const cachedTokens = bucket.rows.reduce((sum, r) => sum + (r.cached_tokens ?? 0), 0);
      const outputTokens = bucket.rows.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0);
      const costRows = bucket.rows.filter((r) => typeof r.cost_value === "number");
      const currency = costRows[0]?.currency ?? null;
      // Costs sum within the store's single currency; a genuinely mixed set is
      // surfaced through `currencies`, never silently cross-summed.
      const cost =
        costRows.length > 0 ? costRows.reduce((sum, r) => sum + (r.cost_value ?? 0), 0) : null;
      const sessionCosts = bucket.sessions
        .map((session) => session.cost)
        .filter((value): value is number => value !== null);
      const ttfts = bucket.rows
        .map((row) => row.ttft_ms)
        .filter((value): value is number => value !== null);
      const errors = bucket.rows.filter((row) => (row.status_code ?? 0) >= 400).length;
      // The verdict rides the EXISTING cacheVerdict thresholds — never re-derived.
      const verdictGroup: VerdictGroup = {
        key: harness,
        requests,
        inputTokens,
        cachedTokens,
        outputTokens,
        costUsd: cost ?? 0,
        misses: requests - cachedTokens,
      };
      return {
        harness,
        requests,
        sessions: bucket.sessions.length,
        tokens: { in: inputTokens, out: outputTokens, cached: cachedTokens },
        cost,
        currency,
        costPerSession: {
          p50: percentile(sessionCosts, 0.5),
          p90: percentile(sessionCosts, 0.9),
        },
        ttft: { p50: percentile(ttfts, 0.5), p95: percentile(ttfts, 0.95) },
        cacheHitRatio: inputTokens > 0 ? cachedTokens / inputTokens : 0,
        errorRate: requests > 0 ? errors / requests : 0,
        verdict: cacheVerdict(verdictGroup),
        samples: bucket.sessions,
      };
    })
    .sort((a, b) => a.harness.localeCompare(b.harness));

  const labels: Record<string, string> = {
    cost: formatLabel(gatewayBilled("store cost_value sums")),
    tokens: formatLabel(gatewayBilled("store token sums (input includes cached)")),
    ttft: formatLabel(gatewayBilled("gateway ttft_ms")),
    cacheHitRatio: formatLabel(estimated("cached_tokens / input_tokens")),
    errorRate: formatLabel(estimated("status_code >= 400 / requests")),
    costPerSession: formatLabel(heuristic("per-session cost over time-gap sessions")),
    verdict: formatLabel(estimated("cacheVerdict thresholds")),
  };

  return {
    provenance: {
      range: options.range ?? { since: null, until: null },
      timezone: options.timezone ?? "UTC",
      storeWatermark: options.storeWatermark ?? null,
      excludedMixed: excluded.length,
      sessionization: { method: "time-gap", gapMinutes, confidence: "heuristic" },
      labels,
    },
    harnesses,
    excluded,
  };
}

/** Per-metric winners for `aiand harness compare` (deterministic markers). */
export type CompareWinners = {
  costPerSessionP50: string | null;
  errorRate: string | null;
  cacheHitRatio: string | null;
  ttftP50: string | null;
};

/** The winner marker used in the compare table — deterministic, works without color. */
export const WINNER_MARKER = "▸";

export function compareWinners(rows: readonly HarnessStatsRow[]): CompareWinners {
  const best = <T>(
    candidates: readonly HarnessStatsRow[],
    value: (row: HarnessStatsRow) => T | null,
    better: (a: T, b: T) => boolean,
  ): string | null => {
    let winner: HarnessStatsRow | null = null;
    let winnerValue: T | null = null;
    for (const row of candidates) {
      const current = value(row);
      if (current === null) continue;
      if (winnerValue === null || better(current, winnerValue)) {
        winner = row;
        winnerValue = current;
      }
    }
    return winner?.harness ?? null;
  };

  return {
    costPerSessionP50: best(
      rows,
      (r) => r.costPerSession.p50,
      (a, b) => a < b,
    ),
    errorRate: best(
      rows,
      (r) => r.errorRate,
      (a, b) => a < b,
    ),
    cacheHitRatio: best(
      rows,
      (r) => r.cacheHitRatio,
      (a, b) => a > b,
    ),
    ttftP50: best(
      rows,
      (r) => r.ttft.p50,
      (a, b) => a < b,
    ),
  };
}

/** The provenance labels used by this module, re-exported for the catalog. */
export function harnessStatsLabels(): Record<string, ProvenanceLabel> {
  return {
    "harness-stats.cost": gatewayBilled("store cost_value sums"),
    "harness-stats.tokens": gatewayBilled("store token sums (input includes cached)"),
    "harness-stats.ttft": gatewayBilled("gateway ttft_ms"),
    "harness-stats.cacheHitRatio": estimated("cached_tokens / input_tokens"),
    "harness-stats.errorRate": estimated("status_code >= 400 / requests"),
    "harness-stats.costPerSession": heuristic("per-session cost over time-gap sessions"),
    "harness-stats.verdict": estimated("cacheVerdict thresholds"),
  };
}
