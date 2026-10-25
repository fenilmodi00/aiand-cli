import {
  ANALYTICS_RANGES,
  type AnalyticsMetric,
  getMetrics,
  getSummary,
} from "../api/analytics.js";
import { openSession } from "../api/client.js";
import { bool, oneOf, type Parsed, parse, str } from "../cli/args.js";
import { CliError, EXIT } from "../cli/errors.js";
import { delta, err, json, num, out, sparkline, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { noSyncRequested } from "../store/index.js";
import { reconcileUsage, VERIFY_RANGES, type VerifyRow } from "../store/reconcile.js";

export const help = `${style.bold("aiand usage")} -- request and token usage for your org

Usage
  aiand usage
  aiand usage --range 30days
  aiand usage --metrics
  aiand usage --verify

Options
  --range <window>    1h, 24h, 7days (default), 30days, 3months
  --metrics           show the full metric breakdown instead of the summary
  --verify            reconciliation gate: compare local-store totals against
                      the gateway (/logs up to 30 days, /analytics/summary
                      up to 3months; default window 30days). Windows the
                      gateway cannot see are reported UNVERIFIABLE, never
                      skipped. Exits 1 when any metric mismatches, 0 when
                      everything reconciles.
  --since <iso>       with --verify: explicit window start (with --until)
  --until <iso>       with --verify: explicit window end (with --since)
  --no-sync           skip the pre-verify store sync and compare the local
                      store as-is (also AIAND_NO_SYNC=1)
  --json              machine-readable output

Percentages compare the window against the one immediately before it.
--verify never recomputes costs from price tables: both sides are sums of
gateway-billed values (tokens: input includes cached).`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    range: { type: "string" },
    metrics: { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    "no-sync": { type: "boolean", default: false },
    since: { type: "string" },
    until: { type: "string" },
  });
  if (bool(parsed, "help")) return out(help);

  if (bool(parsed, "verify")) {
    if (bool(parsed, "metrics")) {
      throw new CliError("--verify cannot be combined with --metrics.");
    }
    return runVerify(parsed);
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
