import {
  ANALYTICS_RANGES,
  type AnalyticsMetric,
  getMetrics,
  getSummary,
} from "../api/analytics.js";
import { openSession } from "../api/client.js";
import { bool, oneOf, parse, str } from "../cli/args.js";
import { delta, err, json, num, out, sparkline, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { storeBudgetWarning, storePacingSummary } from "../obs/forecast.js";
import {
  describeProvenance,
  formatLabel,
  PROVENANCE_CATALOG,
  type ProvenanceEntry,
  provenanceAudit,
} from "../obs/provenance.js";

export const help = `${style.bold("aiand usage")} -- request and token usage for your org

Usage
  aiand usage
  aiand usage --range 30days
  aiand usage --metrics
  aiand usage --audit

Options
  --range <window>    1h, 24h, 7days (default), 30days, 3months
  --metrics           show the full metric breakdown instead of the summary
  --audit             print the provenance table: every reported number, its
                      label (gateway-billed / estimated(<source>) /
                      heuristic(<name>)) and what it is computed from
  --json              machine-readable output

Percentages compare the window against the one immediately before it.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    range: { type: "string" },
    metrics: { type: "boolean", default: false },
    audit: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  if (bool(parsed, "audit")) {
    // Offline by design: the audit describes how numbers are made, it does
    // not fetch any.
    const rows = provenanceAudit();
    if (bool(parsed, "json")) return json(rows);
    return printAudit([...PROVENANCE_CATALOG]);
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
