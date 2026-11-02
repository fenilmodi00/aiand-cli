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
  type CompareVerdicts,
  compareVerdicts,
  type ExcludedMixedAggregate,
  type HarnessRequestRow,
  type HarnessStats,
  type HarnessStatsOptions,
  type HarnessStatsRow,
  type SessionSample,
  WINNER_MARKER,
} from "../obs/harness-stats.js";
import {
  buildRegressionReport,
  type RegressionMetric,
  type RegressionReport,
  type RegressionRow,
  type RegressionVerdict,
} from "../obs/regression.js";
import { listEnvelopesFromDb } from "../store/envelopes.js";
import {
  type ImportedArtifactRow,
  listImportedArtifactsFromDb,
} from "../store/imported-artifacts.js";
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
 * #146: behavioral markers imported by `aiand harness import` inside the
 * window, read through the dedicated reader (fail-open — a missing table or
 * an old store contributes zero markers, never an error). The window rides
 * `COALESCE(at, imported_at)` inside the reader.
 */
export function windowImportedMarkers(
  sinceMs: number | null,
  untilMs: number | null,
): ImportedArtifactRow[] {
  const opened = openStore(storePath());
  if (!opened.ok) return [];
  try {
    return listImportedArtifactsFromDb(opened.db, {
      since: sinceMs === null ? undefined : new Date(sinceMs).toISOString(),
      until: untilMs === null ? undefined : new Date(untilMs).toISOString(),
    });
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
    // #151: stateless two-window screen — `--baseline` names the preceding
    // window (previous | 30m | 12h | 1d | 7d | 30d | 4w); no snapshot is saved.
    baseline: { type: "string" },
    "fail-on-regression": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(workloadHelp(mode));
  if (parsed.positionals.length > 0) {
    throw new CliError(`Unknown argument "${parsed.positionals[0]}".`, {
      hint: `Run \`aiand harness ${mode} --help\` to see the subcommands and flags.`,
    });
  }
  const baselineToken = str(parsed, "baseline");
  const failOnRegression = bool(parsed, "fail-on-regression");

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

  // #151: the regression screen rides compare mode only, needs a bounded
  // current window (there is no edge otherwise), and has no table exporter.
  if (mode !== "compare" && (baselineToken !== undefined || failOnRegression)) {
    throw new CliError("--baseline and --fail-on-regression are harness compare flags.", {
      hint: "Run `aiand harness compare --baseline previous` instead.",
    });
  }
  if (baselineToken !== undefined && sinceMs === null) {
    throw new CliError(
      "compare --baseline needs a bounded current window (--last or --since/--until).",
      { exitCode: EXIT.NO_DATA },
    );
  }
  if (baselineToken !== undefined && outPath !== undefined) {
    throw new CliError("--baseline cannot be combined with --out.", {
      hint: "Use `--json` for machine-readable baseline rows.",
    });
  }

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
    importedMarkers: windowImportedMarkers(sinceMs, untilMs),
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

  if (mode === "compare" && harnesses.length < 2 && baselineToken === undefined) {
    throw new CliError(
      `harness compare needs at least 2 harnesses with requests in range — found ${harnesses.length}.`,
      {
        hint: "Widen the window (--last 30d), sync more history, or wire another agent with `aiand init`.",
        exitCode: EXIT.ERROR,
      },
    );
  }

  // #151: the baseline window is the span immediately before the current one
  // (equal length for `previous`, the token's own span otherwise). Stateless:
  // no snapshot file, no extra state. Both windows read through the same
  // filters, cohort predicate, markers, and gap.
  let baselineWindow: { sinceMs: number; untilMs: number } | null = null;
  let baselineReport: RegressionReport | null = null;
  if (baselineToken !== undefined && sinceMs !== null) {
    const until = untilMs ?? Date.now();
    const token = baselineToken.trim();
    if (token.length === 0) {
      throw new CliError("--baseline needs a window token.", {
        hint: "Use previous, 30m, 12h, 1d, 7d, 30d, or 4w.",
      });
    }
    let span: number;
    if (token === "previous") {
      span = until - sinceMs;
    } else {
      try {
        span = until - parseLast(token, new Date(until)).sinceMs;
      } catch (error) {
        throw new CliError(`Unknown baseline window "${token}".`, {
          hint: `Use previous, 30m, 12h, 1d, 7d, 30d, or 4w (${error instanceof Error ? error.message : String(error)}).`,
        });
      }
    }
    if (!(span > 0)) {
      throw new CliError(`Baseline window "${token}" resolves to an empty span.`, {
        hint: "Use previous, 30m, 12h, 1d, 7d, 30d, or 4w.",
      });
    }
    baselineWindow = { sinceMs: sinceMs - span, untilMs: sinceMs };
    const filters = { agents: list(parsed, "agent"), models: list(parsed, "model") };
    // The store reader's upper bound is inclusive (#92); the baseline must end
    // where the current window starts, otherwise a request exactly on the edge
    // is screened in both windows.
    const baselineRows = readHarnessRows(baselineWindow, filters).filter(
      (row) => Date.parse(row.created_at) < sinceMs,
    );
    if (baselineRows.length === 0) {
      throw new CliError(
        `compare --baseline: no requests in the baseline window (${describeRange(baselineWindow.sinceMs, baselineWindow.untilMs)}).`,
        { exitCode: EXIT.NO_DATA },
      );
    }
    const baselineCohort =
      cohortCategory === undefined ? undefined : cohortOf(baselineRows, cohortCategory);
    baselineReport = buildRegressionReport(rows, baselineRows, {
      gapMinutes,
      timezone,
      cohort: baselineCohort === undefined ? undefined : (row) => baselineCohort.has(row.id),
      envelopesCurrent: windowEnvelopes(sinceMs, untilMs),
      envelopesBaseline: windowEnvelopes(baselineWindow.sinceMs, baselineWindow.untilMs),
      importedCurrent: windowImportedMarkers(sinceMs, untilMs),
      importedBaseline: windowImportedMarkers(baselineWindow.sinceMs, baselineWindow.untilMs),
    });
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

  if (bool(parsed, "json")) {
    const base = payload(stats, harnesses) as Record<string, unknown>;
    const withBaseline =
      baselineReport === null || baselineWindow === null
        ? base
        : {
            ...base,
            baseline: {
              range: {
                since: new Date(baselineWindow.sinceMs).toISOString(),
                until: new Date(baselineWindow.untilMs).toISOString(),
              },
              rows: baselineReport.rows,
              insufficient: baselineReport.insufficient,
              screened: baselineReport.screened,
              regressions: baselineReport.regressions.length,
              improvements: baselineReport.improvements.length,
            },
          };
    json(withBaseline);
    if (failOnRegression && baselineReport !== null && baselineReport.regressions.length > 0) {
      process.exitCode = EXIT.ERROR;
    }
    return;
  }

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
    out(style.dim(behavioralCoverageLine(stats.behavioralCoverage)));
  }
  if (bool(parsed, "samples")) renderSamples(harnesses);

  if (baselineReport !== null && baselineWindow !== null) {
    renderRegression(baselineReport, baselineWindow, noCost);
    if (failOnRegression && baselineReport.regressions.length > 0) {
      process.exitCode = EXIT.ERROR;
    }
  }

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
      labels: {
        behavioral:
          row.behavioral.behavioralSource === "imported"
            ? "heuristic(imported harness markers)"
            : "heuristic(one-shot/retry envelope rule)",
      },
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
    value: (r) =>
      bracketCell(r.costPerSession.p50, r.ci95.costPerSessionP50, (value) => value.toFixed(4)),
    align: "right",
  },
  {
    header: "p90",
    value: (r) => (r.costPerSession.p90 === null ? "—" : r.costPerSession.p90.toFixed(4)),
    align: "right",
  },
];

function renderStats(rows: HarnessStatsRow[], noCost: boolean): void {
  // #146: behavioral columns appear in stats mode too, when any harness's
  // cell is covered (envelope or imported source). Same cells as compare.
  const covered = rows.some(
    (r) =>
      r.behavioral.toolErrorRate !== null ||
      r.behavioral.oneShotRate !== null ||
      r.behavioral.cleanRate !== null,
  );
  const behavioralColumns: Column<HarnessStatsRow>[] = covered
    ? [
        {
          header: "tool-err",
          // Imported cells count against toolCalls; envelope cells against
          // envelope turns.
          value: (r) => rateCell(r.behavioral.toolErrorRate, behavioralN(r), r.ci95.toolErrorRate),
          align: "right",
        },
        {
          header: "one-shot",
          value: (r) => rateCell(r.behavioral.oneShotRate, r.behavioral.envelopeTurns),
          align: "right",
        },
        {
          header: "clean",
          value: (r) => rateCell(r.behavioral.cleanRate, terminalCount(r), r.ci95.cleanRate),
          align: "right",
        },
        {
          header: "outcome",
          value: (r) => outcomeCell(r.behavioral),
          align: "right",
        },
        {
          header: "compactions",
          value: (r) =>
            r.behavioral.compactions === null ? "—" : String(r.behavioral.compactions),
          align: "right",
        },
      ]
    : [];
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
      value: (r) => bracketCell(r.ttft.p50, r.ci95.ttftP50, (value) => `${value.toFixed(0)}ms`),
      align: "right",
    },
    {
      header: "p95",
      value: (r) => bracketCell(r.ttft.p95, r.ci95.ttftP95, (value) => `${value.toFixed(0)}ms`),
      align: "right",
    },
    {
      header: "hit",
      value: (r) => bracketCell(r.cacheHitRatio, r.ci95.cacheHitRatio, pct),
      align: "right",
    },
    {
      header: "errors",
      value: (r) => bracketCell(r.errorRate, r.ci95.errorRate, pct),
      align: "right",
    },
    {
      header: "verdict",
      value: (r) =>
        r.verdict === "good"
          ? style.green(r.verdict)
          : r.verdict === "bad"
            ? style.red(r.verdict)
            : style.yellow(r.verdict),
    },
    ...behavioralColumns,
  ]);
  out();
}

/** The rate cell with its n: em-dash when uncovered, never a fake zero. */
function rateCell(
  value: number | null,
  n: number,
  ci: { lo: number; hi: number } | null = null,
): string {
  return value === null ? "—" : `${bracketCell(value, ci, pct)} (n=${n})`;
}

/** The n behind a tool-error cell: imported → tool calls, envelope → turns. */
function behavioralN(row: HarnessStatsRow): number {
  return row.behavioral.behavioralSource === "imported"
    ? row.behavioral.toolCalls
    : row.behavioral.envelopeTurns;
}

/** The n behind a clean-rate cell: terminal outcomes behind the split. */
function terminalCount(row: HarnessStatsRow): number {
  const s = row.behavioral.sessions;
  return s === null ? 0 : s.clean + s.aborted + s.errored;
}

/**
 * The clean/aborted/errored split: a v1 sequence has no terminal info
 * (all-zero split, no success marker) — missing data, rendered as — not
 * 0/0/0.
 */
function outcomeCell(b: HarnessStatsRow["behavioral"]): string {
  if (b.sessions === null) return "—";
  const s = b.sessions;
  if (s.clean + s.aborted + s.errored === 0 && b.turnsToSuccess === null) return "—";
  return `${s.clean}/${s.aborted}/${s.errored}`;
}

/**
 * The compare-table columns, pure: the terminal renderer and every export
 * format build from this one definition so verdicts (▸), CI brackets, n=
 * counts, em-dash uncovered cells, and provenance survive into
 * markdown/csv/json unchanged. #147: `▸` rides the evidence-gated verdicts —
 * only a CI-disjoint leader is marked, and every metric cell carries its
 * bracket when the n supports one.
 */
function compareColumns(
  rows: readonly HarnessStatsRow[],
  noCost: boolean,
): Column<HarnessStatsRow>[] {
  const w = compareVerdicts(rows);
  // #146: covered when any behavioral cell is computable — envelope rates or
  // imported tool/clean data — not just oneShotRate anymore.
  const covered = rows.some(
    (r) =>
      r.behavioral.oneShotRate !== null ||
      r.behavioral.toolErrorRate !== null ||
      r.behavioral.cleanRate !== null,
  );
  const rate = rateCell;
  const behavioralColumns: Column<HarnessStatsRow>[] = covered
    ? [
        {
          header: "tool-err",
          value: (r) =>
            maybeMark(
              w.toolErrorRate.winner === r.harness,
              bracketCell(r.behavioral.toolErrorRate, r.ci95.toolErrorRate, pct) +
                rateSuffix(r.behavioral.toolErrorRate, behavioralN(r)),
            ),
          align: "right",
        },
        {
          header: "one-shot",
          value: (r) =>
            maybeMark(
              w.oneShotRate.winner === r.harness,
              rate(r.behavioral.oneShotRate, r.behavioral.envelopeTurns),
            ),
          align: "right",
        },
        {
          header: "missed-catch",
          value: (r) =>
            maybeMark(
              w.missedCatchRate.winner === r.harness,
              rate(r.behavioral.missedCatchRate, r.behavioral.envelopeTurns),
            ),
          align: "right",
        },
        {
          header: "turns/success",
          value: (r) =>
            maybeMark(
              w.turnsToSuccess.winner === r.harness,
              r.behavioral.turnsToSuccess === null ? "—" : String(r.behavioral.turnsToSuccess),
            ),
          align: "right",
        },
        {
          header: "outcome",
          value: (r) => outcomeCell(r.behavioral),
          align: "right",
        },
        {
          header: "clean",
          value: (r) =>
            bracketCell(r.behavioral.cleanRate, r.ci95.cleanRate, pct) +
            rateSuffix(r.behavioral.cleanRate, terminalCount(r)),
          align: "right",
        },
        {
          header: "compactions",
          value: (r) =>
            r.behavioral.compactions === null ? "—" : String(r.behavioral.compactions),
          align: "right",
        },
      ]
    : [];
  const costColumn: Column<HarnessStatsRow>[] = [
    {
      header: "cost/session p50",
      value: (r) =>
        maybeMark(
          w.costPerSessionP50.winner === r.harness,
          bracketCell(r.costPerSession.p50, r.ci95.costPerSessionP50, (v) => v.toFixed(4)),
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
          w.ttftP50.winner === r.harness,
          bracketCell(r.ttft.p50, r.ci95.ttftP50, (v) => `${v.toFixed(0)}ms`),
        ),
      align: "right",
    },
    {
      header: "hit",
      value: (r) =>
        maybeMark(
          w.cacheHitRatio.winner === r.harness,
          bracketCell(r.cacheHitRatio, r.ci95.cacheHitRatio, pct),
        ),
      align: "right",
    },
    {
      header: "errors",
      value: (r) =>
        maybeMark(
          w.errorRate.winner === r.harness,
          bracketCell(r.errorRate, r.ci95.errorRate, pct),
        ),
      align: "right",
    },
    ...behavioralColumns,
    { header: "requests", value: (r) => num(r.requests), align: "right" },
    { header: "sessions", value: (r) => num(r.sessions), align: "right" },
  ];
}

/**
 * The `(n=…)` suffix behind a rate cell, only when the rate exists — a
 * bracket without its n hides the sample size the interval rests on.
 */
function rateSuffix(value: number | null, n: number): string {
  return value === null ? "" : ` (n=${n})`;
}

/**
 * The #147 tied footer lines: one per metric whose anchor CI overlaps a rival
 * — the honest "no decision yet" note, deterministic order.
 */
function tiedFooterLines(verdicts: CompareVerdicts): string[] {
  const labels: Record<keyof CompareVerdicts, string> = {
    costPerSessionP50: "cost/session",
    errorRate: "errors",
    cacheHitRatio: "hit",
    ttftP50: "ttft p50",
    toolErrorRate: "tool-err",
    oneShotRate: "one-shot",
    missedCatchRate: "missed-catch",
    turnsToSuccess: "turns-to-success",
  };
  const lines: string[] = [];
  for (const [metric, verdict] of Object.entries(verdicts) as [
    keyof CompareVerdicts,
    { winner: string | null; tied: string[] },
  ][]) {
    if (verdict.winner === null && verdict.tied.length > 0) {
      lines.push(`${labels[metric]}: tied — not distinguishable yet (${verdict.tied.join(", ")})`);
    }
  }
  return lines;
}

/** The footer lines under the compare table (marker legend + provenance + ties). */
function compareFooterLines(covered: boolean, rows: readonly HarnessStatsRow[]): string[] {
  return [
    `${WINNER_MARKER} = evidence-gated winner (CI clear of every rival; lowest cost/session, lowest errors, highest hit, lowest ttft` +
      (covered
        ? "; behavioral: lowest tool-err/missed-catch/turns-to-success, highest one-shot — covered cells only"
        : "") +
      ")",
    ...tiedFooterLines(compareVerdicts(rows)),
    `rule (missed-catch): ${MISSED_CATCH_RULE} · provenance: heuristic(one-shot/retry envelope rule · imported harness markers)`,
  ];
}

function renderCompare(rows: HarnessStatsRow[], noCost: boolean): void {
  const columns = compareColumns(rows, noCost);
  table<HarnessStatsRow>(rows, columns);
  const covered = rows.some(
    (r) => r.behavioral.oneShotRate !== null || r.behavioral.cleanRate !== null,
  );
  for (const line of compareFooterLines(covered, rows)) {
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
  coverage: HarnessStats["behavioralCoverage"];
  cohort: TaskCategory | undefined;
  range: string;
  timezone: string;
  path: string;
  format: "markdown" | "csv" | "json";
}): void {
  const columns = compareColumns(args.rows, args.noCost);
  const covered = args.rows.some(
    (r) => r.behavioral.oneShotRate !== null || r.behavioral.cleanRate !== null,
  );
  const footers = compareFooterLines(covered, args.rows).concat(
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
          labels: "heuristic(one-shot/retry envelope rule · imported harness markers)",
        },
        harnesses: args.rows.map((row) => ({
          ...row,
          labels: {
            behavioral:
              row.behavioral.behavioralSource === "imported"
                ? "heuristic(imported harness markers)"
                : "heuristic(one-shot/retry envelope rule)",
          },
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
 * The #130/#146 coverage line: covered envelope turns / total in-scope
 * requests, plus the imported-marker side (distinct sessions) — the two
 * sources reported separately, never summed. Zero imported sessions get one
 * opt-in instruction line; uncovered cells render `—`, never a zero.
 */
function behavioralCoverageLine(coverage: {
  covered: number;
  total: number;
  ratio: number | null;
  envelopes: { covered: number; total: number };
  imported: { sessions: number; harnesses: number };
}): string {
  const pct =
    coverage.total > 0 && coverage.ratio !== null ? `${Math.round(coverage.ratio * 100)}%` : "n/a";
  const base =
    `behavioral columns: envelopes ${pct} of turns (${coverage.covered}/${coverage.total}), ` +
    `imported ${coverage.imported.sessions} session(s) across ${coverage.imported.harnesses} harness(es), uncovered → —`;
  return coverage.imported.sessions === 0
    ? `${base} · backfill with \`aiand harness import\``
    : base;
}

function maybeMark(isWinner: boolean, cell: string): string {
  return isWinner ? `${WINNER_MARKER} ${cell}` : cell;
}

/**
 * #147: a point estimate with its 95% CI bracket — `$1.20 [0.90–1.55]` style
 * via the given formatter. No CI (n < 5) renders the plain value: the bracket
 * must not imply evidence that doesn't exist.
 */
function bracketCell(
  value: number | null,
  ci: { lo: number; hi: number } | null,
  render: (value: number) => string,
): string {
  if (value === null) return "—";
  if (ci === null) return render(value);
  return `${render(value)} [${render(ci.lo)}–${render(ci.hi)}]`;
}

/** The percentage formatter for rate brackets (whole tenths, no symbol). */
function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
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

// ---------------------------------------------------------------------------
// #151 baseline regression watch
// ---------------------------------------------------------------------------

/** Money for cost metrics, percent for rates. */
function regressionFormat(metric: RegressionMetric): (value: number) => string {
  return metric === "costPerSession"
    ? (value) => `${currencySymbol("usd")}${value.toFixed(4)}`
    : pct;
}

/** The delta CI rendered with the metric's own formatter. */
function regressionCi(row: RegressionRow): string {
  const format = regressionFormat(row.metric);
  return `[${format(row.ci95.lo)}–${format(row.ci95.hi)}]`;
}

/** The verdict word with its color; noise stays dim, never alarming. */
function regressionVerdict(verdict: RegressionVerdict): string {
  if (verdict === "regression") return style.red("regression");
  if (verdict === "improvement") return style.green("improvement");
  return style.dim(verdict);
}

/**
 * The labeled `regression vs baseline` section: one row per
 * (harness, model, metric) with both windows' values, the bootstrap delta CI,
 * the per-window n, and the interval-gated verdict. A separate block — it is
 * a different question from "which harness wins today".
 */
function renderRegression(
  report: RegressionReport,
  baseline: { sinceMs: number; untilMs: number },
  noCost: boolean,
): void {
  const shown = noCost ? report.rows.filter((row) => row.metric !== "costPerSession") : report.rows;
  heading("regression vs baseline");
  out(
    style.dim(
      `  baseline ${describeRange(baseline.sinceMs, baseline.untilMs)} · screening, not proof · n>=5 both windows`,
    ),
  );
  if (shown.length === 0) {
    out(style.dim("  no metric has enough data in both windows to screen."));
  } else {
    table<RegressionRow>(shown, [
      { header: "harness/model", value: (row) => `${row.harness}/${row.model}` },
      { header: "metric", value: (row) => row.metric },
      {
        header: "current",
        value: (row) => regressionFormat(row.metric)(row.current),
        align: "right",
      },
      {
        header: "baseline",
        value: (row) => regressionFormat(row.metric)(row.baseline),
        align: "right",
      },
      {
        header: "delta",
        value: (row) => `${row.delta >= 0 ? "+" : ""}${regressionFormat(row.metric)(row.delta)}`,
        align: "right",
      },
      { header: "95% CI", value: regressionCi },
      { header: "n", value: (row) => `${row.n.current}/${row.n.baseline}`, align: "right" },
      { header: "verdict", value: (row) => regressionVerdict(row.verdict) },
    ]);
  }
  if (report.regressions.length > 0) {
    out(
      style.red(
        `regression: ${report.regressions.length} metric(s) worse — ` +
          report.regressions.map((row) => `${row.harness}/${row.model}/${row.metric}`).join(", "),
      ),
    );
  } else {
    out(style.dim("regression: none"));
  }
  if (report.insufficient > 0) {
    out(
      style.dim(`${report.insufficient} pair(s) below n>=5 in one window — skipped, not screened`),
    );
  }
  out();
}

function workloadHelp(mode: "stats" | "compare"): string {
  const baselineOptions =
    mode === "compare"
      ? `  --baseline <window>  screen the preceding window (previous | 30m | 12h | 1d |
                      7d | 30d | 4w) against the current one — a separate
                      "regression vs baseline" section with per-metric deltas,
                      95% CIs, and interval-gated verdicts (screening, not
                      proof); needs a bounded current window (--last/--since);
                      --json carries a \`baseline\` block
  --fail-on-regression  with --baseline: exit 1 when any metric regressed

`
      : "";
  return `${style.bold(`aiand harness ${mode}`)} — real-workload ${mode === "stats" ? "stats per harness" : "side-by-side harness comparison"}

Usage
  aiand harness ${mode} [--last <window>] [--harness <name>] [--agent <name>] [--model <glob>]
  aiand harness ${mode} --samples          (${mode === "stats" ? "stats" : "compare"}: list sessions behind the numbers)
  aiand harness ${mode} --json

Options
${baselineOptions}  --since <iso>       window start (interpreted in --timezone)
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
thresholds. Costs are gateway-billed store sums; ratios are estimated(derived).

Behavioral columns (tool-err, one-shot, clean, outcome, compactions) read
two opt-in local sources with envelope data winning per harness, never both
summed: captured adapter envelopes, and the markers \`aiand harness import\`
backfilled from the harnesses' own session files (tool outcomes, terminal
states, compactions — no prompts or contents). Uncovered cells render \`—\`.`;
}
