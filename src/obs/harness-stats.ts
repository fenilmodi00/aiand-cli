import { cacheVerdict } from "../api/cache-report.js";
import { type EfficiencyTurn, oneShotRetry } from "../model-efficiency.js";
import type { ImportedArtifactRow } from "../store/imported-artifacts.js";
import { type SessionRequestRow, sessionizeRows } from "../store/sessions.js";
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
  cacheHitRatio: number;
  errorRate: number;
  verdict: "good" | "warn" | "bad";
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
        if (marker.outcome === "error") toolErrors += 1;
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
      const errors = errorCount(bucket.rows);
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
              return {
                behavioralSource: "envelope",
                ...walked,
                // retryRate = retries / (oneShots + retries) — the complement
                // of oneShotRate over the same event set.
                retryRate: walked.oneShotRate === null ? null : 1 - walked.oneShotRate,
                envelopeTurns: harnessTurns.length,
                // Envelope toolCalls: every captured tool outcome this window.
                toolCalls: harnessTurns.reduce(
                  (sum, turn) => sum + (turn.toolOutcomes?.length ?? 0),
                  0,
                ),
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
        cacheHitRatio: inputTokens > 0 ? cachedTokens / inputTokens : 0,
        errorRate: requests > 0 ? errors / requests : 0,
        verdict: cacheVerdict(verdictGroup),
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

/** Per-metric winners for `aiand harness compare` (deterministic markers). */
export type CompareWinners = {
  costPerSessionP50: string | null;
  errorRate: string | null;
  cacheHitRatio: string | null;
  ttftP50: string | null;
  /** #130 behavioral winners: only harnesses with covered cells compete. */
  toolErrorRate: string | null;
  oneShotRate: string | null;
  missedCatchRate: string | null;
  turnsToSuccess: string | null;
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
    // #130 behavioral winners: a harness competes only when its cell has
    // coverage (rate non-null ⇒ envelope turns ≥ MIN_BEHAVIORAL_TURNS).
    toolErrorRate: best(
      rows,
      (r) => r.behavioral?.toolErrorRate ?? null,
      (a, b) => a < b,
    ),
    oneShotRate: best(
      rows,
      (r) => r.behavioral?.oneShotRate ?? null,
      (a, b) => a > b,
    ),
    missedCatchRate: best(
      rows,
      (r) => r.behavioral?.missedCatchRate ?? null,
      (a, b) => a < b,
    ),
    turnsToSuccess: best(
      rows,
      (r) => r.behavioral?.turnsToSuccess ?? null,
      (a, b) => a < b,
    ),
  };
}
