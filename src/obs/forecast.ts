import { agentForMaskedKey } from "../api/agent-keys.js";
import { CliError } from "../cli/errors.js";
import { createdSince, createdUntilExcl, openStore, storePath } from "../store/index.js";
import { HOUR_MS } from "../time.js";
import {
  loadBudget,
  type PacingVerdict,
  pacingLine,
  warnSuppressed,
  warnThresholdLine,
} from "./budget.js";
import { estimated, gatewayBilled, heuristic, type Labeled, labeled } from "./provenance.js";

/**
 * Burn-rate forecast v1 + pacing (feature catalog E1/E4, ticket #74).
 *
 * The v1 algorithm is CC-Usage-Monitor's `BurnRateCalculator`, adapted to
 * request rows instead of usage blocks:
 *
 *   rate          = spend per hour over a trailing window, with PROPORTIONAL
 *                   OVERLAP ATTRIBUTION: a request whose execution spans the
 *                   window start (its cost is attributed to the interval
 *                   [created_at, created_at + latency_ms]) contributes its
 *                   cost × (overlap / duration) — a request half inside the
 *                   window counts half. A request with no latency is a point
 *                   event: fully in or fully out.
 *   projected     = current_month_spend + headline_rate × hours_remaining
 *   headline rate = the trailing-24h rate when it has ≥ 2 hours of data in
 *                   the window, else the trailing-7d rate when it has ≥ 3
 *                   days of data, else indeterminate — a rate is NEVER
 *                   fabricated from thin data.
 *   exceed date   = the first date cumulative spend crosses the budget at
 *                   the headline rate: now + (budget − current) / rate.
 *
 * The P90 auto-budget (`--suggest-budget`, CC-Monitor's p90_calculator) is
 * the nearest-rank 90th percentile of COMPLETED prior calendar months' totals
 * from the store; fewer than two completed windows refuses with a clear
 * message instead of guessing.
 *
 * All time math is UTC on the gateway's `created_at` (the store has no
 * local-time convention; `--timezone` handling does not exist yet — when one
 * lands, month windows move with it).
 *
 * Provenance (#68 discipline, applied at construction): current spend is
 * `gateway-billed` (a sum of gateway-computed cost); every projection is
 * `heuristic("burn-rate v1")` — extrapolation, not measurement; the P90
 * suggestion is `heuristic("P90 of monthly totals")`.
 */

/** Hours of in-window data a trailing window needs before its rate is trusted. */
export const MIN_24H_SPAN_HOURS = 2;
/** Days of in-window data the 7d rate needs before it is used as the fallback. */
export const MIN_7D_SPAN_DAYS = 3;

export const RATE_PROVENANCE = heuristic("burn-rate v1");
const P90_PROVENANCE = heuristic("P90 of monthly totals");
const SPEND_PROVENANCE = gatewayBilled("sum of gateway-computed per-request cost from the store");

/** The verbatim store columns the forecast math reads. */
export type ForecastRow = {
  id: string;
  api_key: string | null;
  endpoint?: string | null;
  created_at: string;
  latency_ms: number | null;
  cost: string | null;
  cost_value?: number | null;
  currency: string | null;
};

export type RateResult =
  | { ok: true; value: Labeled<number>; spanHours: number }
  | { ok: false; reason: "insufficient-data"; spanHours: number };

/**
 * Spend inside [windowStart, windowEnd) with proportional overlap
 * attribution: a request spanning a boundary contributes cost ×
 * (overlap / latency). Pure and deterministic — the core of the v1 math and
 * the piece unit tests pin. Rows with an unparsable cost contribute 0.
 */
export function attributedSpend(
  rows: readonly ForecastRow[],
  windowStartMs: number,
  windowEndMs: number,
): number {
  let total = 0;
  for (const row of rows) {
    const cost = costOf(row);
    if (cost === null) continue;
    const at = Date.parse(row.created_at);
    if (Number.isNaN(at)) continue;
    const latency = row.latency_ms !== null && row.latency_ms > 0 ? row.latency_ms : 0;
    if (latency === 0) {
      if (at >= windowStartMs && at < windowEndMs) total += cost;
      continue;
    }
    const start = Math.max(at, windowStartMs);
    const end = Math.min(at + latency, windowEndMs);
    if (end <= start) continue;
    total += cost * ((end - start) / latency);
  }
  return total;
}

/**
 * The earliest in-window data point (ms), for the min-span indeterminate
 * rule: how much of the trailing window actually has data behind it.
 */
function earliestInWindow(
  rows: readonly ForecastRow[],
  windowStartMs: number,
  windowEndMs: number,
): number | null {
  let earliest: number | null = null;
  for (const row of rows) {
    if (costOf(row) === null) continue;
    const at = Date.parse(row.created_at);
    if (Number.isNaN(at)) continue;
    // Same membership rule as attributedSpend: a latency-less point row
    // entirely before the window contributes no data (and no span); a
    // latency-bearing one counts from its overlap start, clipped in.
    const latency = row.latency_ms !== null && row.latency_ms > 0 ? row.latency_ms : 0;
    if (latency === 0 && at < windowStartMs) continue;
    const effective = Math.max(at, windowStartMs);
    if (effective >= windowEndMs) continue;
    if (earliest === null || effective < earliest) earliest = effective;
  }
  return earliest;
}

function costOf(row: ForecastRow): number | null {
  if (typeof row.cost_value === "number" && Number.isFinite(row.cost_value)) return row.cost_value;
  if (row.cost === null) return null;
  const parsed = Number(row.cost);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Spend-per-hour over a trailing window ending at `nowMs`. `minSpanMs` is the
 * indeterminate floor: fewer than that much data inside the window → no rate.
 * The rate divides the attributed spend by the FULL window length (hours),
 * the CC-Monitor convention (totals / block duration), so a sparse window
 * reads low rather than inventing an instant rate.
 */
export function burnRate(
  rows: readonly ForecastRow[],
  windowMs: number,
  nowMs: number,
  minSpanMs: number,
): RateResult {
  const start = nowMs - windowMs;
  const earliest = earliestInWindow(rows, start, nowMs);
  const spanHours =
    earliest === null ? 0 : Math.max(0, (nowMs - Math.max(earliest, start)) / HOUR_MS);
  if (earliest === null || nowMs - Math.max(earliest, start) < minSpanMs) {
    return { ok: false, reason: "insufficient-data", spanHours };
  }
  const spend = attributedSpend(rows, start, nowMs);
  const hours = windowMs / HOUR_MS;
  return { ok: true, value: labeled(spend / hours, RATE_PROVENANCE), spanHours };
}

/** UTC calendar month containing `at`, as [startMs, endMs). */
export function monthWindow(at: Date): { startMs: number; endMs: number } {
  const startMs = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  const endMs = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return { startMs, endMs };
}

/** The projected-exceed date, YYYY-MM-DD UTC, given the headline rate. */
export function exceedDate(
  currentSpend: number,
  budget: number,
  ratePerHour: number,
  nowMs: number,
): string | null {
  if (currentSpend >= budget) return new Date(nowMs).toISOString().slice(0, 10);
  if (ratePerHour <= 0) return null;
  const hours = (budget - currentSpend) / ratePerHour;
  return new Date(nowMs + hours * HOUR_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The full projection
// ---------------------------------------------------------------------------

export type ForecastInput = {
  /** Store rows covering the current month and the trailing 7d. */
  rows: readonly ForecastRow[];
  /** Overrides `Date.now()` — tests pin time. */
  now?: Date;
  /** The budget in effect (monthly, or the per-harness override). Null → no-budget verdict. */
  budget: number | null;
  /** Budget currency for symbol rendering in the pacing line. */
  currency?: string | null;
};

export type ForecastResult = {
  verdict: PacingVerdict;
  /** Human pacing line per the ticket copy, null for non-pace states. */
  pacing: string | null;
  currency: string | null;
  window: { start: string; end: string; hoursRemaining: number };
  /** Labeled month-to-date spend. */
  currentSpend: Labeled<number>;
  rate24h: RateResult;
  rate7d: RateResult;
  /** The rate the projection used (24h preferred, 7d fallback). */
  headlineRate: RateResult;
  /** `heuristic` projection: current + rate × hours remaining. Null when indeterminate. */
  projectedMonthEnd: Labeled<number> | null;
  /** First date cumulative spend crosses the budget at the headline rate. */
  exceedDate: string | null;
  budget: number | null;
  budgetRemaining: number | null;
};

/**
 * The v1 projection. Never throws for data reasons — thin or absent data
 * degrades to `indeterminate` / `no-data` verdicts; only a bad clock input
 * is a programming error.
 */
export function forecast(input: ForecastInput): ForecastResult {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const { startMs, endMs } = monthWindow(now);
  const rows = input.rows;

  const currentSpendValue = attributedSpend(rows, startMs, endMs);
  const rate24h = burnRate(rows, 24 * HOUR_MS, nowMs, MIN_24H_SPAN_HOURS * HOUR_MS);
  const rate7d = burnRate(rows, 7 * 24 * HOUR_MS, nowMs, MIN_7D_SPAN_DAYS * 24 * HOUR_MS);

  // Headline: 24h preferred; the 7d rate is the fallback when the last day
  // is too thin but at least 3 days of data exist.
  const headlineRate: RateResult = rate24h.ok ? rate24h : rate7d;

  const hoursRemaining = (endMs - nowMs) / HOUR_MS;
  const hasAnyCost = rows.some((row) => costOf(row) !== null);

  let verdict: PacingVerdict;
  if (!hasAnyCost) verdict = "no-data";
  else if (input.budget === null) verdict = "no-budget";
  else if (!headlineRate.ok) verdict = "indeterminate";
  else
    verdict =
      currentSpendValue + headlineRate.value.value * hoursRemaining <= input.budget
        ? "on-pace"
        : "exceeding";

  const projected =
    headlineRate.ok && hasAnyCost
      ? labeled(
          currentSpendValue + headlineRate.value.value * hoursRemaining,
          estimated("current month spend + burn-rate v1 × hours remaining"),
        )
      : null;

  // The exceed date only exists when the projection crosses the budget at
  // the headline rate — on pace means there is no crossing to name.
  const exceed =
    input.budget !== null && verdict === "exceeding" && headlineRate.ok
      ? exceedDate(currentSpendValue, input.budget, headlineRate.value.value, nowMs)
      : null;

  return {
    verdict,
    pacing:
      input.budget === null
        ? null
        : pacingLine(verdict, {
            projected: projected?.value,
            exceedDate: exceed,
            budget: input.budget,
            currency: input.currency,
          }),
    currency: input.currency ?? null,
    window: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      hoursRemaining,
    },
    currentSpend: labeled(currentSpendValue, SPEND_PROVENANCE),
    rate24h,
    rate7d,
    headlineRate,
    projectedMonthEnd: projected,
    exceedDate: exceed,
    budget: input.budget,
    budgetRemaining: input.budget === null ? null : input.budget - currentSpendValue,
  };
}

// ---------------------------------------------------------------------------
// P90 auto-budget (CC-Monitor p90_calculator)
// ---------------------------------------------------------------------------

/**
 * Nearest-rank P90 of a sample: ascending sort, index ceil(0.9·n) − 1.
 * Returns null for an empty sample.
 */
export function p90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(0.9 * sorted.length) - 1);
  return sorted[index] ?? null;
}

/** A completed prior month's spend total, as `--suggest-budget` consumes it. */
export type MonthTotal = { month: string; spend: number };

/** The minimum number of completed monthly windows a P90 suggestion requires. */
export const MIN_COMPLETED_WINDOWS = 2;

/**
 * Pure P90 over month totals: refuses below two completed windows (the
 * caller renders the ticket's exact refusal copy from the count).
 */
export function suggestBudget(monthTotals: readonly MonthTotal[]):
  | {
      ok: true;
      value: Labeled<number>;
    }
  | { ok: false; reason: "insufficient-history"; windows: number } {
  if (monthTotals.length < MIN_COMPLETED_WINDOWS) {
    return { ok: false, reason: "insufficient-history", windows: monthTotals.length };
  }
  const value = p90(monthTotals.map((m) => m.spend));
  if (value === null) {
    return { ok: false, reason: "insufficient-history", windows: monthTotals.length };
  }
  return { ok: true, value: labeled(value, P90_PROVENANCE) };
}

// ---------------------------------------------------------------------------
// Store access
// ---------------------------------------------------------------------------

type StoreDb = {
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
  close: () => void;
};

/**
 * The store rows a projection needs: everything since the later of the month
 * start and the trailing-7d start (the 7d window can reach back before the
 * month boundary early in a month). `harness` scopes rows to one harness's
 * masked keys via the agent-key map — the same attribution the sessions
 * report uses; rows whose key maps elsewhere are excluded, not guessed.
 * Fail-open: no store (or unusable node:sqlite) → empty rows, verdict
 * `no-data` downstream. A mixed-currency row set is an explicit error, never
 * a guess (doctor-style verdict copy).
 */
export function readForecastRows(options: { now?: Date; harness?: string } = {}): {
  rows: ForecastRow[];
  currency: string | null;
} {
  const opened = openStore(storePath()) as
    | { ok: true; db: StoreDb; status: string }
    | { ok: false; reason: string };
  if (!opened.ok) return { rows: [], currency: null };
  const db = opened.db;

  try {
    const now = options.now ?? new Date();
    const { startMs } = monthWindow(now);
    const since = new Date(Math.min(startMs, now.getTime() - 7 * 24 * HOUR_MS)).toISOString();

    const rows = db
      .prepare(
        "SELECT id, api_key, endpoint, created_at, latency_ms, cost, cost_value, currency FROM requests " +
          `WHERE ${createdSince()} ORDER BY created_at, id`,
      )
      .all(since) as unknown as ForecastRow[];

    if (options.harness !== undefined) {
      const keys = new Set(
        rows
          .filter((row) => agentForMaskedKey(row.api_key ?? "", row.endpoint) === options.harness)
          .map((row) => row.api_key ?? ""),
      );
      const scoped = rows.filter((row) => keys.has(row.api_key ?? ""));
      return { rows: scoped, currency: distinctCurrency(scoped) };
    }

    return { rows, currency: distinctCurrency(rows) };
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

/**
 * The single currency across cost rows, or null when none is known. Two
 * different currencies is a hard, explicit error — summing them would be a
 * guess, so the verdict names them and points at doctor.
 */
function distinctCurrency(rows: readonly ForecastRow[]): string | null {
  const currencies = new Set<string>();
  for (const row of rows) {
    if (row.currency) currencies.add(row.currency);
  }
  if (currencies.size > 1) {
    throw new CliError(
      `Mixed currencies in the local store: ${[...currencies].sort().join(", ")}.`,
      {
        hint:
          "Budgets and forecasts refuse to sum across currencies — run `aiand doctor` and " +
          "check which gateway/base URL wrote these rows.",
      },
    );
  }
  return currencies.values().next().value ?? null;
}

/** Completed prior months' totals from the store (for --suggest-budget). */
export function readMonthTotals(now?: Date): MonthTotal[] {
  const opened = openStore(storePath()) as
    | { ok: true; db: StoreDb }
    | { ok: false; reason: string };
  if (!opened.ok) return [];
  const db = opened.db;

  try {
    const current = (now ?? new Date()).toISOString().slice(0, 7);
    const rows = db
      .prepare(
        "SELECT substr(created_at, 1, 7) AS ym, SUM(COALESCE(cost_value, 0)) AS spend, " +
          `COUNT(DISTINCT currency) AS currencies FROM requests WHERE ${createdUntilExcl()} ` +
          "GROUP BY ym ORDER BY ym",
      )
      .all(`${current}-01`) as unknown as { ym: string; spend: number; currencies: number }[];

    const totals: MonthTotal[] = [];
    for (const row of rows) {
      if (row.currencies > 1) {
        throw new CliError(
          `Mixed currencies in the local store for ${row.ym} — refusing to suggest a budget.`,
          { hint: "Run `aiand doctor` and check which gateway wrote these rows." },
        );
      }
      totals.push({ month: row.ym, spend: Number(row.spend) || 0 });
    }
    return totals;
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------
// The shared 80% warning for every cost-showing command
// ---------------------------------------------------------------------------

/**
 * The budget-threshold warning line (or null) for `aiand usage` / `cache` /
 * `logs` / `forecast`, computed from the LOCAL store's current-month spend —
 * one honest basis for all commands, offline, fail-open. Suppressed by
 * --no-warn / AIAND_NO_WARN=1. A mixed-currency store throws from
 * readForecastRows; as a warning side-channel it degrades to silence here —
 * the forecast command surfaces that verdict loudly where it belongs.
 */
export function storeBudgetWarning(noWarnFlag?: boolean): string | null {
  if (warnSuppressed(noWarnFlag)) return null;
  try {
    const budget = loadBudget();
    if (budget.monthly === null) return null;
    const { rows, currency } = readForecastRows();
    const window = monthWindow(new Date());
    const spend = attributedSpend(rows, window.startMs, window.endMs);
    return warnThresholdLine(spend, budget.monthly, budget.warnPct, currency ?? budget.currency);
  } catch {
    return null;
  }
}

/**
 * The billing currency across ALL store cost rows (null when none is known),
 * for `config set budget.*` to record alongside the budget. Mixed currencies
 * are an explicit error — a budget cannot be set against an ambiguous store.
 */
export function storeCurrency(): string | null {
  const opened = openStore(storePath()) as
    | { ok: true; db: StoreDb }
    | { ok: false; reason: string };
  if (!opened.ok) return null;
  const db = opened.db;
  try {
    const rows = db
      .prepare("SELECT DISTINCT currency FROM requests WHERE currency IS NOT NULL")
      .all() as unknown as { currency: string }[];
    const currencies = rows.map((row) => row.currency);
    if (currencies.length > 1) {
      throw new CliError(`Mixed currencies in the local store: ${currencies.sort().join(", ")}.`, {
        hint:
          "A budget must be in one currency — run `aiand doctor` and check which " +
          "gateway/base URL wrote these rows.",
      });
    }
    return currencies[0] ?? null;
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

/**
 * The pacing summary the statusline (OBS-P2-1) and the `status` / `usage`
 * footers consume: verdict + ticket pacing copy from the local store against
 * `budget.monthly`, fail-open — null whenever there is no budget, no store,
 * or no data, never a fabricated verdict. (Per-harness verdicts go through
 * `forecast()` directly with `budget.harness.<name>`.)
 */
export function storePacingSummary(options: { now?: Date } | undefined = undefined): {
  verdict: PacingVerdict;
  pacing: string | null;
  currency: string | null;
} | null {
  try {
    const budget = loadBudget();
    if (budget.monthly === null) return null;
    const { rows, currency } = readForecastRows(options ? { now: options.now } : {});
    const result = forecast({
      rows,
      now: options?.now,
      budget: budget.monthly,
      currency: currency ?? budget.currency,
    });
    return { verdict: result.verdict, pacing: result.pacing, currency: result.currency };
  } catch {
    return null;
  }
}
