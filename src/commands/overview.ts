import { bool, list, parse, str } from "../cli/args.js";
import { err, json, out, style } from "../cli/output.js";
import { assertSafeProfileName } from "../config.js";
import { storeBudgetWarning } from "../obs/forecast.js";
import {
  assertTimezone,
  buildReportData,
  OVERVIEW_SECTIONS,
  type OverviewSection,
  parseSectionList,
  resolveWindow,
  syncWarningFor,
} from "../report/data.js";
import { renderOverviewText } from "../report/overview.js";
import { runPreReadSync } from "../store/sync.js";

/**
 * `aiand overview` (feature catalog F3, ticket #76): the copy-pasteable
 * plain-text "month at a glance". Fixed-width (<=80 cols), color only on a
 * TTY — piped output is pure plain text (the shared style helpers drop
 * ANSI). Reads the local store only; auto-sync is fail-open, --no-sync
 * reads as-is.
 */

export const help = `${style.bold("aiand overview")} -- your period at a glance, as pasteable plain text

Usage
  aiand overview
  aiand overview --last 7d
  aiand overview --sections totals,budget --json

Options
  --since <date>        start of the window (2026-10-01 or an ISO timestamp)
  --until <date>        end of the window (a bare date means end-of-day)
  --last <n><unit>      relative window: m|h|d|w, e.g. --last 7d
  --range <window>      15m, 1h, 6h, 24h, 7days, 30days
  --timezone <tz>       IANA timezone for day boundaries (default UTC)
  --harness <name>      filter to one harness (repeatable)
  --model <glob>        filter to models matching a glob (repeatable)
  --sections <list>     totals,by-harness,models,busiest,daily,budget (default all)
  --no-cost             mask monetary figures
  --json                machine-readable version of the same summary
  --no-sync             skip the pre-read store sync and read the local store as-is`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    range: { type: "string" },
    timezone: { type: "string" },
    harness: { type: "string", multiple: true },
    model: { type: "string", multiple: true },
    sections: { type: "string" },
    "no-cost": { type: "boolean", default: false },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const timezone = str(parsed, "timezone") ?? "UTC";
  assertTimezone(timezone);
  const sections: OverviewSection[] = parseSectionList(
    str(parsed, "sections"),
    OVERVIEW_SECTIONS,
  ) ?? [...OVERVIEW_SECTIONS];
  const showCost = !bool(parsed, "no-cost");

  // -- one sync, then ONE store read for every section --------------------------
  // #87: validate --profile even when sync is skipped or fails open.
  const profileName = str(parsed, "profile");
  if (profileName !== undefined) assertSafeProfileName(profileName);
  const sync = await runPreReadSync(profileName, bool(parsed, "no-sync"));

  const now = new Date();
  const { sinceMs, untilMs } = resolveWindow(
    {
      since: str(parsed, "since"),
      until: str(parsed, "until"),
      last: str(parsed, "last"),
      range: str(parsed, "range"),
    },
    timezone,
    now,
  );
  const data = buildReportData({
    timezone,
    sinceMs,
    untilMs,
    harnesses: list(parsed, "harness"),
    models: list(parsed, "model"),
    sections,
    top: 20,
    sync,
    now,
  });

  // The sync state is surfaced on stderr in every output mode.
  const syncWarning = syncWarningFor(data.meta.sync);
  if (syncWarning) err(style.yellow(`Warning: ${syncWarning}`));
  const budgetWarning = storeBudgetWarning();
  if (budgetWarning && showCost) err(style.yellow(budgetWarning));

  if (bool(parsed, "json")) {
    return json(overviewPayload(data, sections, showCost));
  }
  out(renderOverviewText(data, { showCost, sections }));
}

/** The `--json` payload: the same numbers, machines first. */
function overviewPayload(
  data: ReturnType<typeof buildReportData>,
  sections: readonly OverviewSection[],
  showCost: boolean,
): unknown {
  const wants = new Set<string>(sections);
  const payload: Record<string, unknown> = { meta: { ...data.meta, showCost } };
  if (wants.has("totals")) payload.totals = data.totals;
  if (wants.has("by-harness")) payload.byHarness = data.byHarness;
  if (wants.has("models")) payload.topModels = data.topModels;
  if (wants.has("busiest")) {
    payload.busiestDays = [...data.days]
      .sort((a, b) => {
        const da = dominantOf(a.costs);
        const dbv = dominantOf(b.costs);
        return (
          (dbv === null ? 0 : (b.costs[dbv] ?? 0)) - (da === null ? 0 : (a.costs[da] ?? 0)) ||
          b.requests - a.requests
        );
      })
      .slice(0, 5);
  }
  if (wants.has("daily")) payload.daily = data.days.slice(-14);
  if (wants.has("budget")) payload.budget = data.budget;
  return payload;
}

function dominantOf(costs: Record<string, number>): string | null {
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
