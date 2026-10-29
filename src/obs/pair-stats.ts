import { cacheVerdict } from "../api/cache-report.js";
import { type EfficiencyTurn, oneShotRetry } from "../model-efficiency.js";
import { sessionizeRows } from "../store/sessions.js";
import {
  errorCount,
  type HarnessRequestRow,
  type HarnessStatsOptions,
  MIN_BEHAVIORAL_TURNS,
  percentile,
  type SessionSample,
} from "./harness-stats.js";
import type { ProvenanceLabel } from "./provenance.js";
import { estimated, formatLabel, gatewayBilled, heuristic } from "./provenance.js";

/**
 * Per-(harness, model) pair aggregation — the ONE query pass behind
 * `aiand harness matrix` and `aiand recommend` (feature catalog C2, C4,
 * C6; ticket #79). The OBS-P2-3 HTML matrix section is meant to reuse this
 * too, so the CLI commands and any future renderer share the same numbers.
 *
 * Everything here rides the same discipline as buildHarnessStats (#64):
 * store rows are gateway-verbatim (cost/token sums are `gateway-billed`),
 * ratios and percentiles are `estimated`, session boundaries are the #66
 * time-gap heuristic, and a session whose model mix spans more than one
 * model is attributed per model — each model slice becomes its own session
 * sample for that (harness, model) pair, so no spend is silently dropped.
 * The error rate uses the shared `errorCount` helper (#88): non-2xx
 * statuses EXCLUDING 429 (a rate limit is the gateway's pressure, not the
 * pair's quality) — the same definition `harness stats` now uses.
 */

/** Verdict reuses the shared cacheVerdict thresholds — its input shape. */
type VerdictGroup = Parameters<typeof cacheVerdict>[0];

/** One (harness, model) row of `aiand harness matrix` / `aiand recommend`. */
export type PairStatsRow = {
  harness: string;
  model: string;
  requests: number;
  sessions: number;
  tokensPerSession: { in: number; out: number };
  costPerSession: { p50: number | null; p90: number | null };
  costTotal: number | null;
  currency: string | null;
  ttft: { p50: number | null; p90: number | null; p95: number | null };
  cacheHitRatio: number;
  errorRate: number;
  verdict: "good" | "warn" | "bad";
  /**
   * #130 behavioral columns (T3): present only when the pair's cell has
   * envelope coverage (≥ MIN_BEHAVIORAL_TURNS turns); undefined otherwise —
   * rank on them only when coverage exists.
   */
  behavioral?: {
    toolErrorRate: number | null;
    oneShotRate: number | null;
    retryRate: number | null;
    missedCatchRate: number | null;
    turnsToSuccess: number | null;
    sessions: { clean: number; aborted: number; errored: number } | null;
    envelopeTurns: number;
  };
  /** Every session slice behind the aggregates (inspectable samples). */
  samples: SessionSample[];
};

export type PairStats = {
  provenance: {
    range: { since: string | null; until: string | null };
    timezone: string;
    storeWatermark: string | null;
    sessionization: { method: "time-gap"; gapMinutes: number; confidence: "heuristic" };
    labels: Record<string, string>;
  };
  pairs: PairStatsRow[];
};

/** A session is ranked only with enough of them; below this → "insufficient data". */
export const MIN_SAMPLE_SESSIONS = 5;

/**
 * A JSON row with its per-field provenance labels attached (pattern 6:
 * provenance honesty — every machine payload self-describes its numbers).
 */
export function annotatedPairRow(
  row: PairStatsRow,
): PairStatsRow & { labels: Record<string, string> } {
  return {
    ...row,
    labels: {
      cost: "gateway-billed",
      tokens: "gateway-billed",
      ttft: "gateway-billed",
      cacheHitRatio: "estimated",
      errorRate: "estimated",
      costPerSession: "heuristic",
      verdict: "estimated",
      ...(row.behavioral ? { behavioral: "heuristic(one-shot/retry envelope rule)" } : {}),
    },
  };
}

/** Envelope turns attributed to one (harness, model) cell, as T2 turns. */
function pairBehavioral(
  rows: HarnessStatsOptions["envelopes"],
  harness: string,
  model: string,
): PairStatsRow["behavioral"] {
  const turns: EfficiencyTurn[] = [];
  for (const row of rows ?? []) {
    if (row.agent !== harness || (row.model ?? "") !== model) continue;
    const e = row.envelope;
    if (!e) continue;
    turns.push({
      tools: e.tools,
      editTargets: e.edit_targets,
      toolOutcomes: Array.isArray(e.toolOutcomes) ? e.toolOutcomes : null,
      terminal: (e.terminal ?? null) as EfficiencyTurn["terminal"],
    });
  }
  if (turns.length < MIN_BEHAVIORAL_TURNS) return undefined;
  const walked = oneShotRetry(turns).stats.value;
  return {
    ...walked,
    retryRate: walked.oneShotRate === null ? null : 1 - walked.oneShotRate,
    envelopeTurns: turns.length,
  };
}

/**
 * Aggregate per-(harness, model) pair stats from store rows. Pure and
 * deterministic. The harness dimension is the masked-key agent attribution
 * (the same `session.agent` #64 uses); sessions split across models are
 * attributed per model — each model slice becomes its own session sample.
 */
export function buildPairStats(
  rows: readonly HarnessRequestRow[],
  options: HarnessStatsOptions = {},
): PairStats {
  const gapMinutes = options.gapMinutes ?? 10;
  const scoped = options.cohort ? rows.filter(options.cohort) : rows;
  const details = sessionizeRows(scoped, gapMinutes);

  const byPair = new Map<string, { rows: HarnessRequestRow[]; sessions: SessionSample[] }>();

  for (const session of details) {
    const models = [...new Set(session.rows.map((row) => row.model))].sort();
    for (const model of models) {
      const sliceRows = session.rows.filter((row) => row.model === model);
      const costRows = sliceRows.filter((row) => typeof row.cost_value === "number");
      const sample: SessionSample = {
        session_id: session.session_id,
        agent: session.agent,
        turns: sliceRows.length,
        cost:
          costRows.length > 0 ? costRows.reduce((sum, r) => sum + (r.cost_value ?? 0), 0) : null,
        currency: sliceRows[0]?.currency ?? null,
        models: [model],
        started_at: session.started_at,
      };
      const key = `${session.agent}\n${model}`;
      const bucket = byPair.get(key) ?? { rows: [], sessions: [] };
      bucket.rows.push(...sliceRows);
      bucket.sessions.push(sample);
      byPair.set(key, bucket);
    }
  }

  const pairs: PairStatsRow[] = [...byPair.entries()].map(([key, bucket]) => {
    const [harness, model] = key.split("\n");
    const requests = bucket.rows.length;
    const inputTokens = bucket.rows.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0);
    const cachedTokens = bucket.rows.reduce((sum, r) => sum + (r.cached_tokens ?? 0), 0);
    const outputTokens = bucket.rows.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0);
    const costRows = bucket.rows.filter((r) => typeof r.cost_value === "number");
    const currency = costRows[0]?.currency ?? null;
    const costTotal =
      costRows.length > 0 ? costRows.reduce((sum, r) => sum + (r.cost_value ?? 0), 0) : null;
    const sessionCosts = bucket.sessions
      .map((session) => session.cost)
      .filter((value): value is number => value !== null);
    const ttfts = bucket.rows
      .map((row) => row.ttft_ms)
      .filter((value): value is number => value !== null);
    const sessions = bucket.sessions.length;
    const verdictGroup: VerdictGroup = {
      key: `${harness}:${model}`,
      requests,
      inputTokens,
      cachedTokens,
      outputTokens,
      costUsd: costTotal ?? 0,
    };
    return {
      harness: harness ?? "unknown",
      model: model ?? "",
      requests,
      sessions,
      tokensPerSession: {
        in: sessions > 0 ? Math.round(inputTokens / sessions) : 0,
        out: sessions > 0 ? Math.round(outputTokens / sessions) : 0,
      },
      costPerSession: {
        p50: percentile(sessionCosts, 0.5),
        p90: percentile(sessionCosts, 0.9),
      },
      costTotal,
      currency,
      ttft: {
        p50: percentile(ttfts, 0.5),
        p90: percentile(ttfts, 0.9),
        p95: percentile(ttfts, 0.95),
      },
      cacheHitRatio: inputTokens > 0 ? cachedTokens / inputTokens : 0,
      errorRate: requests > 0 ? errorCount(bucket.rows) / requests : 0,
      verdict: cacheVerdict(verdictGroup),
      // #130: behavioral per (harness, model) cell — envelope turns attributed
      // to this pair (agent + model), gated on MIN_BEHAVIORAL_TURNS.
      behavioral: pairBehavioral(options.envelopes, harness ?? "unknown", model ?? ""),
      samples: bucket.sessions,
    };
  });

  const labels: Record<string, string> = {
    cost: formatLabel(gatewayBilled("store cost_value sums")),
    tokens: formatLabel(gatewayBilled("store token sums (input includes cached)")),
    ttft: formatLabel(gatewayBilled("gateway ttft_ms")),
    cacheHitRatio: formatLabel(estimated("cached_tokens / input_tokens")),
    errorRate: formatLabel(estimated("non-2xx excluding 429 / requests")),
    costPerSession: formatLabel(
      heuristic("per-session cost over time-gap sessions; mixed-model sessions split per model"),
    ),
    verdict: formatLabel(estimated("cacheVerdict thresholds")),
  };

  return {
    provenance: {
      range: options.range ?? { since: null, until: null },
      timezone: options.timezone ?? "UTC",
      storeWatermark: options.storeWatermark ?? null,
      sessionization: { method: "time-gap", gapMinutes, confidence: "heuristic" },
      labels,
    },
    pairs,
  };
}

/** The sort keys `--sort` accepts on both matrix and recommend. */
export type PairSortKey = "cost" | "ttft" | "hit" | "errors" | "tool-err" | "one-shot";

export function pairSortValue(row: PairStatsRow, key: PairSortKey): number | null {
  switch (key) {
    case "cost":
      return row.costPerSession.p50;
    case "ttft":
      return row.ttft.p50;
    case "hit":
      return row.cacheHitRatio;
    case "errors":
      return row.errorRate;
    case "tool-err":
      return row.behavioral?.toolErrorRate ?? null;
    case "one-shot":
      return row.behavioral?.oneShotRate ?? null;
  }
}

/**
 * Sort pairs by `key`. Direction is the key's natural "better first" unless
 * `order` says otherwise: cost/ttft/errors ascend (lower is better), hit
 * descends (higher is better). Nulls always sink to the bottom regardless of
 * direction, so unpriced/unknown rows never masquerade as winners.
 */
export function sortPairs(
  pairs: readonly PairStatsRow[],
  key: PairSortKey,
  order?: "asc" | "desc",
): PairStatsRow[] {
  const better = key === "hit" || key === "one-shot" ? 1 : -1; // hit/one-shot: higher better; others: lower better
  const preferred = order ?? (key === "hit" || key === "one-shot" ? "desc" : "asc");
  const dir =
    preferred === (key === "hit" || key === "one-shot" ? "desc" : "asc") ? better : -better;
  return [...pairs].sort((a, b) => {
    const av = pairSortValue(a, key);
    const bv = pairSortValue(b, key);
    if (av === null && bv === null)
      return (
        a.harness.localeCompare(b.harness) ||
        a.model.localeCompare(b.model) ||
        a.sessions - b.sessions
      );
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return av < bv ? dir : -dir;
    // Ties: hit-ratio desc, then ttft p50 asc (the C4 documented tie-breaks),
    // then name for determinism.
    if (a.cacheHitRatio !== b.cacheHitRatio) return b.cacheHitRatio - a.cacheHitRatio;
    const attft = a.ttft.p50 ?? Number.POSITIVE_INFINITY;
    const bttft = b.ttft.p50 ?? Number.POSITIVE_INFINITY;
    if (attft !== bttft) return attft < bttft ? -1 : 1;
    return a.harness.localeCompare(b.harness) || a.model.localeCompare(b.model);
  });
}

/** The provenance labels used by this module, keyed for catalogs/tests. */
export function pairStatsLabels(): Record<string, ProvenanceLabel> {
  return {
    "pair-stats.cost": gatewayBilled("store cost_value sums"),
    "pair-stats.tokens": gatewayBilled("store token sums (input includes cached)"),
    "pair-stats.ttft": gatewayBilled("gateway ttft_ms"),
    "pair-stats.cacheHitRatio": estimated("cached_tokens / input_tokens"),
    "pair-stats.errorRate": estimated("non-2xx excluding 429 / requests"),
    "pair-stats.costPerSession": heuristic(
      "per-session cost over time-gap sessions; mixed-model sessions split per model",
    ),
    "pair-stats.verdict": estimated("cacheVerdict thresholds"),
    "pair-stats.behavioral": heuristic("one-shot/retry envelope rule (T2 walk)"),
  };
}
