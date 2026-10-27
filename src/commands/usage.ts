import {
  ANALYTICS_RANGES,
  type AnalyticsMetric,
  getMetrics,
  getSummary,
} from "../api/analytics.js";
import { openSession } from "../api/client.js";
import { bool, list, oneOf, type Parsed, parse, str } from "../cli/args.js";
import { CliError, EXIT } from "../cli/errors.js";
import { delta, err, heading, json, num, out, sparkline, style, table } from "../cli/output.js";
import { assertSafeProfileName, resolveProfile } from "../config.js";
import { storeBudgetWarning, storePacingSummary } from "../obs/forecast.js";
import {
  describeProvenance,
  formatLabel,
  PROVENANCE_CATALOG,
  type ProvenanceEntry,
  provenanceAudit,
} from "../obs/provenance.js";
import { syncWarningLine } from "../store/coverage.js";
import { noSyncRequested } from "../store/index.js";
import { reconcileUsage, VERIFY_RANGES, type VerifyRow } from "../store/reconcile.js";
import { runPreReadSync } from "../store/sync.js";
import {
  applyJqPath,
  assertWindowOrder,
  type BlockSection,
  buildReport,
  isValidTimezone,
  parseJqPath,
  parseLast,
  parseSince,
  parseUntil,
  primarySection,
  renderReport,
  reportCsv,
  SECTION_REGISTRY,
  type SectionName,
  SORT_COLUMNS,
  TIME_UNITS,
  UNIT_SECTION,
  unitOfSection,
} from "./usage-report.js";

export const help = `${style.bold("aiand usage")} -- request and token usage for your org

Usage
  aiand usage                        local store report: daily blocks + totals
  aiand usage --by day|week|month|session
  aiand usage --sections daily,totals,by-model
  aiand usage --since 2026-10-01 --agent claude --breakdown
  aiand usage --json --jq '.sections.totals'
  aiand usage --format csv
  aiand usage --range 30days         gateway summary (legacy view)
  aiand usage --metrics              full metric breakdown (legacy view)
  aiand usage --audit                provenance of every reported number
  aiand usage --verify               reconciliation gate vs the gateway

Report options (local store, auto-synced before read; --no-sync / AIAND_NO_SYNC=1
reads the store as-is and never touches the network)
  --by <unit>        day (default) | week (ISO) | month | session
  --sections <list>  comma list from: ${SECTION_REGISTRY.join("|")};
                     one store read feeds every requested section
  --since <date>     window start (date = midnight in the display timezone)
  --until <date>     window end (date = end of day in the display timezone)
  --last <n><u>      relative window: --last 7d, --last 4w, --last 12h, --last 30m
  --timezone <tz>    IANA timezone for day/week/month boundaries and display
                     (default UTC)
  --agent <name>     only requests attributed to this agent (masked-key
                     attribution; repeatable, "unknown" = unmapped keys)
  --harness <name>   same attribution as --agent (the harness that owns the key)
  --model <glob>     model name glob (repeatable; * and ? wildcards)
  --sort <column>    period | requests | input | output | cached | cost
  --order <dir>      asc (default) | desc
  --breakdown, -b    per-model sub-table under each block
  --no-breakdown     (breakdown is off by default)
  --no-totals        drop the totals row (totals are shown by default)
  --no-cost          hide every cost column
  --compact          narrow tables (period, requests, tokens, cost); also
                     automatic under a 100-column terminal. Compact drops,
                     in order: cached tokens, then the input/output split

  --json             machine-readable payload { meta, sections }
                     totals carry errors / errorRate (#98): non-2xx statuses
                     excluding 429 over requests — the shared #88 definition;
                     errorRate is null on an empty window, never 0.0
  --jq <filter>      minimal dot-path filter on the --json document
                     (.sections.totals, .sections.daily[0], .sections.daily[])
  --format csv       flat CSV of the primary section; fixed header
                     period,requests,input_tokens,output_tokens,cached_tokens,cost,currency
                     (one row per period+currency; never summed across currencies)

Legacy gateway options
  --range <window>   1h, 24h, 7days (default), 30days, 3months
  --metrics          show the full metric breakdown instead of the summary
  --audit            print the provenance table: every reported number, its
                     label (gateway-billed / estimated(<source>) /
                     heuristic(<name>)) and what it is computed from
  --verify           reconciliation gate: compare local-store totals against
                     the gateway (/logs up to 30 days, /analytics/summary
                     up to 3months; default window 30days). Windows the
                     gateway cannot see are reported UNVERIFIABLE, never
                     skipped. Exits 1 when any metric mismatches, 0 when
                     everything reconciles.
  --since <iso>       with --verify: explicit window start (with --until)
  --until <iso>       with --verify: explicit window end (with --since)
  --no-sync           skip the pre-verify store sync and compare the local
                      store as-is (also AIAND_NO_SYNC=1)

Percentages compare the window against the one immediately before it.
Cost is always the gateway-billed amount in the request's currency (mixed
currencies are shown per currency, never summed) and is never recomputed
from price tables; tokens follow the gateway convention: input includes cached.`;

/** Report-only flags that select the local-store report path. */
const REPORT_STRING_FLAGS = ["by", "sections", "last", "timezone", "sort", "order", "jq", "format"];
const REPORT_LIST_FLAGS = ["agent", "model", "harness"];
const REPORT_BOOL_FLAGS = ["breakdown", "no-breakdown", "no-totals", "no-cost", "compact"];

function wantsReport(parsed: Parsed): boolean {
  return (
    REPORT_STRING_FLAGS.some((flag) => str(parsed, flag) !== undefined) ||
    REPORT_LIST_FLAGS.some((flag) => list(parsed, flag).length > 0) ||
    REPORT_BOOL_FLAGS.some((flag) => bool(parsed, flag))
  );
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    range: { type: "string" },
    metrics: { type: "boolean", default: false },
    audit: { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    "no-sync": { type: "boolean", default: false },
    since: { type: "string" },
    until: { type: "string" },
    by: { type: "string" },
    sections: { type: "string" },
    last: { type: "string" },
    timezone: { type: "string" },
    agent: { type: "string", multiple: true },
    harness: { type: "string", multiple: true },
    model: { type: "string", multiple: true },
    sort: { type: "string" },
    order: { type: "string" },
    breakdown: { type: "boolean", default: false, short: "b" },
    "no-breakdown": { type: "boolean", default: false },
    "no-totals": { type: "boolean", default: false },
    "no-cost": { type: "boolean", default: false },
    compact: { type: "boolean", default: false },
    jq: { type: "string" },
    format: { type: "string" },
  });
  if (bool(parsed, "help")) return out(help);

  if (bool(parsed, "audit")) {
    // Offline by design: the audit describes how numbers are made, it does
    // not fetch any.
    const rows = provenanceAudit();
    if (bool(parsed, "json")) return json(rows);
    return printAudit([...PROVENANCE_CATALOG]);
  }

  if (bool(parsed, "verify")) {
    if (bool(parsed, "metrics")) {
      throw new CliError("--verify cannot be combined with --metrics.");
    }
    return runVerify(parsed);
  }

  const report = wantsReport(parsed);
  if (report && (bool(parsed, "metrics") || str(parsed, "range") !== undefined)) {
    throw new CliError(
      "--metrics/--range are the legacy gateway view and cannot be combined with the local-store report flags.",
      {
        hint: "Use either the report flags (--by, --sections, --since, ...) or --range/--metrics alone.",
      },
    );
  }
  if (report || (str(parsed, "range") === undefined && !bool(parsed, "metrics"))) {
    return runReport(parsed);
  }

  const session = await openSession(resolveProfile(str(parsed, "profile")));
  const range = oneOf(parsed, "range", ANALYTICS_RANGES, "7days");

  if (bool(parsed, "metrics")) {
    const metrics = await getMetrics(session, range);
    if (bool(parsed, "json")) return json(metrics);
    return printMetrics(metrics, range);
  }

  const summary = await getSummary(session, range);
  if (bool(parsed, "json")) return json(summary);

  const { current, previous } = summary;
  const totalTokens = current.input_tokens + current.output_tokens;
  const previousTokens = previous.input_tokens + previous.output_tokens;

  const rows: { label: string; current: number; previous: number }[] = [
    { label: "requests", current: current.requests, previous: previous.requests },
    { label: "input tokens", current: current.input_tokens, previous: previous.input_tokens },
    { label: "output tokens", current: current.output_tokens, previous: previous.output_tokens },
    { label: "total tokens", current: totalTokens, previous: previousTokens },
  ];

  heading(`Last ${range}`);
  out();
  table(rows, [
    { header: "", value: (r) => style.dim(r.label) },
    { header: "", value: (r) => num(r.current), align: "right" },
    { header: "", value: (r) => delta(r.current, r.previous), align: "right" },
    { header: "", value: (r) => style.dim(`was ${num(r.previous)}`) },
  ]);

  if (summary.timeseries.length > 1) {
    out();
    out(style.dim("tokens  ") + style.cyan(sparkline(summary.timeseries.map((p) => p.tokens))));
    const first = summary.timeseries[0]!;
    const last = summary.timeseries[summary.timeseries.length - 1]!;
    out(
      style.dim(
        `        ${first.timestamp.replace("T", " ")}  to  ${last.timestamp.replace("T", " ")}`,
      ),
    );
  }

  printBudgetFooter();
}

/**
 * The budget footer (ticket #74 req 3): the 80%-threshold warning when
 * crossed, then the pacing verdict line. Both come from the LOCAL store and
 * fail open — no budget or no data prints nothing, and a mixed-currency
 * store never blocks a usage report.
 */
function printBudgetFooter(): void {
  const warning = storeBudgetWarning();
  if (warning) err(style.yellow(warning));
  const pacing = storePacingSummary();
  if (pacing?.pacing) {
    out();
    out(style.dim(pacing.pacing));
  }
}

function printAudit(rows: ProvenanceEntry[]): void {
  heading("Provenance of every reported number");
  out();
  table<ProvenanceEntry>(rows, [
    { header: "report", value: (r) => r.report },
    { header: "field", value: (r) => r.field },
    { header: "label", value: (r) => formatLabel(r.provenance) },
    { header: "computed from", value: (r) => style.dim(describeProvenance(r.provenance)) },
  ]);
  out();
  out(
    style.dim(
      "gateway-billed = verbatim gateway field · estimated(<source>) = computed by ai& · " +
        "heuristic(<name>) = depends on a heuristic",
    ),
  );
}

function printMetrics(metrics: AnalyticsMetric[], range: string): void {
  if (metrics.length === 0) {
    out(style.dim("No metrics for this window."));
    return;
  }

  heading(`Last ${range}`);
  out();
  table<AnalyticsMetric>(metrics, [
    { header: "metric", value: (m) => m.summary[0]?.display_name ?? m.metric_name },
    {
      header: "value",
      value: (m) => {
        const value = m.summary[0]?.value ?? 0;
        return `${Number.isInteger(value) ? num(value) : value.toFixed(2)}${m.unit === "percent" ? "%" : ""}`;
      },
      align: "right",
    },
    { header: "unit", value: (m) => style.dim(m.unit) },
    { header: "trend", value: (m) => style.cyan(sparkline(m.timeseries.map((p) => p.value))) },
  ]);
}

// ---------------------------------------------------------------------------
// --verify: the reconciliation accuracy gate (feature catalog A5)
// ---------------------------------------------------------------------------

async function runVerify(parsed: Parsed): Promise<void> {
  const range = oneOf(parsed, "range", VERIFY_RANGES, "30days");
  const since = str(parsed, "since");
  const until = str(parsed, "until");
  if ((since === undefined) !== (until === undefined)) {
    throw new CliError("--since and --until must be passed together.", {
      hint: "Example: aiand usage --verify --since 2026-09-25T00:00:00Z --until 2026-10-25T00:00:00Z",
    });
  }

  const session = await openSession(resolveProfile(str(parsed, "profile")));
  const outcome = await reconcileUsage(session, {
    range,
    since,
    until,
    skipSync: bool(parsed, "no-sync") || noSyncRequested(),
  });

  // Sync state is reported in both modes, on stderr in --json so the machine
  // payload keeps the exact per-row array shape the ticket pins. A failed
  // sync is surfaced, never folded away — but it is not a mismatch: the
  // comparison runs on the store as-is.
  if (!outcome.sync.requested) {
    err(style.dim("sync: skipped (--no-sync) — comparing the local store as-is."));
  } else if (!outcome.sync.ok) {
    err(style.yellow(`Warning: pre-verify sync failed (${outcome.sync.error}).`));
    err(style.dim("Comparing the local store as-is; it may be stale."));
  }

  const mismatches = outcome.rows.filter((r) => r.status === "mismatch");
  const unverifiable = outcome.rows.filter((r) => r.status === "unverifiable");
  // The exit code is the gate: any mismatch exits 1, in both output modes.
  if (mismatches.length > 0) process.exitCode = EXIT.ERROR;

  if (bool(parsed, "json")) return json(outcome.rows);

  const { since: from, until: to } = outcome.rows[0]?.window ?? { since: "", until: "" };
  heading("Accuracy check — local store vs gateway");
  out(style.dim(`window ${from.replace("T", " ")}  to  ${to.replace("T", " ")}`));
  out();
  table<VerifyRow>(outcome.rows, [
    { header: "source", value: (r) => r.source },
    { header: "metric", value: (r) => r.metric },
    { header: "local", value: (r) => formatValue(r, r.local), align: "right" },
    {
      header: "remote",
      value: (r) => (r.remote === null ? "-" : formatValue(r, r.remote)),
      align: "right",
    },
    {
      header: "delta",
      value: (r) => (r.delta === null ? "-" : formatValue(r, r.delta)),
      align: "right",
    },
    { header: "status", value: (r) => formatStatus(r) },
  ]);

  out();
  if (mismatches.length > 0) {
    out(
      style.red(
        style.bold(
          `${mismatches.length} MISMATCH${mismatches.length === 1 ? "" : "ES"} — ` +
            "local totals do not reconcile with the gateway.",
        ),
      ),
    );
    out(style.dim("Exit code 1. Do not trust local reports for the mismatched metrics."));
  } else if (unverifiable.length > 0) {
    out(style.yellow("Everything comparable reconciles; some rows are UNVERIFIABLE (see table)."));
  } else {
    out(style.green("All metrics reconcile exactly (delta 0)."));
  }
  for (const row of unverifiable) {
    if (row.detail) out(style.dim(`unverifiable (${row.metric}): ${row.detail}`));
  }

  if (mismatches.length > 0) process.exitCode = EXIT.ERROR;
}

function formatValue(row: VerifyRow, value: number): string {
  return row.metric === "cost" ? value.toFixed(6) : num(value);
}

function formatStatus(row: VerifyRow): string {
  if (row.status === "ok") return style.green("OK");
  if (row.status === "mismatch") return style.red("MISMATCH");
  return style.yellow("UNVERIFIABLE");
}

// ---------------------------------------------------------------------------
// The local-store report (feature catalog B1/B6/B7/G1, ticket #60)
// ---------------------------------------------------------------------------

async function runReport(parsed: Parsed): Promise<void> {
  const format = oneOf(parsed, "format", ["table", "csv"], "table");
  if (format === "csv" && bool(parsed, "json")) {
    throw new CliError("--format csv and --json are different output formats; choose one.");
  }
  if (str(parsed, "jq") !== undefined && format === "csv") {
    throw new CliError(
      "--jq filters the --json document and cannot be combined with --format csv.",
    );
  }

  const timezone = str(parsed, "timezone") ?? "UTC";
  if (!isValidTimezone(timezone)) {
    throw new CliError(`Invalid --timezone value: ${timezone}.`, {
      hint: "Use an IANA timezone, e.g. America/New_York or Europe/Berlin.",
    });
  }

  const unit = oneOf(parsed, "by", TIME_UNITS, "day");

  // --sections: a comma list from the documented registry; it picks the block
  // unit itself (daily/weekly/monthly/sessions) unless --by says otherwise.
  let reportUnit = unit;
  let sections: SectionName[];
  const rawSections = str(parsed, "sections");
  if (rawSections !== undefined) {
    const names = [
      ...new Set(
        rawSections
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    for (const name of names) {
      if (!(SECTION_REGISTRY as readonly string[]).includes(name)) {
        throw new CliError(`Invalid --sections entry: ${name}.`, {
          hint: `Choose from: ${SECTION_REGISTRY.join(", ")}.`,
        });
      }
    }
    const blockSection = names.find((name) =>
      (["daily", "weekly", "monthly", "sessions"] as const).includes(name as BlockSection),
    ) as BlockSection | undefined;
    if (blockSection !== undefined) {
      const sectionsUnit = unitOfSection(blockSection);
      if (str(parsed, "by") !== undefined && sectionsUnit !== unit) {
        throw new CliError(`--by ${unit} does not match --sections ${blockSection}.`, {
          hint: "Either drop --by or pick the matching section.",
        });
      }
      reportUnit = sectionsUnit;
    }
    sections = names as SectionName[];
  } else {
    sections = [UNIT_SECTION[unit]];
    if (!bool(parsed, "no-totals")) sections.push("totals");
  }

  // -- window -----------------------------------------------------------------
  const since = str(parsed, "since");
  const until = str(parsed, "until");
  const sinceMs = since === undefined ? null : parseSince(since, timezone);
  const untilMs = until === undefined ? null : parseUntil(until, timezone);
  const last = str(parsed, "last");
  const lastSinceMs = last === undefined ? null : parseLast(last, new Date()).sinceMs;
  assertWindowOrder(sinceMs, untilMs);

  // -- one sync, then ONE store read for every section --------------------------
  // #87: every path consuming a profile name validates it — even when the
  // sync is skipped or fails open, an unsafe --profile never renders a report.
  const profileName = str(parsed, "profile");
  if (profileName !== undefined) assertSafeProfileName(profileName);
  const sync = await runPreReadSync(profileName, bool(parsed, "no-sync"));

  const report = buildReport({
    unit: reportUnit,
    sections,
    timezone,
    sinceMs:
      sinceMs !== null && lastSinceMs !== null
        ? Math.max(sinceMs, lastSinceMs)
        : (sinceMs ?? lastSinceMs),
    untilMs,
    filters: {
      agents: [...list(parsed, "agent"), ...list(parsed, "harness")],
      models: list(parsed, "model"),
    },
    sort: oneOf(parsed, "sort", SORT_COLUMNS, "period"),
    order: oneOf(parsed, "order", ["asc", "desc"], "asc"),
    sync,
    breakdown: bool(parsed, "breakdown") && !bool(parsed, "no-breakdown"),
  });

  // The sync state is surfaced on stderr in every output mode — a failed or
  // skipped sync is never folded away from the human or the machine payload.
  const syncWarning = syncWarningLine(report.coverage);
  if (syncWarning) err(style.yellow(`Warning: ${syncWarning}`));

  if (str(parsed, "jq") !== undefined || (bool(parsed, "json") && format === "table")) {
    const payload = { meta: report.meta, sections: report.sections };
    const filter = str(parsed, "jq");
    if (filter !== undefined) return json(applyJqPath(payload, parseJqPath(filter)));
    return json(payload);
  }

  if (format === "csv") {
    const primary = primarySection(sections);
    if (primary === null) {
      throw new CliError(
        "--format csv needs a block section (daily, weekly, monthly or sessions).",
        {
          hint: "Add one to --sections, e.g. --sections daily,totals.",
        },
      );
    }
    return out(reportCsv(report, primary));
  }

  renderReport(report, {
    showCost: !bool(parsed, "no-cost"),
    compact:
      bool(parsed, "compact") ||
      (process.stdout.isTTY === true &&
        typeof process.stdout.columns === "number" &&
        process.stdout.columns > 0 &&
        process.stdout.columns < 100),
    breakdown: bool(parsed, "breakdown") && !bool(parsed, "no-breakdown"),
    totals: !bool(parsed, "no-totals"),
    sections,
    unit: reportUnit,
  });
}
