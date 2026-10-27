import { openSession } from "../api/client.js";
import { bool, int, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, json, out, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { budgetFor, loadBudget, warnSuppressed, warnThresholdLine } from "../obs/budget.js";
import {
  type ForecastResult,
  forecast,
  type RateResult,
  readForecastRows,
  readMonthTotals,
  suggestBudget,
} from "../obs/forecast.js";
import { formatLabel, type Labeled } from "../obs/provenance.js";
import {
  computeCoverage,
  rangeDurationMs,
  type SyncOutcome,
  syncWarningLine,
} from "../store/coverage.js";
import { noSyncRequested, syncStore } from "../store/index.js";
import { assertWindowOrder } from "./usage-report.js";

export const help = `${style.bold("aiand forecast")} -- burn-rate projection against your budget

Usage
  aiand forecast
  aiand forecast --harness claude
  aiand forecast --suggest-budget
  aiand forecast --json

Options
  --harness <name>    scope to one harness (uses budget.harness.<name> when set)
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
in the month. Current spend is
gateway-billed (summed verbatim from the local store); every projection is
labeled. Budgets are advisory: nothing is enforced or blocked.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    harness: { type: "string" },
    range: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    "suggest-budget": { type: "boolean", default: false },
    "no-sync": { type: "boolean", default: false },
    "no-warn": { type: "boolean", default: false },
    jq: { type: "string" },
  });
  if (bool(parsed, "help")) return out(help);

  const [subcommand] = parsed.positionals;
  if (subcommand !== undefined) {
    throw new CliError(`Unknown subcommand "${subcommand}".`, {
      hint: "Run `aiand forecast --help` to see the usage.",
    });
  }

  const budgetConfig = loadBudget();
  const harness = str(parsed, "harness");
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

function untilOrNow(parsed: ReturnType<typeof parse>): Date {
  const until = str(parsed, "until");
  if (until === undefined) return new Date();
  const ms = Date.parse(until);
  if (Number.isNaN(ms)) {
    throw new CliError(`Invalid --until value: ${until}.`, {
      hint: "Use an ISO timestamp, e.g. 2026-10-25T00:00:00Z.",
    });
  }
  // #87: an inverted --since/--until pair narrows to nothing; reject it up front.
  const since = str(parsed, "since");
  if (since !== undefined) {
    const sinceMs = Date.parse(since);
    if (!Number.isNaN(sinceMs)) assertWindowOrder(sinceMs, ms);
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
    // #99: machine-readable refusal when --json asked for JSON.
    if (bool(parsed, "json")) {
      json({ status: "insufficient-history", windows: suggestion.windows });
      return;
    }
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

/**
 * The `--json` payload shape, exported so the MCP `spend_check` tool (ticket
 * #70) emits the exact same document — one source of truth for the shape.
 */
export function buildForecastPayload(result: ForecastResult, harness: string | undefined): unknown {
  return {
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
}

function emitJson(
  result: ForecastResult,
  harness: string | undefined,
  parsed: ReturnType<typeof parse>,
): void {
  const payload = buildForecastPayload(result, harness);
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
