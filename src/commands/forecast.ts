import { openSession } from "../api/client.js";
import { bool, int, oneOf, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, json, out, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import {
  budgetFor,
  loadBudget,
  type PacingVerdict,
  warnSuppressed,
  warnThresholdLine,
} from "../obs/budget.js";
import {
  type ForecastResult,
  forecast,
  type RateResult,
  readForecastRows,
  readMonthTotals,
  suggestBudget,
} from "../obs/forecast.js";
import {
  type BenchResult,
  bench,
  DEFAULT_BENCH_HORIZON_HOURS,
  DEFAULT_BENCH_WINDOWS,
  type ForecastV2Result,
  forecastV2,
  MC_DRAWS,
} from "../obs/forecast-v2.js";
import { formatLabel, type Labeled } from "../obs/provenance.js";
import {
  computeCoverage,
  rangeDurationMs,
  type SyncOutcome,
  syncWarningLine,
} from "../store/coverage.js";
import { noSyncRequested, syncStore } from "../store/index.js";

export const help = `${style.bold("aiand forecast")} -- burn-rate projection against your budget

Usage
  aiand forecast
  aiand forecast --harness claude
  aiand forecast --model v2
  aiand forecast --suggest-budget
  aiand forecast bench --model v2
  aiand forecast --json

Options
  --harness <name>    scope to one harness (uses budget.harness.<name> when set)
  --model <v1|v2>     v1 burn-rate extrapolation (default) or the calibrated
                      Gamma-process Monte Carlo v2 (80% credible interval,
                      ETA-to-budget median+CI, seeded --seed)
  --seed <n>          explicit Monte Carlo seed (v2; default: derived from the
                      forecast month, so the same window + seed reproduces
                      byte-identical output)
  --range <window>    narrow the request rows: 15m, 1h, 6h, 24h, 7days, 30days
  --since <iso>       narrow the request rows from this timestamp
  --until <iso>       narrow the request rows up to this timestamp
  --last <days>       narrow the request rows to the trailing N days
  --suggest-budget    suggest budget.monthly from the P90 of completed months
  --no-sync           skip the store sync first (also AIAND_NO_SYNC=1)
  --no-warn           suppress the budget-threshold warning (also AIAND_NO_WARN=1;
                      the escape hatch of the CodeBurn guard pattern — budgets are
                      advisory, the CLI never blocks)
  --json              machine-readable output
  --jq <path>         extract a path from the --json payload (e.g. verdict)

Model v1: projected = current month spend + spend-per-hour (the trailing 24h,
falling back to the trailing 7d when >= 3 days of data exist) x hours remaining
in the month. Model v2 (claumon MODEL.tex v2.2): OLS rate over the last 30
minutes conjugated with a prior from past completed day-windows, a rectified
Gaussian rate draw per path, Gamma-process increments over 5-minute steps,
${MC_DRAWS} seeded Monte Carlo paths -> median + 80% credible interval, uncapped
above the budget (overshoot is projected demand). ETA to budget is nil when
P(never reaching) >= 0.5. Fewer than 2 hours of data in the trailing window is
reported as indeterminate — a rate is never fabricated. Current spend is
gateway-billed (summed verbatim from the local store); every projection is
labeled. Budgets are advisory: nothing is enforced or blocked.

Subcommands
  aiand forecast bench [--model v1|v2] [--windows n] [--horizon-hours h]
      Replay past daily windows and score the forecaster: CRPS, pinball loss
      (q10/q50/q90), 80% coverage, bias, and the [delta, delta^2] calibration
      regression with a plain-language verdict. Offline from the local store;
      deterministic given the same store + seed.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    harness: { type: "string" },
    range: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    model: { type: "string" },
    seed: { type: "string" },
    "suggest-budget": { type: "boolean", default: false },
    "no-sync": { type: "boolean", default: false },
    "no-warn": { type: "boolean", default: false },
    "horizon-hours": { type: "string" },
    windows: { type: "string" },
    jq: { type: "string" },
  });
  if (bool(parsed, "help")) return out(help);

  const [subcommand] = parsed.positionals;
  if (subcommand === "bench") return benchCommand(parsed);
  if (subcommand !== undefined) {
    throw new CliError(`Unknown subcommand "${subcommand}".`, {
      hint: "Run `aiand forecast --help` to see the usage.",
    });
  }

  const budgetConfig = loadBudget();
  const harness = str(parsed, "harness");
  const model = oneOf(parsed, "model", ["v1", "v2"], "v1");
  const now = untilOrNow(parsed);

  if (bool(parsed, "suggest-budget")) return suggest(parsed, now);

  // Pre-command sync, best-effort (the cache command's convention): a failure
  // is surfaced through the coverage helpers, never silent, never fatal.
  let syncOutcome: SyncOutcome;
  if (bool(parsed, "no-sync") || noSyncRequested()) {
    syncOutcome = { skipped: true };
  } else {
    try {
      const session = await openSession(resolveProfile(str(parsed, "profile")));
      const result = await syncStore(session);
      syncOutcome = result.ok ? { ok: true } : { ok: false, error: result.error };
    } catch (error) {
      syncOutcome = {
        ok: false,
        error: error instanceof Error ? error.message : String(error ?? "sync failed"),
      };
    }
  }

  const { rows } = readForecastRows({ now, harness });
  const filteredRows = applyRowFilters(rows, parsed, now);
  const budget = budgetFor(budgetConfig, harness);

  if (model === "v2") {
    return runV2({
      parsed,
      rows: filteredRows,
      now,
      budget,
      harness,
      budgetConfig,
      syncStatus: "skipped" in syncOutcome ? "skipped" : syncOutcome.ok ? "ok" : "failed",
    });
  }

  const result = forecast({
    rows: filteredRows,
    now,
    budget,
    currency: budgetConfig.currency,
  });

  const coverage = computeCoverage("30days", { now, sync: syncOutcome });
  const warning = syncWarningLine(coverage);
  if (warning) err(style.yellow(`Warning: ${warning}`));

  if (bool(parsed, "json")) return emitJson(result, harness, parsed);

  printForecast(result, harness, coverage.sync.status);
  printBudgetWarning(result, budgetConfig.warnPct, parsed);
}

// ---------------------------------------------------------------------------
// Model v2
// ---------------------------------------------------------------------------

async function runV2(context: {
  parsed: ReturnType<typeof parse>;
  rows: ReturnType<typeof readForecastRows>["rows"];
  now: Date;
  budget: number | null;
  harness: string | undefined;
  budgetConfig: ReturnType<typeof loadBudget>;
  syncStatus: string;
}): Promise<void> {
  const { parsed, rows, now, budget, harness, budgetConfig } = context;
  const seedFlag = seedValue(parsed);
  const result = forecastV2({ rows, now, seed: seedFlag, budget });

  if (bool(parsed, "json")) return emitV2Json(result, harness, budget, parsed);

  const symbol = currencyPrefix(budgetConfig.currency);
  const money = (value: number | null): string =>
    value === null ? style.dim("-") : `${symbol}${value.toFixed(2)}`;

  out(
    style.bold(
      `Forecast (v2 calibrated Monte Carlo) · ${now.toISOString().slice(0, 10)}` +
        (harness ? ` · harness ${harness}` : ""),
    ),
  );
  out();
  const etaText =
    result.eta === null
      ? style.dim(
          result.pNever >= 0.5 ? `nil (P(never) = ${Math.round(result.pNever * 100)}%)` : "-",
        )
      : `${result.eta.medianHours.toFixed(1)}h ` +
        `(80% CI ${result.eta.lowHours.toFixed(1)}–${result.eta.highHours.toFixed(1)}h)`;
  table(
    [
      {
        label: "current spend",
        value: money(result.currentSpend),
        label2: "gateway-billed",
      },
      {
        label: "posterior rate",
        value: `${money(result.rate.value)}/h`,
        label2: formatLabel(result.rate.provenance),
      },
      {
        label: "projected month-end (median)",
        value: result.projectedMonthEnd
          ? money(result.projectedMonthEnd.value)
          : style.dim("indeterminate"),
        label2: result.projectedMonthEnd
          ? formatLabel(result.projectedMonthEnd.provenance)
          : style.dim("insufficient data"),
      },
      {
        label: "80% credible interval",
        value:
          result.ci80.low !== null && result.ci80.high !== null
            ? `${money(result.ci80.low)} – ${money(result.ci80.high)}`
            : style.dim("-"),
        label2:
          result.ci80.low !== null
            ? "uncapped above budget (projected demand)"
            : style.dim("not computed"),
      },
      {
        label: "projected utilization",
        value:
          result.projectedUtilization === null
            ? style.dim("-")
            : `${(result.projectedUtilization * 100).toFixed(0)}%`,
        label2:
          result.projectedUtilization !== null && result.projectedUtilization > 1
            ? "overshoot — uncapped"
            : "median / budget",
      },
      {
        label: "ETA to budget",
        value: etaText,
        label2: "median + 80% CI (nil when P(never) ≥ 50%)",
      },
      {
        label: "verdict",
        value: verdictCell(v2Verdict(result, budget)),
        label2: "heuristic(forecast v2 calibrated MC)",
      },
      {
        label: "budget remaining",
        value: money(budget === null ? null : budget - result.currentSpend),
        label2: budget === null ? style.dim("no budget set") : "gateway-billed",
      },
    ],
    [
      { header: "", value: (r) => style.dim(r.label) },
      { header: "", value: (r) => r.value, align: "right" },
      { header: "provenance", value: (r) => r.label2 },
    ],
  );
  out();
  out(
    style.dim(
      `${result.draws} seeded Monte Carlo paths · seed ${result.seed} · ${result.stepMinutes}-min steps · ` +
        `store sync ${context.syncStatus}`,
    ),
  );
  out(
    style.dim(
      "budgets are advisory — the CLI warns, it never blocks (suppress: --no-warn / AIAND_NO_WARN=1)",
    ),
  );

  const line = warnThresholdLine(
    result.currentSpend,
    budget ?? 0,
    budgetConfig.warnPct,
    budgetConfig.currency,
  );
  if (line && !warnSuppressed(bool(parsed, "no-warn"))) err(style.yellow(line));
}

function seedValue(parsed: ReturnType<typeof parse>): number | string | null {
  const raw = str(parsed, "seed");
  if (raw === undefined) return null;
  const num = Number(raw);
  if (raw !== "" && Number.isFinite(num)) return num >>> 0;
  return raw; // any non-numeric string is still a valid string seed
}

function v2Verdict(result: ForecastV2Result, budget: number | null): PacingVerdict {
  if (result.verdict === "insufficient-data") return "no-data";
  if (budget === null) return "no-budget";
  const median = result.projectedMonthEnd?.value;
  if (median === undefined || result.projectedMonthEnd === null) return "indeterminate";
  return median > budget ? "exceeding" : "on-pace";
}

function emitV2Json(
  result: ForecastV2Result,
  harness: string | undefined,
  budget: number | null,
  parsed: ReturnType<typeof parse>,
): void {
  const payload = {
    model: "v2",
    harness: harness ?? null,
    verdict: v2Verdict(result, budget),
    currency: null,
    current_spend: { value: result.currentSpend, provenance: "gateway-billed" },
    rate: labeledJson(result.rate),
    rate_ols: result.rateOls,
    prior_windows: result.priorWindows,
    projected_month_end: result.projectedMonthEnd ? labeledJson(result.projectedMonthEnd) : null,
    ci80: result.ci80,
    eta: result.eta,
    p_never: result.pNever,
    projected_utilization: result.projectedUtilization,
    budget,
    budget_remaining: budget === null ? null : budget - result.currentSpend,
    seed: result.seed,
    draws: result.draws,
    step_minutes: result.stepMinutes,
  };
  const jq = str(parsed, "jq");
  json(jq === undefined ? payload : jqPath(payload, jq));
}

// ---------------------------------------------------------------------------
// `forecast bench`
// ---------------------------------------------------------------------------

async function benchCommand(parsed: ReturnType<typeof parse>): Promise<void> {
  const model = oneOf(parsed, "model", ["v1", "v2"], "v2");
  const horizonHours = int(parsed, "horizon-hours") ?? DEFAULT_BENCH_HORIZON_HOURS;
  const windows = int(parsed, "windows") ?? DEFAULT_BENCH_WINDOWS;
  if (horizonHours <= 0) {
    throw new CliError(
      `--horizon-hours must be a positive number of hours (got "${horizonHours}").`,
    );
  }
  if (windows <= 0) {
    throw new CliError(`--windows must be a positive number of windows (got "${windows}").`);
  }

  // The bench runs OFFLINE from the local store by design — it scores the
  // forecaster against history the store already holds; no sync, no network.
  const now = untilOrNow(parsed);
  const { rows } = readForecastRows({ now });
  const result = bench({
    rows,
    now,
    model: model as "v1" | "v2",
    seed: seedValue(parsed),
    horizonHours,
    windows,
  });

  if (!result.ok) {
    out(`insufficient history for the bench (${result.windows} scoreable windows)`);
    return;
  }
  const scored = result.result;
  if (bool(parsed, "json")) return emitBenchJson(scored, parsed);
  printBench(scored);
}

function printBench(result: BenchResult): void {
  out(
    style.bold(
      `Forecast bench · model ${result.model} · ${result.windows.length} daily windows · ` +
        `${result.horizonHours}h horizon`,
    ),
  );
  out();
  table(
    result.windows.map((w) => ({
      anchor: w.anchor.slice(0, 10),
      actual: w.actual.toFixed(4),
      point: w.point.toFixed(4),
      ci: `${w.ciLow.toFixed(4)}–${w.ciHigh.toFixed(4)}`,
      hit: w.hit ? "✓" : "✗",
      crps: w.crps.toFixed(4),
    })),
    [
      { header: "anchor", value: (r) => r.anchor },
      { header: "actual", value: (r) => r.actual, align: "right" },
      { header: "point", value: (r) => r.point, align: "right" },
      { header: "80% CI", value: (r) => r.ci, align: "right" },
      { header: "hit", value: (r) => (r.hit ? style.green(r.hit) : style.red(r.hit)) },
      { header: "CRPS", value: (r) => r.crps, align: "right" },
    ],
  );
  out();
  table(
    [
      { metric: "CRPS", value: result.metrics.crps.toFixed(4) },
      { metric: "pinball q10", value: result.metrics.pinball10.toFixed(4) },
      { metric: "pinball q50", value: result.metrics.pinball50.toFixed(4) },
      { metric: "pinball q90", value: result.metrics.pinball90.toFixed(4) },
      { metric: "80% coverage", value: `${(result.metrics.coverage * 100).toFixed(0)}%` },
      { metric: "bias (mean signed error)", value: result.metrics.bias.toFixed(4) },
    ],
    [
      { header: "metric", value: (r) => r.metric },
      { header: "value", value: (r) => r.value, align: "right" },
    ],
  );
  out();
  out(
    `calibration regression of e² on [δ, δ²]: intercept ${result.regression.intercept.toFixed(4)}, ` +
      `δ ${result.regression.delta.toFixed(4)}, δ² ${result.regression.deltaSq.toFixed(4)}`,
  );
  out(`verdict: ${result.regression.verdict}`);
  out();
  out(
    style.dim(
      `seed ${result.seed} · ${result.model === "v2" ? `${MC_DRAWS} Monte Carlo paths` : "point forecast (no interval)"} · ` +
        `replayed offline from the local store`,
    ),
  );
}

function emitBenchJson(result: BenchResult, parsed: ReturnType<typeof parse>): void {
  const payload = {
    model: result.model,
    seed: result.seed,
    draws: result.draws,
    horizon_hours: result.horizonHours,
    metrics: result.metrics,
    regression: result.regression,
    windows: result.windows,
  };
  const jq = str(parsed, "jq");
  json(jq === undefined ? payload : jqPath(payload, jq));
}

/** `--until` also pins "now" so projections are deterministic against a window. */
function untilOrNow(parsed: ReturnType<typeof parse>): Date {
  const until = str(parsed, "until");
  if (until === undefined) return new Date();
  const ms = Date.parse(until);
  if (Number.isNaN(ms)) {
    throw new CliError(`Invalid --until value: ${until}.`, {
      hint: "Use an ISO timestamp, e.g. 2026-10-25T00:00:00Z.",
    });
  }
  return new Date(ms);
}

/** The lower bound the row-narrowing flags ask for, or null for "no narrowing". */
function filterStartMs(parsed: ReturnType<typeof parse>, now: Date): number | null {
  const since = str(parsed, "since");
  const last = int(parsed, "last");
  const range = str(parsed, "range");
  if (since !== undefined) {
    const ms = Date.parse(since);
    if (Number.isNaN(ms)) {
      throw new CliError(`Invalid --since value: ${since}.`, {
        hint: "Use an ISO timestamp, e.g. 2026-10-25T00:00:00Z.",
      });
    }
    return ms;
  }
  if (last !== undefined) {
    if (last <= 0) {
      throw new CliError(`--last must be a positive number of days (got "${last}").`);
    }
    return now.getTime() - last * 24 * 3_600_000;
  }
  if (range !== undefined) {
    if (!/^(\d+)(m|h|d|days?)$/.test(range)) {
      throw new CliError(`Invalid --range value: ${range}.`, {
        hint: "Use a window like 24h, 7days, or 30days.",
      });
    }
    return now.getTime() - rangeDurationMs(range);
  }
  return null;
}

/** Narrow the rows to the requested analysis window (--since/--until/--last/--range). */
function applyRowFilters<T extends { created_at: string }>(
  rows: readonly T[],
  parsed: ReturnType<typeof parse>,
  now: Date,
): T[] {
  const start = filterStartMs(parsed, now);
  if (start === null) return [...rows];
  return rows.filter((row) => Date.parse(row.created_at) >= start);
}

function suggest(parsed: ReturnType<typeof parse>, now: Date): void {
  const totals = readMonthTotals(now);
  const suggestion = suggestBudget(totals);
  if (!suggestion.ok) {
    out(`insufficient history for P90 suggestion (${suggestion.windows} windows)`);
    return;
  }
  if (bool(parsed, "json")) {
    json({
      suggested: suggestion.value.value,
      provenance: formatLabel(suggestion.value.provenance),
      windows: totals,
    });
    return;
  }
  out(`Suggested budget.monthly: ${suggestion.value.value}`);
  out(style.dim(`Run: aiand config set budget.monthly ${suggestion.value.value}`));
}

function emitJson(
  result: ForecastResult,
  harness: string | undefined,
  parsed: ReturnType<typeof parse>,
): void {
  const payload = {
    harness: harness ?? null,
    verdict: result.verdict,
    pacing: result.pacing,
    currency: result.currency,
    window: result.window,
    current_spend: labeledJson(result.currentSpend),
    burn_rate_24h: rateJson(result.rate24h),
    burn_rate_7d: rateJson(result.rate7d),
    headline_rate: rateJson(result.headlineRate),
    projected_month_end: result.projectedMonthEnd ? labeledJson(result.projectedMonthEnd) : null,
    projected_exceed_date: result.exceedDate,
    budget: result.budget,
    budget_remaining: result.budgetRemaining,
  };
  const jq = str(parsed, "jq");
  json(jq === undefined ? payload : jqPath(payload, jq));
}

function labeledJson(entry: Labeled<unknown>): unknown {
  return { value: entry.value, provenance: formatLabel(entry.provenance) };
}

function rateJson(rate: RateResult): unknown {
  return rate.ok
    ? {
        value: rate.value.value,
        provenance: formatLabel(rate.value.provenance),
        span_hours: rate.spanHours,
      }
    : { value: null, reason: rate.reason, span_hours: rate.spanHours };
}

/**
 * Minimal --jq: a dot path with optional [n] array indexes, e.g.
 * `projected_month_end.value` or `windows[0].month`. A missing path prints
 * null rather than failing — extraction, not validation.
 */
function jqPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const token of path.split(".")) {
    if (typeof current !== "object" || current === null) return null;
    const indexed = /^([^\][]*)\[(\d+)\]$/.exec(token);
    if (indexed) {
      const key = indexed[1] ?? "";
      let next: unknown = key ? (current as Record<string, unknown>)[key] : current;
      if (Array.isArray(next)) next = next[Number(indexed[2])] ?? null;
      current = next;
      continue;
    }
    current = (current as Record<string, unknown>)[token] ?? null;
  }
  return current;
}

function printForecast(
  result: ForecastResult,
  harness: string | undefined,
  syncStatus: string,
): void {
  const symbol = currencyPrefix(result.currency);
  const money = (value: number | null): string =>
    value === null ? style.dim("-") : `${symbol}${value.toFixed(2)}`;
  const rateText = (rate: RateResult): string =>
    rate.ok ? `${money(rate.value.value)}/h` : style.dim("indeterminate");

  out(
    style.bold(
      `Forecast · ${result.window.start.slice(0, 10)} to ${result.window.end.slice(0, 10)}` +
        (harness ? ` · harness ${harness}` : ""),
    ),
  );
  out();
  table(
    [
      {
        label: "current spend",
        value: money(result.currentSpend.value),
        label2: formatLabel(result.currentSpend.provenance),
      },
      {
        label: "burn rate (24h)",
        value: rateText(result.rate24h),
        label2: result.rate24h.ok
          ? formatLabel(result.rate24h.value.provenance)
          : style.dim("not computed"),
      },
      {
        label: "burn rate (7d)",
        value: rateText(result.rate7d),
        label2: result.rate7d.ok
          ? formatLabel(result.rate7d.value.provenance)
          : style.dim("not computed"),
      },
      {
        label: "projected month-end",
        value: result.projectedMonthEnd
          ? money(result.projectedMonthEnd.value)
          : style.dim("indeterminate"),
        label2: result.projectedMonthEnd
          ? formatLabel(result.projectedMonthEnd.provenance)
          : style.dim("not computed"),
      },
      {
        label: "projected exceed date",
        value: result.exceedDate ?? style.dim("-"),
        label2: result.exceedDate ? "heuristic(burn-rate v1)" : style.dim("not applicable"),
      },
      {
        label: "verdict",
        value: verdictCell(result.verdict),
        label2: "heuristic(burn-rate v1)",
      },
      {
        label: "budget remaining",
        value: money(result.budgetRemaining),
        label2: result.budgetRemaining === null ? style.dim("no budget set") : "gateway-billed",
      },
    ],
    [
      { header: "", value: (r) => style.dim(r.label) },
      { header: "", value: (r) => r.value, align: "right" },
      { header: "provenance", value: (r) => r.label2 },
    ],
  );

  if (result.pacing) {
    out();
    out(result.verdict === "exceeding" ? style.yellow(result.pacing) : style.green(result.pacing));
  }
  out();
  out(
    style.dim(
      `projection window ${result.window.start.replace("T", " ").slice(0, 16)}Z — ` +
        `${Math.round(result.window.hoursRemaining)}h remaining · store sync ${syncStatus}`,
    ),
  );
  out(
    style.dim(
      "budgets are advisory — the CLI warns, it never blocks (suppress: --no-warn / AIAND_NO_WARN=1)",
    ),
  );
}

function currencyPrefix(currency: string | null | undefined): string {
  return currency === "usd" ? "$" : currency ? `${currency} ` : "";
}

function verdictCell(verdict: string): string {
  if (verdict === "exceeding") return style.red(verdict);
  if (verdict === "on-pace") return style.green(verdict);
  return style.yellow(verdict);
}

/**
 * The 80%-threshold warning on stderr, suppressible with --no-warn /
 * AIAND_NO_WARN=1 (the `guard allow` escape hatch). No budget or under the
 * threshold → no warning.
 */
function printBudgetWarning(
  result: ForecastResult,
  warnPct: number,
  parsed: ReturnType<typeof parse>,
): void {
  if (result.budget === null) return;
  if (warnSuppressed(bool(parsed, "no-warn"))) return;
  const line = warnThresholdLine(
    result.currentSpend.value,
    result.budget,
    warnPct,
    result.currency,
  );
  if (line) err(style.yellow(line));
}
