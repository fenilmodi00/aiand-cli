import { currencySymbol } from "../cli/output.js";
import { formatMoneyFixed } from "../pricing/currency.js";
import { CHART_COLORS, lineChart } from "./charts.js";
import {
  type Costs,
  cumulativeSavings,
  harnessCostSeries,
  type ReportData,
  type ReportSection,
} from "./data.js";

/**
 * The offline HTML report (feature catalog F1, ticket #76) — CacheLane's
 * `render-html.ts` approach: one self-contained page, all CSS inline, all
 * charts inline SVG, no JS required, ZERO external requests (a test asserts
 * the file contains no http(s):// resource references at all).
 *
 * Provenance (#68): every monetary figure carries a badge; the footer is the
 * legend that explains all three tiers.
 */

export type HtmlOptions = {
  theme: "light" | "dark" | "auto";
  showCost: boolean;
  sections: readonly ReportSection[];
};

const PROVENANCE_TITLES: Record<string, string> = {
  requests: "count of gateway /logs rows in the local store",
  cost: "sum of the gateway-computed per-request cost; never recomputed",
  savings: "costIfUncached minus the gateway-billed cost; cached catalog prices",
  hit_ratio: "cached_tokens / input_tokens over the grouped rows",
  sessions: "groups of requests separated by an inactivity gap",
  budget: "projection from the burn-rate v1 heuristic, not a measurement",
};

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(value: number, currency: string): string {
  const symbol = currencySymbol(currency === "" ? null : currency);
  const code = currency === "" || currency === "usd" ? "" : `${esc(currency)} `;
  return `${code}${symbol}${formatMoneyFixed(value, 6)}`;
}

function costCell(costs: Costs): string {
  const entries = Object.entries(costs);
  if (entries.length === 0) return '<span class="muted">—</span>';
  return entries.map(([currency, value]) => money(value, currency)).join("; ");
}

function badge(kind: string): string {
  return `<span class="badge badge-${esc(kind.split("(")[0] ?? kind)}" title="${esc(
    PROVENANCE_TITLES[kind] ?? kind,
  )}">${esc(kind)}</span>`;
}

function fmtInt(value: number): string {
  return value.toLocaleString("en-US");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

const CSS = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 24px; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
  --bg: #ffffff; --fg: #20222e; --muted: #6b7280; --line: #d8dae3; --card: #f6f7fa;
  --badge-bg: #e8ecfa; --badge-fg: #33418f; background: var(--bg); color: var(--fg); }
body.theme-dark { --bg: #14161f; --fg: #e6e6f0; --muted: #9aa1b2; --line: #2c3040;
  --card: #1c1f2b; --badge-bg: #26304f; --badge-fg: #b9c6f5; }
@media (prefers-color-scheme: dark) { body.theme-auto { --bg: #14161f; --fg: #e6e6f0;
  --muted: #9aa1b2; --line: #2c3040; --card: #1c1f2b; --badge-bg: #26304f; --badge-fg: #b9c6f5; } }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 28px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.meta { color: var(--muted); margin: 0 0 16px; }
section { margin: 0 0 8px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; }
th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line);
  white-space: nowrap; }
th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
td.r, th.r { text-align: right; }
.badge { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 8px;
  background: var(--badge-bg); color: var(--badge-fg); cursor: help; margin-left: 6px;
  vertical-align: middle; }
.chart { max-width: 100%; height: auto; display: block; }
.plot-bg { fill: var(--card); }
.grid { stroke: var(--line); stroke-width: 1; }
.axis { fill: var(--muted); font-size: 11px; }
.legend { margin: 4px 0 12px; color: var(--muted); font-size: 12px; }
.legend-item { margin-right: 16px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px;
  margin-right: 5px; vertical-align: middle; }
.verdict-good { color: #1c7c3c; } .verdict-warn { color: #9a6b0a; } .verdict-bad { color: #b3261e; }
body.theme-dark .verdict-good { color: #6fd18a; }
body.theme-dark .verdict-warn { color: #e8c268; }
body.theme-dark .verdict-bad { color: #f28b84; }
@media (prefers-color-scheme: dark) { body.theme-auto .verdict-good { color: #6fd18a; }
  body.theme-auto .verdict-warn { color: #e8c268; }
  body.theme-auto .verdict-bad { color: #f28b84; } }
.note { color: var(--muted); font-size: 12px; margin: 6px 0; }
footer { margin-top: 32px; border-top: 1px solid var(--line); padding-top: 12px;
  color: var(--muted); font-size: 12px; }
.muted { color: var(--muted); }
`;

function sessionTable(data: ReportData): string {
  const rows = data.sessions
    .map(
      (session) => `<tr>
  <td title="${esc(session.session_id)}">${esc(session.session_id)}</td>
  <td>${esc(session.started_at.replace("T", " ").slice(0, 19))}</td>
  <td>${esc(session.agent)}</td>
  <td class="r">${fmtInt(session.turns)}</td>
  <td class="r">${fmtInt(session.input_tokens)}</td>
  <td class="r">${fmtInt(session.output_tokens)}</td>
  <td class="r">${fmtInt(session.cached_tokens)}</td>
  <td class="r">${
    session.cost === null
      ? '<span class="muted">—</span>'
      : costCell({ [session.currency ?? ""]: session.cost })
  }</td>
  <td class="r">${
    session.input_tokens > 0
      ? pct(session.cached_tokens / session.input_tokens)
      : '<span class="muted">—</span>'
  }</td>
</tr>`,
    )
    .join("\n");
  return `<table>
<thead><tr><th>session</th><th>started (UTC)</th><th>harness</th>
<th class="r">turns</th><th class="r">tokens in</th><th class="r">tokens out</th>
<th class="r">cached</th><th class="r">cost ${badge("cost")}</th>
<th class="r">hit-ratio ${badge("hit_ratio")}</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function matrixTable(data: ReportData, view: HtmlOptions): string {
  const rows = data.matrix
    .map(
      (row) => `<tr>
  <td>${esc(row.harness)}</td>
  <td>${esc(row.model)}</td>
  <td class="r">${fmtInt(row.requests)}</td>
  <td class="r">${fmtInt(row.inputTokens)}</td>
  <td class="r">${fmtInt(row.outputTokens)}</td>
  <td class="r">${fmtInt(row.cachedTokens)}</td>
  <td class="r">${row.hitRatio === null ? '<span class="muted">—</span>' : pct(row.hitRatio)}</td>
  <td class="r">${view.showCost ? costCell(row.costs) : '<span class="muted">masked</span>'}</td>
  <td class="r">${
    view.showCost && row.savings !== null
      ? money(row.savings, data.meta.currency ?? "usd")
      : '<span class="muted">—</span>'
  }</td>
  <td class="verdict-${row.verdict}">${row.verdict}</td>
</tr>`,
    )
    .join("\n");
  return `<table>
<thead><tr><th>harness</th><th>model</th><th class="r">requests</th>
<th class="r">tokens in</th><th class="r">tokens out</th><th class="r">cached</th>
<th class="r">hit-ratio ${badge("hit_ratio")}</th><th class="r">cost ${badge("cost")}</th>
<th class="r">savings ${badge("savings")}</th><th>verdict</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function budgetBlock(data: ReportData): string {
  const budget = data.budget;
  if (!budget.configured) {
    return `<p class="note">No budget configured — set one with <code>aiand config set budget.monthly &lt;amount&gt;</code>.</p>`;
  }
  if ("error" in budget) {
    return `<p class="note">${esc(budget.error)}</p>`;
  }
  const symbol =
    budget.currency === "usd" ? "$" : budget.currency ? `${esc(budget.currency)} ` : "";
  const share = budget.budget > 0 ? budget.currentSpend / budget.budget : 0;
  const projected =
    budget.projected === null
      ? ""
      : `<div>Projected month end: ${symbol}${budget.projected.toFixed(2)}</div>`;
  const exceed =
    budget.exceedDate === null ? "" : `<div>Crosses budget: ${esc(budget.exceedDate)}</div>`;
  return `<div>
  <div>Month to date: ${symbol}${budget.currentSpend.toFixed(2)} of ${symbol}${budget.budget.toFixed(
    2,
  )} (${pct(share)}) ${badge("cost")}</div>
  ${projected}
  ${exceed}
  <div class="verdict-${budget.verdict === "exceeding" ? "bad" : "good"}">${esc(
    budget.verdict,
  )} ${badge("budget")}</div>
  ${budget.pacing === null ? "" : `<div>${esc(budget.pacing)}</div>`}
</div>`;
}

function timeseriesSection(data: ReportData, view: HtmlOptions): string {
  if (data.days.length === 0) {
    return '<p class="note">No data in the selected range.</p>';
  }
  const labels = data.days.map((day) => day.day.slice(5));
  const formatY = (value: number): string => money(value, data.meta.currency ?? "usd");
  const parts: string[] = [];

  if (view.showCost && data.meta.currencyHandling !== "none") {
    const series = harnessCostSeries(data.harnessDays, data.days).map((entry, i) => ({
      label:
        data.meta.currencyHandling === "mixed"
          ? `${entry.harness} (${entry.currency || "unknown"})`
          : entry.harness,
      points: entry.points.map((point) => point.value),
      color: CHART_COLORS[i % CHART_COLORS.length]!,
    }));
    parts.push(`<h3>Daily cost by harness</h3>`);
    parts.push(lineChart({ series, xLabels: labels, yLabel: "daily cost", formatY }));
  }

  const cumulative = cumulativeSavings(data.days);
  if (view.showCost && cumulative.some((point) => point.value !== null)) {
    parts.push(`<h3>Cumulative savings</h3>`);
    parts.push(
      lineChart({
        series: [
          {
            label: `savings ${data.meta.currency ?? ""} (estimated)`,
            points: cumulative.map((point) => point.value),
            color: CHART_COLORS[2]!,
          },
        ],
        xLabels: labels,
        yLabel: "cumulative savings",
        formatY,
      }),
    );
  }
  if (parts.length === 0) {
    return '<p class="note">Cost display disabled (--no-cost).</p>';
  }
  return parts.join("\n");
}

/**
 * The whole page as ONE self-contained HTML string. No external references,
 * no scripts; charts are inline SVG.
 */
export function renderHtml(data: ReportData, options: HtmlOptions): string {
  const meta = data.meta;
  const since = meta.range.since === null ? "the beginning" : meta.range.since.slice(0, 10);
  const until = meta.range.until === null ? "now" : meta.range.until.slice(0, 10);
  const currencyNote =
    meta.currencyHandling === "mixed"
      ? "mixed currencies — costs are shown per currency, never summed"
      : meta.currencyHandling === "single"
        ? `currency ${meta.currency}`
        : "no cost data in range";

  const sections: string[] = [];
  if (options.sections.includes("timeseries")) {
    sections.push(
      `<section id="timeseries"><h2>Time series</h2>${timeseriesSection(data, options)}</section>`,
    );
  }
  if (options.sections.includes("matrix")) {
    sections.push(
      `<section id="matrix"><h2>Comparison matrix</h2><p class="note">${esc(meta.matrixNote)}</p>${
        data.matrix.length === 0 ? '<p class="note">No data.</p>' : matrixTable(data, options)
      }</section>`,
    );
  }
  if (options.sections.includes("sessions")) {
    const note = meta.sessionization
      ? `sessionization: inactivity gap ${meta.sessionization.gapMinutes} min (${meta.sessionization.confidence}).`
      : "";
    sections.push(
      `<section id="sessions"><h2>Most expensive sessions</h2><p class="note">${note} Sessions are groups of requests separated by an inactivity gap, not confirmed agent sessions.</p>${
        data.sessions.length === 0 ? '<p class="note">No data.</p>' : sessionTable(data)
      }</section>`,
    );
  }
  if (options.sections.includes("budget")) {
    sections.push(`<section id="budget"><h2>Budget pacing</h2>${budgetBlock(data)}</section>`);
  }

  const coverageNotes: string[] = [];
  if (meta.sync.status !== "synced") {
    coverageNotes.push(
      `store sync: ${esc(meta.sync.status)}${meta.sync.error ? ` (${esc(meta.sync.error)})` : ""} — showing local data only`,
    );
  }
  if (meta.lagSeconds !== null) {
    coverageNotes.push(
      `ingestion lag: ${Math.round(meta.lagSeconds)}s since the newest stored request`,
    );
  }
  if (meta.missingDays.length > 0) {
    coverageNotes.push(
      `no local data for ${meta.missingDays.length} day(s): ${esc(meta.missingDays.join(", "))} — absent from aggregates, not averaged over`,
    );
  }

  const legend = Object.entries(PROVENANCE_TITLES)
    .map(([kind, title]) => `${badge(kind)} ${esc(title)}`)
    .join("<br>");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ai&amp; usage report</title>
<style>${CSS}</style>
</head>
<body class="theme-${esc(options.theme)}">
<h1>ai&amp; usage report</h1>
<p class="meta">Generated ${esc(meta.generatedAt.replace("T", " ").slice(0, 19))}Z ·
range ${esc(since)} to ${esc(until)} · ${fmtInt(meta.rowCount)} requests ·
timezone ${esc(meta.timezone)} · ${esc(currencyNote)}</p>
${sections.join("\n")}
<footer>
<div>${legend}</div>
${coverageNotes.map((note) => `<div class="note">${note}</div>`).join("\n")}
${meta.savingsNote === null ? "" : `<div class="note">${esc(meta.savingsNote)}</div>`}
${meta.correlationNote ? `<div class="note">${esc(meta.correlationNote)}</div>` : ""}
<div class="note">Offline report — self-contained file, no external resources.</div>
</footer>
</body>
</html>
`;
}
