import { cacheVerdict } from "../api/cache-report.js";
import { openSession } from "../api/client.js";
import type { BenchResult } from "../benchmark/harness-bench.js";
import { loadSavedSweep, type SavedSweep } from "../benchmark/sweep-store.js";
import { bool, int, list, oneOf, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import type { Column } from "../cli/output.js";
import { currencySymbol, err, json, num, out, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import {
  annotatedPairRow,
  buildPairStats,
  MIN_SAMPLE_SESSIONS,
  type PairSortKey,
  type PairStatsRow,
  sortPairs,
} from "../obs/pair-stats.js";
import { getStoreInfo, noSyncRequested, syncStore } from "../store/index.js";
import { resolveGapMinutes, sessionizationNote } from "../store/sessions.js";
import { parseWindowFlags, readHarnessRows } from "./harness-stats.js";
import { applyJqPath, isValidTimezone, parseJqPath } from "./usage-report.js";

/**
 * `aiand harness matrix` (ticket #79, feature catalog C2): per-(harness,
 * model) statistics over the user's REAL workload, optionally joined —
 * in a SEPARATE, clearly-labeled block only — with the saved synthetic sweep
 * from `aiand harness --sweep-models`. The framing is "cheapest pair for
 * you": the user's own traffic, never a generic leaderboard.
 *
 * The aggregation is src/obs/pair-stats.ts, shared verbatim with
 * `aiand recommend` and the OBS-P2-3 HTML matrix section.
 */

const SORT_KEYS: readonly PairSortKey[] = ["cost", "ttft", "hit", "errors"];

const help = `${style.bold("aiand harness matrix")} -- (harness × model) pairs on your workload

Usage
  aiand harness matrix [--last 7d] [--harness <name>] [--model <glob>]
  aiand harness matrix --sort cost --order asc --top 10
  aiand harness matrix --synthetic        (add the saved sweep in its own block)
  aiand harness matrix --format markdown
  aiand harness matrix --json --jq '.pairs[0]'

Options
  --since <iso>       window start (interpreted in --timezone)
  --until <iso>       window end
  --last <window>     30m, 12h, 1d, 7d, 30d, 4w (default: all stored history)
  --harness <name>    one harness only
  --model <glob>      repeatable model filter (* wildcards)
  --top <n>           keep only the first n rows after sorting
  --sort <key>        cost (default) | ttft | hit | errors
  --order <dir>       asc | desc (default: lower is better; hit: higher)
  --show p90          add the p90 columns (cost/session and ttft)
  --unpriced          include rows with no priced cost (cost shown as —)
  --synthetic         display the saved \`harness --sweep-models\` sweep in a
                      separate, labeled block — never mixed into the observed
                      rows or any ranking
  --timezone <tz>     IANA timezone for --since/--until interpretation
  --session-gap <min> session gap override (default 10, or sessionGapMinutes)
  --format <fmt>      table (default) | json | markdown
  --jq <path>         extract a path from the --json payload
  --no-sync           read the local store without syncing (AIAND_NO_SYNC=1)

Reading the numbers: sessions are the #66 time-gap heuristic (${sessionizationNote(10)});
sessions whose model mix spans models are EXCLUDED and counted in the footer,
never assigned to a model. Verdicts reuse the cache-report thresholds (warn
under 5 requests). Costs are gateway-billed store sums; ratios are estimated.
The error rate counts non-2xx statuses excluding 429 (a rate limit is not the
pair's quality). cost/session is the median; --show p90 adds the tail.`;

export async function runHarnessMatrix(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    harness: { type: "string" },
    model: { type: "string", multiple: true },
    timezone: { type: "string" },
    "session-gap": { type: "string" },
    top: { type: "string" },
    sort: { type: "string" },
    order: { type: "string" },
    show: { type: "string", multiple: true },
    unpriced: { type: "boolean", default: false },
    synthetic: { type: "boolean", default: false },
    format: { type: "string" },
    jq: { type: "string" },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const timezone = str(parsed, "timezone") ?? "UTC";
  if (!isValidTimezone(timezone)) {
    throw new CliError(`Unknown timezone "${timezone}".`, {
      hint: "Use an IANA name, e.g. Europe/Berlin.",
    });
  }

  const format = oneOf(parsed, "format", ["table", "json", "markdown"], "table");
  const sortKey = oneOf(parsed, "sort", SORT_KEYS, "cost") as PairSortKey;
  const order =
    str(parsed, "order") === undefined ? undefined : oneOf(parsed, "order", ["asc", "desc"], "asc");
  const showP90 = list(parsed, "show").includes("p90");
  const top = int(parsed, "top");
  if (top !== undefined && (top < 1 || !Number.isFinite(top))) {
    throw new CliError(`Invalid --top value: ${top}.`, { hint: "Use a positive number." });
  }

  await autoSync(parsed);

  const { sinceMs, untilMs } = parseWindowFlags(parsed, timezone);
  const rows = readHarnessRows({ sinceMs, untilMs }, { agents: [], models: list(parsed, "model") });
  const storeInfo = getStoreInfo();
  const gapMinutes = resolveGapMinutes(
    str(parsed, "session-gap") === undefined
      ? undefined
      : (int(parsed, "session-gap") ?? undefined),
  );

  const stats = buildPairStats(rows, {
    gapMinutes,
    timezone,
    storeWatermark: storeInfo.newestCreatedAt ?? storeInfo.lastSyncAt,
    range: {
      since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
      until: untilMs === null ? null : new Date(untilMs).toISOString(),
    },
  });

  let pairs = stats.pairs;
  const harnessFilter = str(parsed, "harness");
  if (harnessFilter !== undefined) pairs = pairs.filter((row) => row.harness === harnessFilter);

  // --unpriced: rows without a priced cost are hidden by default so the
  // "cheapest pair" framing never ranks on a guessed price (never-guess
  // pricing); the flag shows them explicitly with an em-dash cost.
  if (!bool(parsed, "unpriced")) pairs = pairs.filter((row) => row.costPerSession.p50 !== null);

  pairs = sortPairs(pairs, sortKey, order);
  if (top !== undefined) pairs = pairs.slice(0, top);

  const synthetic = bool(parsed, "synthetic") ? loadSavedSweep() : null;
  if (bool(parsed, "synthetic") && synthetic === null) {
    err(
      style.yellow(
        "no saved sweep found — run `aiand harness --sweep-models` first; showing observed rows only",
      ),
    );
  }

  // --json (the global convention) and --format json both select the JSON
  // payload; --jq implies it (same rule as `aiand usage`).
  const jsonOut = bool(parsed, "json") || format === "json" || str(parsed, "jq") !== undefined;
  if (jsonOut) {
    const payload = {
      provenance: stats.provenance,
      pairs: pairs.map(annotatedPairRow),
      excludedMixed: stats.provenance.excludedMixed,
      synthetic: syntheticPayload(synthetic),
    };
    const filter = str(parsed, "jq");
    return json(filter === undefined ? payload : applyJqPath(payload, parseJqPath(filter)));
  }

  const header = describeRange(sinceMs, untilMs);
  if (format === "markdown") {
    renderMarkdown(pairs, header, showP90, stats.provenance.excludedMixed);
  } else {
    renderTable(pairs, showP90);
    out();
    out(
      style.dim(
        `${stats.provenance.excludedMixed} mixed-model session(s) excluded — counted, assigned to no model`,
      ),
    );
    out(
      style.dim(
        `n = sessions per row · verdicts warn under 5 requests; ` +
          `\`aiand recommend\` needs ${MIN_SAMPLE_SESSIONS} sessions`,
      ),
    );
  }
  out();
  if (synthetic) renderSynthetic(synthetic, format);
}

// ---------------------------------------------------------------------------
// Auto-sync (same fail-open discipline as harness stats/compare)
// ---------------------------------------------------------------------------

async function autoSync(parsed: ReturnType<typeof parse>): Promise<void> {
  if (bool(parsed, "no-sync") || noSyncRequested()) return;
  try {
    const session = await openSession(resolveProfile(str(parsed, "profile")));
    const result = await syncStore(session);
    if (!result.ok)
      err(style.yellow(`store sync failed (${result.code ?? "error"}): ${result.error}`));
  } catch (error) {
    err(
      style.yellow(`store sync skipped: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
}

// ---------------------------------------------------------------------------
// JSON shaping — every row carries its provenance labels
// ---------------------------------------------------------------------------

function syntheticPayload(synthetic: SavedSweep | null): unknown {
  if (!synthetic) return null;
  return {
    savedAt: synthetic.savedAt,
    scenario: synthetic.scenario,
    label: "synthetic",
    rows: synthetic.sweep.flatMap(({ model, results }) =>
      results.map((result) => syntheticRow(result, model)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Synthetic block — display only, never a ranking input
// ---------------------------------------------------------------------------

function syntheticRow(
  result: BenchResult,
  model: string,
): {
  scenario: string;
  harness: string;
  model: string;
  dialect: string;
  requests: number;
  hitRatio: number;
  costUsd: number;
  savedUsd: number;
  verdict: "good" | "warn" | "bad";
} {
  const group = {
    key: `${result.harness}:${model}`,
    requests: result.requests,
    inputTokens: result.inputTokens,
    cachedTokens: result.cachedTokens,
    outputTokens: 0,
    costUsd: result.costUsd,
  };
  return {
    scenario: result.scenario,
    harness: result.label,
    model,
    dialect: result.dialect,
    requests: result.requests,
    hitRatio: result.hitRatio,
    costUsd: result.costUsd,
    savedUsd: result.savedUsd,
    verdict: cacheVerdict(group),
  };
}

function renderSynthetic(sweep: SavedSweep, format: "table" | "markdown"): void {
  out(style.bold("synthetic sweep (fixed scenario replay — NOT your workload)"));
  if (format === "markdown") {
    out("| harness | model | requests | hit-ratio | cost | verdict |");
    out("|---|---|---:|---:|---:|---|");
  }
  for (const { model, results } of sweep.sweep) {
    for (const result of results) {
      const row = syntheticRow(result, model);
      if (format === "markdown") {
        out(
          `| ${row.harness} | ${model} | ${row.requests} | ` +
            `${(row.hitRatio * 100).toFixed(1)}% | ${row.costUsd.toFixed(6)} | ${row.verdict} |`,
        );
      } else {
        out(
          `  ${row.harness} · ${model} · ${row.requests} requests · ` +
            `hit ${(row.hitRatio * 100).toFixed(1)}% · ` +
            `${currencySymbol("usd")}${row.costUsd.toFixed(6)} · ${row.verdict}`,
        );
      }
    }
  }
  out(
    style.dim("synthetic rows are display-only; they never join a ranking or `aiand recommend`."),
  );
  out();
}

// ---------------------------------------------------------------------------
// Table + markdown rendering
// ---------------------------------------------------------------------------

function costCell(row: PairStatsRow, key: "p50" | "p90"): string {
  const value = row.costPerSession[key];
  if (value === null) return "—";
  return `${currencySymbol(row.currency ?? "usd")}${value.toFixed(4)}`;
}

function ttftCell(row: PairStatsRow, key: "p50" | "p90" | "p95"): string {
  const value = row.ttft[key];
  return value === null ? "—" : `${value.toFixed(0)}ms`;
}

function verdictCell(row: PairStatsRow): string {
  return row.verdict === "good"
    ? style.green(row.verdict)
    : row.verdict === "bad"
      ? style.red(row.verdict)
      : style.yellow(row.verdict);
}

function pairColumns(showP90: boolean): Column<PairStatsRow>[] {
  return [
    { header: "harness", value: (r) => r.harness },
    { header: "model", value: (r) => r.model },
    { header: "n", value: (r) => num(r.sessions), align: "right" },
    { header: "cost/sess", value: (r) => costCell(r, "p50"), align: "right" },
    ...(showP90
      ? ([
          { header: "p90", value: (r: PairStatsRow) => costCell(r, "p90"), align: "right" },
        ] as Column<PairStatsRow>[])
      : []),
    { header: "tok/sess in", value: (r) => num(r.tokensPerSession.in), align: "right" },
    { header: "out", value: (r) => num(r.tokensPerSession.out), align: "right" },
    { header: "ttft p50", value: (r) => ttftCell(r, "p50"), align: "right" },
    { header: "p95", value: (r) => ttftCell(r, "p95"), align: "right" },
    ...(showP90
      ? ([
          { header: "p90", value: (r: PairStatsRow) => ttftCell(r, "p90"), align: "right" },
        ] as Column<PairStatsRow>[])
      : []),
    { header: "hit", value: (r) => `${(r.cacheHitRatio * 100).toFixed(1)}%`, align: "right" },
    { header: "errors", value: (r) => `${(r.errorRate * 100).toFixed(1)}%`, align: "right" },
    { header: "verdict", value: (r) => verdictCell(r) },
  ];
}

function renderTable(pairs: PairStatsRow[], showP90: boolean): void {
  table<PairStatsRow>(pairs, pairColumns(showP90));
}

function markdownTable(rows: PairStatsRow[], showP90: boolean): string[] {
  const columns: Column<PairStatsRow>[] = pairColumns(showP90).map((c) => ({
    header: c.header,
    align: c.align,
    value: (r: PairStatsRow) => stripAnsi(c.value(r)),
  }));
  const header = `| ${columns.map((c) => c.header).join(" | ")} |`;
  const align = `|${columns.map((c) => (c.align === "right" ? "---:" : "---")).join("|")}|`;
  const body = rows.map((row) => `| ${columns.map((c) => c.value(row)).join(" | ")} |`);
  return [header, align, ...body];
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderMarkdown(
  pairs: PairStatsRow[],
  header: string,
  showP90: boolean,
  excludedMixed: number,
): void {
  out(`### harness × model matrix — ${header}`);
  out();
  for (const line of markdownTable(pairs, showP90)) out(line);
  out();
  out(`_${excludedMixed} mixed-model session(s) excluded — counted, assigned to no model._`);
}

function describeRange(sinceMs: number | null, untilMs: number | null): string {
  if (sinceMs === null && untilMs === null) return "all stored history";
  const since = sinceMs === null ? "beginning" : new Date(sinceMs).toISOString().slice(0, 10);
  const until = untilMs === null ? "now" : new Date(untilMs).toISOString().slice(0, 10);
  return `${since} → ${until}`;
}
