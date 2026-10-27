import type { Session } from "../api/client.js";
import { CliError } from "../cli/errors.js";
import { percentile } from "../obs/harness-stats.js";
import { DEFAULT_PAIR_LAYOUT, type DuelPair, measureTransport } from "./duel.js";
import { type BenchScenario, type RunBenchOptions, runHarnessBenchmark } from "./harness-bench.js";
import { findHarnessLayout, HARNESS_LAYOUTS } from "./harness-layouts.js";

/**
 * The latency/TTFT A/B (feature catalog D3, ticket #82).
 *
 * A live benchmark loop per (harness layout, model) pair — N turns through
 * the same gateway path as normal traffic, NO special proxy setup — compared
 * against the historical TTFT percentiles for the same (harness, model) from
 * the local store's `ttft_ms` rows.
 *
 * The live measurements are `measured`: per-request durations around the
 * real round trip (the benchmark sends `max_tokens: 4`, so the round trip is
 * effectively the time to first token). The historical column is
 * `gateway-billed` store data. A historical bucket with fewer than
 * MIN_HISTORICAL_SAMPLES samples prints `insufficient data` — a percentile
 * from two samples is a fabrication, not a statistic.
 */

/** Below this, a historical percentile is refused rather than fabricated. */
export const MIN_HISTORICAL_SAMPLES = 5;

/** Historical TTFT percentiles for one (harness, model) bucket. */
export type HistoricalTtft = { p50: number; p90: number; p95: number; n: number };

/**
 * Percentiles over store `ttft_ms` values (nulls dropped). Returns null when
 * there are fewer than MIN_HISTORICAL_SAMPLES real samples — the caller must
 * print `insufficient data`, never a thin percentile.
 */
export function historicalTtft(rows: readonly { ttft_ms: number | null }[]): HistoricalTtft | null {
  const values = rows
    .map((row) => row.ttft_ms)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length < MIN_HISTORICAL_SAMPLES) return null;
  return {
    p50: percentile(values, 0.5)!,
    p90: percentile(values, 0.9)!,
    p95: percentile(values, 0.95)!,
    n: values.length,
  };
}

/**
 * Benchmark harness layout id → store agent id, for matching historical rows.
 * Only the two real harnesses have a store counterpart; the synthetic
 * fault-injection layouts have no historical traffic by construction.
 */
export const HARNESS_AGENT_ALIASES: Record<string, string> = {
  "claude-code": "claude",
  omp: "omp",
};

/** One pair's live latency measurements. */
export type LatencyPairResult = {
  pair: DuelPair;
  ttft: { p50: number | null; p90: number | null; p95: number | null };
  wall: { p50: number | null; p95: number | null };
  turns: number;
  partial: boolean;
  errors: number;
};

export type RunLatencyOptions = {
  session: Session;
  /** The scenario whose turns the latency loop replays (turn count decides N). */
  scenario: BenchScenario;
  pairs: readonly DuelPair[];
  prices?: RunBenchOptions["prices"];
  fetchImpl?: typeof fetch;
  now?: () => number;
  shouldAbort?: () => boolean;
  onProgress?: (message: string) => void;
};

/**
 * Run the latency loop: N turns per pair, one pair at a time, through the
 * normal gateway path. Per-request durations ARE the TTFT samples.
 */
export async function runLatency(options: RunLatencyOptions): Promise<LatencyPairResult[]> {
  const results: LatencyPairResult[] = [];
  for (const pair of options.pairs) {
    const layout = findHarnessLayout(pair.harness);
    if (!layout) {
      throw new CliError(`Unknown harness layout "${pair.harness}".`, {
        hint:
          `Valid layouts: ${HARNESS_LAYOUTS.map((l) => l.id).join(", ")}. ` +
          `Or omit harness= (--pair model=<model>) to use the default layout "${DEFAULT_PAIR_LAYOUT}".`,
      });
    }
    const transport = measureTransport(options.fetchImpl ?? fetch, {
      now: options.now,
      shouldAbort: options.shouldAbort,
    });
    options.onProgress?.(`measuring ${pair.harness} × ${pair.model}…`);
    const start = (options.now ?? Date.now)();
    let turns = 0;
    let partial = false;
    try {
      const bench = await runHarnessBenchmark({
        session: options.session,
        scenario: options.scenario,
        layouts: [layout],
        model: pair.model,
        prices: options.prices ?? {},
        fetchImpl: transport.fetchImpl,
        onProgress: options.onProgress,
      });
      turns = bench[0]?.requests ?? transport.completed();
    } catch {
      // A transport error (or an abort) leaves whatever samples completed;
      // the pair is reported partial either way.
      partial = true;
    }
    const wallSamples = [Math.max(0, (options.now ?? Date.now)() - start)];
    results.push({
      pair,
      ttft: {
        p50: percentile(transport.durations, 0.5),
        p90: percentile(transport.durations, 0.9),
        p95: percentile(transport.durations, 0.95),
      },
      wall: { p50: percentile(wallSamples, 0.5), p95: percentile(wallSamples, 0.95) },
      turns,
      partial: partial || transport.aborted(),
      errors: transport.errors(),
    });
  }
  return results;
}
