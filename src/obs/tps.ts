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
export function requestTps(
  outputTokens: number | null,
  ttftMs: number | null,
  latencyMs: number | null,
): number | null {
  if (ttftMs === null || latencyMs === null || latencyMs <= ttftMs) return null;
  if (outputTokens === null || outputTokens === 0) return null;
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
