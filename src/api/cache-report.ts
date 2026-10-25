import type { LogEntry } from "./logs.js";

/**
 * Cache observability over Gateway /logs rows.
 *
 * Every number here is derived from what the Gateway already reports per
 * request: `input_tokens`, `cached_tokens`, `cost`, `api_key`, `endpoint`.
 * Nothing is estimated, and nothing requires a second data source.
 *
 * The one thing the Gateway does NOT report is which client sent a request.
 * `api_key` is the only handle, so a row is attributed to a harness through
 * the local key map (see agent-keys.ts). A key we do not know is reported as
 * "unknown" rather than being silently folded into some other agent.
 */

type CacheRow = {
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Turns that read 0 cached tokens — i.e. the cache did not fire. */
  misses: number;
};

export type CacheGroup = CacheRow & {
  /** The group key: an agent id, a model id, or a masked key. */
  key: string;
};

export type CacheReport = {
  range: string;
  totals: CacheRow;
  /** Cache hit ratio over prompt tokens: cached / (input + cached). */
  hitRatio: number;
  /** What the run would have cost with no cache at all, at the same mix. */
  costIfUncached: number;
  /** costIfUncached - costUsd. The money the cache saved. */
  savedUsd: number;
  byAgent: CacheGroup[];
  byModel: CacheGroup[];
  byKey: CacheGroup[];
  /** Rows the local key map could not attribute. */
  unattributedRequests: number;
};

/**
 * The prices a model is billed at, per 1M tokens.
 *
 * The cache-read rate is model-specific — GLM charges 0.30 against a 1.00
 * input rate, Kimi 0.50 against 3.00, DeepSeek 0.02 against 0.30 — so the
 * savings have to be computed per model against the live catalog, never
 * with one global constant.
 */
export type ModelPrice = {
  inputPer1m: number;
  cachedPer1m: number;
  outputPer1m: number;
};

function emptyRow(): CacheRow {
  return { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, misses: 0 };
}

function addRow(target: CacheRow, entry: LogEntry): void {
  const input = entry.input_tokens ?? 0;
  const cached = entry.cached_tokens ?? 0;
  target.requests += 1;
  target.inputTokens += input;
  target.cachedTokens += cached;
  target.outputTokens += entry.output_tokens ?? 0;
  target.costUsd += Number(entry.cost ?? 0);
  if (cached === 0) target.misses += 1;
}

function toGroup(key: string, row: CacheRow): CacheGroup {
  return { key, ...row };
}

/** The accumulator for `key`, created on first use. */
function bucket(map: Map<string, CacheRow>, key: string): CacheRow {
  let row = map.get(key);
  if (!row) {
    row = emptyRow();
    map.set(key, row);
  }
  return row;
}

export type BuildCacheReportOptions = {
  range: string;
  entries: LogEntry[];
  /** Masked key -> harness id. Unknown keys are reported as "unknown". */
  agentByKey: Record<string, string>;
  /** Model id -> prices. Missing models fall back to the observed mix. */
  prices?: Record<string, ModelPrice>;
};

export function buildCacheReport(options: BuildCacheReportOptions): CacheReport {
  const totals = emptyRow();
  const agents = new Map<string, CacheRow>();
  const models = new Map<string, CacheRow>();
  const keys = new Map<string, CacheRow>();
  const perModelCost = new Map<string, { uncached: number; cached: number; output: number }>();
  let unattributed = 0;

  for (const entry of options.entries) {
    addRow(totals, entry);

    const agent = options.agentByKey[entry.api_key] ?? "unknown";
    if (agent === "unknown") unattributed += 1;

    addRow(bucket(agents, agent), entry);
    addRow(bucket(models, entry.model), entry);
    addRow(bucket(keys, entry.api_key), entry);

    // Price each request's tokens at its own model's catalog rates.
    const price = options.prices?.[entry.model];
    if (!price) continue;
    const bucketCost = perModelCost.get(entry.model) ?? { uncached: 0, cached: 0, output: 0 };
    // `input_tokens` INCLUDES `cached_tokens` (verified against the Gateway's
    // own cost arithmetic), so the uncached part is the difference.
    bucketCost.uncached += ((entry.input_tokens ?? 0) - (entry.cached_tokens ?? 0)) / 1e6;
    bucketCost.cached += (entry.cached_tokens ?? 0) / 1e6;
    bucketCost.output += (entry.output_tokens ?? 0) / 1e6;
    perModelCost.set(entry.model, bucketCost);
  }

  // `input_tokens` INCLUDES `cached_tokens`, so the prompt total is just
  // `input_tokens` — adding them would double-count the cached portion.
  const promptTokens = totals.inputTokens;
  const hitRatio = promptTokens > 0 ? totals.cachedTokens / promptTokens : 0;

  // What the same traffic would cost with no cache: every prompt token at
  // the full input rate instead of the cache-read rate, plus the output at
  // the output rate. Models with no catalog price contribute nothing — an
  // unknown price is not a guess.
  let costIfUncached = 0;
  for (const [model, { uncached, cached, output }] of perModelCost) {
    const price = options.prices?.[model];
    if (!price) continue;
    costIfUncached += (uncached + cached) * price.inputPer1m + output * price.outputPer1m;
  }

  const sorted = (map: Map<string, CacheRow>): CacheGroup[] =>
    [...map.entries()]
      .map(([key, row]) => toGroup(key, row))
      .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);

  return {
    range: options.range,
    totals,
    hitRatio,
    costIfUncached,
    savedUsd: costIfUncached - totals.costUsd,
    byAgent: sorted(agents),
    byModel: sorted(models),
    byKey: sorted(keys),
    unattributedRequests: unattributed,
  };
}

/**
 * A per-group verdict, in the same spirit as CacheLane's harness health
 * check: enough traffic to judge, then the hit ratio decides.
 */
export function cacheVerdict(group: CacheGroup): "good" | "warn" | "bad" {
  if (group.requests < 5) return "warn";
  // `input_tokens` includes `cached_tokens`.
  const hitRatio = group.inputTokens > 0 ? group.cachedTokens / group.inputTokens : 0;
  if (hitRatio < 0.2) return "bad";
  if (hitRatio < 0.5) return "warn";
  return "good";
}
