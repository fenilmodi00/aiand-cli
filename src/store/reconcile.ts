import { getSummary } from "../api/analytics.js";
import type { Session } from "../api/client.js";
import { getLogsPaged, LOG_RANGES, type LogEntry } from "../api/logs.js";
import { CliError } from "../cli/errors.js";
import { getStoreInfo, openStore, type StoreInfo, storePath, syncStore } from "./index.js";

/**
 * Reconciliation — the accuracy gate (feature catalog A5, ticket #63).
 *
 * Compares what the local store computes (request count, token totals, cost
 * totals) against what the gateway itself reports, per window:
 *
 *   - windows up to 30 days: remote reference = `/logs`, paged in full and
 *     summed entry by entry (gateway-verbatim values);
 *   - the 3-month window: remote reference = `/analytics/summary` (the only
 *     endpoint that reaches past 30 days). The summary carries no cost, so
 *     the cost row is reported `unverifiable`, never silently dropped;
 *   - anything the gateway cannot see (windows past 3 months, or arbitrary
 *     since/until slices wider than 30 days) is reported `unverifiable` with
 *     a reason — never skipped, never guessed.
 *
 * Trust rules (H1): every number on both sides is a sum of gateway-billed
 * values. Tokens follow the gateway convention — `input_tokens` INCLUDES
 * `cached_tokens`, so the token total is input + output with nothing added
 * or subtracted. Cost is the gateway `cost` string parsed numerically.
 * Nothing is recomputed from price tables.
 *
 * Never hide: a mismatch is reported as-is with the exact delta. The only
 * tolerance is a floating-point epsilon on the cost metric (parsed decimal
 * strings can differ in the last bit depending on summation order); token
 * and request counts are integers and must match exactly.
 */

/** Ranges `usage --verify` accepts: every /logs range plus the 3-month summary. */
export const VERIFY_RANGES = [...LOG_RANGES, "3months"] as const;
export type VerifyRange = (typeof VERIFY_RANGES)[number];

type LogRange = (typeof LOG_RANGES)[number];

const RANGE_MS: Record<VerifyRange, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7days": 7 * 24 * 60 * 60_000,
  "30days": 30 * 24 * 60 * 60_000,
  "3months": 90 * 24 * 60 * 60_000,
};

const MAX_LOGS_MS = RANGE_MS["30days"];
const MAX_ANALYTICS_MS = RANGE_MS["3months"];

/** Floating-point slack for the cost metric only; see the module doc. */
export const COST_EPSILON = 1e-9;

export type VerifyMetric = "requests" | "tokens" | "cost";

/**
 * `ok` — local and gateway agree. `mismatch` — they do not; the delta is
 * exact. `unverifiable` — the gateway cannot serve this comparison (window
 * past its horizon, no cost in the analytics summary, or no local store);
 * the local value is still reported.
 */
export type VerifyStatus = "ok" | "mismatch" | "unverifiable";

/**
 * Which gateway endpoint the remote number came from. `none` marks a window
 * no endpoint can serve (beyond the 3-month analytics horizon, or an
 * arbitrary since/until slice the fixed-range summary cannot represent).
 */
export type VerifySource = "logs" | "analytics" | "none";

export type VerifyRow = {
  source: VerifySource;
  window: { since: string; until: string };
  metric: VerifyMetric;
  local: number;
  /** null when the remote side cannot serve this comparison. */
  remote: number | null;
  /** local - remote; null when unverifiable. */
  delta: number | null;
  status: VerifyStatus;
  /** Why a comparison is unverifiable. */
  detail?: string;
};

/** How the pre-verify sync went; a failed sync is surfaced, never folded away. */
export type VerifySync = {
  /** false when sync was skipped (--no-sync / AIAND_NO_SYNC=1). */
  requested: boolean;
  ok: boolean;
  code?: "network" | "auth" | "store";
  error?: string;
};

export type VerifyOutcome = {
  rows: VerifyRow[];
  sync: VerifySync;
  store: StoreInfo;
};

export type VerifyOptions = {
  range: VerifyRange;
  since?: string;
  until?: string;
  /** --no-sync / AIAND_NO_SYNC=1: compare the local store as-is. */
  skipSync: boolean;
};

type Totals = { requests: number; tokens: number; cost: number };

type ResolvedWindow = {
  since: string;
  until: string;
  source: VerifySource;
  /** The /logs range to request when source is "logs". */
  logsRange?: LogRange;
  /** The /analytics range to request when source is "analytics". */
  analyticsRange?: "3months";
  /** Why source is "none". */
  detail?: string;
};

/** The gateway cost string parsed for arithmetic; null when absent/unparseable. */
function parseCost(cost: string | null): number | null {
  if (cost === null) return null;
  const value = Number(cost);
  return Number.isFinite(value) ? value : null;
}

/**
 * Sum gateway-verbatim log rows the way the gateway bills them: requests are
 * rows, tokens are input + output (input INCLUDES cached — never re-add
 * cached_tokens on top, and never subtract it), cost is the parsed gateway
 * `cost` string. Unparseable or absent costs contribute nothing on BOTH
 * sides, so they cancel rather than fake a mismatch.
 */
export function sumLogEntries(entries: readonly LogEntry[]): Totals {
  let requests = 0;
  let tokens = 0;
  let cost = 0;
  for (const entry of entries) {
    requests += 1;
    tokens += (entry.input_tokens ?? 0) + (entry.output_tokens ?? 0);
    const parsed = parseCost(entry.cost);
    if (parsed !== null) cost += parsed;
  }
  return { requests, tokens, cost };
}

/**
 * Resolve the window to verify. `--since`/`--until` (both or neither) define
 * an explicit window; otherwise the range counts back from now. Source
 * selection: explicit windows up to 30 days go to /logs (the covering
 * smallest /logs range is requested and entries are filtered to the window);
 * the fixed 3-month range goes to /analytics/summary. Anything wider —
 * explicit windows past 30 days the fixed-range summary cannot represent,
 * or anything past the 3-month horizon — resolves to source "none" with the
 * reason attached.
 */
export function resolveVerifyWindow(
  opts: Pick<VerifyOptions, "range" | "since" | "until">,
  now: number = Date.now(),
): ResolvedWindow {
  const untilMs = opts.until !== undefined ? Date.parse(opts.until) : now;
  if (Number.isNaN(untilMs)) {
    throw new CliError(`Invalid --until value: ${opts.until}.`, {
      hint: "Use an ISO timestamp, e.g. 2026-10-25T00:00:00Z.",
    });
  }
  if (opts.since !== undefined) {
    const sinceMs = Date.parse(opts.since);
    if (Number.isNaN(sinceMs)) {
      throw new CliError(`Invalid --since value: ${opts.since}.`, {
        hint: "Use an ISO timestamp, e.g. 2026-09-25T00:00:00Z.",
      });
    }
    if (sinceMs >= untilMs) {
      throw new CliError("--since must be earlier than --until.");
    }
    const duration = untilMs - sinceMs;
    const since = new Date(sinceMs).toISOString();
    const until = new Date(untilMs).toISOString();
    if (duration <= MAX_LOGS_MS) {
      return {
        since,
        until,
        source: "logs",
        logsRange: coveringLogsRange(now - sinceMs),
      };
    }
    if (duration <= MAX_ANALYTICS_MS) {
      return {
        since,
        until,
        source: "none",
        detail:
          "the gateway's /analytics summary serves fixed ranges only and /logs stops at 30 days, " +
          "so an arbitrary window this wide cannot be reconciled",
      };
    }
    return {
      since,
      until,
      source: "none",
      detail: "the window is older than the gateway's 3-month analytics horizon",
    };
  }

  const range = opts.range;
  const since = new Date(now - RANGE_MS[range]).toISOString();
  const until = new Date(now).toISOString();
  if (range === "3months") {
    return { since, until, source: "analytics", analyticsRange: "3months" };
  }
  return { since, until, source: "logs", logsRange: range as LogRange };
}

/** Smallest /logs range that covers `spanMs` back from now. */
function coveringLogsRange(spanMs: number): LogRange {
  for (const range of LOG_RANGES) {
    if (spanMs <= RANGE_MS[range]) return range;
  }
  return "30days";
}

/** Local store sums over the window; a closed-over store is always closed here. */
function localTotals(since: string, until: string): Totals {
  const opened = openStore(storePath());
  if (!opened.ok) return { requests: 0, tokens: 0, cost: 0 };
  const db = opened.db;
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS requests, " +
          "COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens, " +
          "COALESCE(SUM(cost_value), 0) AS cost FROM requests " +
          "WHERE created_at >= ? AND created_at <= ?",
      )
      .get(since, until) as Record<string, unknown>;
    return {
      requests: Number(row.requests ?? 0),
      tokens: Number(row.tokens ?? 0),
      cost: Number(row.cost ?? 0),
    };
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

function inWindow(entry: LogEntry, since: string, until: string): boolean {
  return entry.created_at >= since && entry.created_at <= until;
}

/**
 * Run the reconciliation. The remote fetch throwing (network down, 401, a
 * gateway that no longer serves the endpoint) propagates — an unverified
 * claim must fail loudly, never pass silently. A failed pre-verify sync is
 * different: it degrades the local side, so it is surfaced in the outcome
 * (`sync.ok: false`) and the comparison still runs on the store as-is.
 */
export async function reconcileUsage(
  session: Session,
  opts: VerifyOptions,
): Promise<VerifyOutcome> {
  const window = resolveVerifyWindow(opts);

  let sync: VerifySync = { requested: false, ok: true };
  if (!opts.skipSync) {
    const result = await syncStore(session);
    sync = result.ok
      ? { requested: true, ok: true }
      : { requested: true, ok: false, code: result.code, error: result.error };
  }

  const store = getStoreInfo();
  // A failed sync that left the store empty leaves nothing trustworthy on the
  // local side: comparing a fabricated 0 against the gateway would fake a
  // mismatch, so those rows are unverifiable instead. A failed sync with a
  // populated store still compares — the store's data is real, if stale.
  const syncFailedEmpty = sync.requested && !sync.ok && store.rows === 0;
  const storeUsable =
    (store.status === "ok" || store.status === "stale" || store.status === "corrupt-recovered") &&
    !syncFailedEmpty;
  const storeUnavailableReason = syncFailedEmpty
    ? "the pre-verify sync failed and the local store is empty — nothing to compare against"
    : `the local request store is ${store.status}`;
  const local: Totals = storeUsable
    ? localTotals(window.since, window.until)
    : { requests: 0, tokens: 0, cost: 0 };

  let remote: Totals | null = null;
  if (window.source === "logs") {
    const { entries } = await getLogsPaged(session, {
      range: window.logsRange,
      limit: Number.POSITIVE_INFINITY,
    });
    remote = sumLogEntries(entries.filter((entry) => inWindow(entry, window.since, window.until)));
  } else if (window.source === "analytics" && window.analyticsRange) {
    const summary = await getSummary(session, window.analyticsRange);
    // The summary's input_tokens already includes cached, same convention.
    remote = {
      requests: summary.current.requests,
      tokens: summary.current.input_tokens + summary.current.output_tokens,
      // The summary reports no cost — the cost row stays unverifiable below.
      cost: 0,
    };
  }

  const metrics: VerifyMetric[] = ["requests", "tokens", "cost"];
  const rows: VerifyRow[] = metrics.map((metric) => {
    const base = {
      source: window.source,
      window: { since: window.since, until: window.until },
      metric,
      local: local[metric],
    };
    if (window.source === "none") {
      return { ...base, remote: null, delta: null, status: "unverifiable", detail: window.detail };
    }
    if (metric === "cost" && window.source === "analytics") {
      // The analytics summary carries no cost figure: reported as
      // unverifiable, never silently compared against a fabricated zero.
      return {
        ...base,
        remote: null,
        delta: null,
        status: "unverifiable",
        detail: "the /analytics summary reports requests and tokens only, no cost",
      };
    }
    if (remote === null || !storeUsable) {
      return {
        ...base,
        remote: remote === null ? null : remote[metric],
        delta: null,
        status: "unverifiable",
        detail: storeUnavailableReason,
      };
    }
    const delta = local[metric] - remote[metric];
    const ok = metric === "cost" ? Math.abs(delta) <= COST_EPSILON : delta === 0;
    return { ...base, remote: remote[metric], delta, status: ok ? "ok" : "mismatch" };
  });

  return { rows, sync, store };
}
