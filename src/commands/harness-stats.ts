import { agentForMaskedKey } from "../api/agent-keys.js";
import { openSession } from "../api/client.js";
import { bool, int, list, oneOf, type Parsed, parse, str } from "../cli/args.js";
import { CliError, EXIT } from "../cli/errors.js";
import type { Column } from "../cli/output.js";
import { currencySymbol, err, heading, json, num, out, style, table } from "../cli/output.js";
import { inferExportFormat, toCsvRows, toMarkdownTable } from "../compare/table-export.js";
import { resolveProfile } from "../config.js";
import { writeFileAtomic } from "../fsutil.js";
import { MISSED_CATCH_RULE } from "../model-efficiency.js";
import {
  assertCategory,
  classifyEnvelope,
  TASK_CATEGORIES,
  type TaskCategory,
} from "../obs/classifier.js";
import {
  buildHarnessStats,
  compareWinners,
  type ExcludedMixedAggregate,
  type HarnessRequestRow,
  type HarnessStatsOptions,
  type HarnessStatsRow,
  type SessionSample,
  WINNER_MARKER,
} from "../obs/harness-stats.js";
import { listEnvelopesFromDb } from "../store/envelopes.js";
import {
  createdSince,
  createdUntilIncl,
  getStoreInfo,
  noSyncRequested,
  openStore,
  storePath,
  syncStore,
} from "../store/index.js";
import { resolveGapMinutes, sessionizationNote } from "../store/sessions.js";
import {
  assertWindowOrder,
  isValidTimezone,
  parseLast,
  parseSince,
  parseUntil,
} from "./usage-report.js";

/**
 * `aiand harness stats` / `aiand harness compare` (ticket #64): the benchmark
 * verdict machinery applied to the user's REAL workload in the local store.
 * The synthetic benchmark path lives in ./harness.ts; these subcommands read
 * the store (auto-sync fail-open, `--no-sync` honored) and never run requests.
 */

// ---------------------------------------------------------------------------
// Behavioral envelope read + cohort classification (#130)
// ---------------------------------------------------------------------------

/** The envelope-row shape `HarnessStatsOptions.envelopes` accepts. */
type EnvelopeOptionRow = HarnessStatsOptions["envelopes"] extends readonly (infer Row)[] | undefined
  ? Row
  : never;

/** Stored envelope rows inside the window, mapped to the options shape. */
export function windowEnvelopes(
  sinceMs: number | null,
  untilMs: number | null,
): EnvelopeOptionRow[] {
  const opened = openStore(storePath());
  if (!opened.ok) return [];
  try {
    return listEnvelopesFromDb(opened.db, {
      since: sinceMs === null ? undefined : new Date(sinceMs).toISOString(),
      until: untilMs === null ? undefined : new Date(untilMs).toISOString(),
    }).map((row) => ({ agent: row.agent, model: row.model, envelope: row.envelope }));
  } catch {
    return [];
  } finally {
    try {
      opened.db.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Classify each in-scope request row's session once (C6, deterministic
 * classifier over its envelope turns) and return the id set matching the
 * cohort. A row in an unclassified session is simply not in the set —
 * excluded, never folded. Shared by every --cohort consumer (compare,
 * matrix, recommend) so one classification pass feeds all of them.
 */
function cohortOf(rows: readonly HarnessRequestRow[], category: TaskCategory): Set<string> {
  const opened = openStore(storePath());
  const matching = new Set<string>();
  if (!opened.ok) return matching;
  try {
    const envelopes = listEnvelopesFromDb(opened.db);
    for (const row of rows) {
      // The row's session turns: envelopes attributed to this row's masked
      // key within the turn window (the same join branch-spend uses).
      const at = Date.parse(row.created_at);
      const turn = envelopes.find((e) => {
        if (e.api_key !== row.api_key) return false;
        const ts = Date.parse(e.created_at);
        return !Number.isNaN(ts) && ts <= at && at - ts <= 10 * 60_000;
      });
      if (turn?.envelope && classifyEnvelope(turn.envelope) === category) {
        matching.add(row.id);
      }
    }
  } catch {
    // fail-open: no classification → empty cohort
  } finally {
    try {
      opened.db.close();
    } catch {
      // already closed
    }
  }
  return matching;
}

/**
 * Parse the shared `--cohort <category>` flag and narrow the rows through
 * the classifier. Returns undefined when no flag was given; throws for an
 * unknown category. One definition for stats/compare, matrix, and recommend
 * — the same excluded-not-folded semantics everywhere (C6).
 */
export function cohortFromFlags(
  parsed: Parsed,
  rows: readonly HarnessRequestRow[],
): ((row: HarnessRequestRow) => boolean) | undefined {
  const category = str(parsed, "cohort");
  if (category === undefined) return undefined;
  const validated = assertCategory(category);
  if (validated === null) {
    throw new CliError(`Unknown cohort "${category}".`, {
      hint: `Categories: ${TASK_CATEGORIES.join(", ")}.`,
    });
  }
  const matching = cohortOf(rows, validated);
  return (row) => matching.has(row.id);
}

export async function runHarnessWorkload(mode: "stats" | "compare", argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    agent: { type: "string", multiple: true },
    harness: { type: "string" },
    model: { type: "string", multiple: true },
    timezone: { type: "string" },
    "session-gap": { type: "string" },
    cohort: { type: "string" },
    out: { type: "string" },
    format: { type: "string" },
    samples: { type: "boolean", default: false },
    "include-mixed": { type: "boolean", default: false },
    "no-cost": { type: "boolean", default: false },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(workloadHelp(mode));

  // #135: --out exports the compare table (--format markdown|csv|json, default
  // from the file extension). Only compare mode exports; stats stays stdout.
  const outPath = str(parsed, "out");
  const formatFlag = str(parsed, "format");
  if (outPath === undefined && formatFlag !== undefined) {
    throw new CliError("--format needs --out.", {
      hint: "Usage: aiand harness compare --out table.md [--format csv]",
    });
  }
  const exportFormat =
    outPath === undefined
      ? undefined
      : oneOf(
          parsed,
          "format",
          ["markdown", "csv", "json"],
          inferExportFormat(outPath, formatFlag),
        );

  const timezone = str(parsed, "timezone") ?? "UTC";
  if (!isValidTimezone(timezone)) {
    throw new CliError(`Unknown timezone "${timezone}".`, {
      hint: "Use an IANA name, e.g. Europe/Berlin.",
    });
  }

  const { sinceMs, untilMs } = parseWindowFlags(parsed, timezone);

  const gapMinutes = resolveGapMinutes(
    str(parsed, "session-gap") === undefined
      ? undefined
      : (int(parsed, "session-gap") ?? undefined),
  );

  // Auto-sync before read, fail-open: a failed sync warns on stderr and the
  // stats serve the local store as-is — never a failed command.
  if (!(bool(parsed, "no-sync") || noSyncRequested())) {
    try {
      const session = await openSession(resolveProfile(str(parsed, "profile")));
      const result = await syncStore(session);
      if (!result.ok)
        err(style.yellow(`store sync failed (${result.code ?? "error"}): ${result.error}`));
    } catch (error) {
      err(
        style.yellow(
          `store sync skipped: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  const window = { sinceMs, untilMs };
  const rows = readHarnessRows(window, {
    agents: list(parsed, "agent"),
    models: list(parsed, "model"),
  });
  const storeInfo = getStoreInfo();

  // #130: cohort seam (C6) — a named classifier category narrows the rows to
  // "same kind of work" before sessionization. Excluded rows are counted in
  // the coverage line, never folded silently. Validation rides the shared
  // cohortFromFlags helper (same rules for matrix/recommend).
  const cohortRaw = str(parsed, "cohort");
  let cohortCategory: TaskCategory | undefined;
  if (cohortRaw !== undefined) {
    const validated = assertCategory(cohortRaw);
    if (validated === null) {
      throw new CliError(`Unknown cohort "${cohortRaw}".`, {
        hint: `Categories: ${TASK_CATEGORIES.join(", ")}.`,
      });
    }
    cohortCategory = validated;
  }

  const stats = buildHarnessStats(rows, {
    gapMinutes,
    timezone,
    storeWatermark: storeInfo.newestCreatedAt ?? storeInfo.lastSyncAt,
    range: {
      since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
      until: untilMs === null ? null : new Date(untilMs).toISOString(),
    },
    cohort:
      cohortCategory === undefined
        ? undefined
        : (row) => cohortOf(rows, cohortCategory).has(row.id),
    envelopes: windowEnvelopes(sinceMs, untilMs),
  });

  // #100: an empty (or entirely filtered-out) window is a clean empty answer,
  // not an error — the same honest-empty contract `recommend` already follows.
  if (rows.length === 0) {
    if (bool(parsed, "json")) {
      return json({
        provenance: { ...stats.provenance, emptyWindow: true },
        harnesses: [],
        excluded: stats.excluded,
        excludedMixedSpend: stats.excludedMixed,
      });
    }
    out(
      style.yellow(
        mode === "compare"
          ? "harness compare: no requests in this window — nothing to compare."
          : "harness stats: no requests in this window.",
      ),
    );
    out(style.dim("Run `aiand store --sync`, wire an agent with `aiand init`, or widen --last."));
    return;
  }

  const harnessFilter = str(parsed, "harness");
  let harnesses = stats.harnesses;
  if (harnessFilter !== undefined) {
    harnesses = harnesses.filter((row) => row.harness === harnessFilter);
    if (harnesses.length === 0) {
      const known = stats.harnesses.map((row) => row.harness).join(", ") || "(none in range)";
      throw new CliError(`No requests attributed to harness "${harnessFilter}" in range.`, {
        hint: `Harnesses with data: ${known}. Wire more agents or widen the window.`,
      });
    }
  }

  if (mode === "compare" && harnesses.length < 2) {
    throw new CliError(
      `harness compare needs at least 2 harnesses with requests in range — found ${harnesses.length}.`,
      {
        hint: "Widen the window (--last 30d), sync more history, or wire another agent with `aiand init`.",
        exitCode: EXIT.ERROR,
      },
    );
  }

  // #135: --out exports the compare table (markdown/csv/json) and returns —
  // an explicit file target wins over terminal rendering, --json included.
  const noCost = bool(parsed, "no-cost");
  if (mode === "compare" && outPath !== undefined) {
    exportCompareTable({
      rows: harnesses,
      noCost,
      coverage: stats.behavioralCoverage,
      cohort: cohortCategory,
      range: describeRange(sinceMs, untilMs),
      timezone,
      path: outPath,
      format: exportFormat!,
    });
    return;
  }

  if (bool(parsed, "json")) return json(payload(stats, harnesses));

  out(
    style.bold(
      mode === "compare" ? "harness compare · your workload" : "harness stats · your workload",
    ),
  );
  out(
    style.dim(
      `  ${describeRange(sinceMs, untilMs)} · ${timezone} · ${sessionizationNote(gapMinutes)}`,
    ),
  );
  out();

  if (mode === "compare") {
    renderCompare(harnesses, noCost);
    out(style.dim(behavioralCoverageLine(stats.behavioralCoverage)));
    if (cohortCategory !== undefined) {
      const cohortRequests = stats.harnesses.reduce((s, h) => s + h.requests, 0);
      out(
        style.yellow(
          `cohort ${cohortCategory}: ${cohortRequests} of ${rows.length} request(s) match — ` +
            "excluded, not folded (C6)",
        ),
      );
    }
  } else {
    renderStats(harnesses, noCost);
  }
  if (bool(parsed, "samples")) renderSamples(harnesses);

  if (stats.provenance.excludedMixed > 0) {
    out(
      style.yellow(
        `excluded: ${stats.provenance.excludedMixed} mixed-model session(s) — counted, assigned to no harness`,
      ),
    );
    const excludedLine = excludedMixedLine(stats.excludedMixed, noCost);
    if (excludedLine !== null) out(style.yellow(excludedLine));
    if (bool(parsed, "include-mixed")) renderExcluded(stats.excluded, noCost);
  }
}

// ---------------------------------------------------------------------------
// Store access (shared with harness matrix / recommend — one query pass)
// ---------------------------------------------------------------------------

/**
 * The OBS-LT-4 reconciliation line: the gateway-billed spend of the
 * mixed-model sessions excluded from every pair/harness row — same
 * provenance as the pair costs, never folded into them. One definition,
 * shared by stats and compare. Empty when nothing was excluded.
 */
function excludedMixedLine(agg: ExcludedMixedAggregate, noCost: boolean): string | null {
  if (agg.sessions === 0) return null;
  const cost =
    noCost || agg.cost === null
      ? ""
      : ` · cost ${currencySymbol(agg.currency ?? "usd")}${agg.cost.toFixed(4)}`;
  return (
    `excluded mixed-model spend (${agg.sessions} session(s), gateway-billed, ` +
    `not in any row above): ${agg.requests} request(s), ` +
    `${num(agg.tokens.in)} in / ${num(agg.tokens.out)} out / ${num(agg.tokens.cached)} cached` +
    `${cost}`
  );
}

type RowFilters = { agents: string[]; models: string[] };

/** The one store read + filter shared by the harness stats commands. */
export function readHarnessRows(
  window: { sinceMs: number | null; untilMs: number | null },
  filters: RowFilters,
): HarnessRequestRow[] {
  const opened = openStore(storePath());
  if (!opened.ok) return [];
  const db = opened.db;
  try {
    const conditions: string[] = [];
    const args: (string | number)[] = [];
    if (window.sinceMs !== null) {
      conditions.push(createdSince());
      args.push(new Date(window.sinceMs).toISOString());
    }
    if (window.untilMs !== null) {
      conditions.push(createdUntilIncl());
      args.push(new Date(window.untilMs).toISOString());
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(
        "SELECT id, model, api_key, endpoint, created_at, input_tokens, output_tokens, cached_tokens, " +
          "cost, cost_value, currency, status_code, ttft_ms FROM requests" +
          where +
          " ORDER BY created_at, id",
      )
      .all(...args) as unknown as HarnessRequestRow[];
    const agents = filters.agents.length > 0 ? new Set(filters.agents) : null;
    const patterns = filters.models.map(globToRegExp);
    return rows.filter((row) => {
      if (
        agents &&
        !agents.has(
          row.api_key === null
            ? "unknown"
            : (agentForMaskedKey(row.api_key, row.endpoint) ?? "unknown"),
        )
      ) {
        return false;
      }
      if (patterns.length > 0 && !patterns.some((re) => re.test(row.model))) return false;
      return true;
    });
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * The shared --since/--until/--last window parse for the store-reading
 * harness subcommands (ticket #79 keeps matrix/recommend on the same rules).
 */
export function parseWindowFlags(
  parsed: ReturnType<typeof parse>,
  timezone: string,
): { sinceMs: number | null; untilMs: number | null } {
  const now = new Date();
  let sinceMs: number | null = null;
  let untilMs: number | null = null;
  if (str(parsed, "last") !== undefined) {
    sinceMs = parseLast(str(parsed, "last") ?? "7d", now).sinceMs;
  }
  if (str(parsed, "since") !== undefined)
    sinceMs = parseSince(str(parsed, "since") ?? "", timezone);
  if (str(parsed, "until") !== undefined)
    untilMs = parseUntil(str(parsed, "until") ?? "", timezone);
  assertWindowOrder(sinceMs, untilMs);
  return { sinceMs, untilMs };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The `--json` payload shape (provenance + harnesses + excluded) — one source of truth for the shape. */
function payload(
  stats: ReturnType<typeof buildHarnessStats>,
  harnesses: HarnessStatsRow[],
): unknown {
  return {
    provenance: stats.provenance,
    harnesses: harnesses.map((row) => ({
      ...row,
      labels: { behavioral: "heuristic(one-shot/retry envelope rule)" },
    })),
    excluded: stats.excluded,
    excludedMixedSpend: stats.excludedMixed,
    behavioralCoverage: stats.behavioralCoverage,
  };
}

function describeRange(sinceMs: number | null, untilMs: number | null): string {
  if (sinceMs === null && untilMs === null) return "all stored history";
  const since = sinceMs === null ? "beginning" : new Date(sinceMs).toISOString().slice(0, 10);
  const until = untilMs === null ? "now" : new Date(untilMs).toISOString().slice(0, 10);
  return `${since} → ${until}`;
}

function costCell(row: HarnessStatsRow): string {
  if (row.cost === null) return "—";
  return `${currencySymbol(row.currency ?? "usd")}${row.cost.toFixed(4)}`;
}

const statCostColumns: Column<HarnessStatsRow>[] = [
  { header: "cost", value: (r) => costCell(r), align: "right" },
  {
    header: "cost/session p50",
    value: (r) => (r.costPerSession.p50 === null ? "—" : r.costPerSession.p50.toFixed(4)),
    align: "right",
  },
  {
    header: "p90",
    value: (r) => (r.costPerSession.p90 === null ? "—" : r.costPerSession.p90.toFixed(4)),
    align: "right",
  },
];

function renderStats(rows: HarnessStatsRow[], noCost: boolean): void {
  table<HarnessStatsRow>(rows, [
    { header: "harness", value: (r) => r.harness },
    { header: "requests", value: (r) => num(r.requests), align: "right" },
    { header: "sessions", value: (r) => num(r.sessions), align: "right" },
    { header: "tokens in", value: (r) => num(r.tokens.in), align: "right" },
    { header: "out", value: (r) => num(r.tokens.out), align: "right" },
    { header: "cached", value: (r) => num(r.tokens.cached), align: "right" },
    ...(noCost ? [] : statCostColumns),
    {
      header: "ttft p50",
      value: (r) => (r.ttft.p50 === null ? "—" : `${r.ttft.p50.toFixed(0)}ms`),
      align: "right",
    },
    {
      header: "p95",
      value: (r) => (r.ttft.p95 === null ? "—" : `${r.ttft.p95.toFixed(0)}ms`),
      align: "right",
    },
    { header: "hit", value: (r) => `${(r.cacheHitRatio * 100).toFixed(1)}%`, align: "right" },
    { header: "errors", value: (r) => `${(r.errorRate * 100).toFixed(1)}%`, align: "right" },
    {
      header: "verdict",
      value: (r) =>
        r.verdict === "good"
          ? style.green(r.verdict)
          : r.verdict === "bad"
            ? style.red(r.verdict)
            : style.yellow(r.verdict),
    },
  ]);
  out();
}

/**
 * The compare-table columns, pure: the terminal renderer and every export
 * format build from this one definition so winners (▸), n= counts, em-dash
 * uncovered cells, and provenance survive into markdown/csv/json unchanged.
 */
function compareColumns(
  rows: readonly HarnessStatsRow[],
  noCost: boolean,
): Column<HarnessStatsRow>[] {
  const w = compareWinners(rows);
  const covered = rows.some((r) => r.behavioral.oneShotRate !== null);
  const rate = (value: number | null, n: number): string =>
    value === null ? "—" : `${(value * 100).toFixed(1)}% (n=${n})`;
  const outcome = (b: HarnessStatsRow["behavioral"]): string => {
    if (b.sessions === null) return "—";
    // A v1 sequence has no terminal info (all-zero split, no success marker)
    // — that's missing data, rendered as — not 0/0/0.
    const s = b.sessions;
    if (s.clean + s.aborted + s.errored === 0 && b.turnsToSuccess === null) return "—";
    return `${s.clean}/${s.aborted}/${s.errored}`;
  };
  const behavioralColumns: Column<HarnessStatsRow>[] = covered
    ? [
        {
          header: "tool-err",
          value: (r) =>
            maybeMark(
              w.toolErrorRate === r.harness,
              rate(r.behavioral.toolErrorRate, r.behavioral.envelopeTurns),
            ),
          align: "right",
        },
        {
          header: "one-shot",
          value: (r) =>
            maybeMark(
              w.oneShotRate === r.harness,
              rate(r.behavioral.oneShotRate, r.behavioral.envelopeTurns),
            ),
          align: "right",
        },
        {
          header: "missed-catch",
          value: (r) =>
            maybeMark(
              w.missedCatchRate === r.harness,
              rate(r.behavioral.missedCatchRate, r.behavioral.envelopeTurns),
            ),
          align: "right",
        },
        {
          header: "turns/success",
          value: (r) =>
            maybeMark(
              w.turnsToSuccess === r.harness,
              r.behavioral.turnsToSuccess === null ? "—" : String(r.behavioral.turnsToSuccess),
            ),
          align: "right",
        },
        {
          header: "outcome",
          value: (r) => outcome(r.behavioral),
          align: "right",
        },
      ]
    : [];
  const costColumn: Column<HarnessStatsRow>[] = [
    {
      header: "cost/session p50",
      value: (r) =>
        maybeMark(
          w.costPerSessionP50 === r.harness,
          r.costPerSession.p50 === null ? "—" : r.costPerSession.p50.toFixed(4),
        ),
      align: "right",
    },
  ];
  return [
    { header: "harness", value: (r) => r.harness },
    ...(noCost ? [] : costColumn),
    {
      header: "ttft p50",
      value: (r) =>
        maybeMark(
          w.ttftP50 === r.harness,
          r.ttft.p50 === null ? "—" : `${r.ttft.p50.toFixed(0)}ms`,
        ),
      align: "right",
    },
    {
      header: "hit",
      value: (r) =>
        maybeMark(w.cacheHitRatio === r.harness, `${(r.cacheHitRatio * 100).toFixed(1)}%`),
      align: "right",
    },
    {
      header: "errors",
      value: (r) => maybeMark(w.errorRate === r.harness, `${(r.errorRate * 100).toFixed(1)}%`),
      align: "right",
    },
    ...behavioralColumns,
    { header: "requests", value: (r) => num(r.requests), align: "right" },
    { header: "sessions", value: (r) => num(r.sessions), align: "right" },
  ];
}

/** The footer lines under the compare table (marker legend + provenance). */
function compareFooterLines(covered: boolean): string[] {
  return [
    `${WINNER_MARKER} = per-metric winner (lowest cost/session, lowest errors, highest hit, lowest ttft` +
      (covered
        ? "; behavioral: lowest tool-err/missed-catch/turns-to-success, highest one-shot — covered cells only"
        : "") +
      ")",
    `rule (missed-catch): ${MISSED_CATCH_RULE} · provenance: heuristic(one-shot/retry envelope rule)`,
  ];
}

function renderCompare(rows: HarnessStatsRow[], noCost: boolean): void {
  const columns = compareColumns(rows, noCost);
  table<HarnessStatsRow>(rows, columns);
  for (const line of compareFooterLines(rows.some((r) => r.behavioral.oneShotRate !== null))) {
    out(style.dim(line));
  }
  out();
}

/**
 * #135: write the compare table to a file. Markdown/csv carry the exact
 * rendered columns (winners, n=, provenance in the footer lines); the JSON
 * export is the same payload `--json` prints, plus the coverage/cohort
 * context lines. The synthetic sweep block never joins this table — it is
 * display-only in `harness matrix --synthetic` and has no export here.
 */
function exportCompareTable(args: {
  rows: HarnessStatsRow[];
  noCost: boolean;
  coverage: { covered: number; total: number; ratio: number | null };
  cohort: TaskCategory | undefined;
  range: string;
  timezone: string;
  path: string;
  format: "markdown" | "csv" | "json";
}): void {
  const columns = compareColumns(args.rows, args.noCost);
  const covered = args.rows.some((r) => r.behavioral.oneShotRate !== null);
  const footers = compareFooterLines(covered).concat(
    behavioralCoverageLine(args.coverage),
    args.cohort === undefined
      ? []
      : [
          `cohort ${args.cohort}: ${args.rows.reduce((s, h) => s + h.requests, 0)} request(s) match — excluded, not folded (C6)`,
        ],
  );
  const headers = columns.map((c) => c.header);
  const aligns = columns.map((c) => c.align ?? "left");
  const cellRows = args.rows.map((row) => columns.map((c) => c.value(row)));

  let body: string;
  if (args.format === "json") {
    body = `${JSON.stringify(
      {
        provenance: {
          range: args.range,
          timezone: args.timezone,
          behavioralCoverage: args.coverage,
          cohort: args.cohort ?? null,
          missedCatchRule: MISSED_CATCH_RULE,
          labels: "heuristic(one-shot/retry envelope rule)",
        },
        harnesses: args.rows.map((row) => ({
          ...row,
          labels: { behavioral: "heuristic(one-shot/retry envelope rule)" },
        })),
        notes: footers,
      },
      null,
      2,
    )}\n`;
  } else {
    const lines =
      args.format === "markdown"
        ? [
            `### harness compare — ${args.range} (${args.timezone})`,
            "",
            ...toMarkdownTable(headers, aligns, cellRows),
            "",
            ...footers.map((f) => `> ${f}`),
          ]
        : toCsvRows(headers, cellRows);
    body = `${lines.join("\n")}\n`;
  }
  void writeFileAtomic(args.path, body).then(() => {
    err(
      style.green(
        `Wrote compare table (${args.format}, ${args.rows.length} row(s)) to ${args.path}.`,
      ),
    );
  });
}

/**
 * The #130 coverage line: covered envelope turns / total in-scope requests —
 * honest math, uncovered cells render `—`, never a zero.
 */
function behavioralCoverageLine(coverage: {
  covered: number;
  total: number;
  ratio: number | null;
}): string {
  const pct =
    coverage.total > 0 && coverage.ratio !== null ? `${Math.round(coverage.ratio * 100)}%` : "n/a";
  return `behavioral columns: envelopes ${pct} of turns (${coverage.covered}/${coverage.total}), uncovered → —`;
}

function maybeMark(isWinner: boolean, cell: string): string {
  return isWinner ? `${WINNER_MARKER} ${cell}` : cell;
}

function renderSamples(rows: HarnessStatsRow[]): void {
  heading("samples — the sessions behind each median/P90");
  for (const row of rows) {
    out(style.dim(`${row.harness} · ${row.samples.length} session(s)`));
    table<SessionSample>(row.samples, [
      { header: "session", value: (s) => s.session_id },
      { header: "models", value: (s) => s.models.join(" + ") },
      { header: "turns", value: (s) => num(s.turns), align: "right" },
      {
        header: "cost",
        value: (s) =>
          s.cost === null ? "—" : `${currencySymbol(s.currency ?? "usd")}${s.cost.toFixed(4)}`,
        align: "right",
      },
      { header: "started", value: (s) => s.started_at },
    ]);
    out();
  }
}

function renderExcluded(excluded: SessionSample[], noCost: boolean): void {
  heading("mixed-model sessions (excluded from all aggregates)");
  const excludedCostColumn: Column<SessionSample>[] = [
    {
      header: "cost",
      value: (s) =>
        s.cost === null ? "—" : `${currencySymbol(s.currency ?? "usd")}${s.cost.toFixed(4)}`,
      align: "right",
    },
  ];
  table<SessionSample>(excluded, [
    { header: "session", value: (s) => s.session_id },
    { header: "models", value: (s) => s.models.join(" + ") },
    { header: "turns", value: (s) => num(s.turns), align: "right" },
    ...(noCost ? [] : excludedCostColumn),
    { header: "started", value: (s) => s.started_at },
  ]);
  out();
}

function workloadHelp(mode: "stats" | "compare"): string {
  return `${style.bold(`aiand harness ${mode}`)} — real-workload ${mode === "stats" ? "stats per harness" : "side-by-side harness comparison"}

Usage
  aiand harness ${mode} [--last <window>] [--harness <name>] [--agent <name>] [--model <glob>]
  aiand harness ${mode} --samples          (${mode === "stats" ? "stats" : "compare"}: list sessions behind the numbers)
  aiand harness ${mode} --json

Options
  --since <iso>       window start (interpreted in --timezone)
  --until <iso>       window end
  --last <window>     30m, 12h, 1d, 7d, 30d, 4w (default: all stored history)
  --harness <name>    one harness only (stats)
  --agent <name>      repeatable; masked-key attribution filter
  --model <glob>      repeatable model filter (* wildcards)
  --timezone <tz>     IANA timezone for --since/--until interpretation
  --cohort <category> rank same-kind-of-work rows only (classifier category:
                      Coding, Debugging, Testing, …) — excluded, not folded
  --session-gap <min> session gap override (default 10, or sessionGapMinutes)
  --samples           print the contributing sessions per harness
  --include-mixed     also print the excluded mixed-model sessions
  --no-cost           hide all cost columns
  --no-sync           read the local store without syncing (AIAND_NO_SYNC=1)
  --json              machine-readable output

Sessions are the #66 time-gap heuristic; mixed-model sessions are excluded
from every aggregate and counted explicitly — the footer also shows their
gateway-billed spend (in --json under \`excludedMixedSpend\`) so totals
reconcile with \`usage\`. Verdicts reuse the cache-report
thresholds. Costs are gateway-billed store sums; ratios are estimated(derived).`;
}
