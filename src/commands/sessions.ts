import { agentForMaskedKey } from "../api/agent-keys.js";
import { openSession } from "../api/client.js";
import { bool, list, type Parsed, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { type Column, currencySymbol, err, json, num, out, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { percentile } from "../obs/harness-stats.js";
import {
  createdSince,
  createdUntilIncl,
  noSyncRequested,
  openStore,
  storePath,
  syncStore,
} from "../store/index.js";
import {
  resolveGapMinutes,
  type SessionDetail,
  type SessionRequestRow,
  sessionGapMinutes,
  sessionizationNote,
  sessionizeRows,
} from "../store/sessions.js";
import {
  assertWindowOrder,
  isValidTimezone,
  parseLast,
  parseSince,
  parseUntil,
} from "./usage-report.js";

/**
 * `aiand sessions` (feature catalog B2/B3/B5, ticket #62): the per-conversation
 * view over the local request store. Sessions are the #66 time-gap heuristic —
 * this command consumes `sessionizeRows()` (aggregate + member rows) and never
 * regroups on its own. Money stays gateway-verbatim per currency; TTFT
 * percentiles reuse the #64 `percentile()`. A "turn" is exactly one stored
 * request in the session.
 */

/** Store row shape this command consumes (superset of `SessionRequestRow`). */
export type SessionCommandRow = SessionRequestRow & {
  model: string;
  status_code: number | null;
  ttft_ms: number | null;
  latency_ms: number | null;
};

/** `""` buckets rows that carried no currency — never mixed into a real code. */
const UNKNOWN_CURRENCY = "";

type Costs = Record<string, number>;

/** The one session view both output modes build from (shared with MCP, #70). */
export type SessionView = {
  id: string;
  harness: string;
  models: { model: string; count: number }[];
  turns: number;
  tokens: { input: number; output: number; cached: number };
  /** Sum within the session's single currency; null when mixed or unpriced. */
  cost: number | null;
  currency: string | null;
  /** Per-currency sums — the only money shape when the session mixes. */
  costs: Costs;
  ttft: { p50: number | null; p95: number | null };
  errors: number;
  start: string;
  end: string;
};

/** Ordering key for `--top-cost`: the sum ACROSS currencies (display never sums). */
function costAcross(session: SessionView): number {
  return Object.values(session.costs).reduce((sum, value) => sum + value, 0);
}

/** The list-row and drill-down view of one session (shared with MCP, #70). */
export function toView(detail: SessionDetail<SessionCommandRow>): SessionView {
  const modelCounts = new Map<string, number>();
  const costs: Costs = {};
  const ttfts: number[] = [];
  let errors = 0;
  for (const row of detail.rows) {
    modelCounts.set(row.model, (modelCounts.get(row.model) ?? 0) + 1);
    if (typeof row.cost_value === "number" && Number.isFinite(row.cost_value)) {
      // #89: casefold so mixed-case stored currencies stay in one lane.
      const currency = (row.currency ?? UNKNOWN_CURRENCY).toLowerCase();
      costs[currency] = (costs[currency] ?? 0) + row.cost_value;
    }
    if (row.ttft_ms !== null) ttfts.push(row.ttft_ms);
    if ((row.status_code ?? 0) >= 400) errors += 1;
  }
  const currencies = Object.keys(costs);
  return {
    id: detail.session_id,
    harness: detail.agent,
    models: [...modelCounts.entries()]
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model)),
    turns: detail.turns,
    tokens: {
      input: detail.input_tokens,
      output: detail.output_tokens,
      cached: detail.cached_tokens,
    },
    cost: currencies.length === 1 ? (costs[currencies[0]!] ?? null) : null,
    currency: currencies.length === 1 ? (currencies[0] === "" ? null : currencies[0]!) : null,
    costs,
    ttft: { p50: percentile(ttfts, 0.5), p95: percentile(ttfts, 0.95) },
    errors,
    start: detail.started_at,
    end: detail.ended_at,
  };
}

// ---------------------------------------------------------------------------
// Store access — one read, sessionized once
// ---------------------------------------------------------------------------

type RowFilters = { agents: string[]; models: string[] };

/** The one store read + filter (exported for the MCP session_stats tool, #70). */
export function readSessionRows(
  window: { sinceMs: number | null; untilMs: number | null },
  filters: RowFilters,
): SessionCommandRow[] {
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
          "cost, cost_value, currency, status_code, ttft_ms, latency_ms FROM requests" +
          where +
          " ORDER BY created_at, id",
      )
      .all(...args) as unknown as SessionCommandRow[];
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
    // A store that cannot answer serves an empty session list — fail open.
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

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const help = `${style.bold("aiand sessions")} -- your requests grouped into conversations

Usage
  aiand sessions                      one row per session
  aiand sessions <id>                 request-level drill-down into one session
  aiand sessions --top-cost 5         the 5 most expensive sessions
  aiand sessions --json               machine-readable output

Options
  --top-cost <n>      sort by gateway-billed cost, descending, keep n rows
                      (default 10; ties broken by the newer session first)
  --since <date>      window start (date = midnight in the display timezone)
  --until <date>      window end (date = end of day in the display timezone)
  --last <n><u>       relative window: --last 7d, --last 4w, --last 12h
  --timezone <tz>     IANA timezone for --since/--until and displayed times
                      (default UTC)
  --agent <name>      only sessions whose key is attributed to this agent
                      (repeatable, "unknown" = unmapped keys)
  --harness <name>    same attribution as --agent
  --model <glob>      model name glob (repeatable; * and ? wildcards); filters
                      requests BEFORE sessionization
  --session-gap <min> session gap override (default 10, or sessionGapMinutes)
  --no-cost           hide every cost column
  --compact           narrow tables; also automatic under a 100-column terminal
  --format csv        flat CSV of the sessions table; fixed header
  --no-sync           read the local store without syncing (AIAND_NO_SYNC=1)
  --json              machine-readable output

A session is derived by the time-gap heuristic (requests from one API key
within the gap threshold); boundaries are approximate, never authoritative.
A "turn" is exactly one stored request. Costs are the gateway-billed amounts
per currency (mixed currencies are shown per currency, never summed); tokens
follow the gateway convention: input includes cached.`;

/** `--top-cost` is valid bare (defaults to 10); normalize before parseArgs. */
function normalizeTopCost(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--top-cost") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        out.push("--top-cost=10");
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(normalizeTopCost(argv), {
    "top-cost": { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    timezone: { type: "string" },
    agent: { type: "string", multiple: true },
    harness: { type: "string", multiple: true },
    model: { type: "string", multiple: true },
    "session-gap": { type: "string" },
    "no-cost": { type: "boolean", default: false },
    compact: { type: "boolean", default: false },
    format: { type: "string" },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const format = str(parsed, "format") === undefined ? "table" : str(parsed, "format");
  if (format !== "table" && format !== "csv") {
    throw new CliError(`Invalid --format value: ${format}.`, {
      hint: "Use table (default) or csv.",
    });
  }
  if (format === "csv" && bool(parsed, "json")) {
    throw new CliError("--format csv and --json are different output formats; choose one.");
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

  const topCostRaw = str(parsed, "top-cost");
  let topCost: number | null = null;
  if (topCostRaw !== undefined) {
    const value = Number(topCostRaw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new CliError(`--top-cost must be a positive whole number (got "${topCostRaw}").`);
    }
    topCost = value;
  }

  const sessionId = parsed.positionals[0];
  if (parsed.positionals.length > 1) {
    throw new CliError(
      `aiand sessions takes at most one session id (got ${parsed.positionals.length}).`,
    );
  }

  // Auto-sync before read, fail-open: a failed sync warns on stderr and the
  // command serves the local store as-is — never a failed command.
  if (!(bool(parsed, "no-sync") || noSyncRequested())) {
    try {
      const session = await openSession(resolveProfile(str(parsed, "profile")));
      const result = await syncStore(session);
      if (!result.ok) err(style.yellow(`store sync failed: ${result.error}`));
      else if (result.error)
        err(
          style.yellow(
            `Warning: sync stopped early (stuck cursor) — history may be incomplete: ${result.error}`,
          ),
        ); // #85
    } catch (error) {
      err(
        style.yellow(
          `store sync skipped: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  const gapMinutes = resolveGapMinutesLocal(str(parsed, "session-gap"));
  const rows = readSessionRows(
    {
      sinceMs:
        sinceMs !== null && lastSinceMs !== null
          ? Math.max(sinceMs, lastSinceMs)
          : (sinceMs ?? lastSinceMs),
      untilMs,
    },
    {
      agents: [...list(parsed, "agent"), ...list(parsed, "harness")],
      models: list(parsed, "model"),
    },
  );
  const details = sessionizeRows(rows, gapMinutes);
  const sessions = details.map(toView);

  if (sessionId !== undefined)
    return runDrillDown(parsed, details, sessions, sessionId, gapMinutes, timezone);

  // --top-cost: cost desc, ties by the newer session first (requirement 2).
  const ordered = topCost === null ? sessions : topCostOrder(sessions).slice(0, topCost);
  const sessionization = {
    method: "time-gap" as const,
    gapMinutes,
    confidence: "heuristic" as const,
  };

  if (bool(parsed, "json")) {
    return json({
      sessionization,
      sessions: ordered.map((session) => ({ ...session })),
    });
  }
  if (format === "csv") return out(sessionsCsv(ordered));

  renderList(ordered, {
    showCost: !bool(parsed, "no-cost"),
    compact: autoCompact(parsed),
    timezone,
    gapMinutes,
  });
}

/** The per-invocation gap: the `--session-gap` flag wins, else the config default. */
function resolveGapMinutesLocal(raw: string | undefined): number {
  if (raw === undefined) return sessionGapMinutes();
  const value = Number(raw);
  return resolveGapMinutes(Number.isFinite(value) ? value : Number.NaN);
}

function topCostOrder(sessions: SessionView[]): SessionView[] {
  return [...sessions].sort(
    (a, b) =>
      costAcross(b) - costAcross(a) ||
      b.start.localeCompare(a.start) ||
      b.end.localeCompare(a.end) ||
      a.id.localeCompare(b.id),
  );
}

function autoCompact(parsed: Parsed): boolean {
  return (
    bool(parsed, "compact") ||
    (process.stdout.isTTY === true &&
      typeof process.stdout.columns === "number" &&
      process.stdout.columns > 0 &&
      process.stdout.columns < 100)
  );
}

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------

const CENTS = 6;

function formatMoney(sum: number, currency: string): string {
  return `${currencySymbol(currency)}${sum.toFixed(CENTS)}`;
}

function costCell(session: SessionView, showCost: boolean): string {
  if (!showCost) return "";
  const entries = Object.entries(session.costs);
  if (entries.length === 0) return "-";
  if (entries.length === 1) return formatMoney(entries[0]![1], entries[0]![0]);
  return "-"; // mixed: the per-currency table carries it, never a cross-sum
}

function modelMix(session: SessionView): string {
  return session.models.map((m) => `${m.model}:${m.count}`).join(", ");
}

function stamp(iso: string, timezone: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function ttftCell(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(0)}ms`;
}

type ListView = {
  showCost: boolean;
  compact: boolean;
  timezone: string;
  gapMinutes: number;
};

function renderList(sessions: SessionView[], view: ListView): void {
  out(style.bold("Sessions"));
  out(style.dim(`  ${sessionizationNote(view.gapMinutes)}`));
  out();
  if (sessions.length === 0) {
    out(style.dim("No sessions in the local store for this window."));
    out(style.dim("Run `aiand store --sync` or widen the window."));
    return;
  }

  const rows = sessions.map((session) => ({
    session,
    id: session.id,
    harness: session.harness,
    models: view.compact ? modelMix(session) : modelMix(session),
    turns: session.turns,
    input: session.tokens.input,
    output: session.tokens.output,
    cached: session.tokens.cached,
    cost: costCell(session, view.showCost),
    ttftP50: ttftCell(session.ttft.p50),
    ttftP95: ttftCell(session.ttft.p95),
    errors: session.errors,
    start: stamp(session.start, view.timezone),
    end: stamp(session.end, view.timezone),
  }));

  const columns: Column<(typeof rows)[number]>[] = [
    { header: "session", value: (r) => r.id },
    { header: "harness", value: (r) => r.harness },
    { header: "models", value: (r) => r.models },
    { header: "turns", value: (r) => num(r.turns), align: "right" },
  ];
  if (view.compact) {
    columns.push({
      header: "tokens",
      value: (r) => num(r.input + r.output),
      align: "right",
    });
  } else {
    columns.push(
      { header: "input tok", value: (r) => num(r.input), align: "right" },
      { header: "out tok", value: (r) => num(r.output), align: "right" },
      { header: "cached tok", value: (r) => num(r.cached), align: "right" },
    );
  }
  if (view.showCost) columns.push({ header: "cost", value: (r) => r.cost, align: "right" });
  const statColumns: Column<(typeof rows)[number]>[] = [
    { header: "ttft p50", value: (r) => r.ttftP50, align: "right" },
    { header: "p95", value: (r) => r.ttftP95, align: "right" },
    { header: "errors", value: (r) => num(r.errors), align: "right" },
  ];
  columns.push(...(view.compact ? [] : statColumns));
  if (!view.compact) {
    columns.push(
      { header: "start", value: (r) => r.start },
      { header: "end", value: (r) => r.end },
    );
  }
  table(rows, columns);

  // Mixed currencies: the per-currency sub-table (requirement 7).
  const mixed = sessions.filter((session) => Object.keys(session.costs).length > 1);
  if (view.showCost && mixed.length > 0) {
    out(style.yellow("Warning: mixed currencies — costs are shown per currency, never summed."));
    out();
    out(style.dim("Costs per currency"));
    out();
    const perCurrency: { session: string; currency: string; cost: string }[] = [];
    for (const session of mixed) {
      for (const [currency, sum] of Object.entries(session.costs)) {
        perCurrency.push({
          session: session.id,
          currency: currency === "" ? "unknown" : currency,
          cost: formatMoney(sum, currency),
        });
      }
    }
    table(perCurrency, [
      { header: "session", value: (r) => r.session },
      { header: "currency", value: (r) => r.currency },
      { header: "cost", value: (r) => r.cost, align: "right" },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Drill-down (aiand sessions <id>)
// ---------------------------------------------------------------------------

const NEAREST_SHOWN = 5;

function nearestHint(sessions: SessionView[]): string {
  if (sessions.length === 0) return "The local store has no sessions in this window.";
  const recent = [...sessions]
    .sort((a, b) => b.start.localeCompare(a.start) || a.id.localeCompare(b.id))
    .slice(0, NEAREST_SHOWN)
    .map((session) => `${session.id} (${session.start.slice(0, 10)})`);
  return `Nearest sessions (most recent): ${recent.join(", ")}.`;
}

function runDrillDown(
  parsed: Parsed,
  details: SessionDetail<SessionCommandRow>[],
  sessions: SessionView[],
  sessionId: string,
  gapMinutes: number,
  timezone: string,
): void {
  const detail = details.find((session) => session.session_id === sessionId);
  if (!detail) {
    throw new CliError(`No session with id "${sessionId}" in the local store.`, {
      hint:
        nearestHint(sessions) +
        " Session ids are derived from the gap heuristic and change when --session-gap changes.",
    });
  }
  const view = toView(detail);
  const sessionization = {
    method: "time-gap" as const,
    gapMinutes,
    confidence: "heuristic" as const,
    override: sessionId,
  };

  if (bool(parsed, "json")) {
    json({
      sessionization,
      session: { ...view, agent: detail.agent },
      requests: detail.rows.map((row) => ({
        id: row.id,
        timestamp: row.created_at,
        model: row.model,
        tokens: {
          input: row.input_tokens ?? 0,
          output: row.output_tokens ?? 0,
          cached: row.cached_tokens ?? 0,
        },
        cost: row.cost_value,
        currency: row.currency,
        latency_ms: row.latency_ms,
        ttft_ms: row.ttft_ms,
        status: row.status_code,
      })),
    });
    return;
  }

  out(style.bold(`Session ${view.id}`));
  out(
    style.dim(
      `  harness ${view.harness} · ${view.turns} turn${view.turns === 1 ? "" : "s"} · ` +
        `${stamp(view.start, timezone)} → ${stamp(view.end, timezone)} (${timezone})`,
    ),
  );
  out(style.dim(`  ${sessionizationNote(gapMinutes)}`));
  out();

  const showCost = !bool(parsed, "no-cost");
  const compact = autoCompact(parsed);
  type RequestRowView = {
    time: string;
    model: string;
    input: number;
    output: number;
    cached: number;
    cost: string;
    latency: string;
    ttft: string;
    status: string;
  };
  const requestRows: RequestRowView[] = detail.rows.map((row) => ({
    time: row.created_at.replace("T", " ").slice(0, 19),
    model: row.model,
    input: row.input_tokens ?? 0,
    output: row.output_tokens ?? 0,
    cached: row.cached_tokens ?? 0,
    cost:
      typeof row.cost_value !== "number" || !showCost
        ? "-"
        : formatMoney(row.cost_value, row.currency ?? UNKNOWN_CURRENCY),
    latency: row.latency_ms === null ? "-" : `${row.latency_ms.toFixed(0)}ms`,
    ttft: row.ttft_ms === null ? "-" : `${row.ttft_ms.toFixed(0)}ms`,
    status: row.status_code === null ? "-" : String(row.status_code),
  }));
  const totals: RequestRowView = {
    time: "total",
    model: modelMix(view),
    input: view.tokens.input,
    output: view.tokens.output,
    cached: view.tokens.cached,
    cost: showCost ? costCell(view, true) : "-",
    latency: "-",
    ttft: showCost ? `p50 ${ttftCell(view.ttft.p50)} / p95 ${ttftCell(view.ttft.p95)}` : "-",
    status: `${view.errors} err`,
  };
  const columns: Column<RequestRowView>[] = [
    { header: "time", value: (r) => r.time },
    { header: "model", value: (r) => r.model },
  ];
  if (compact) {
    columns.push({ header: "tokens", value: (r) => num(r.input + r.output), align: "right" });
  } else {
    columns.push(
      { header: "input tok", value: (r) => num(r.input), align: "right" },
      { header: "out tok", value: (r) => num(r.output), align: "right" },
      { header: "cached tok", value: (r) => num(r.cached), align: "right" },
    );
  }
  if (showCost) columns.push({ header: "cost", value: (r) => r.cost, align: "right" });
  if (!compact) {
    columns.push(
      { header: "latency", value: (r) => r.latency, align: "right" },
      { header: "ttft", value: (r) => r.ttft, align: "right" },
      { header: "status", value: (r) => r.status, align: "right" },
    );
  }
  table([...requestRows, totals], columns);

  if (showCost && Object.keys(view.costs).length > 1) {
    out(
      style.yellow(
        "Warning: mixed currencies in this session — costs are shown per currency, never summed.",
      ),
    );
    out();
    const perCurrency = Object.entries(view.costs).map(([currency, sum]) => ({
      currency: currency === "" ? "unknown" : currency,
      cost: formatMoney(sum, currency),
    }));
    table(perCurrency, [
      { header: "currency", value: (r) => r.currency },
      { header: "cost", value: (r) => r.cost, align: "right" },
    ]);
  }
  if (Object.keys(view.costs).length === 0) {
    out(style.dim("No billed cost recorded for this session (all requests costless)."));
  }
}

// ---------------------------------------------------------------------------
// CSV — flat, locked header, one row per (session, currency)
// ---------------------------------------------------------------------------

const CSV_HEADER =
  "session_id,harness,turns,input_tokens,output_tokens,cached_tokens,cost,currency,start,end";

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function sessionsCsv(sessions: SessionView[]): string {
  const lines = [CSV_HEADER];
  for (const session of sessions) {
    const currencies = Object.keys(session.costs);
    for (const currency of currencies.length > 0 ? currencies : [""]) {
      lines.push(
        [
          session.id,
          session.harness,
          String(session.turns),
          String(session.tokens.input),
          String(session.tokens.output),
          String(session.tokens.cached),
          session.costs[currency] === undefined ? "" : session.costs[currency]!.toFixed(CENTS),
          currency,
          session.start,
          session.end,
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }
  return lines.join("\n");
}
