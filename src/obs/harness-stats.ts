import { cacheVerdict } from "../api/cache-report.js";
import { type EfficiencyTurn, oneShotRetry } from "../model-efficiency.js";
import type { ImportedArtifactRow } from "../store/imported-artifacts.js";
import { type SessionRequestRow, sessionizeRows } from "../store/sessions.js";
import {
  bootstrapRatio,
  type CI95,
  percentileBootstrap,
  seedFromString,
  wilson95,
} from "./evidence.js";
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
  /** #155: decode-throughput denominator (with ttft_ms); null on old rows. */
  latency_ms: number | null;
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

/**
 * Behavioral per-harness columns (T3, #130), sourced from T2's envelope walk
 * (`oneShotRetry` over the harness's envelope turns — the same join
 * `src/commands/efficiency.ts` uses: per masked api_key, most recent
 * envelope at-or-before the request within the turn window). All nullable:
 * v1 envelopes or no envelope data → null, rendered as `—`, never a zero.
 */
type BehavioralStats = {
  /**
   * #146: which source fed this harness's behavioral cells — the envelope
   walk, the imported artifact markers, or neither. Precedence: envelope
   (≥ MIN_BEHAVIORAL_TURNS) > imported (≥ 1 session) > none; the two are
   never summed.
   */
  behavioralSource: "envelope" | "imported" | "none";
  toolErrorRate: number | null;
  oneShotRate: number | null;
  retryRate: number | null;
  missedCatchRate: number | null;
  turnsToSuccess: number | null;
  sessions: { clean: number; aborted: number; errored: number } | null;
  /** Envelope turns behind the rates (the cell's n for coverage gating). */
  envelopeTurns: number;
  /** #146: tool calls behind toolErrorRate (envelope toolOutcomes or imported tool markers). */
  toolCalls: number;
  /** #146: imported compaction-marker count; null for envelope (not captured) and none. */
  compactions: number | null;
  /** #146: distinct (harness, session) imported rows behind an imported cell. */
  importedSessions: number;
  /** #146: clean / (clean+aborted+errored); null when no terminal info. */
  cleanRate: number | null;
  /**
   * #147: the 0/1 tool-error outcomes behind toolErrorRate (1 = error) — the
   * bootstrap sample for its CI. null when the cell is uncovered (the CI must
   * not exist where the rate doesn't); kept on the BehavioralStats that
   * already carries the rate's n.
   */
  toolOutcomes: readonly number[] | null;
};

/** The uncovered cell: nulls and a zero count — never fake zeros in rates. */
const EMPTY_BEHAVIORAL: BehavioralStats = {
  behavioralSource: "none",
  toolErrorRate: null,
  oneShotRate: null,
  retryRate: null,
  missedCatchRate: null,
  turnsToSuccess: null,
  sessions: null,
  envelopeTurns: 0,
  toolCalls: 0,
  compactions: null,
  importedSessions: 0,
  cleanRate: null,
  toolOutcomes: null,
};

/**
 * Behavioral columns are only shown for a harness with at least this many
 * envelope turns behind them — the MIN_SAMPLE_SESSIONS discipline applied to
 * envelope data (below it, the rates are a guess).
 */
export const MIN_BEHAVIORAL_TURNS = 5;

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
  /** #155: throughput-weighted avg TPS over this harness's requests; informational, never a verdict input. */
  avgTps: number | null;
  cacheHitRatio: number;
  errorRate: number;
  verdict: "good" | "warn" | "bad";
  /**
   * #147: 95% confidence intervals behind the point estimates — null when the
   * n is below 5 (a small-n interval is a guess, never displayed). cost/ttft
   * ride the percentile bootstrap over session costs / ttft rows; hit and
   * error ride bootstrap/Wilson over requests; behavioral CIs ride the
   * behavioral source's own n.
   */
  ci95: {
    costPerSessionP50: CI95 | null;
    ttftP50: CI95 | null;
    ttftP95: CI95 | null;
    cacheHitRatio: CI95 | null;
    errorRate: CI95 | null;
    cleanRate: CI95 | null;
    toolErrorRate: CI95 | null;
  };
  /** Behavioral columns (#130): null when envelope data doesn't cover the harness. */
  behavioral: BehavioralStats;
  /** Every non-mixed session that fed the aggregates (the --samples list). */
  samples: SessionSample[];
};

/**
 * The gateway-billed spend of the mixed-model sessions excluded from every
 * aggregate — the visibility line that lets harness totals reconcile with
 * `usage` (OBS-LT-4). One definition, shared by `harness stats`, `compare`,
 * `matrix`, and `recommend`.
 */
export type ExcludedMixedAggregate = {
  sessions: number;
  requests: number;
  /** Gateway token sums; input INCLUDES cached (same as every row above). */
  tokens: { in: number; out: number; cached: number };
  cost: number | null;
  currency: string | null;
};

/** Sum the excluded sessions' rows. Pure; same provenance as pair costs. */
function excludedMixedAggregate(
  sessions: readonly { rows: readonly HarnessRequestRow[] }[],
): ExcludedMixedAggregate {
  const rows = sessions.flatMap((session) => [...session.rows]);
  const costRows = rows.filter((r) => typeof r.cost_value === "number");
  return {
    sessions: sessions.length,
    requests: rows.length,
    tokens: {
      in: rows.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0),
      out: rows.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0),
      cached: rows.reduce((sum, r) => sum + (r.cached_tokens ?? 0), 0),
    },
    cost: costRows.length > 0 ? costRows.reduce((sum, r) => sum + (r.cost_value ?? 0), 0) : null,
    currency: costRows[0]?.currency ?? null,
  };
}

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
  /**
   * Envelope rows in the window (#130): the behavioral-column source. Each
   * entry is one captured turn with its harness id (`agent`) — the same
   * stored-row shape `efficiencyByHarness` reads. Absent/empty → behavioral
   * columns uncovered (all null).
   */
  envelopes?: readonly {
    agent: string;
    model?: string | null;
    envelope: {
      tools: string[];
      edit_targets: string[];
      toolOutcomes?: { name: string; ok: boolean }[] | null;
      terminal?: string | null;
    } | null;
  }[];

  /**
   * #146: behavioral markers imported by `aiand harness import` (table
   * `imported_artifacts`, read via `src/store/imported-artifacts.ts`). Each
   * entry is one marker row with its harness id. Absent/empty → imported
   * contributes nothing. Imported markers carry no edit targets and no
   * model/api_key, so they unlock only harness-level tool-error rate,
   * terminal split, and compaction counts.
   */
  importedMarkers?: readonly ImportedArtifactRow[];
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
  /** Their gateway-billed spend — the reconciliation line (OBS-LT-4). */
  excludedMixed: ExcludedMixedAggregate;
  /**
   * #130 behavioral coverage: covered envelope turns / total requests in
   * scope (the honest "envelopes N% of turns" denominator), null when there
   * are no requests. Zero turns → 0 coverage, columns all uncovered.
   * #146 splits the sources: `envelopes` keeps the covered-turn math,
   * `imported` counts the marker rows' distinct sessions and harnesses —
   * never summed with the envelope side.
   */
  behavioralCoverage: {
    covered: number;
    total: number;
    ratio: number | null;
    envelopes: { covered: number; total: number };
    imported: { sessions: number; harnesses: number };
  };
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
 * The one error-count helper for every harness surface (stats, compare,
 * matrix, recommend — #88) and the usage report (#98): non-2xx excluding
 * 429; a null status is unknown, not an error. A rate limit is the gateway's
 * pressure, not the pair's quality.
 */
export function errorCount(rows: readonly { status_code: number | null }[]): number {
  return rows.filter((row) => {
    const status = row.status_code;
    if (status === null) return false;
    return (status < 200 || status >= 300) && status !== 429;
  }).length;
}

/**
 * Convert one harness's stored envelope rows to T2's EfficiencyTurn shape —
 * the exact mapping `src/commands/efficiency.ts` uses for its walk (v2
 * outcome fields absent on v1 envelopes → null, never zero).
 */
function buildEfficiencyTurns(
  rows: HarnessStatsOptions["envelopes"],
  harness: string,
): EfficiencyTurn[] {
  const turns: EfficiencyTurn[] = [];
  for (const row of rows ?? []) {
    if (row.agent !== harness) continue;
    const e = row.envelope;
    if (!e) continue;
    turns.push({
      tools: e.tools,
      editTargets: e.edit_targets,
      toolOutcomes: Array.isArray(e.toolOutcomes) ? e.toolOutcomes : null,
      terminal: (e.terminal ?? null) as EfficiencyTurn["terminal"],
    });
  }
  return turns;
}

/**
 * #146: derive one harness's behavioral stats from its imported artifact
 * markers, grouped per (harness, session_id). Tool markers → calls/errors;
 * the LAST terminal marker in a session decides its outcome (the same rule
 * `artifact-import.sessionStats` applies); compaction markers count.
 * Markers carry no edit targets, so one-shot/retry, missed-catch, and
 * turns-to-success stay null (never 0) and the envelope walk is not run.
 */
export function buildImportedBehavioral(
  markers: readonly ImportedArtifactRow[],
  harness: string,
): BehavioralStats | null {
  const bySession = new Map<string, ImportedArtifactRow[]>();
  for (const marker of markers) {
    if (marker.harness !== harness) continue;
    const bucket = bySession.get(marker.session_id);
    if (bucket) bucket.push(marker);
    else bySession.set(marker.session_id, [marker]);
  }
  if (bySession.size === 0) return null;

  let toolCalls = 0;
  let toolErrors = 0;
  let compactions = 0;
  const toolOutcomes: number[] = [];
  const sessions = { clean: 0, aborted: 0, errored: 0 };
  let terminals = 0;
  for (const bucket of bySession.values()) {
    // Rows arrive ordered (harness, session_id, seq, at); the last terminal
    // marker wins when a session logs several turns.
    const lastTerminal = [...bucket].reverse().find((m) => m.kind === "terminal");
    const outcome = lastTerminal?.outcome;
    if (outcome === "clean" || outcome === "aborted" || outcome === "errored") {
      terminals += 1;
      sessions[outcome] += 1;
    }
    for (const marker of bucket) {
      if (marker.kind === "tool") {
        toolCalls += 1;
        const errored = marker.outcome === "error" ? 1 : 0;
        toolErrors += errored;
        toolOutcomes.push(errored);
      } else if (marker.kind === "compaction") {
        compactions += 1;
      }
    }
  }
  return {
    behavioralSource: "imported",
    toolErrorRate: toolCalls > 0 ? toolErrors / toolCalls : null,
    oneShotRate: null,
    retryRate: null,
    missedCatchRate: null,
    turnsToSuccess: null,
    sessions: terminals > 0 ? sessions : null,
    envelopeTurns: 0,
    toolCalls,
    compactions,
    importedSessions: bySession.size,
    cleanRate: terminals > 0 ? sessions.clean / terminals : null,
    toolOutcomes: toolCalls > 0 ? toolOutcomes : null,
  };
}

/** Below this many observations, no CI is computed — an interval needs an n. */
const MIN_CI_N = 5;

/**
 * #147: the per-harness 95% CIs behind the point estimates. Seed =
 * seedFromString(harness), so one harness's interval never shifts when another
 * joins the table; same store + flags → identical output. Each metric null
 * below 5 observations (session costs / ttft rows / requests / terminals /
 * tool outcomes) — and behavioral CIs ride the behavioral source's own n.
 */
function buildCi95(
  harness: string,
  sessionCosts: readonly number[],
  ttfts: readonly number[],
  cachedPerRequest: readonly number[],
  inputPerRequest: readonly number[],
  errors: number,
  requests: number,
  behavioral: BehavioralStats,
  toolValues: readonly number[] | null,
): HarnessStatsRow["ci95"] {
  const seed = seedFromString(harness);
  const terminals = behavioral.sessions;
  const terminalN =
    terminals === null ? 0 : terminals.clean + terminals.aborted + terminals.errored;
  return {
    costPerSessionP50:
      sessionCosts.length >= MIN_CI_N ? percentileBootstrap(sessionCosts, 0.5, { seed }) : null,
    ttftP50: ttfts.length >= MIN_CI_N ? percentileBootstrap(ttfts, 0.5, { seed }) : null,
    ttftP95: ttfts.length >= MIN_CI_N ? percentileBootstrap(ttfts, 0.95, { seed }) : null,
    cacheHitRatio:
      inputPerRequest.length >= MIN_CI_N
        ? bootstrapRatio(cachedPerRequest, inputPerRequest, { seed })
        : null,
    errorRate: requests >= MIN_CI_N ? wilson95(errors, requests) : null,
    cleanRate:
      behavioral.cleanRate === null || terminalN < MIN_CI_N
        ? null
        : wilson95(terminals?.clean ?? 0, terminalN),
    toolErrorRate:
      toolValues !== null && toolValues.length >= MIN_CI_N
        ? bootstrapRatio(
            toolValues,
            toolValues.map(() => 1),
            { seed },
          )
        : null,
  };
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
  const excludedSessions: { rows: HarnessRequestRow[] }[] = [];
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
      excludedSessions.push(session);
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
      // #155: throughput-weighted avg TPS over this harness's eligible rows —
      // sum(output)/sum(latency − ttft)*1000; null without eligible rows
      // (null never becomes 0).
      let tpsTokens = 0;
      let tpsMs = 0;
      for (const row of bucket.rows) {
        if (
          row.latency_ms !== null &&
          row.ttft_ms !== null &&
          row.latency_ms > row.ttft_ms &&
          row.output_tokens !== null &&
          row.output_tokens > 0
        ) {
          tpsTokens += row.output_tokens;
          tpsMs += row.latency_ms - row.ttft_ms;
        }
      }
      const errors = errorCount(bucket.rows);
      // #147: per-request cache vectors for the hit-ratio bootstrap — cached
      // rides with its own input denominator (paired resampling).
      const cachedPerRequest = bucket.rows.map((r) => r.cached_tokens ?? 0);
      const inputPerRequest = bucket.rows.map((r) => r.input_tokens ?? 0);
      // #130/#146: behavioral columns ride T2's walk over this harness's
      // envelope turns (same join as efficiency.ts). Gated on
      // MIN_BEHAVIORAL_TURNS — below it the cell falls through to the
      // imported markers (#146), and only then to uncovered (nulls, never a
      // small-n guess). The two sources are never summed.
      const harnessTurns = buildEfficiencyTurns(options.envelopes, harness);
      const envelopeBehavioral: BehavioralStats | null =
        harnessTurns.length >= MIN_BEHAVIORAL_TURNS
          ? (() => {
              const walked = oneShotRetry(harnessTurns).stats.value;
              // #147: every captured tool outcome this window, as 0/1 error
              // flags — the bootstrap sample behind toolErrorRate's CI.
              const toolOutcomes = harnessTurns.flatMap((turn) =>
                (turn.toolOutcomes ?? []).map((o) => (o.ok ? 0 : 1)),
              );
              return {
                behavioralSource: "envelope",
                ...walked,
                // retryRate = retries / (oneShots + retries) — the complement
                // of oneShotRate over the same event set.
                retryRate: walked.oneShotRate === null ? null : 1 - walked.oneShotRate,
                envelopeTurns: harnessTurns.length,
                // Envelope toolCalls: every captured tool outcome this window.
                toolCalls: toolOutcomes.length,
                // Compaction events are not captured in envelopes — honest
                // null, never a zero.
                compactions: null,
                importedSessions: 0,
                cleanRate:
                  walked.sessions === null
                    ? null
                    : (() => {
                        const total =
                          walked.sessions.clean + walked.sessions.aborted + walked.sessions.errored;
                        return total > 0 ? walked.sessions.clean / total : null;
                      })(),
                toolOutcomes: toolOutcomes.length > 0 ? toolOutcomes : null,
              };
            })()
          : null;
      const behavioral: BehavioralStats =
        envelopeBehavioral ??
        buildImportedBehavioral(options.importedMarkers ?? [], harness) ??
        EMPTY_BEHAVIORAL;
      // The verdict rides the EXISTING cacheVerdict thresholds — never re-derived.
      const verdictGroup: VerdictGroup = {
        key: harness,
        requests,
        inputTokens,
        cachedTokens,
        outputTokens,
        costUsd: cost ?? 0,
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
        avgTps: tpsMs > 0 ? (tpsTokens / tpsMs) * 1000 : null,
        cacheHitRatio: inputTokens > 0 ? cachedTokens / inputTokens : 0,
        errorRate: requests > 0 ? errors / requests : 0,
        verdict: cacheVerdict(verdictGroup),
        ci95: buildCi95(
          harness,
          sessionCosts,
          ttfts,
          cachedPerRequest,
          inputPerRequest,
          errors,
          requests,
          behavioral,
          behavioral.toolOutcomes,
        ),
        behavioral,
        samples: bucket.sessions,
      };
    })
    .sort((a, b) => a.harness.localeCompare(b.harness));

  // #130 coverage math: how many of the in-scope requests an envelope turn
  // can plausibly explain (harness matches + turn window). Honest ratio —
  // covered / total, not the share among covered harnesses. #146 adds the
  // imported side: distinct sessions/harnesses that imported markers cover,
  // reported separately — never folded into the envelope turns.
  const totalRequests = scoped.length;
  const covered = options.envelopes
    ? harnesses.reduce((sum, h) => sum + h.behavioral.envelopeTurns, 0)
    : 0;
  const importedRows = options.importedMarkers ?? [];
  const importedSessions = new Set(importedRows.map((m) => `${m.harness}\u0000${m.session_id}`));
  const behavioralCoverage = {
    covered,
    total: totalRequests,
    ratio: totalRequests > 0 ? covered / totalRequests : null,
    envelopes: { covered, total: totalRequests },
    imported: {
      sessions: importedSessions.size,
      harnesses: new Set(importedRows.map((m) => m.harness)).size,
    },
  };

  const labels: Record<string, string> = {
    cost: formatLabel(gatewayBilled("store cost_value sums")),
    tokens: formatLabel(gatewayBilled("store token sums (input includes cached)")),
    ttft: formatLabel(gatewayBilled("gateway ttft_ms")),
    cacheHitRatio: formatLabel(estimated("cached_tokens / input_tokens")),
    errorRate: formatLabel(estimated("non-2xx excluding 429 / requests")),
    costPerSession: formatLabel(heuristic("per-session cost over time-gap sessions")),
    verdict: formatLabel(estimated("cacheVerdict thresholds")),
    behavioral: formatLabel(heuristic("one-shot/retry envelope rule (T2 walk)")),
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
    excludedMixed: excludedMixedAggregate(excludedSessions),
    behavioralCoverage,
  };
}

/** The winner marker used in the compare table — deterministic, works without color. */
export const WINNER_MARKER = "▸";

/**
 * Per-metric evidence-gated verdicts for `aiand harness compare` (#147).
 * A metric's `winner` is the harness whose best-value CI is disjoint from
 * EVERY other candidate's CI; when intervals overlap, `winner` is null and
 * `tied` lists the harnesses whose CIs overlap the anchor's (sorted) —
 * the decision is "not distinguishable yet", never a point-estimate crown.
 */
export type CompareVerdicts = {
  [M in keyof CompareMetrics]: { winner: string | null; tied: string[] };
};

/** The compared metrics and their "better" direction (thresholds stay here). */
type CompareMetrics = {
  costPerSessionP50: "lower";
  errorRate: "lower";
  cacheHitRatio: "higher";
  ttftP50: "lower";
  toolErrorRate: "lower";
  oneShotRate: "higher";
  missedCatchRate: "lower";
  turnsToSuccess: "lower";
};

/** One compared metric: its extractor, its CI extractor, the better direction. */
type MetricSpec = {
  value: (row: HarnessStatsRow) => number | null;
  ci: (row: HarnessStatsRow) => CI95 | null;
  better: "lower" | "higher";
};

const COMPARE_METRICS: { [M in keyof CompareMetrics]: MetricSpec } = {
  costPerSessionP50: {
    value: (r) => r.costPerSession.p50,
    ci: (r) => r.ci95.costPerSessionP50,
    better: "lower",
  },
  errorRate: {
    value: (r) => r.errorRate,
    ci: (r) => r.ci95.errorRate,
    better: "lower",
  },
  cacheHitRatio: {
    value: (r) => r.cacheHitRatio,
    ci: (r) => r.ci95.cacheHitRatio,
    better: "higher",
  },
  ttftP50: {
    value: (r) => r.ttft.p50,
    ci: (r) => r.ci95.ttftP50,
    better: "lower",
  },
  // #130/#147 behavioral verdicts: a harness competes only when its cell has
  // coverage (rate non-null ⇒ envelope turns ≥ MIN_BEHAVIORAL_TURNS or
  // imported markers) AND a CI (n ≥ 5 outcomes).
  toolErrorRate: {
    value: (r) => r.behavioral?.toolErrorRate ?? null,
    ci: (r) => r.ci95.toolErrorRate,
    better: "lower",
  },
  oneShotRate: {
    value: (r) => r.behavioral?.oneShotRate ?? null,
    ci: () => null,
    better: "higher",
  },
  missedCatchRate: {
    value: (r) => r.behavioral?.missedCatchRate ?? null,
    ci: () => null,
    better: "lower",
  },
  turnsToSuccess: {
    value: (r) => r.behavioral?.turnsToSuccess ?? null,
    ci: () => null,
    better: "lower",
  },
};

const ciOverlaps = (a: CI95, b: CI95): boolean => a.lo <= b.hi && b.lo <= a.hi;

/**
 * #147: evidence-gated per-metric verdicts. `▸` appears only when the leader's
 * CI is disjoint from EVERY rival's CI. Any candidate without an interval
 * (n < 5, or a metric with no CI surface such as one-shot/missed-catch/turns)
 * makes separation unprovable: no winner, and the candidates are listed as
 * tied. Small-n point estimates never crown a harness.
 */
export function compareVerdicts(rows: readonly HarnessStatsRow[]): CompareVerdicts {
  const verdicts = {} as CompareVerdicts;
  const entries = Object.entries(COMPARE_METRICS) as [keyof CompareMetrics, MetricSpec][];
  for (const [metric, spec] of entries) {
    const candidates = rows.filter((row) => spec.value(row) !== null);
    if (candidates.length === 0) {
      verdicts[metric] = { winner: null, tied: [] };
      continue;
    }
    const withCi = candidates.filter((row) => spec.ci(row) !== null);
    if (withCi.length < candidates.length) {
      // At least one rival has no interval → the data cannot prove separation.
      verdicts[metric] = {
        winner: null,
        tied: candidates.length > 1 ? candidates.map((row) => row.harness).sort() : [],
      };
      continue;
    }
    const lower = spec.better === "lower";
    let anchor: HarnessStatsRow | null = null;
    let anchorValue: number | null = null;
    for (const row of candidates) {
      const current = spec.value(row);
      if (current === null) continue;
      if (anchorValue === null || (lower ? current < anchorValue : current > anchorValue)) {
        anchor = row;
        anchorValue = current;
      }
    }
    if (anchor === null || anchorValue === null) {
      verdicts[metric] = { winner: null, tied: [] };
      continue;
    }
    const anchorCi = spec.ci(anchor)!;
    const overlapping = candidates
      .filter((row) => row.harness !== anchor.harness)
      .filter((row) => {
        const ci = spec.ci(row);
        return ci !== null && ciOverlaps(anchorCi, ci);
      })
      .map((row) => row.harness)
      .sort();
    verdicts[metric] = {
      winner: overlapping.length === 0 ? anchor.harness : null,
      tied: overlapping.length === 0 ? [] : [anchor.harness, ...overlapping].sort(),
    };
  }
  return verdicts;
}
