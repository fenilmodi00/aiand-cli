import { agentForMaskedKey } from "../api/agent-keys.js";
import { CliError } from "../cli/errors.js";
import { type Column, currencySymbol, heading, num, out, style, table } from "../cli/output.js";
import { type ImportedReportRow, loadImportedRows } from "../obs/ccusage-import.js";
import { errorCount } from "../obs/harness-stats.js";
import { estimated, formatLabel, gatewayBilled, heuristic } from "../obs/provenance.js";
import { currencyKey } from "../pricing/currency.js";
import { type PeakSplit, splitPeakOffPeak } from "../pricing/peak-windows.js";
import {
  type CoverageReport,
  computeCoverage,
  coverageLines,
  type SyncOutcome,
} from "../store/coverage.js";
import { createdSince, createdUntilIncl, openStore, storePath } from "../store/index.js";
import {
  type SessionizationMeta,
  type SessionRequestRow,
  sessionGapMinutes,
  sessionizationAnnotation,
  sessionizationNote,
  sessionize,
} from "../store/sessions.js";

/**
 * The store-backed usage report (feature catalog B1/B6/B7/G1, ticket #60).
 *
 * One local-store read feeds every requested section (`--sections`), mirroring
 * ccusage's one-load-many-reports structure. All money is the gateway-verbatim
 * `cost` sum (never recomputed); `input_tokens` includes `cached_tokens` per
 * the gateway convention. Sessions come from the #66 sessionizer — the pure
 * `sessionize()` grouping — never a local reimplementation.
 *
 * Imported usage (ticket #73, feature catalog G4) is NEVER folded into these
 * gateway aggregates: imported ccusage rows live in their own store table and
 * surface as the separate `imported` section (default-exclude, the CodeBurn
 * gateway-totals pattern). Only an explicit `--include-imported` produces the
 * combined `grand-total` section, beside — never replacing — the gateway-only
 * totals.
 *
 * The wire payload (`--json`) is exactly `{ meta, sections }`; the `coverage`
 * and `breakdowns` fields on `Report` are render-side only.
 */

export const TIME_UNITS = ["day", "week", "month", "session"] as const;
export type TimeUnit = (typeof TIME_UNITS)[number];

export const SECTION_REGISTRY = [
  "daily",
  "weekly",
  "monthly",
  "sessions",
  "totals",
  "by-model",
  "by-agent",
  "peak",
  "imported",
  "grand-total",
] as const;
export type SectionName = (typeof SECTION_REGISTRY)[number];

export type BlockSection = Extract<SectionName, "daily" | "weekly" | "monthly" | "sessions">;

/** The time unit each section name buckets by. */
export const UNIT_SECTION: Record<TimeUnit, BlockSection> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  session: "sessions",
};

/** The time unit a block section buckets by (inverse of UNIT_SECTION). */
export function unitOfSection(section: BlockSection): TimeUnit {
  return (Object.entries(UNIT_SECTION) as [TimeUnit, BlockSection][]).find(
    ([, value]) => value === section,
  )![0];
}

export const SORT_COLUMNS = ["period", "requests", "input", "output", "cached", "cost"] as const;
type SortColumn = (typeof SORT_COLUMNS)[number];

/** A verbatim store row: exactly the columns the report aggregates over. */
export type RequestRow = {
  id: string;
  model: string;
  api_key: string | null;
  created_at: string;
  status_code: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost_value: number | null;
  currency: string | null;
};

type Costs = Record<string, number>;

/** Imported ccusage rows ride `RequestRow` plus a source label (#73). */
type ImportedRequestRow = RequestRow & { sourceLabel: string };

type BlockRow = {
  /** Stable display key: `YYYY-MM-DD`, `YYYY-Www`, `YYYY-MM`, or a session id. */
  period: string;
  /** Block window in UTC, when the unit has calendar walls (null for sessions). */
  start: string | null;
  end: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  /** Per-currency gateway-cost sums; `""` = the row carried no currency. */
  costs: Costs;
  /** Sessions only. */
  started_at?: string;
  agent?: string;
  turns?: number;
};

type GroupRow = {
  key: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  costs: Costs;
};

type TotalsRow = Omit<GroupRow, "key"> & {
  /** #98: the shared #88 error count (non-2xx excluding 429); null status is unknown, not an error. */
  errors: number;
  /** #98: errors / requests; null when the window holds no requests — never a fabricated 0. */
  errorRate: number | null;
};

/**
 * The `--include-imported` combined view (ticket #73): gateway-only totals
 * stay untouched beside it — the combined row folds the imported lane in
 * explicitly, and its cost mixes provenance (gateway-billed +
 * ccusage-estimated), which the meta labels call out.
 */
type GrandTotalRow = {
  /** Identical to `sections.totals`. */
  gateway: TotalsRow;
  /**
   * The imported lane's own rollup, null when nothing imported in window.
   * Imported ccusage rows carry no gateway status, so this lane has no
   * `errors`/`errorRate` — unknown, never a fabricated 0.
   */
  imported: Omit<GroupRow, "key"> | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  costs: Costs;
};

type CurrencyHandling = "single" | "mixed" | "none";

type ReportMeta = {
  /** The resolved filter window (null where unbounded). */
  range: { since: string | null; until: string | null };
  timezone: string;
  currencyHandling: CurrencyHandling;
  /** The one currency when `single`; null when none or mixed. */
  currency: string | null;
  /** Present when the report is session-bucketed: the #66 heuristic annotation. */
  sessionization: SessionizationMeta | null;
  /** Provenance label per reported field (ticket #68 discipline). */
  provenance: Record<string, string>;
  /** True when `--include-imported` asked for the combined grand-total. */
  importedIncluded: boolean;
  coverage: {
    sync: { status: string; at: string | null; error?: string };
    lagSeconds: number | null;
    missingDays: string[];
  };
};

/** The `--json` payload: exactly these two fields. */
type ReportPayload = { meta: ReportMeta; sections: Partial<Record<SectionName, unknown>> };

export type Report = ReportPayload & {
  /** Render-side: the full #68 coverage report (syncWarningLine et al). */
  coverage: CoverageReport;
  /** Render-side: per-block per-model rows, when `--breakdown` was requested. */
  breakdowns: Record<string, GroupRow[]>;
};

// ---------------------------------------------------------------------------
// Store read — the ONE loader every section shares
// ---------------------------------------------------------------------------

/** The single store read a report performs; injectable for tests. */
type RequestLoader = (window: { sinceMs: number | null; untilMs: number | null }) => RequestRow[];

function readRequests(window: { sinceMs: number | null; untilMs: number | null }): RequestRow[] {
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
        "SELECT id, model, api_key, status_code, created_at, input_tokens, output_tokens, cached_tokens, " +
          "cost_value, currency FROM requests" +
          where +
          " ORDER BY created_at, id",
      )
      .all(...args);
    return rows as unknown as RequestRow[];
  } catch {
    // A store that cannot answer (locked, mid-migration elsewhere) serves an
    // empty report — observability fails open, the CLI keeps working.
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

type Accumulator = {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  costs: Map<string, number>;
};

function emptyAccumulator(): Accumulator {
  return { requests: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, costs: new Map() };
}

/** Get-or-create an accumulator under `key` and return it. */
function upsert(map: Map<string, Accumulator>, key: string): Accumulator {
  const existing = map.get(key);
  if (existing) return existing;
  const fresh = emptyAccumulator();
  map.set(key, fresh);
  return fresh;
}

function accumulate(acc: Accumulator, row: RequestRow): void {
  acc.requests += 1;
  acc.input_tokens += row.input_tokens ?? 0;
  acc.output_tokens += row.output_tokens ?? 0;
  acc.cached_tokens += row.cached_tokens ?? 0;
  if (row.cost_value !== null) {
    // #89: casefold so gateway "usd" and ccusage-imported "USD" land in one
    // lane; genuinely different currencies still get their own keys.
    const currency = currencyKey(row.currency);
    acc.costs.set(currency, (acc.costs.get(currency) ?? 0) + row.cost_value);
  }
}

function finalize(acc: Accumulator): Omit<GroupRow, "key"> {
  const costs: Costs = {};
  for (const [currency, sum] of [...acc.costs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    costs[currency] = sum;
  }
  return {
    requests: acc.requests,
    input_tokens: acc.input_tokens,
    output_tokens: acc.output_tokens,
    cached_tokens: acc.cached_tokens,
    costs,
  };
}

function currencyKeysOf(rows: readonly { costs: Costs }[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) for (const currency of Object.keys(row.costs)) keys.add(currency);
  return [...keys].sort();
}

function currencyHandlingOf(rows: readonly { costs: Costs }[]): CurrencyHandling {
  const count = currencyKeysOf(rows).length;
  if (count === 0) return "none";
  return count === 1 ? "single" : "mixed";
}

function costTotal(costs: Costs): number {
  return Object.values(costs).reduce((sum, value) => sum + value, 0);
}

// -- filters ------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function agentOf(row: Pick<RequestRow, "api_key">): string {
  return row.api_key === null ? "unknown" : (agentForMaskedKey(row.api_key) ?? "unknown");
}

type ReportFilters = {
  agents: string[];
  models: string[];
};

/**
 * The one store read + filter every section (and the `--vs-list` comparison)
 * shares; exported for the sibling reports downstream tickets build on the
 * same engine. One read, no re-query.
 */
export function loadRequestRows(
  filters: ReportFilters,
  window: { sinceMs: number | null; untilMs: number | null },
): RequestRow[] {
  return filterRows(readRequests(window), filters);
}

function filterRows<T extends RequestRow>(rows: readonly T[], filters: ReportFilters): T[] {
  const agentWanted = filters.agents.length > 0 ? new Set(filters.agents) : null;
  const modelMatchers = filters.models.map(globToRegExp);
  return rows.filter((row) => {
    if (agentWanted && !agentWanted.has(agentOf(row))) return false;
    if (modelMatchers.length > 0 && !modelMatchers.some((re) => re.test(row.model))) return false;
    return true;
  });
}

// -- time bucketing -----------------------------------------------------------

const DAY_MS = 86_400_000;

function datePlusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar date of an instant, in the display timezone. */
function tzDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** The wall-clock stamp of an instant in a timezone, as `YYYY-MM-DDTHH:mm:ss`. */
function tzWall(tz: string, ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  // some ICU builds emit "24" for midnight
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}

/** UTC instant of a wall-clock time in a timezone (two-pass offset resolution). */
function wallToUtc(tz: string, wall: string): number {
  // #87: Date.parse silently rolls nonexistent dates over (2025-02-29 -> 03-01)
  // and Node rejects impossible components (month 13, hour 25) with NaN — a raw
  // Error/exit-70 there. Parse the components, parse the instant, and require a
  // round-trip so only real calendar wall times survive.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(wall);
  if (m === null) {
    throw new CliError(`Invalid --since value: ${wall}.`, {
      hint: "Use a date (2026-10-01) or an ISO timestamp, e.g. 2026-10-01T00:00:00Z.",
    });
  }
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.parse(`${wall}Z`);
  if (Number.isNaN(asUtc)) {
    throw new CliError(`Invalid --since value: ${wall}.`, {
      hint: "The date or time does not exist (e.g. month 13 or hour 25).",
    });
  }
  // Nonexistent calendar dates (2025-02-29) parse fine but roll over; require
  // the wall components to round-trip through UTC (calendar existence is
  // timezone-independent; the two-pass below applies the display offset).
  const [wy, wmo, wd, wh, wmi, ws] = [
    new Date(asUtc).getUTCFullYear(),
    new Date(asUtc).getUTCMonth() + 1,
    new Date(asUtc).getUTCDate(),
    new Date(asUtc).getUTCHours(),
    new Date(asUtc).getUTCMinutes(),
    new Date(asUtc).getUTCSeconds(),
  ];
  if (
    wy !== Number(y) ||
    wmo !== Number(mo) ||
    wd !== Number(d) ||
    wh !== Number(h) ||
    wmi !== Number(mi) ||
    ws !== Number(s)
  ) {
    throw new CliError(`Invalid --since value: ${wall}.`, {
      hint: "That calendar date or time does not exist (e.g. 2025-02-29 rolls into March).",
    });
  }
  let instant = asUtc;
  for (let i = 0; i < 2; i++) {
    const offset = Date.parse(`${tzWall(tz, instant)}Z`) - instant;
    instant = asUtc + offset;
  }
  return instant;
}

/**
 * A `--since` value: a bare date (midnight in the display timezone — the
 * timezone sets the boundary, requirement 6) or any ISO datetime.
 */
export function parseSince(value: string, tz: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    assertRealDate(value, "--since");
    return wallToUtc(tz, `${value}T00:00:00`);
  }
  // #87: ISO datetimes roll nonexistent dates over too (2025-02-29T10:00:00Z
  // silently becomes March 1); validate the date part before trusting Date.parse.
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) assertRealDate(value.slice(0, 10), "--since");
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new CliError(`Invalid --since value: ${value}.`, {
      hint: "Use a date (2026-10-01) or an ISO timestamp, e.g. 2026-10-01T00:00:00Z.",
    });
  }
  return ms;
}

/** An `--until` value: a bare date means end-of-day in the display timezone. */
export function parseUntil(value: string, tz: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    assertRealDate(value, "--until");
    return wallToUtc(tz, `${datePlusDays(value, 1)}T00:00:00`) - 1;
  }
  // #87: validate the date part of ISO datetimes (silent rollover).
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) assertRealDate(value.slice(0, 10), "--until");
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new CliError(`Invalid --until value: ${value}.`, {
      hint: "Use a date (2026-10-25) or an ISO timestamp, e.g. 2026-10-25T00:00:00Z.",
    });
  }
  return ms;
}

/**
 * A bare `YYYY-MM-DD` must be a real calendar date: Date.parse rolls
 * nonexistent dates over silently (2025-02-29 -> 2025-03-01), and a
 * month-13/day-32 input produces NaN or another rollover depending on the
 * engine (#87). Parse the components back and demand they survive.
 */
function assertRealDate(value: string, flag: "--since" | "--until"): void {
  const [y, m, d] = value.split("-").map(Number);
  const ms = Date.parse(`${value}T00:00:00Z`);
  const real =
    !Number.isNaN(ms) &&
    new Date(ms).getUTCFullYear() === y &&
    new Date(ms).getUTCMonth() + 1 === m &&
    new Date(ms).getUTCDate() === d;
  if (!real) {
    throw new CliError(`Invalid ${flag} value: ${value}.`, {
      hint: "That calendar date does not exist (e.g. month 13 or 2025-02-29).",
    });
  }
}

/**
 * A `--since`/`--until` pair must be ordered; an inverted window would
 * otherwise silently render an empty report (#87).
 */
export function assertWindowOrder(sinceMs: number | null, untilMs: number | null): void {
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) {
    throw new CliError(
      `--since ${new Date(sinceMs).toISOString()} is after --until ${new Date(untilMs).toISOString()}.`,
      { hint: "Pass an earlier --since or a later --until." },
    );
  }
}

/** Monday of the ISO week containing `date` (a `YYYY-MM-DD` string). */
function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  return datePlusDays(date, -((weekday + 6) % 7));
}

/** ISO-8601 week label `YYYY-Www` for a Monday date. */
function isoWeekLabel(monday: string): string {
  // The Thursday of this week pins the ISO year (ISO 8601).
  const thursday = datePlusDays(monday, 3);
  const year = Number(thursday.slice(0, 4));
  const jan4Monday = mondayOf(`${year}-01-04`);
  const week =
    Math.round(
      (Date.parse(`${monday}T00:00:00Z`) - Date.parse(`${jan4Monday}T00:00:00Z`)) / (7 * DAY_MS),
    ) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type BucketKey = { period: string; startMs: number; endMs: number };

function bucketOf(ms: number, unit: Exclude<TimeUnit, "session">, tz: string): BucketKey {
  const day = tzDay(ms, tz);
  if (unit === "day") {
    return {
      period: day,
      startMs: wallToUtc(tz, `${day}T00:00:00`),
      endMs: wallToUtc(tz, `${datePlusDays(day, 1)}T00:00:00`),
    };
  }
  if (unit === "month") {
    const month = day.slice(0, 7);
    const [y, m] = month.split("-").map(Number) as [number, number];
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    return {
      period: month,
      startMs: wallToUtc(tz, `${month}-01T00:00:00`),
      endMs: wallToUtc(tz, `${next}T00:00:00`),
    };
  }
  const monday = mondayOf(day);
  return {
    period: isoWeekLabel(monday),
    startMs: wallToUtc(tz, `${monday}T00:00:00`),
    endMs: wallToUtc(tz, `${datePlusDays(monday, 7)}T00:00:00`),
  };
}

/** `--last 7d` / `--last 4w` … relative windows, resolved against `now`. */
export function parseLast(value: string, now: Date): { sinceMs: number } {
  const match = /^(\d+)(m|h|d|w)$/.exec(value);
  if (!match || Number(match[1]) === 0) {
    throw new CliError(`Invalid --last value: ${value}.`, {
      hint: "Use <count><unit> with unit m|h|d|w, e.g. --last 7d or --last 4w.",
    });
  }
  const n = Number(match[1]);
  const unitMs: Record<string, number> = { m: 60_000, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS };
  return { sinceMs: now.getTime() - n * unitMs[match[2]!]! };
}

// -- session bucketing (via the #66 sessionizer) -------------------------------

function toSessionRows(rows: readonly RequestRow[]): SessionRequestRow[] {
  return rows.map((row) => ({
    id: row.id,
    api_key: row.api_key,
    created_at: row.created_at,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cached_tokens: row.cached_tokens,
    cost: row.cost_value === null ? null : String(row.cost_value),
    cost_value: row.cost_value,
    currency: row.currency,
  }));
}

// ---------------------------------------------------------------------------
// Report construction — ONE load, every section
// ---------------------------------------------------------------------------

export type BuildReportOptions = {
  unit: TimeUnit;
  sections: readonly SectionName[];
  timezone: string;
  /** Explicit/derived window in UTC ms; null where unbounded. */
  sinceMs: number | null;
  untilMs: number | null;
  filters: ReportFilters;
  sort: SortColumn;
  order: "asc" | "desc";
  /** What the pre-command sync did (null: nothing attempted, e.g. --no-sync). */
  sync: SyncOutcome | null;
  /** Request --breakdown per-model sub-tables (populates `breakdowns`). */
  breakdown?: boolean;
  /**
   * Fold imported ccusage rows into a combined `grand-total` section
   * (ticket #73). Gateway totals remain gateway-only either way.
   */
  includeImported?: boolean;
  /** Overrides Date.now() — tests pin time. */
  now?: Date;
  /** Injected store loader (tests); defaults to the real single read. */
  load?: RequestLoader;
  /** Injected imported-rows loader (tests); defaults to the real read. */
  loadImported?: (window: {
    sinceMs: number | null;
    untilMs: number | null;
  }) => ImportedReportRow[];
};

export function buildReport(options: BuildReportOptions): Report {
  const load = options.load ?? readRequests;
  const rows = filterRows(
    load({ sinceMs: options.sinceMs, untilMs: options.untilMs }),
    options.filters,
  );

  // Imported ccusage rows (ticket #73) are a second, SEPARATE lane. They
  // never enter `rows`, so no gateway aggregate (blocks, totals, by-model,
  // by-agent, peak, sessions) can ever double-count them.
  const loadImported = options.loadImported ?? loadImportedRows;
  const importedRows = loadImported({
    sinceMs: options.sinceMs,
    untilMs: options.untilMs,
  }).map((row) => ({
    // RequestRow-shaped for the shared accumulator/filter; api_key stays
    // null (imported rows are never agent-attributed) and the source label
    // rides along for the per-source rollup.
    id: "",
    model: row.model,
    api_key: null,
    created_at: row.created_at,
    status_code: null,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cached_tokens: row.cached_tokens,
    cost_value: row.cost_value,
    currency: row.currency,
    sourceLabel: row.sourceLabel,
  }));
  const filteredImported: ImportedRequestRow[] = filterRows(importedRows, options.filters);

  const blockSection = UNIT_SECTION[options.unit];
  const wants = new Set<SectionName>(options.sections);

  let sessionization: SessionizationMeta | null = null;
  let blocks: BlockRow[];
  const breakdowns: Record<string, GroupRow[]> = {};
  if (options.unit === "session") {
    const gapMinutes = sessionGapMinutes();
    sessionization = sessionizationAnnotation(gapMinutes);
    blocks = sessionize(toSessionRows(rows), gapMinutes).map((session) => ({
      period: session.session_id,
      start: null,
      end: null,
      requests: session.turns,
      input_tokens: session.input_tokens,
      output_tokens: session.output_tokens,
      cached_tokens: session.cached_tokens,
      // #89: same casefold as accumulate so mixed-case stored currencies
      // can't split one currency into two session lanes.
      costs: session.cost === null ? {} : { [currencyKey(session.currency)]: session.cost },
      started_at: session.started_at,
      agent: session.agent,
      turns: session.turns,
    }));
  } else {
    const buckets = new Map<string, { key: BucketKey; acc: Accumulator }>();
    const byModel = new Map<string, Map<string, Accumulator>>();
    for (const row of rows) {
      const key = bucketOf(Date.parse(row.created_at), options.unit, options.timezone);
      const bucket = buckets.get(key.period);
      if (bucket) {
        accumulate(bucket.acc, row);
      } else {
        const acc = emptyAccumulator();
        accumulate(acc, row);
        buckets.set(key.period, { key, acc });
      }

      if (options.breakdown) {
        const perBlock = byModel.get(key.period) ?? new Map<string, Accumulator>();
        const acc = perBlock.get(row.model) ?? emptyAccumulator();
        accumulate(acc, row);
        perBlock.set(row.model, acc);
        byModel.set(key.period, perBlock);
      }
    }
    blocks = [...buckets.values()]
      .map(({ key, acc }) => ({
        period: key.period,
        start: new Date(key.startMs).toISOString(),
        end: new Date(key.endMs).toISOString(),
        ...finalize(acc),
      }))
      .sort(
        (a, b) =>
          (a.start ?? a.period).localeCompare(b.start ?? b.period) ||
          a.period.localeCompare(b.period),
      );
    if (options.breakdown) {
      for (const [period, perModel] of byModel) {
        breakdowns[period] = [...perModel.entries()]
          .map(([key, acc]) => ({ key, ...finalize(acc) }))
          .sort((a, b) => a.key.localeCompare(b.key));
      }
    }
  }

  blocks = sortBlocks(blocks, options.sort, options.order);

  const totalsAcc = emptyAccumulator();
  for (const row of rows) accumulate(totalsAcc, row);
  // #98: the shared #88 definition (non-2xx excluding 429) — no second formula.
  const errors = errorCount(rows);
  const totals: TotalsRow = {
    ...finalize(totalsAcc),
    errors,
    errorRate: totalsAcc.requests > 0 ? errors / totalsAcc.requests : null,
  };

  const byModelAll = new Map<string, Accumulator>();
  const byAgentAll = new Map<string, Accumulator>();
  for (const row of rows) {
    accumulate(byModelAll.get(row.model) ?? upsert(byModelAll, row.model), row);
    accumulate(byAgentAll.get(agentOf(row)) ?? upsert(byAgentAll, agentOf(row)), row);
  }
  const groupRows = (map: Map<string, Accumulator>): GroupRow[] =>
    [...map.entries()]
      .map(([key, acc]) => ({ key, ...finalize(acc) }))
      .sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));

  const currencyHandling = currencyHandlingOf([...blocks, totals]);

  const sections: ReportPayload["sections"] = {};
  if (wants.has(blockSection)) sections[blockSection] = blocks;
  if (wants.has("totals")) sections.totals = totals;
  if (wants.has("by-model")) sections["by-model"] = groupRows(byModelAll);
  if (wants.has("by-agent")) sections["by-agent"] = groupRows(byAgentAll);
  if (wants.has("peak")) {
    // B9 (ticket #81): shares of gateway-billed cost by the vendor window
    // table; unclassified families land in their model row, never guessed.
    const peakRows = rows.map((row) => ({
      model: row.model,
      created_at: row.created_at,
      cost_value: row.cost_value,
      currency: row.currency,
    }));
    const peak: PeakSplit = splitPeakOffPeak(peakRows);
    sections.peak = peak;
  }

  // Imported ccusage lane (ticket #73): own source rows, default-excluded
  // from every gateway total above. Auto-present only when rows exist.
  const importedBySource = new Map<string, Accumulator>();
  for (const row of filteredImported) {
    accumulate(
      importedBySource.get(row.sourceLabel) ?? upsert(importedBySource, row.sourceLabel),
      row,
    );
  }
  if (importedBySource.size > 0) sections.imported = groupRows(importedBySource);

  if (options.includeImported) {
    // The combined view is additive and explicit: gateway totals remain
    // gateway-only; the grand total folds the imported lane in, and its
    // per-currency sums keep each currency separate (never summed across).
    const impAcc = emptyAccumulator();
    for (const row of filteredImported) accumulate(impAcc, row);
    const importedTotals = filteredImported.length > 0 ? finalize(impAcc) : null;
    const costs: Costs = { ...totals.costs };
    for (const [currency, sum] of Object.entries(importedTotals?.costs ?? {})) {
      costs[currency] = (costs[currency] ?? 0) + sum;
    }
    sections["grand-total"] = {
      gateway: totals,
      imported: importedTotals,
      requests: totals.requests + (importedTotals?.requests ?? 0),
      input_tokens: totals.input_tokens + (importedTotals?.input_tokens ?? 0),
      output_tokens: totals.output_tokens + (importedTotals?.output_tokens ?? 0),
      cached_tokens: totals.cached_tokens + (importedTotals?.cached_tokens ?? 0),
      costs,
    };
  }

  const coverage = computeCoverage("30days", { now: options.now, sync: options.sync ?? undefined });

  return {
    meta: {
      range: {
        since: options.sinceMs === null ? null : new Date(options.sinceMs).toISOString(),
        until: options.untilMs === null ? null : new Date(options.untilMs).toISOString(),
      },
      timezone: options.timezone,
      currencyHandling,
      currency: currencyHandling === "single" ? (currencyKeysOf([totals])[0] ?? null) : null,
      sessionization,
      provenance: provenanceMeta(options.unit === "session"),
      importedIncluded: options.includeImported ?? false,
      coverage: {
        sync: coverage.sync,
        lagSeconds: coverage.lagSeconds,
        missingDays: coverage.missingDays,
      },
    },
    sections,
    coverage,
    breakdowns,
  };
}

function sortBlocks(blocks: BlockRow[], sort: SortColumn, order: "asc" | "desc"): BlockRow[] {
  if (sort === "period") {
    // calendar order rides the start stamp; sessions keep started_at order
    return [...blocks].sort((a, b) => {
      const base = (a.started_at ?? a.start ?? a.period).localeCompare(
        b.started_at ?? b.start ?? b.period,
      );
      return order === "asc" ? base : -base;
    });
  }
  const value = (row: BlockRow): number => {
    switch (sort) {
      case "requests":
        return row.requests;
      case "input":
        return row.input_tokens;
      case "output":
        return row.output_tokens;
      case "cached":
        return row.cached_tokens;
      default:
        return costTotal(row.costs);
    }
  };
  return [...blocks].sort(
    (a, b) =>
      (order === "asc" ? value(a) - value(b) : value(b) - value(a)) ||
      (a.start ?? a.period).localeCompare(b.start ?? b.period),
  );
}

/** The #68 provenance labels for every field the report emits. */
function provenanceMeta(sessionUnit: boolean): Record<string, string> {
  const labels: Record<string, string> = {
    requests: formatLabel(estimated("count of gateway /logs rows in the local store")),
    input_tokens: formatLabel(
      gatewayBilled("sum of gateway /logs input_tokens (includes cached_tokens)"),
    ),
    output_tokens: formatLabel(gatewayBilled("sum of gateway /logs output_tokens")),
    cached_tokens: formatLabel(gatewayBilled("sum of gateway /logs cached_tokens")),
    cost: formatLabel(
      gatewayBilled("sum of the gateway-computed per-request cost; never recomputed"),
    ),
    // #98: the shared #88 definition — same label harness-stats emits.
    errors: formatLabel(estimated("non-2xx statuses excluding 429 over the window's rows")),
    errorRate: formatLabel(estimated("non-2xx excluding 429 / requests")),
  };
  if (sessionUnit) labels.sessions = formatLabel(heuristic("time-gap sessionization"));
  labels.peak = formatLabel(
    estimated("peak-window table applied to stored created_at timestamps and gateway costs"),
  );
  // Imported ccusage lane (ticket #73): ccusage numbers are its own report
  // values, cost is price-table-derived — never gateway-billed.
  labels.imported = formatLabel(
    estimated("imported ccusage report values; ccusage derives them from local harness logs"),
  );
  labels["imported.cost"] = formatLabel(
    estimated("imported ccusage <import-date>; ccusage price-table-derived, never gateway-billed"),
  );
  labels["grand-total.cost"] = formatLabel(
    estimated("sum of gateway-billed cost and ccusage-estimated imported cost; mixed provenance"),
  );
  return labels;
}

// ---------------------------------------------------------------------------
// --jq: a minimal, safe dot-path filter (NOT a jq engine, zero deps)
// ---------------------------------------------------------------------------

type JqToken = { kind: "key"; name: string } | { kind: "index"; index: number } | { kind: "iter" };

export function parseJqPath(filter: string): JqToken[] {
  const rest = filter.trim();
  if (!rest.startsWith(".")) {
    throw new CliError(`Unsupported --jq filter: ${filter}.`, {
      hint:
        "This is a minimal dot-path filter, not a jq engine: " +
        "use .sections.totals, .sections.daily[0], .sections.daily[] etc.",
    });
  }
  const tokens: JqToken[] = [];
  let i = 1; // the leading dot is consumed
  while (i < rest.length) {
    const char = rest[i]!;
    if (char === "." || /^[A-Za-z_]/.test(char)) {
      if (char === ".") i += 1;
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest.slice(i));
      if (!match) {
        throw new CliError(`Unsupported --jq filter: ${filter}.`, {
          hint: "Expected a field name after '.', e.g. .sections.totals.",
        });
      }
      tokens.push({ kind: "key", name: match[0] });
      i += match[0].length;
    } else if (char === "[") {
      if (rest[i + 1] === "]") {
        tokens.push({ kind: "iter" });
        i += 2;
      } else {
        const match = /^\[(\d+)\]/.exec(rest.slice(i));
        if (!match) {
          throw new CliError(`Unsupported --jq filter: ${filter}.`, {
            hint: "Bracket forms are [N] (index) and [] (iterate).",
          });
        }
        tokens.push({ kind: "index", index: Number(match[1]) });
        i += match[0].length;
      }
    } else {
      throw new CliError(`Unsupported --jq filter: ${filter}.`, {
        hint: "Unexpected character after a path element.",
      });
    }
  }
  return tokens;
}

/** Evaluate a parsed dot path; missing fields yield null (jq `.foo` on {}). */
export function applyJqPath(document: unknown, tokens: readonly JqToken[]): unknown {
  let results: unknown[] = [document];
  for (const token of tokens) {
    const next: unknown[] = [];
    for (const value of results) {
      if (token.kind === "iter") {
        if (Array.isArray(value)) next.push(...value);
      } else if (token.kind === "key") {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          next.push((value as Record<string, unknown>)[token.name] ?? null);
        }
      } else if (Array.isArray(value) && token.index < value.length) {
        next.push(value[token.index]);
      }
    }
    results = next;
  }
  return results.length === 1 ? results[0] : results;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type RenderOptions = {
  showCost: boolean;
  compact: boolean;
  breakdown: boolean;
  totals: boolean;
  /** Sections actually selected (drives which tables render). */
  sections: readonly SectionName[];
  unit: TimeUnit;
};

const CSV_HEADER = "period,requests,input_tokens,output_tokens,cached_tokens,cost,currency";

function formatCost(sum: number, currency: string): string {
  return `${currencySymbol(currency)}${sum.toFixed(6)}`;
}

function costCell(costs: Costs): string {
  const entries = Object.entries(costs);
  if (entries.length === 0) return "-";
  if (entries.length === 1) return formatCost(entries[0]![1], entries[0]![0]);
  // mixed: never summed across currencies; the per-currency sub-table carries it
  return "-";
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The flat CSV of the primary (block) section: fixed header, one row per
 * (period, currency) so mixed-currency ranges stay un-summed. The same
 * columns regardless of terminal width or --compact.
 */
export function reportCsv(report: Report, section: BlockSection): string {
  const blocks = report.sections[section];
  const lines = [CSV_HEADER];
  if (!Array.isArray(blocks)) return lines.join("\n");
  for (const block of blocks as BlockRow[]) {
    const currencies = Object.keys(block.costs);
    for (const currency of currencies.length > 0 ? currencies : [""]) {
      lines.push(
        [
          block.period,
          String(block.requests),
          String(block.input_tokens),
          String(block.output_tokens),
          String(block.cached_tokens),
          block.costs[currency] === undefined ? "" : block.costs[currency]!.toFixed(6),
          currency,
        ]
          .map(csvEscape)
          .join(","),
      );
    }
  }
  return lines.join("\n");
}

/** The first block section present in the selection — CSV's primary section. */
export function primarySection(sections: readonly SectionName[]): BlockSection | null {
  for (const candidate of ["daily", "weekly", "monthly", "sessions"] as const) {
    if (sections.includes(candidate)) return candidate;
  }
  return null;
}

export function renderReport(report: Report, view: RenderOptions): void {
  const meta = report.meta;
  heading(`Usage by ${view.unit}`);
  const windowBits = [
    meta.range.since ? `from ${meta.range.since.replace("T", " ").slice(0, 19)}Z` : null,
    meta.range.until ? `to ${meta.range.until.replace("T", " ").slice(0, 19)}Z` : null,
    `timezone ${meta.timezone}`,
  ].filter((bit) => bit !== null);
  out(style.dim(windowBits.join("  ·  ")));

  // The sync warning itself is emitted by the caller (all output modes, stderr).
  if (view.showCost && meta.currencyHandling === "mixed") {
    out(
      style.yellow(
        "Warning: mixed currencies in range — costs are shown per currency, never summed.",
      ),
    );
  }

  const blockSection = UNIT_SECTION[view.unit];
  const blocks = report.sections[blockSection];
  if (Array.isArray(blocks) && (blocks as BlockRow[]).length > 0) {
    out();
    renderBlockTable(blocks as BlockRow[], report, view);
    if (view.showCost && meta.currencyHandling === "mixed") renderPerCurrency(blocks as BlockRow[]);
    if (view.breakdown && view.unit !== "session") renderBreakdowns(report, view);
  }

  if (!Array.isArray(blocks) && view.sections.includes("totals")) {
    out();
    heading("Totals");
    out();
    renderTotalsFields(report.sections.totals as TotalsRow | undefined, report, view);
  }

  if (view.sections.includes("by-model")) {
    out();
    heading("By model");
    out();
    renderGroupTable(report.sections["by-model"] as GroupRow[] | undefined, view, "model");
  }
  if (view.sections.includes("by-agent")) {
    out();
    heading("By agent");
    out();
    renderGroupTable(report.sections["by-agent"] as GroupRow[] | undefined, view, "agent");
  }

  if (view.sections.includes("peak")) {
    out();
    heading("Peak / off-peak");
    out(style.dim(meta.provenance.peak ?? ""));
    out();
    renderPeak(report.sections.peak as PeakSplit | undefined);
  }

  const importedRows = report.sections.imported as GroupRow[] | undefined;
  if (importedRows) {
    out();
    heading("Imported (ccusage) — excluded from gateway totals");
    out(style.dim(meta.provenance.imported ?? ""));
    out();
    renderGroupTable(importedRows, view, "source");
    out(style.dim(meta.provenance["imported.cost"] ?? ""));
    if (!report.sections["grand-total"]) {
      out(style.dim("Run with --include-imported for a combined grand total."));
    }
  }

  const grandTotal = report.sections["grand-total"] as GrandTotalRow | undefined;
  if (grandTotal) {
    out();
    heading("Grand total (gateway + imported)");
    out(style.dim(meta.provenance["grand-total.cost"] ?? ""));
    out();
    const rows: (GroupRow | null)[] = [
      { key: "gateway", ...grandTotal.gateway },
      grandTotal.imported ? { key: "imported", ...grandTotal.imported } : null,
      {
        key: "combined",
        requests: grandTotal.requests,
        input_tokens: grandTotal.input_tokens,
        output_tokens: grandTotal.output_tokens,
        cached_tokens: grandTotal.cached_tokens,
        costs: grandTotal.costs,
      },
    ];
    table(
      rows.filter((row) => row !== null),
      groupColumns(view, "source"),
    );
  }

  if (meta.sessionization) {
    out();
    out(style.dim(sessionizationNote(meta.sessionization.gapMinutes)));
  }

  const lines = coverageLines(report.coverage);
  if (lines.length > 0) {
    out();
    for (const line of lines) out(style.dim(line));
  }
}

/** A table row of the block table; the totals row rides the same shape. */
type BlockTableRow = {
  label: string;
  started: string;
  turns: string;
  requests: number;
  input: number;
  output: number;
  cached: number;
  cost: string;
};

function renderBlockTable(blocks: BlockRow[], report: Report, view: RenderOptions): void {
  const rows: BlockTableRow[] = blocks.map((block) => ({
    label: block.period,
    started: (block.started_at ?? "").replace("T", " ").slice(0, 19),
    turns: block.turns === undefined ? "" : String(block.turns),
    requests: block.requests,
    input: block.input_tokens,
    output: block.output_tokens,
    cached: block.cached_tokens,
    cost: costCell(block.costs),
  }));

  if (view.totals && report.sections.totals) {
    const totals = report.sections.totals as TotalsRow;
    rows.push({
      label: "total",
      started: "",
      turns: "",
      requests: totals.requests,
      input: totals.input_tokens,
      output: totals.output_tokens,
      cached: totals.cached_tokens,
      cost: costCell(totals.costs),
    });
  }

  const columns: Column<BlockTableRow>[] = [];
  if (view.unit === "session") {
    columns.push(
      { header: "session", value: (r) => r.label },
      { header: "started", value: (r) => r.started },
      { header: "turns", value: (r) => r.turns, align: "right" },
    );
  } else {
    columns.push({ header: "period", value: (r) => r.label });
  }
  if (view.compact) {
    columns.push(
      { header: "requests", value: (r) => num(r.requests), align: "right" },
      {
        header: "tokens",
        value: (r) => num(r.input + r.output),
        align: "right",
      },
    );
  } else {
    columns.push(
      { header: "requests", value: (r) => num(r.requests), align: "right" },
      { header: "input tokens", value: (r) => num(r.input), align: "right" },
      { header: "output tokens", value: (r) => num(r.output), align: "right" },
      { header: "cached tokens", value: (r) => num(r.cached), align: "right" },
    );
  }
  if (view.showCost) columns.push({ header: "cost", value: (r) => r.cost, align: "right" });

  table(rows, columns);

  // #98: same number the `--json` totals carry; absent (not 0.0) on an empty
  // window. `logs --errors` counts the same non-2xx-excluding-429 set.
  if (view.totals && report.sections.totals) {
    const totals = report.sections.totals as TotalsRow;
    if (totals.errorRate !== null) {
      out(
        style.dim(
          `error rate  ${(totals.errorRate * 100).toFixed(1)}% ` +
            `(${totals.errors}/${totals.requests} non-2xx excl. 429) · estimated`,
        ),
      );
    }
  }
}

function renderBreakdowns(report: Report, view: RenderOptions): void {
  for (const [period, models] of Object.entries(report.breakdowns)) {
    if (models.length === 0) continue;
    out();
    out(style.dim(period));
    table(models, groupColumns(view, "model"));
  }
}

function renderGroupTable(rows: GroupRow[] | undefined, view: RenderOptions, header: string): void {
  if (!rows || rows.length === 0) {
    out(style.dim("No matching requests."));
    return;
  }
  table(rows, groupColumns(view, header));
}

function groupColumns(view: RenderOptions, header: string): Column<GroupRow>[] {
  const columns: Column<GroupRow>[] = [{ header, value: (r) => r.key }];
  if (view.compact) {
    columns.push(
      { header: "requests", value: (r) => num(r.requests), align: "right" },
      { header: "tokens", value: (r) => num(r.input_tokens + r.output_tokens), align: "right" },
    );
  } else {
    columns.push(
      { header: "requests", value: (r) => num(r.requests), align: "right" },
      { header: "input tokens", value: (r) => num(r.input_tokens), align: "right" },
      { header: "output tokens", value: (r) => num(r.output_tokens), align: "right" },
      { header: "cached tokens", value: (r) => num(r.cached_tokens), align: "right" },
    );
  }
  if (view.showCost) {
    columns.push({ header: "cost", value: (r) => costCell(r.costs), align: "right" });
  }
  return columns;
}

function renderPerCurrency(blocks: BlockRow[]): void {
  out();
  out(style.dim("Costs per currency"));
  out();
  type Row = { period: string; currency: string; cost: string };
  const rows: Row[] = [];
  for (const block of blocks) {
    for (const [currency, sum] of Object.entries(block.costs)) {
      rows.push({
        period: block.period,
        currency: currency === "" ? "unknown" : currency,
        cost: formatCost(sum, currency),
      });
    }
  }
  table(rows, [
    { header: "period", value: (r) => r.period },
    { header: "currency", value: (r) => r.currency },
    { header: "cost", value: (r) => r.cost, align: "right" },
  ]);
}

function renderTotalsFields(
  totals: TotalsRow | undefined,
  report: Report,
  view: RenderOptions,
): void {
  if (!totals) return;
  const meta = report.meta;
  const pairs: [string, string][] = [
    ["requests", num(totals.requests)],
    ["input tokens", num(totals.input_tokens)],
    ["output tokens", num(totals.output_tokens)],
    ["cached tokens", num(totals.cached_tokens)],
  ];
  // #98: same number as `--json` totals; absent (not 0.0) on an empty window.
  if (totals.errorRate !== null) {
    pairs.push([
      "error rate",
      `${(totals.errorRate * 100).toFixed(1)}% (${totals.errors}/${totals.requests} non-2xx excl. 429)`,
    ]);
    pairs.push(["error rate provenance", meta.provenance.errorRate ?? ""]);
  }
  if (view.showCost) {
    for (const [currency, sum] of Object.entries(totals.costs)) {
      pairs.push([`cost (${currency === "" ? "unknown" : currency})`, formatCost(sum, currency)]);
    }
  }
  for (const [key, value] of pairs) out(`${style.dim(key.padEnd(16))}  ${value}`);
}

// ---------------------------------------------------------------------------
// Peak / off-peak section (feature catalog B9, ticket #81)
// ---------------------------------------------------------------------------

type PeakBucket = { requests: number; costs: Costs };

/**
 * One bucket cell: share% plus cost for the single-currency case; "-" when
 * the bucket is empty or mixed-currency (the per-currency JSON carries the
 * detail; a mixed cell is never a sum).
 */
function peakCell(bucket: PeakBucket, share: number | undefined): string {
  const entries = Object.entries(bucket.costs);
  if (entries.length === 0) return "-";
  if (entries.length > 1) return "-";
  const cost = formatCost(entries[0]![1], entries[0]![0]);
  return share === undefined ? cost : `${share.toFixed(1)}% (${cost})`;
}

function renderPeak(split: PeakSplit | undefined): void {
  if (!split || split.models.length === 0) {
    out(style.dim("No matching requests."));
    return;
  }
  const rows = split.models.map((model) => {
    const share = Object.values(model.shares)[0];
    const mixed = currencyKeysOf([model.peak, model.offPeak, model.unclassified]).length > 1;
    return {
      model: model.model,
      family: model.family ?? "unclassified",
      peak: model.family === null || mixed ? "n/a" : peakCell(model.peak, share?.peak),
      "off-peak": model.family === null || mixed ? "n/a" : peakCell(model.offPeak, share?.offPeak),
      unclassified: model.family === null ? peakCell(model.unclassified, undefined) : "-",
      requests: model.peak.requests + model.offPeak.requests + model.unclassified.requests,
    };
  });
  table(rows, [
    { header: "model", value: (r) => r.model },
    { header: "family", value: (r) => r.family },
    { header: "peak", value: (r) => r.peak, align: "right" },
    { header: "off-peak", value: (r) => r["off-peak"], align: "right" },
    { header: "unclassified", value: (r) => r.unclassified, align: "right" },
    { header: "requests", value: (r) => num(r.requests), align: "right" },
  ]);

  if (split.routed.requests > 0) {
    const routedCost = peakCell(split.routed, undefined);
    out(
      style.dim(
        `routed (non-first-party) traffic: ${num(split.routed.requests)} requests` +
          `${routedCost === "-" ? "" : `, ${routedCost}`} — window split not applicable`,
      ),
    );
  }
  const sources = [...new Set(split.models.map((m) => m.source).filter((s) => s !== null))];
  if (sources.length > 0) out(style.dim(`window sources: ${sources.join(" · ")}`));
  const unclassified = split.models.filter((m) => m.family === null).map((m) => m.model);
  if (unclassified.length > 0) {
    out(
      style.dim(
        `no window-table entry for ${unclassified.join(", ")} — reported unclassified, never guessed.`,
      ),
    );
  }
}
