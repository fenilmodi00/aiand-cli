import { agentForMaskedKey } from "../api/agent-keys.js";
import { openSession } from "../api/client.js";
import { bool, int, list, parse, str } from "../cli/args.js";
import { CliError, EXIT } from "../cli/errors.js";
import type { Column } from "../cli/output.js";
import { currencySymbol, err, json, num, out, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import {
  buildHarnessStats,
  compareWinners,
  type HarnessRequestRow,
  type HarnessStatsRow,
  type SessionSample,
  WINNER_MARKER,
} from "../obs/harness-stats.js";
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
import { assertWindowOrder, isValidTimezone, parseLast, parseSince, parseUntil } from "./usage-report.js";

/**
 * `aiand harness stats` / `aiand harness compare` (ticket #64): the benchmark
 * verdict machinery applied to the user's REAL workload in the local store.
 * The synthetic benchmark path lives in ./harness.ts; these subcommands read
 * the store (auto-sync fail-open, `--no-sync` honored) and never run requests.
 */

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
    samples: { type: "boolean", default: false },
    "include-mixed": { type: "boolean", default: false },
    "no-cost": { type: "boolean", default: false },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(workloadHelp(mode));

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
      else if (result.error)
        err(style.yellow(`Warning: sync stopped early (stuck cursor) — history may be incomplete: ${result.error}`)); // #85
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

  const stats = buildHarnessStats(rows, {
    gapMinutes,
    timezone,
    storeWatermark: storeInfo.newestCreatedAt ?? storeInfo.lastSyncAt,
    range: {
      since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
      until: untilMs === null ? null : new Date(untilMs).toISOString(),
    },
  });

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

  if (bool(parsed, "json")) return json(payload(stats, harnesses));

  const noCost = bool(parsed, "no-cost");
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
    if (bool(parsed, "include-mixed")) renderExcluded(stats.excluded, noCost);
  }
}

// ---------------------------------------------------------------------------
// Store access (shared with harness matrix / recommend — one query pass)
// ---------------------------------------------------------------------------

type RowFilters = { agents: string[]; models: string[] };

/** The one store read + filter (exported for the MCP harness_compare tool, #70). */
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
        "SELECT id, model, api_key, created_at, input_tokens, output_tokens, cached_tokens, " +
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
          row.api_key === null ? "unknown" : (agentForMaskedKey(row.api_key) ?? "unknown"),
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

/**
 * The `--json` payload shape (provenance + harnesses + excluded), exported so
 * the MCP `harness_compare` tool (ticket #70) emits the exact same document —
 * one source of truth for the shape.
 */
export function payload(
  stats: ReturnType<typeof buildHarnessStats>,
  harnesses: HarnessStatsRow[],
): unknown {
  return {
    provenance: stats.provenance,
    harnesses: harnesses.map((row) => ({ ...row })),
    excluded: stats.excluded,
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

function renderCompare(rows: HarnessStatsRow[], noCost: boolean): void {
  const w = compareWinners(rows);
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
  table<HarnessStatsRow>(rows, [
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
    { header: "requests", value: (r) => num(r.requests), align: "right" },
    { header: "sessions", value: (r) => num(r.sessions), align: "right" },
  ]);
  out(
    style.dim(
      `${WINNER_MARKER} = per-metric winner (lowest cost/session, lowest errors, highest hit, lowest ttft)`,
    ),
  );
  out();
}

function maybeMark(isWinner: boolean, cell: string): string {
  return isWinner ? `${WINNER_MARKER} ${cell}` : cell;
}

function renderSamples(rows: HarnessStatsRow[]): void {
  out(style.bold("samples — the sessions behind each median/P90"));
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
  out(style.bold("mixed-model sessions (excluded from all aggregates)"));
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
  aiand harness ${mode} [--last 7d] [--harness <name>] [--agent <name>] [--model <glob>]
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
  --session-gap <min> session gap override (default 10, or sessionGapMinutes)
  --samples           print the contributing sessions per harness
  --include-mixed     also print the excluded mixed-model sessions
  --no-cost           hide all cost columns
  --no-sync           read the local store without syncing (AIAND_NO_SYNC=1)
  --json              machine-readable output

Sessions are the #66 time-gap heuristic; mixed-model sessions are excluded
from every aggregate and counted explicitly. Verdicts reuse the cache-report
thresholds. Costs are gateway-billed store sums; ratios are estimated(derived).`;
}
