import { style } from "../cli/output.js";
import { createdSince, openStore, storePath } from "../store/index.js";
import { listSessions } from "../store/sessions.js";
import { HOUR_MS } from "../time.js";
import { loadBudget } from "./budget.js";
import { attributedSpend, type ForecastRow, forecast, readForecastRows } from "./forecast.js";
import { formatLabel, gatewayBilled, heuristic } from "./provenance.js";

/**
 * The statusline (feature catalog E3, ticket #71).
 *
 * One glanceable line plus the machine snapshot behind it, read EXCLUSIVELY
 * from the local request store — never a blocking gateway call. Empty or
 * unsynced stores degrade to the `no-data` verdict; a store that has synced
 * but whose numbers cannot be trusted (mixed currencies, too little data for
 * a rate while a budget is set) degrades to `indeterminate`. Nothing is
 * fabricated.
 *
 * Line format (v1; the catalog's block segment is omitted — aiand has no
 * block pricing concept yet):
 *
 *   💰 $2.10 session / $8.40 today | 🔥 $1.85/hr 🟢 | 45%→72% of budget | ttft p50 320ms
 *
 *   - spend figures are gateway-billed sums from the store ("session" is the
 *     most recent time-gap session — boundaries are heuristic, the cost is
 *     verbatim; "today" is the current UTC day)
 *   - the burn rate is burn-rate v1 (trailing 24h, 7d fallback — heuristic)
 *   - the pacing segment appears only when `budget.monthly` is set:
 *     current→projected percent of budget (the claumon pairing); the
 *     projected side is `heuristic(burn-rate v1)`
 *   - `ttft p50` is the median gateway-reported `ttft_ms` over the trailing
 *     24h of stored rows (gateway-billed); omitted when none
 *   - in `--watch`, data older than 3× the interval renders a dim
 *     `stale HH:MM` suffix (ccusage's stale-while-refresh pattern)
 *
 * Snapshot contract (feature catalog G5): `--write-state <path>` writes the
 * versioned JSON snapshot atomically (temp file in the same directory, then
 * rename — `writeFileAtomic`). `schema_version` starts at 1; ADDITIVE
 * changes (new optional fields) keep 1, BREAKING changes (removing or
 * re-typing fields) bump it — consumers must refuse unknown major versions.
 *
 * Exit codes (the same run as --write-state and `--format line`):
 *   0 ok · 10 near-limit · 11 limit-hit · 20 indeterminate · 30 no-data.
 */

/** The snapshot schema version. Additive changes keep 1; breaking changes bump. */
export const SCHEMA_VERSION = 1;

/** Near-limit threshold: 80% of budget, per the ticket's exit-code table. */
export const NEAR_LIMIT_PCT = 80;

/** A one-shot statusline treats a store unsynced this long as stale. */
export const ONE_SHOT_STALE_MS = 60 * 60 * 1000;

/** Watch staleness factor: data older than this many intervals renders stale. */
export const WATCH_STALE_FACTOR = 3;

/** The watch interval default (ms) and the floor. */
export const WATCH_DEFAULT_INTERVAL_MS = 10_000;
export const WATCH_MIN_INTERVAL_MS = 2_000;

/**
 * The automation verdict vocabulary (G5): what the exit code and the
 * snapshot's `verdict` field carry. Deliberately distinct from the forecast's
 * pacing verdicts — this one is about the BUDGET GATE, not the projection.
 */
export type StatusVerdict = "ok" | "near-limit" | "limit-hit" | "indeterminate" | "no-data";

/** The versioned machine snapshot `--write-state` produces (G5). */
export type StatusSnapshot = {
  schema_version: 1;
  generated_at: string;
  source: "aiand status";
  spend: { session: number | null; today: number | null; currency: string | null };
  burn: { per_hour: number | null; currency: string | null };
  budget: { monthly: number; used: number; remaining: number; projected_pct: number | null } | null;
  verdict: StatusVerdict;
  ttft: { p50_ms: number | null };
  stale: boolean;
  provenance: {
    spend: string;
    session: string;
    burn: string;
    budget_projected_pct: string;
    ttft: string;
  };
};

export type StatuslineResult = {
  snapshot: StatusSnapshot;
  /** The one-line human render of the snapshot. */
  line: string;
  /** The exit code this state maps to (0/10/11/20/30). */
  exitCode: number;
  /** Extra context only the `--format json` superset carries. */
  extras: {
    session: {
      id: string;
      agent: string;
      started_at: string;
      ended_at: string;
      turns: number;
    } | null;
    burn_span_hours: number | null;
    store_rows: number;
  };
};

/** Exit code for a verdict, per the G5 contract: 0/10/11/20/30. */
export function statusExitCode(verdict: StatusVerdict): number {
  switch (verdict) {
    case "near-limit":
      return 10;
    case "limit-hit":
      return 11;
    case "indeterminate":
      return 20;
    case "no-data":
      return 30;
    default:
      return 0;
  }
}

const SPEND_PROVENANCE = gatewayBilled("sum of gateway-computed per-request cost from the store");
const SESSION_PROVENANCE = heuristic("time-gap sessionization (session boundary only)");
const BURN_PROVENANCE = heuristic("burn-rate v1");
const TTFT_PROVENANCE = gatewayBilled("median of gateway-reported ttft_ms over the trailing 24h");

/** Store ttft values over the trailing window, newest first (fail-open: []). */
function readTtftValues(nowMs: number, windowMs: number): number[] {
  const opened = openStore(storePath()) as
    | { ok: true; db: { prepare: (sql: string) => { all: (...p: unknown[]) => unknown[] } } }
    | { ok: false; reason: string };
  if (!opened.ok) return [];
  try {
    const since = new Date(nowMs - windowMs).toISOString();
    const rows = opened.db
      .prepare(
        `SELECT ttft_ms FROM requests WHERE ttft_ms IS NOT NULL AND ${createdSince()} ` +
          "ORDER BY created_at DESC",
      )
      .all(since) as unknown as { ttft_ms: number | null }[];
    return rows.map((r) => r.ttft_ms).filter((v): v is number => typeof v === "number");
  } finally {
    try {
      (opened.db as unknown as { close: () => void }).close();
    } catch {
      // already closed
    }
  }
}

/** Nearest-rank p50 (the median) of a sample; null for an empty one. */
export function p50(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.5 * sorted.length) - 1)] ?? null;
}

/** UTC calendar day containing `at`, as [startMs, endMs). */
export function dayWindow(at: Date): { startMs: number; endMs: number } {
  const startMs = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return { startMs, endMs: startMs + 24 * HOUR_MS };
}

/**
 * The statusline, computed from the local store only. Never throws for data
 * reasons — every degraded state maps to a verdict. `staleThresholdMs`
 * overrides the one-shot staleness default (watch passes interval × factor).
 */
export function computeStatusline(
  options: { now?: Date; staleThresholdMs?: number } = {},
): StatuslineResult {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const generatedAt = new Date(nowMs).toISOString();

  // The most recent time-gap session is "the session": boundaries are
  // heuristic (annotated), its cost is a verbatim gateway sum.
  const sessions = readSessions();
  const current: (typeof sessions)[number] | undefined =
    sessions.length > 0 ? sessions[sessions.length - 1] : undefined;

  let rows: ForecastRow[] = [];
  let currency: string | null = null;
  let mixedCurrency = false;
  try {
    const read = readForecastRows({ now });
    rows = read.rows;
    currency = read.currency;
  } catch {
    // Mixed currencies (or an unreadable store mid-read): sums would be a
    // guess, so the spend figures stay empty and the verdict degrades.
    mixedCurrency = true;
  }

  const budget = loadBudget();
  const monthly = budget.monthly;
  const displayCurrency = currency ?? budget.currency;
  const day = dayWindow(now);
  const todaySpend = mixedCurrency ? null : attributedSpend(rows, day.startMs, day.endMs);

  const fc = mixedCurrency
    ? null
    : forecast({ rows, now, budget: monthly, currency: displayCurrency });
  const headline = fc
    ? fc.headlineRate
    : { ok: false as const, reason: "insufficient-data" as const, spanHours: 0 };
  const burnPerHour = headline.ok ? headline.value.value : null;
  const monthSpend = fc ? fc.currentSpend.value : null;

  const ttfts = readTtftValues(nowMs, 24 * HOUR_MS);
  const ttftP50 = p50(ttfts);

  const used = monthSpend ?? 0;
  const projectedPct =
    monthly !== null && fc?.projectedMonthEnd ? (fc.projectedMonthEnd.value / monthly) * 100 : null;

  // Verdict (G5): gate on the budget, degrade on untrustworthy data. A
  // data set we cannot sum (mixed currencies) is indeterminate even though
  // rows exist — it is not "no data".
  let verdict: StatusVerdict;
  if (mixedCurrency) verdict = "indeterminate";
  else if (rows.length === 0) verdict = "no-data";
  else if (monthly === null) verdict = "ok";
  else if (!headline.ok) verdict = "indeterminate";
  else if (used >= monthly) verdict = "limit-hit";
  else if (
    used >= (NEAR_LIMIT_PCT / 100) * monthly ||
    (projectedPct !== null && projectedPct >= 100)
  )
    verdict = "near-limit";
  else verdict = "ok";

  // Staleness: a store that has never synced is stale the moment it has
  // rows (rows can only come from a sync); otherwise age vs the threshold.
  const threshold = options.staleThresholdMs ?? ONE_SHOT_STALE_MS;
  const lastSyncMs = readLastSyncMs();
  const stale = rows.length > 0 && (lastSyncMs === null || nowMs - lastSyncMs > threshold);

  // No data means no measured figures: spend and burn stay null (a zero
  // would read as "measured $0.00", which we cannot claim).
  const hasData = rows.length > 0 && !mixedCurrency;

  const snapshot: StatusSnapshot = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    source: "aiand status",
    spend: {
      session: hasData ? (current?.cost ?? null) : null,
      today: hasData ? todaySpend : null,
      currency: displayCurrency,
    },
    burn: { per_hour: hasData ? burnPerHour : null, currency: displayCurrency },
    budget:
      monthly === null
        ? null
        : {
            monthly,
            used: monthSpend ?? 0,
            remaining: monthly - (monthSpend ?? 0),
            projected_pct: projectedPct,
          },
    verdict,
    ttft: { p50_ms: ttftP50 },
    stale,
    provenance: {
      spend: formatLabel(SPEND_PROVENANCE),
      session: formatLabel(SESSION_PROVENANCE),
      burn: formatLabel(BURN_PROVENANCE),
      budget_projected_pct: formatLabel(BURN_PROVENANCE),
      ttft: formatLabel(TTFT_PROVENANCE),
    },
  };

  const extras = {
    session:
      current === undefined
        ? null
        : {
            id: current.session_id,
            agent: current.agent,
            started_at: current.started_at,
            ended_at: current.ended_at,
            turns: current.turns,
          },
    burn_span_hours: headline.ok ? headline.spanHours : null,
    store_rows: rows.length,
  };

  return {
    snapshot,
    line: renderLine(snapshot, lastSyncMs === null ? null : new Date(lastSyncMs)),
    exitCode: statusExitCode(verdict),
    extras,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function money(value: number | null, currency: string | null): string {
  if (value === null) return "–";
  const symbol =
    currency === "usd" ? "$" : currency === "jpy" ? "¥" : currency ? `${currency} ` : "";
  return `${symbol}${value.toFixed(2)}`;
}

/**
 * The overall state glyph: 🟢 ok, 🟡 near-limit, 🔴 limit-hit, ⚪ unknown.
 * Colors are governed by src/cli/output.ts (auto-drop when piped); glyphs
 * are content, not color, and stay in the piped line — the statusline hook
 * contract is the text itself.
 */
export function verdictGlyph(verdict: StatusVerdict): string {
  switch (verdict) {
    case "ok":
      return "🟢";
    case "near-limit":
      return "🟡";
    case "limit-hit":
      return "🔴";
    default:
      return "⚪";
  }
}

function hhmm(at: Date): string {
  return at.toTimeString().slice(0, 5);
}

/**
 * The one-line render. Exactly one line, no newlines, no box drawing; ANSI
 * (only the dim stale suffix) drops automatically when stdout is not a TTY.
 * The no-data state renders one plain line too, so statusline hooks always
 * get a usable string.
 */
export function renderLine(snapshot: StatusSnapshot, lastSyncAt: Date | null = null): string {
  if (snapshot.verdict === "no-data") {
    return "aiand status: no data yet — run `aiand usage` to sync the local store";
  }

  const { spend, burn, budget, verdict, ttft } = snapshot;
  const parts: string[] = [];

  parts.push(
    `💰 ${money(spend.session, spend.currency)} session / ${money(spend.today, spend.currency)} today`,
  );

  const rate =
    burn.per_hour === null ? `🔥 indeterminate` : `🔥 ${money(burn.per_hour, burn.currency)}/hr`;
  parts.push(`${rate} ${verdictGlyph(verdict)}`);

  if (budget !== null) {
    const currentPct = Math.floor((budget.used / budget.monthly) * 100);
    const projected = budget.projected_pct === null ? "" : `→${Math.floor(budget.projected_pct)}%`;
    parts.push(`${currentPct}%${projected} of budget`);
  }

  if (ttft.p50_ms !== null) parts.push(`ttft p50 ${Math.round(ttft.p50_ms)}ms`);

  let line = parts.join(" | ");
  if (snapshot.stale && lastSyncAt !== null) {
    line += ` · ${style.dim(`stale ${hhmm(lastSyncAt)}`)}`;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Store helpers (all fail-open)
// ---------------------------------------------------------------------------

function openDb(): {
  prepare: (sql: string) => {
    all: (...p: unknown[]) => unknown[];
    get: (...p: unknown[]) => unknown;
  };
  close: () => void;
} | null {
  const opened = openStore(storePath()) as
    | {
        ok: true;
        db: {
          prepare: (sql: string) => {
            all: (...p: unknown[]) => unknown[];
            get: (...p: unknown[]) => unknown;
          };
          close: () => void;
        };
      }
    | { ok: false; reason: string };
  return opened.ok ? opened.db : null;
}

function readLastSyncMs(): number | null {
  const db = openDb();
  if (db === null) return null;
  try {
    const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'last_sync_at'").get() as
      | { value?: unknown }
      | undefined;
    const value = row?.value;
    if (typeof value !== "string") return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

function readSessions(): ReturnType<typeof listSessions>["sessions"] {
  try {
    return listSessions().sessions;
  } catch {
    return [];
  }
}
