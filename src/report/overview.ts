import { currencySymbol, num, style } from "../cli/output.js";
import { formatMoneyFixed } from "../pricing/currency.js";
import {
  type Costs,
  OVERVIEW_DAY_ROWS,
  OVERVIEW_TOP_N,
  type OverviewSection,
  type ReportData,
} from "./data.js";

/**
 * The plain-text `overview` (feature catalog F3, ticket #76) — CodeBurn's
 * "your month at a glance": totals first, then breakdowns, fixed-width
 * plain text that pastes cleanly into PRs and Slack (only `==`/`--` rules
 * and aligned columns, no box drawing). Color comes exclusively from the
 * shared `style` helpers, which drop ANSI automatically when piped, so a
 * piped overview is pure plain text.
 */

export type OverviewView = {
  showCost: boolean;
  sections: readonly OverviewSection[];
};

/** Width budget: every line stays at or under 80 columns. */
const OVERVIEW_WIDTH = 80;
const BAR_WIDTH = 20;

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function money(value: number, currency: string): string {
  const symbol = currencySymbol(currency === "" ? null : currency);
  const code = currency === "" || currency === "usd" ? "" : `${currency} `;
  return `${code}${symbol}${formatMoneyFixed(value, 4)}`;
}

function costCell(costs: Costs): string {
  const entries = Object.entries(costs);
  if (entries.length === 0) return "-";
  return entries.map(([currency, value]) => money(value, currency)).join("; ");
}

/** ASCII share bar, e.g. `████████████░░░░░░░░` truncated to the share. */
function bar(share: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(share * BAR_WIDTH)));
  return "█".repeat(filled) + "·".repeat(BAR_WIDTH - filled);
}

function rule(char: string): string {
  return char.repeat(OVERVIEW_WIDTH);
}

/**
 * The whole overview as one string (no trailing newline). The caller writes
 * it with `out()`; because styling rides the shared TTY detection, piped
 * output contains zero ANSI escapes.
 */
export function renderOverviewText(data: ReportData, view: OverviewView): string {
  const meta = data.meta;
  const lines: string[] = [];
  const since = meta.range.since === null ? "the beginning" : meta.range.since.slice(0, 10);
  const until = meta.range.until === null ? "now" : meta.range.until.slice(0, 10);

  // -- header: range + currency + provenance note ----------------------------
  lines.push(
    style.bold(
      `ai& overview — ${since} to ${until} (${meta.timezone}) · ${num(meta.rowCount)} requests`,
    ),
  );
  if (meta.currencyHandling === "mixed") {
    lines.push(style.yellow("mixed currencies — costs shown per currency, never summed"));
  }
  lines.push(style.dim("cost: gateway-billed · savings: estimated (catalog prices)"));
  lines.push("");

  const wants = new Set<string>(view.sections);

  // -- totals -----------------------------------------------------------------
  if (wants.has("totals")) {
    lines.push(style.bold("Totals"));
    lines.push(`  ${padRight("requests", 12)} ${padLeft(num(data.totals.requests), 12)}`);
    lines.push(
      `  ${padRight("tokens in", 12)} ${padLeft(num(data.totals.inputTokens), 12)}` +
        `  (cached ${num(data.totals.cachedTokens)})`,
    );
    lines.push(`  ${padRight("tokens out", 12)} ${padLeft(num(data.totals.outputTokens), 12)}`);
    if (view.showCost) {
      for (const [currency, value] of Object.entries(data.totals.costs)) {
        lines.push(
          `  ${padRight(`cost ${currency === "" ? "(unknown)" : currency}`, 12)} ` +
            `${padLeft(money(value, currency), 12)}`,
        );
      }
      if (data.totals.savings !== null) {
        lines.push(
          `  ${padRight("savings", 12)} ${padLeft(money(data.totals.savings, meta.currency ?? ""), 12)}`,
        );
      }
    }
    lines.push("");
  }

  // -- by-harness share ---------------------------------------------------------
  if (wants.has("by-harness") && data.byHarness.length > 0) {
    lines.push(style.bold("By harness"));
    for (const harness of data.byHarness) {
      const share = harness.share === null ? 0 : harness.share;
      const cost = view.showCost ? `  ${costCell(harness.costs)}` : "";
      const shareText = harness.share === null ? "n/a" : `${Math.round(share * 100)}%`;
      lines.push(
        `  ${padRight(harness.harness, 12)} ${bar(share)} ${padLeft(shareText, 4)}${cost}`,
      );
    }
    lines.push("");
  }

  // -- top models ------------------------------------------------------------
  if (wants.has("models") && data.topModels.length > 0) {
    lines.push(style.bold(`Top models (by cost, top ${OVERVIEW_TOP_N})`));
    for (const model of data.topModels) {
      const cost = view.showCost ? `  ${costCell(model.costs)}` : "";
      lines.push(`  ${padRight(model.key, 28)} ${padLeft(num(model.requests), 6)}${cost}`);
    }
    lines.push("");
  }

  // -- busiest days ------------------------------------------------------------
  if (wants.has("busiest") && data.days.length > 0) {
    const busiest = [...data.days]
      .sort((a, b) => {
        const da = dominant(a.costs);
        const dbv = dominant(b.costs);
        return (
          (dbv === null ? 0 : (b.costs[dbv] ?? 0)) - (da === null ? 0 : (a.costs[da] ?? 0)) ||
          b.requests - a.requests
        );
      })
      .slice(0, OVERVIEW_TOP_N);
    lines.push(style.bold("Busiest days (by cost)"));
    for (const day of busiest) {
      const cost = view.showCost ? `  ${costCell(day.costs)}` : "";
      lines.push(`  ${day.day}  ${padLeft(num(day.requests), 6)}${cost}`);
    }
    lines.push("");
  }

  // -- per-day table ------------------------------------------------------------
  if (wants.has("daily") && data.days.length > 0) {
    const rows = data.days.slice(-OVERVIEW_DAY_ROWS);
    lines.push(style.bold(`Per day (last ${rows.length} of ${data.days.length} day(s))`));
    const header =
      `  ${padRight("date", 11)}${padLeft("requests", 9)}${padLeft("tokens", 10)}` +
      (view.showCost ? `${padLeft("cost", 14)}${padLeft("savings", 14)}` : "");
    lines.push(style.dim(header));
    for (const day of rows) {
      const cells =
        `  ${padRight(day.day, 11)}${padLeft(num(day.requests), 9)}` +
        `${padLeft(num(day.inputTokens + day.outputTokens), 10)}`;
      lines.push(
        cells +
          (view.showCost
            ? `${padLeft(costCell(day.costs), 14)}${
                day.savings === null
                  ? padLeft("-", 14)
                  : padLeft(money(day.savings, meta.currency ?? ""), 14)
              }`
            : ""),
      );
    }
    lines.push("");
  }

  // -- budget -------------------------------------------------------------------
  if (wants.has("budget") && data.budget.configured) {
    const budget = data.budget;
    lines.push(style.bold("Budget"));
    if ("error" in budget) {
      lines.push(`  ${budget.error}`);
    } else {
      const symbol = budget.currency === "usd" ? "$" : budget.currency ? `${budget.currency} ` : "";
      lines.push(
        `  ${padRight("month to date", 14)} ${padLeft(
          `${symbol}${budget.currentSpend.toFixed(2)}`,
          12,
        )} of ${symbol}${budget.budget.toFixed(2)}`,
      );
      if (budget.projected !== null) {
        lines.push(
          `  ${padRight("projected", 14)} ${padLeft(`${symbol}${budget.projected.toFixed(2)}`, 12)}`,
        );
      }
      const verdictLine =
        budget.verdict === "exceeding"
          ? style.red(`  ${budget.verdict}`)
          : style.green(`  ${budget.verdict}`);
      lines.push(verdictLine);
      if (budget.pacing !== null) lines.push(`  ${budget.pacing}`);
    }
    lines.push("");
  }

  // -- footnotes ----------------------------------------------------------------
  const notes: string[] = [];
  if (meta.savingsNote) notes.push(meta.savingsNote);
  if (meta.missingDays.length > 0) {
    notes.push(
      `no local data for ${meta.missingDays.length} day(s): ${meta.missingDays.join(", ")} — ` +
        "absent from aggregates, not averaged over",
    );
  }
  if (meta.sync.status === "failed") {
    notes.push(
      `sync failed${meta.sync.error ? ` (${meta.sync.error})` : ""} — showing local data only`,
    );
  }
  if (meta.sync.status === "skipped") {
    notes.push("sync skipped (--no-sync) — showing local data as-is");
  }
  if (meta.sessionization) {
    notes.push(
      `sessions are time-gap groups (${meta.sessionization.gapMinutes} min), not confirmed agent sessions`,
    );
  }
  if (meta.correlationNote) notes.push(meta.correlationNote);
  if (notes.length > 0) {
    lines.push(style.dim(rule("-")));
    for (const note of notes) lines.push(style.dim(`note: ${note}`));
  }
  return lines.join("\n");
}

function dominant(costs: Costs): string | null {
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
