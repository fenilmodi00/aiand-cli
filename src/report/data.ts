import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentForMaskedKey } from "../api/agent-keys.js";
import { type CacheGroup, cacheVerdict } from "../api/cache-report.js";
import { CliError } from "../cli/errors.js";
import { isValidTimezone, parseLast, parseSince, parseUntil } from "../commands/usage-report.js";
import { configDir } from "../config.js";
import { loadBudget, type PacingVerdict } from "../obs/budget.js";
import { forecast } from "../obs/forecast.js";
import { estimated, formatLabel, gatewayBilled, heuristic } from "../obs/provenance.js";
import { computeCoverage, rangeDurationMs, type SyncOutcome } from "../store/coverage.js";
import { openStore, storePath } from "../store/index.js";
import {
  type SessionizationMeta,
  type SessionRequestRow,
  type SessionRow,
  sessionGapMinutes,
  sessionizationAnnotation,
  sessionize,
} from "../store/sessions.js";

/**
 * The data engine behind `aiand report` (F1, ticket #76) and
 * `aiand overview` (F3): ONE store load feeds every section (feature
 * catalog Appendix §6 pattern 1, CacheLane's single query pass).
 *
 * Honesty rules carried over from #60/#66/#68/#74:
 *   - cost is the gateway-verbatim per-request sum, kept PER CURRENCY and
 *     never summed across currencies;
 *   - savings and hit-ratio are `estimated(...)`, built only from the cached
 *     model catalog (model-catalog.json) — no network, no guessing;
 *   - sessions come from the #66 time-gap sessionizer, annotated as
 *     `heuristic`;
 *   - budget pacing reuses the #74 burn-rate v1 over the SAME loaded rows.
 */

export const REPORT_SECTIONS = ["timeseries", "matrix", "sessions", "budget"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export const OVERVIEW_SECTIONS = [
  "totals",
  "by-harness",
  "models",
  "busiest",
  "daily",
  "budget",
] as const;
export type OverviewSection = (typeof OVERVIEW_SECTIONS)[number];

/** The top-5 list lengths the overview prints. */
export const OVERVIEW_TOP_N = 5;
/** Most expensive sessions the HTML report shows by default. */
export const DEFAULT_TOP_SESSIONS = 20;
/** The per-day table on the overview shows at most this many recent days. */
export const OVERVIEW_DAY_ROWS = 14;

type ReportRow = {
  id: string;
  model: string;
  api_key: string | null;
  created_at: string;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost_value: number | null;
  currency: string | null;
};

/** Currency map key for rows with no `currency` (never a real code). */
const UNKNOWN_CURRENCY = "";

export type Costs = Record<string, number>;

type Mix = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costs: Costs;
};

export type DayBucket = Mix & {
  /** `YYYY-MM-DD` in the display timezone. */
  day: string;
  savings: number | null;
};

type HarnessShare = {
  harness: string;
  requests: number;
  costs: Costs;
  /** Share of total cost in the dominant currency (null when no cost data). */
  share: number | null;
  savings: number | null;
};

type MatrixRow = {
  harness: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costs: Costs;
  /** `estimated(cached_tokens / input_tokens)` — null with no tokens. */
  hitRatio: number | null;
  savings: number | null;
  verdict: "good" | "warn" | "bad";
};

type BudgetBlock =
  | { configured: false }
  | { configured: true; error: string }
  | {
      configured: true;
      verdict: PacingVerdict;
      currentSpend: number;
      projected: number | null;
      exceedDate: string | null;
      budget: number;
      currency: string | null;
      pacing: string | null;
    };

export type SeriesPoint = { day: string; value: number | null };

export type HarnessSeries = {
  harness: string;
  currency: string;
  points: SeriesPoint[];
};

export type ReportData = {
  meta: {
    generatedAt: string;
    timezone: string;
    range: { since: string | null; until: string | null };
    currencyHandling: "single" | "mixed" | "none";
    currency: string | null;
    rowCount: number;
    /** The #68 labels for the derived fields both surfaces print. */
    provenance: Record<string, string>;
    sync: { status: string; at: string | null; error?: string };
    lagSeconds: number | null;
    missingDays: string[];
    sessionization: SessionizationMeta | null;
    /** Why the matrix uses the cache-report grouping columns (#64 pending). */
    matrixNote: string;
    /** Present when savings could not be computed (no cached catalog). */
    savingsNote: string | null;
  };
  totals: Mix & { savings: number | null };
  byHarness: HarnessShare[];
  days: DayBucket[];
  harnessDays: { harness: string; day: string; costs: Costs; savings: number | null }[];
  topModels: (Mix & { key: string; savings: number | null })[];
  matrix: MatrixRow[];
  sessions: SessionRow[];
  budget: BudgetBlock;
};

export type LoadFn = (window: { sinceMs: number | null; untilMs: number | null }) => ReportRow[];

// ---------------------------------------------------------------------------
// Store read — the ONE loader every section shares
// ---------------------------------------------------------------------------

function storeLoad(window: { sinceMs: number | null; untilMs: number | null }): ReportRow[] {
  const opened = openStore(storePath());
  if (!opened.ok) return [];
  const db = opened.db;
  try {
    const conditions: string[] = [];
    const args: (string | number)[] = [];
    if (window.sinceMs !== null) {
      conditions.push("created_at >= ?");
      args.push(new Date(window.sinceMs).toISOString());
    }
    if (window.untilMs !== null) {
      conditions.push("created_at <= ?");
      args.push(new Date(window.untilMs).toISOString());
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(
        "SELECT id, model, api_key, created_at, latency_ms, input_tokens, output_tokens, " +
          "cached_tokens, cost_value, currency FROM requests" +
          where +
          " ORDER BY created_at, id",
      )
      .all(...args);
    return rows as unknown as ReportRow[];
  } catch {
    // A store that cannot answer (locked, mid-migration elsewhere) serves an
    // empty report — observability fails open, the CLI keeps working.
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export type WindowSpec = {
  since?: string;
  until?: string;
  last?: string;
  /** `--range`, a LOG_RANGES-style window (`24h`, `7days`, …). */
  range?: string;
};

/**
 * The resolved UTC window: explicit `--since/--until`, `--last <n><unit>`,
 * and/or `--range <LOG_RANGES value>`; the default is the trailing 30 days
 * the gateway serves. Bare dates are timezone walls (the #60 convention).
 */
export function resolveWindow(
  spec: WindowSpec,
  timezone: string,
  now: Date,
): { sinceMs: number | null; untilMs: number | null } {
  const sinceMs = spec.since === undefined ? null : parseSince(spec.since, timezone);
  const untilMs = spec.until === undefined ? null : parseUntil(spec.until, timezone);
  const lastMs = spec.last === undefined ? null : parseLast(spec.last, now).sinceMs;
  const rangeMs = spec.range === undefined ? null : now.getTime() - rangeDurationMs(spec.range);
  const candidates = [sinceMs, lastMs, rangeMs].filter((v): v is number => v !== null);
  return {
    sinceMs: candidates.length === 0 ? now.getTime() - 30 * 86_400_000 : Math.min(...candidates),
    untilMs,
  };
}

export function assertTimezone(timezone: string): void {
  if (!isValidTimezone(timezone)) {
    throw new CliError(`Invalid --timezone value: ${timezone}.`, {
      hint: "Use an IANA timezone, e.g. America/New_York or Europe/Berlin.",
    });
  }
}

/**
 * A `--sections` comma list validated against a command's registry; null
 * when the flag is absent (the caller applies its own default).
 */
export function parseSectionList<T extends string>(
  raw: string | undefined,
  registry: readonly T[],
): T[] | null {
  if (raw === undefined) return null;
  const names = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  for (const name of names) {
    if (!(registry as readonly string[]).includes(name)) {
      throw new CliError(`Invalid --sections entry: ${name}.`, {
        hint: `Choose from: ${registry.join(", ")}.`,
      });
    }
  }
  return names as T[];
}

/**
 * The #68 sync warning for a report whose pre-command sync failed or was
 * skipped, or null when the local data is synced.
 */
export function syncWarningFor(sync: {
  status: string;
  at: string | null;
  error?: string;
}): string | null {
  if (sync.status === "failed") {
    return `sync failed${sync.error ? ` (${sync.error})` : ""} — showing local data only; it may be stale`;
  }
  if (sync.status === "skipped") {
    return "sync skipped (--no-sync) — showing local data as-is";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function harnessOf(row: Pick<ReportRow, "api_key">): string {
  return row.api_key === null ? "unknown" : (agentForMaskedKey(row.api_key) ?? "unknown");
}

// ---------------------------------------------------------------------------
// The cached-catalog price table (offline — never fetched here)
// ---------------------------------------------------------------------------

type Price = {
  inputPer1m: number;
  cachedPer1m: number;
  outputPer1m: number;
  currency: string;
};

/**
 * Prices from the 6h catalog cache (<configDir>/model-catalog.json), the
 * same file `getCatalog` writes. Read-only, never fetched: a report must
 * work with networking disabled, so a missing or broken cache means savings
 * are absent, not guessed.
 */
function readCachedPrices(): Record<string, Price> | null {
  try {
    const raw = readFileSync(join(configDir(), "model-catalog.json"), "utf8");
    const parsed = JSON.parse(raw) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return null;
    const prices: Record<string, Price> = {};
    for (const model of parsed.models) {
      const entry = model as Record<string, unknown>;
      if (typeof entry.id !== "string") continue;
      const input = Number(entry.input_per_1m);
      const output = Number(entry.output_per_1m);
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      prices[entry.id] = {
        inputPer1m: input,
        cachedPer1m: Number(entry.cached_input_per_1m ?? 0) || 0,
        outputPer1m: output,
        currency: typeof entry.currency === "string" ? entry.currency : "usd",
      };
    }
    return Object.keys(prices).length > 0 ? prices : null;
  } catch {
    return null;
  }
}

/**
 * `costIfUncached − gateway cost` over a per-model token mix, in the
 * cache-report convention: every prompt token at the full input rate plus
 * output at the output rate; unpriced (or currency-mismatched) models
 * contribute nothing — an unknown price is not a guess. Null when the mix
 * has no single known currency, or no cached catalog exists.
 */
function savingsOf(
  perModel: readonly {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  }[],
  costs: Costs,
  prices: Record<string, Price> | null,
): number | null {
  if (prices === null) return null;
  const currencies = Object.keys(costs).filter((c) => c !== "");
  if (currencies.length !== 1 || costs[""] !== undefined) return null;
  const currency = currencies[0]!;
  let costIfUncached = 0;
  for (const entry of perModel) {
    const price = prices[entry.model];
    if (!price || price.currency !== currency) continue;
    // `input_tokens` INCLUDES `cached_tokens`; the uncached prompt is the
    // non-cached remainder and the cache read is priced at the cached rate.
    const uncached = entry.inputTokens - entry.cachedTokens;
    costIfUncached +=
      (uncached * price.inputPer1m + entry.cachedTokens * price.cachedPer1m) / 1e6 +
      (entry.outputTokens * price.outputPer1m) / 1e6;
  }
  return costIfUncached - (costs[currency] ?? 0);
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

const emptyMix = (): Mix => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costs: {},
});

/** A grouping plus the per-model detail its savings computation needs. */
type Group = { mix: Mix; models: Map<string, Mix> };

const emptyGroup = (): Group => ({ mix: emptyMix(), models: new Map() });

function accMix(mix: Mix, row: ReportRow): void {
  mix.requests += 1;
  mix.inputTokens += row.input_tokens ?? 0;
  mix.outputTokens += row.output_tokens ?? 0;
  mix.cachedTokens += row.cached_tokens ?? 0;
  if (row.cost_value !== null) {
    const currency = row.currency ?? UNKNOWN_CURRENCY;
    mix.costs[currency] = (mix.costs[currency] ?? 0) + row.cost_value;
  }
}

function accGroup(group: Group, row: ReportRow): void {
  accMix(group.mix, row);
  const perModel = group.models.get(row.model) ?? emptyMix();
  accMix(perModel, row);
  group.models.set(row.model, perModel);
}

function groupSavings(group: Group, prices: Record<string, Price> | null): number | null {
  return savingsOf(
    [...group.models.entries()].map(([model, mix]) => ({
      model,
      inputTokens: mix.inputTokens,
      outputTokens: mix.outputTokens,
      cachedTokens: mix.cachedTokens,
    })),
    group.mix.costs,
    prices,
  );
}

/** The currency carrying the largest total — the ranking/share basis. */
function dominantCurrency(costs: Costs): string | null {
  let best: string | null = null;
  let bestValue = 0;
  for (const [currency, value] of Object.entries(costs)) {
    if (value > bestValue) {
      best = currency;
      bestValue = value;
    }
  }
  return best;
}

function sortedCosts(costs: Costs): Costs {
  return Object.fromEntries(Object.entries(costs).sort(([a], [b]) => a.localeCompare(b)));
}

const MATRIX_NOTE =
  "Matrix mirrors the cache-report grouping columns (harness × model); " +
  "the OBS-P2-4 harness-stats columns (ttft p50/p95, error rate) land with #64.";

// ---------------------------------------------------------------------------
// One load, every section
// ---------------------------------------------------------------------------

export type BuildDataOptions = {
  timezone: string;
  sinceMs: number | null;
  untilMs: number | null;
  harnesses: string[];
  models: string[];
  sections: readonly (ReportSection | OverviewSection)[];
  top: number;
  sync: SyncOutcome | null;
  /** Overrides Date.now() — tests pin time. */
  now?: Date;
  /** Injected store loader (tests); defaults to the real single read. */
  load?: LoadFn;
};

/**
 * The single data pass. When the budget section is selected and a budget is
 * configured, the load window extends to cover the current month plus the
 * trailing 7 days so the #74 projection reads the SAME rows — no second
 * store pass for the pacing verdict.
 */
export function buildReportData(options: BuildDataOptions, load: LoadFn = storeLoad): ReportData {
  const now = options.now ?? new Date();
  const wants = new Set<string>(options.sections);

  // -- window (extended for the budget projection when needed) ---------------
  let sinceMs = options.sinceMs;
  if (wants.has("budget")) {
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const floor = Math.min(monthStart, now.getTime() - 7 * 86_400_000);
    sinceMs = sinceMs === null ? floor : Math.min(sinceMs, floor);
  }

  const rows = filterRows(load({ sinceMs, untilMs: options.untilMs }), options);
  const prices = readCachedPrices();

  // -- the one accumulation walk --------------------------------------------
  const totals = emptyGroup();
  const byDay = new Map<string, Group>();
  const byDayHarness = new Map<string, Group>(); // key `${day}\u0000${harness}`
  const byHarness = new Map<string, Group>();
  const byHarnessModel = new Map<string, Group>(); // key `${harness}\u0000${model}`
  const byModel = new Map<string, Group>();
  const currencies = new Set<string>();
  let hasUnknownCurrencyCost = false;

  for (const row of rows) {
    const day = tzDay(Date.parse(row.created_at), options.timezone);
    const harness = harnessOf(row);
    accGroup(totals, row);
    accGroup(byDay.get(day) ?? byDay.set(day, emptyGroup()).get(day)!, row);
    const dhKey = `${day}\0${harness}`;
    accGroup(byDayHarness.get(dhKey) ?? byDayHarness.set(dhKey, emptyGroup()).get(dhKey)!, row);
    accGroup(byHarness.get(harness) ?? byHarness.set(harness, emptyGroup()).get(harness)!, row);
    const hmKey = `${harness}\0${row.model}`;
    accGroup(byHarnessModel.get(hmKey) ?? byHarnessModel.set(hmKey, emptyGroup()).get(hmKey)!, row);
    accGroup(byModel.get(row.model) ?? byModel.set(row.model, emptyGroup()).get(row.model)!, row);
    if (row.cost_value !== null) {
      if (row.currency === null) hasUnknownCurrencyCost = true;
      else currencies.add(row.currency);
    }
  }
  if (hasUnknownCurrencyCost) currencies.add(UNKNOWN_CURRENCY);

  const currencyKeys = [...currencies].sort();
  const currencyHandling =
    currencyKeys.length === 0 ? "none" : currencyKeys.length === 1 ? "single" : "mixed";
  const only = currencyKeys[0];
  const currency =
    currencyHandling === "single" && only !== undefined && only !== UNKNOWN_CURRENCY ? only : null;

  // -- sections ---------------------------------------------------------------
  const days: DayBucket[] = [...byDay.entries()]
    .map(([day, group]) => ({
      day,
      ...group.mix,
      costs: sortedCosts(group.mix.costs),
      savings: groupSavings(group, prices),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const harnessDays = [...byDayHarness.entries()]
    .map(([key, group]) => {
      const [day, harness] = key.split("\0") as [string, string];
      return {
        harness,
        day,
        costs: sortedCosts(group.mix.costs),
        savings: groupSavings(group, prices),
      };
    })
    .sort((a, b) => a.day.localeCompare(b.day) || a.harness.localeCompare(b.harness));

  const byHarnessRows: HarnessShare[] = [...byHarness.entries()]
    .map(([harness, group]) => {
      const dominant = dominantCurrency(totals.mix.costs);
      const share =
        dominant === null || currencyHandling === "none"
          ? null
          : (group.mix.costs[dominant] ?? 0) / totals.mix.costs[dominant]!;
      return {
        harness,
        requests: group.mix.requests,
        costs: sortedCosts(group.mix.costs),
        share,
        savings: groupSavings(group, prices),
      };
    })
    .sort((a, b) => b.requests - a.requests || a.harness.localeCompare(b.harness));

  const modelRank = (keyA: string, a: Group, keyB: string, b: Group): number => {
    const da = dominantCurrency(a.mix.costs);
    const db = dominantCurrency(b.mix.costs);
    const va = da === null ? 0 : (a.mix.costs[da] ?? 0);
    const vb = db === null ? 0 : (b.mix.costs[db] ?? 0);
    return vb - va || b.mix.requests - a.mix.requests || keyA.localeCompare(keyB);
  };

  const topModels = [...byModel.entries()]
    .sort(([keyA, a], [keyB, b]) => modelRank(keyA, a, keyB, b))
    .slice(0, OVERVIEW_TOP_N)
    .map(([key, group]) => ({
      key,
      ...group.mix,
      costs: sortedCosts(group.mix.costs),
      savings: groupSavings(group, prices),
    }));

  const matrix: MatrixRow[] = [...byHarnessModel.entries()]
    .map(([key, group]) => {
      const [harness, model] = key.split("\0") as [string, string];
      const hitRatio =
        group.mix.inputTokens > 0 ? group.mix.cachedTokens / group.mix.inputTokens : null;
      const verdict = cacheVerdict({
        requests: group.mix.requests,
        inputTokens: group.mix.inputTokens,
        cachedTokens: group.mix.cachedTokens,
        outputTokens: group.mix.outputTokens,
        costUsd: 0,
        misses: 0,
        key: model,
      } as unknown as CacheGroup);
      return {
        harness,
        model,
        requests: group.mix.requests,
        inputTokens: group.mix.inputTokens,
        outputTokens: group.mix.outputTokens,
        cachedTokens: group.mix.cachedTokens,
        costs: sortedCosts(group.mix.costs),
        hitRatio,
        savings: groupSavings(group, prices),
        verdict,
      };
    })
    .sort((a, b) => a.harness.localeCompare(b.harness) || a.model.localeCompare(b.model));

  // -- sessions (the #66 sessionizer, never a local reimplementation) ---------
  let sessionization: SessionizationMeta | null = null;
  let sessions: SessionRow[] = [];
  if (wants.has("sessions")) {
    const gapMinutes = sessionGapMinutes();
    sessionization = sessionizationAnnotation(gapMinutes);
    const sessionRows: SessionRequestRow[] = rows.map((row) => ({
      id: row.id,
      api_key: row.api_key,
      created_at: row.created_at,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cached_tokens: row.cached_tokens,
      cost: row.cost_value === null ? null : String(row.cost_value),
      cost_value: row.cost_value,
      currency: row.currency,
    }));
    // Ranked by cost for the "most expensive" table. Ranking order only —
    // the displayed cost stays per currency; with mixed currencies the rank
    // basis is the dominant currency of each session.
    sessions = sessionize(sessionRows, gapMinutes)
      .sort((a, b) => {
        const ca = a.cost ?? -1;
        const cb = b.cost ?? -1;
        return cb - ca || a.started_at.localeCompare(b.started_at);
      })
      .slice(0, Math.max(1, options.top));
  }

  // -- budget pacing (#74 burn-rate v1 over the SAME rows) ---------------------
  const budget = buildBudget(wants, rows, currencyKeys, currencyHandling, now);

  const coverage = computeCoverage("30days", { now, sync: options.sync ?? undefined });

  return {
    meta: {
      generatedAt: now.toISOString(),
      timezone: options.timezone,
      range: {
        since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
        until: options.untilMs === null ? null : new Date(options.untilMs).toISOString(),
      },
      currencyHandling,
      currency,
      rowCount: rows.length,
      provenance: {
        requests: formatLabel(estimated("count of gateway /logs rows in the local store")),
        cost: formatLabel(
          gatewayBilled("sum of the gateway-computed per-request cost; never recomputed"),
        ),
        savings: formatLabel(
          estimated("costIfUncached minus the gateway-billed cost; cached catalog prices"),
        ),
        hit_ratio: formatLabel(estimated("cached_tokens / input_tokens")),
        sessions: formatLabel(heuristic("time-gap sessionization")),
        budget: formatLabel(heuristic("burn-rate v1")),
      },
      sync: coverage.sync,
      lagSeconds: coverage.lagSeconds,
      missingDays: coverage.missingDays,
      sessionization,
      matrixNote: MATRIX_NOTE,
      savingsNote:
        prices === null
          ? "savings unavailable — no cached model catalog (model-catalog.json); " +
            "run any catalog-reading command once to cache it"
          : currencyHandling === "mixed" || currency === null
            ? "savings unavailable — mixed or unknown currencies; never summed across currencies"
            : null,
    },
    totals: {
      ...totals.mix,
      costs: sortedCosts(totals.mix.costs),
      savings: groupSavings(totals, prices),
    },
    byHarness: byHarnessRows,
    days,
    harnessDays,
    topModels,
    matrix,
    sessions,
    budget,
  };
}

function filterRows(rows: readonly ReportRow[], options: BuildDataOptions): ReportRow[] {
  const harnessWanted = options.harnesses.length > 0 ? new Set(options.harnesses) : null;
  const modelMatchers = options.models.map(globToRegExp);
  return rows.filter((row) => {
    if (harnessWanted && !harnessWanted.has(harnessOf(row))) return false;
    if (modelMatchers.length > 0 && !modelMatchers.some((re) => re.test(row.model))) return false;
    return true;
  });
}

function buildBudget(
  wants: Set<string>,
  rows: readonly ReportRow[],
  currencyKeys: string[],
  currencyHandling: "single" | "mixed" | "none",
  now: Date,
): BudgetBlock {
  if (!wants.has("budget")) return { configured: false };
  const { monthly, currency: budgetCurrency } = loadBudget();
  if (monthly === null) return { configured: false };
  if (currencyHandling !== "single" || currencyKeys[0] === undefined) {
    return {
      configured: true,
      error:
        "mixed or unknown currencies in range — refusing to pace a budget " +
        "across currencies; run `aiand doctor`",
    };
  }
  const currency = currencyKeys[0]!;
  const result = forecast({
    // ForecastRow reads cost_value first; the gateway `cost` string is not
    // needed because the store's parsed companion is already verbatim.
    rows: rows.map((row) => ({ ...row, cost: null })),
    now,
    budget: monthly,
    currency: budgetCurrency ?? currency,
  });
  return {
    configured: true,
    verdict: result.verdict,
    currentSpend: result.currentSpend.value,
    projected: result.projectedMonthEnd?.value ?? null,
    exceedDate: result.exceedDate,
    budget: monthly,
    currency: result.currency,
    pacing: result.pacing,
  };
}

/** The calendar date of an instant, in the display timezone. */
function tzDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** The cumulative savings series for the timeseries chart (total, per day). */
export function cumulativeSavings(days: readonly DayBucket[]): SeriesPoint[] {
  let running = 0;
  return days.map((day) => {
    if (day.savings !== null) running += day.savings;
    return { day: day.day, value: day.savings === null ? null : running };
  });
}

/** Per-harness daily cost series for the timeseries chart, one per currency. */
export function harnessCostSeries(
  harnessDays: readonly { harness: string; day: string; costs: Costs }[],
  days: readonly { day: string }[],
): HarnessSeries[] {
  const series = new Map<string, Map<string, number>>();
  for (const row of harnessDays) {
    for (const [currency, value] of Object.entries(row.costs)) {
      const key = `${row.harness}\0${currency}`;
      const perDay = series.get(key) ?? new Map<string, number>();
      perDay.set(row.day, (perDay.get(row.day) ?? 0) + value);
      series.set(key, perDay);
    }
  }
  return [...series.entries()]
    .map(([key, perDay]) => {
      const [harness, currency] = key.split("\0") as [string, string];
      return {
        harness,
        currency,
        points: days.map((day) => ({ day: day.day, value: perDay.get(day.day) ?? 0 })),
      };
    })
    .sort((a, b) => a.harness.localeCompare(b.harness) || a.currency.localeCompare(b.currency));
}
