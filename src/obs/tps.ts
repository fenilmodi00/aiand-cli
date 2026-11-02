/**
 * #155: the two throughput formulas, one source of truth for every surface
 * that derives TPS from the store's `ttft_ms`/`latency_ms`/`output_tokens`
 * columns. `null` never becomes 0 — an ineligible row or window is null.
 */

/**
 * Per-request TPS = output_tokens / ((latency_ms − ttft_ms) / 1000).
 * null when either latency input is null, latency ≤ ttft, or output is
 * null/0.
 */
/**
 * The shortest decode window a rate can meaningfully measure. `ttft_ms`
 * and `latency_ms` have millisecond granularity, so a 1ms window (e.g.
 * ttft 500, latency 501) turns 382 tokens into 382,000 tok/s of timer
 * noise. Benchmark harnesses (vLLM's `vllm bench serve`) summarize
 * per-request rates with medians/percentiles for the same reason; we
 * additionally gate the aggregates: sub-200ms windows never feed a TPS
 * mean or peak. Per-request display surfaces (logs, sessions) keep the
 * plain formula and show the row as-is.
 */
export const MIN_MEASURABLE_DECODE_MS = 200;

export function requestTps(
  outputTokens: number | null,
  ttftMs: number | null,
  latencyMs: number | null,
): number | null {
  // Defensive at the formula boundary: a missing column (undefined from a
  // synthetic loader) must behave like null, never slip past the checks as
  // NaN.
  if (
    ttftMs === null ||
    ttftMs === undefined ||
    latencyMs === null ||
    latencyMs === undefined ||
    !Number.isFinite(ttftMs) ||
    !Number.isFinite(latencyMs) ||
    latencyMs <= ttftMs
  ) {
    return null;
  }
  if (outputTokens === null || outputTokens === 0 || !Number.isFinite(outputTokens)) return null;
  return outputTokens / ((latencyMs - ttftMs) / 1000);
}

/**
 * Throughput-weighted avg TPS = tokens / decodeMs * 1000 — tokens and
 * decodeMs summed over eligible rows upstream. null when decodeMs ≤ 0
 * (no eligible rows, or no decode window).
 */
export function avgTps(tokens: number, decodeMs: number): number | null {
  if (decodeMs <= 0) return null;
  return (tokens / decodeMs) * 1000;
}
