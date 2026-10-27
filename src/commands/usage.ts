import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  ANALYTICS_RANGES,
  type AnalyticsMetric,
  getMetrics,
  getSummary,
} from "../api/analytics.js";
import { openSession } from "../api/client.js";
import { bool, list, oneOf, type Parsed, parse, str } from "../cli/args.js";
import { CliError, EXIT } from "../cli/errors.js";
import { delta, err, json, num, out, sparkline, style, table } from "../cli/output.js";
import { assertSafeProfileName, resolveProfile } from "../config.js";
import { importCcusage, parseCcusagePayload, readImportPayload } from "../obs/ccusage-import.js";
import { storeBudgetWarning, storePacingSummary } from "../obs/forecast.js";
import {
  describeProvenance,
  estimated,
  formatLabel,
  gatewayBilled,
  PROVENANCE_CATALOG,
  type ProvenanceEntry,
  provenanceAudit,
} from "../obs/provenance.js";
import { computeVsList, loadPriceOverrides, readSnapshotFile } from "../pricing/list-prices.js";
import { PEAK_WINDOWS, windowLabel } from "../pricing/peak-windows.js";
import { BUNDLED_SNAPSHOT } from "../pricing/price-snapshot.js";
import { computeCoverage, syncWarningLine } from "../store/coverage.js";
import { noSyncRequested } from "../store/index.js";
import { reconcileUsage, VERIFY_RANGES, type VerifyRow } from "../store/reconcile.js";
import { runPreReadSync } from "../store/sync.js";
import {
  applyJqPath,
  assertWindowOrder,
  type BlockSection,
  buildReport,
  isValidTimezone,
  loadRequestRows,
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
  aiand usage --show-windows         print the peak/off-peak window table
  aiand usage --vs-list              vendor list-price equivalent + ai& savings
  aiand usage --import-ccusage <f|-> import ccusage --json output (offline)

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
  --include-imported fold IMPORTED ccusage rows (see --import-ccusage) into
                     a combined grand-total section. Default-excluded: every
                     gateway total stays gateway-only so mixed sources never
                     double-count; the grand total's cost mixes provenance
                     (gateway-billed + ccusage-estimated) and is labeled so

ccusage import (--import-ccusage; ticket #73, offline — no sync, no network)
  --import-ccusage <file|->   import the JSON output of
                              ccusage daily|weekly|monthly|session|blocks
                              --json (a file path, or "-" for stdin), e.g.
                              ccusage daily --json | aiand usage --import-ccusage -
                              Rows land as EXTERNAL source
                              imported(ccusage@<import-date>), shown as their
                              own source row and EXCLUDED from gateway totals
                              by default. Re-importing identical input is a
                              no-op (content-hash dedupe); a newer payload
                              over the same report periods replaces them.
                              Costs are ccusage's price-table-derived USD
                              equivalents — estimated, never gateway-billed.
                              Unknown schemas are refused, never guessed.
  --json                      (with --import-ccusage) print the import summary
  --json             machine-readable payload { meta, sections }
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
from price tables; tokens follow the gateway convention: input includes cached.

Peak / off-peak (--sections peak or --show-windows; ticket #81)
  --sections peak     per-model split of gateway-billed cost by the vendor
                      window table (GLM peak: Mon-Fri 14:00-18:00 SGT);
                      percentages are shares of cost and sum to 100;
                      unclassified families and non-first-party (routed)
                      traffic are reported explicitly, never guessed
  --show-windows      print the window table itself with its per-entry
                      sources (offline; --json for the raw table)

List-price comparison (--vs-list; feature catalog B8)
  --vs-list           recompute stored tokens at vendor list prices and set
                      the equivalent beside the gateway-billed cost;
                      savings = equivalent - billed, shown only where BOTH
                      sides are priced (partial rows say so)
  --prices-file <p>   use a snapshot file instead of the bundled one
                      (format 1; schema in src/pricing/price-snapshot.ts)
  --config prices.<model>.input|.output|.cacheRead <n>
                      per-model user overrides, USD per 1M tokens; labeled
                      estimated(user-override) in the output
  Never-guess: exact vendor-id match only (through the snapshot alias map);
  a model without an exact price is unpriced — never $0.00, never
  interpolated. The equivalent is always an estimate
  (estimated(vendor-list-price <snapshot>@<date>)); the gateway-billed cost
  stays the billing-grade number.`;

/** Report-only flags that select the local-store report path. */
const REPORT_STRING_FLAGS = ["by", "sections", "last", "timezone", "sort", "order", "jq", "format"];
const REPORT_LIST_FLAGS = ["agent", "model", "harness"];
const REPORT_BOOL_FLAGS = [
  "breakdown",
  "no-breakdown",
  "no-totals",
  "no-cost",
  "compact",
  "include-imported",
];

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
    "vs-list": { type: "boolean", default: false },
    "show-windows": { type: "boolean", default: false },
    "prices-file": { type: "string" },
    "import-ccusage": { type: "string" },
    "include-imported": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  if (bool(parsed, "show-windows")) return printWindows(parsed);

  const importTarget = str(parsed, "import-ccusage");
  if (importTarget !== undefined) {
    if (bool(parsed, "include-imported")) {
      throw new CliError(
        "--include-imported is a report flag: import first, then run the report with it.",
      );
    }
    if (bool(parsed, "metrics") || str(parsed, "range") !== undefined || bool(parsed, "vs-list")) {
      throw new CliError(
        "--import-ccusage only imports data; run the report separately afterwards.",
      );
    }
    return runCcusageImport(parsed, importTarget);
  }

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

  if (bool(parsed, "vs-list")) {
    if (bool(parsed, "metrics") || str(parsed, "range") !== undefined) {
      throw new CliError(
        "--vs-list is a local-store view and cannot be combined with --metrics/--range.",
      );
    }
    return runVsList(parsed);
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

  out(style.bold(`Last ${range}`));
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
  out(style.bold("Provenance of every reported number"));
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

  out(style.bold(`Last ${range}`));
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
  out(style.bold("Accuracy check — local store vs gateway"));
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
// --import-ccusage: the ccusage JSON import adapter (feature catalog G4, #73)
// ---------------------------------------------------------------------------

/**
 * One-shot, fully offline import: no session is opened and no sync runs —
 * importing must never trigger gateway side effects (ticket #73 req 7).
 * The adapter validates loudly; identical payloads dedupe on their content
 * hash (0 rows). Output states the default-exclude so the anti-double-count
 * contract is visible at import time.
 */
async function runCcusageImport(parsed: Parsed, target: string): Promise<void> {
  const raw = readImportPayload(target);
  const summary = importCcusage(parseCcusagePayload(raw));
  if (bool(parsed, "json")) return json(summary);

  out(style.bold("ccusage import"));
  out();
  table(
    [summary],
    [
      { header: "source", value: (r) => r.sourceLabel },
      { header: "report", value: (r) => r.reportKind },
      {
        header: "rows written",
        value: (r) => (r.deduped ? "0 (already imported)" : num(r.inserted)),
        align: "right",
      },
    ],
  );
  out();
  out(style.dim("Imported rows are EXCLUDED from gateway totals by default (anti-double-count)."));
  out(style.dim("Run aiand usage --include-imported for a combined grand total."));
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
    includeImported: bool(parsed, "include-imported"),
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

// ---------------------------------------------------------------------------
// Peak window table (--show-windows) — offline data inspection
// ---------------------------------------------------------------------------

function printWindows(parsed: Parsed): void {
  const rows = PEAK_WINDOWS.map((family) => ({
    family: family.family,
    matches: family.match,
    windows: family.windows.map(windowLabel).join(", "),
    source: family.source,
  }));
  if (bool(parsed, "json")) {
    json(PEAK_WINDOWS);
    return;
  }
  out(style.bold("Peak / off-peak window table"));
  out(style.dim("model ids containing `matches` (case-insensitive) are split by these windows."));
  out();
  table(rows, [
    { header: "family", value: (r) => r.family },
    { header: "matches", value: (r) => r.matches },
    { header: "peak windows", value: (r) => r.windows },
    { header: "source", value: (r) => style.dim(r.source) },
  ]);
}

// ---------------------------------------------------------------------------
// --vs-list: vendor list-price equivalent (feature catalog B8, ticket #81)
// ---------------------------------------------------------------------------

const USD = "usd";

function formatMoney(value: number): string {
  return value.toFixed(6);
}

async function runVsList(parsed: Parsed): Promise<void> {
  if (str(parsed, "format") !== undefined) {
    throw new CliError(
      "--vs-list supports --json (and --jq) output only; --format csv is not defined for it.",
    );
  }
  const timezone = str(parsed, "timezone") ?? "UTC";
  if (!isValidTimezone(timezone)) {
    throw new CliError(`Invalid --timezone value: ${timezone}.`, {
      hint: "Use an IANA timezone, e.g. America/New_York or Europe/Berlin.",
    });
  }

  const since = str(parsed, "since");
  const until = str(parsed, "until");
  const sinceMs = since === undefined ? null : parseSince(since, timezone);
  const untilMs = until === undefined ? null : parseUntil(until, timezone);
  const last = str(parsed, "last");
  const lastSinceMs = last === undefined ? null : parseLast(last, new Date()).sinceMs;
  assertWindowOrder(sinceMs, untilMs);

  const pricesFile = str(parsed, "prices-file");
  const snapshot = pricesFile
    ? readSnapshotFile(pricesFile, basename(pricesFile), (p) => readFileSync(p, "utf8"))
    : BUNDLED_SNAPSHOT;
  const overrides = loadPriceOverrides();

  // One sync, one store read — the same engine every section shares.
  // #87: validate the profile even when sync is skipped or fails open.
  const profileName = str(parsed, "profile");
  if (profileName !== undefined) assertSafeProfileName(profileName);
  const sync = await runPreReadSync(profileName, bool(parsed, "no-sync"));

  const rows = loadRequestRows(
    {
      agents: [...list(parsed, "agent"), ...list(parsed, "harness")],
      models: list(parsed, "model"),
    },
    {
      sinceMs:
        sinceMs !== null && lastSinceMs !== null
          ? Math.max(sinceMs, lastSinceMs)
          : (sinceMs ?? lastSinceMs),
      untilMs,
    },
  ).map((row) => ({
    model: row.model,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cached_tokens: row.cached_tokens,
    cost_value: row.cost_value,
    currency: row.currency,
  }));
  const result = computeVsList(rows, snapshot, overrides);

  const syncWarning = syncWarningLine(
    computeCoverage("30days", { now: new Date(), sync: sync ?? undefined }),
  );
  if (syncWarning) err(style.yellow(`Warning: ${syncWarning}`));

  const windowSince = sinceMs ?? lastSinceMs;
  const payload = {
    meta: {
      snapshot_name: result.snapshotName,
      snapshot_date: result.snapshotDate,
      window: {
        since: windowSince === null ? null : new Date(windowSince).toISOString(),
        until: untilMs === null ? null : new Date(untilMs).toISOString(),
        timezone,
      },
      provenance: {
        billed: formatLabel(gatewayBilled("sum of the gateway-computed per-request cost")),
        equivalent: formatLabel(
          estimated(
            `vendor-list-price ${result.snapshotName}@${result.snapshotDate} applied to stored tokens`,
          ),
        ),
        savings: formatLabel(estimated("list-price equivalent minus gateway-billed cost")),
      },
    },
    rows: result.rows,
    totals: result.totals,
  };
  const filter = str(parsed, "jq");
  if (filter !== undefined || bool(parsed, "json")) {
    if (filter !== undefined) return json(applyJqPath(payload, parseJqPath(filter)));
    return json(payload);
  }

  out(style.bold("List-price comparison"));
  out(
    style.dim(
      `snapshot ${result.snapshotName}@${result.snapshotDate}` +
        `  ·  equivalent = estimated(vendor-list-price)` +
        `  ·  billed = gateway-billed`,
    ),
  );
  out();
  if (result.rows.length === 0) {
    out(style.dim("No matching requests."));
    return;
  }
  table(
    [
      ...result.rows.map((row) => ({
        model: row.model,
        requests: row.requests,
        input: row.input_tokens,
        output: row.output_tokens,
        cached: row.cached_tokens,
        billed: row.billed === null ? "-" : `${USD} ${formatMoney(row.billed)}`,
        equivalent: row.equivalent === null ? "unpriced" : `${USD} ${formatMoney(row.equivalent)}`,
        savings:
          row.savings === null
            ? row.status === "partial"
              ? "partial"
              : "-"
            : `${USD} ${formatMoney(row.savings)}`,
        status: row.status,
      })),
    ],
    [
      { header: "model", value: (r) => r.model },
      { header: "requests", value: (r) => num(r.requests), align: "right" },
      { header: "input tok", value: (r) => num(r.input), align: "right" },
      { header: "output tok", value: (r) => num(r.output), align: "right" },
      { header: "cached tok", value: (r) => num(r.cached), align: "right" },
      { header: "billed", value: (r) => r.billed, align: "right" },
      { header: "equivalent", value: (r) => r.equivalent, align: "right" },
      { header: "savings", value: (r) => r.savings, align: "right" },
      { header: "status", value: (r) => r.status },
    ],
  );
  const totals = result.totals;
  out();
  out(
    style.dim(
      `total billed ${totals.billed === null ? "-" : formatMoney(totals.billed)} ${USD}` +
        `  ·  equivalent ${totals.equivalent === null ? "unpriced" : formatMoney(totals.equivalent)} ${USD}` +
        `  ·  savings ${totals.savings === null ? "-" : formatMoney(totals.savings)} ${USD}` +
        " (savings only where both sides are priced)",
    ),
  );
  for (const row of result.rows) {
    if (row.reason) out(style.dim(`unpriced/partial (${row.model}): ${row.reason}`));
  }
  if (Object.keys(overrides).length > 0) {
    out(
      style.dim(
        `user overrides applied: ${Object.keys(overrides).join(", ")} (estimated(user-override))`,
      ),
    );
  }
}
