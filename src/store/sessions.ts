import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  agentKeysPath,
  buildHarnessIndex,
  resolveHarness,
  SHARED_AGENT,
} from "../api/agent-keys.js";
import { CliError } from "../cli/errors.js";
import { configPath } from "../config.js";
import { openStore, storePath } from "./index.js";
import {
  attributedAgents,
  collectLocalUsageRecords,
  correlationsPending,
  refreshCorrelations,
} from "./local-usage.js";

/**
 * Sessionization (feature catalog A4, ticket #66).
 *
 * The gateway provides no server-side session ids, so sessions are DERIVED,
 * shipped v1 as an explicitly heuristic grouping:
 *
 *   - Requests are grouped per `api_key` (the masked value, verbatim from the
 *     gateway — two distinct keys that share a mask are one group here, since
 *     the store never sees the full key).
 *   - Within a group, requests are ordered by (`created_at`, `id`) — the `id`
 *     tiebreak makes identical timestamps deterministic.
 *   - A gap of `gapMinutes` or MORE between consecutive requests starts a new
 *     session; only a gap strictly UNDER the threshold continues one. The
 *     boundary is deliberate (ticket acceptance: a gap exactly at the
 *     threshold splits; 9m59s under a 10-minute threshold does not) — a 10
 *     minute idle gap is treated as "the user walked away".
 *   - All time math is UTC on the gateway's `created_at`; no local-time or
 *     DST boundary math exists.
 *
 * Storage decision: sessions are a MATERIALIZED table (migration 0002),
 * rebuilt deterministically — DELETE + re-INSERT in one transaction —
 * whenever the request set or the gap threshold changes (a fingerprint in
 * `sync_meta` detects either). This keeps `requests` verbatim (contract
 * rule), avoids re-grouping the whole log on every read, and stays idempotent:
 * the same rows always produce byte-identical session ids and rollups, whether
 * built before or after a sync. The pure grouping lives in `sessionize()`, so
 * tests and callers can verify determinism without the database.
 *
 * Session boundaries are NEVER authoritative: every payload carries the
 * `sessionization` confidence annotation, and human output gets the one-line
 * note from `sessionizationNote()`.
 */

/** The gap threshold when nothing is configured anywhere. */
export const DEFAULT_SESSION_GAP_MINUTES = 10;

/** config.json key for the default threshold (`aiand config.json` hand-edit for now). */
export const SESSION_GAP_CONFIG_KEY = "sessionGapMinutes";

/**
 * The configured default gap: `sessionGapMinutes` in config.json when it is a
 * positive finite number, else 10. Read fail-open — a missing or malformed
 * config degrades to the default, never throws. (config.json tolerates extra
 * top-level keys on read; until a settings command exists, the key is set by
 * hand-editing the file.)
 */
export function sessionGapMinutes(): number {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    const value = raw?.[SESSION_GAP_CONFIG_KEY];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  } catch {
    // missing/unreadable/unparseable config — default applies
  }
  return DEFAULT_SESSION_GAP_MINUTES;
}

/**
 * Per-invocation gap resolution: the explicit flag wins, the config default
 * applies otherwise (flag > config > built-in default). An invalid flag is a
 * user error, not a silent fallback.
 */
export function resolveGapMinutes(flagMinutes?: number): number {
  if (flagMinutes !== undefined) {
    if (typeof flagMinutes !== "number" || !Number.isFinite(flagMinutes) || flagMinutes <= 0) {
      throw new CliError(`Invalid --session-gap value: ${String(flagMinutes)}.`, {
        hint: "Pass a positive number of minutes, e.g. --session-gap 5.",
      });
    }
    return flagMinutes;
  }
  return sessionGapMinutes();
}

// ---------------------------------------------------------------------------
// Pure grouping
// ---------------------------------------------------------------------------

/**
 * The sessionization inputs: the verbatim columns the store keeps per request
 * (shape matches the `requests` table; `cost_value` is the parsed companion
 * of the gateway `cost` string and is optional so raw gateway rows work too).
 */
export type SessionRequestRow = {
  id: string;
  api_key: string | null;
  /** Gateway wire-dialect path (e.g. "/v1/messages"); null on pre-endpoint rows. */
  endpoint?: string | null;
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost: string | null;
  cost_value?: number | null;
  currency: string | null;
};

/**
 * One derived session. `agent` is resolved per member row via the key + wire
 * dialect (`endpoint`): the sole distinct label wins, "shared" when members
 * mix dialects, `unknown` for a null or unmapped key — never guessed.
 */
export type SessionRow = {
  session_id: string;
  agent: string;
  api_key: string | null;
  started_at: string;
  ended_at: string;
  turns: number;
  /** Gateway convention: input INCLUDES cached — these are verbatim sums. */
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost: number | null;
  currency: string | null;
  /** How this session came to be: `gap` (multi-request, heuristic) or `single-request`. */
  confidence: "gap" | "single-request";
};

/**
 * Deterministic session id: SHA-256 of (api_key, started_at), first 16 hex
 * chars. Stable across rebuilds; the started_at dependence is safe because a
 * group's sessions have distinct starts by construction (consecutive walk).
 * Note: ids depend on the gap threshold — a different threshold can change
 * both boundaries and ids.
 */
function sessionId(apiKey: string | null, startedAt: string): string {
  return createHash("sha256")
    .update(`${apiKey ?? ""}\n${startedAt}`)
    .digest("hex")
    .slice(0, 16);
}

function costOf(row: SessionRequestRow): number | null {
  if (typeof row.cost_value === "number" && Number.isFinite(row.cost_value)) return row.cost_value;
  if (row.cost === null) return null;
  const parsed = Number(row.cost);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One derived session WITH its member rows (ticket #64: harness stats needs
 * per-session model mix and per-request ttft/status, which the aggregate
 * `SessionRow` does not carry). Generic so callers keep their wider row
 * shapes (model, status_code, ttft_ms, …) on the members.
 */
export type SessionDetail<T extends SessionRequestRow = SessionRequestRow> = SessionRow & {
  rows: T[];
};

/**
 * The durable correlation refinement for this row set, read from the
 * `attributed_agent` column (migration 0006). Pure read, fail-open: a
 * pre-0006 store or locked db contributes no refinements. The refine pass
 * itself runs in `rebuildSessions` before this is consulted.
 */
function sessionRefinements(rows: readonly { id: string }[]): Map<string, string> {
  try {
    const db = openStore(storePath());
    if (!db.ok) return new Map();
    try {
      return attributedAgents(
        db.db,
        rows.map((row) => row.id),
      );
    } finally {
      try {
        db.db.close();
      } catch {
        // already closed
      }
    }
  } catch {
    return new Map();
  }
}

/** The shared boundary walk: same rule as `sessionize`, members retained. */
function walkSessions<T extends SessionRequestRow>(
  rows: readonly T[],
  gapMinutes: number,
): SessionDetail<T>[] {
  const gapMs = gapMinutes * 60_000;
  const sorted = [...rows].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );

  type Group = { apiKey: string | null; requests: T[] };
  const groups = new Map<string, Group>();
  for (const row of sorted) {
    const key = row.api_key ?? "";
    const group = groups.get(key);
    if (group) group.requests.push(row);
    else groups.set(key, { apiKey: row.api_key, requests: [row] });
  }

  const harnessIndex = buildHarnessIndex();
  const refinements = sessionRefinements(rows);
  const sessions: SessionDetail<T>[] = [];
  for (const group of groups.values()) {
    let current: T[] = [];
    const flush = (): void => {
      if (current.length === 0) return;
      const first = current[0];
      if (!first) return;
      const last = current[current.length - 1];
      const labels = new Set<string>();
      for (const row of current) {
        const base = resolveHarness(harnessIndex, row.api_key, row.endpoint);
        // Correlation precedence: a specific base label is never overridden;
        // shared/unknown rows take the persisted attributed_agent refinement.
        labels.add(
          base === SHARED_AGENT || base === "unknown" ? (refinements.get(row.id) ?? base) : base,
        );
      }
      const agent = labels.size === 1 ? (labels.values().next().value ?? "unknown") : SHARED_AGENT;
      sessions.push({
        session_id: sessionId(group.apiKey, first.created_at),
        agent,
        api_key: group.apiKey,
        started_at: first.created_at,
        ended_at: last?.created_at ?? first.created_at,
        turns: current.length,
        input_tokens: current.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0),
        output_tokens: current.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0),
        cached_tokens: current.reduce((sum, r) => sum + (r.cached_tokens ?? 0), 0),
        cost: current.some((r) => costOf(r) !== null)
          ? current.reduce((sum, r) => sum + (costOf(r) ?? 0), 0)
          : null,
        currency: current.find((r) => r.currency !== null)?.currency ?? null,
        confidence: current.length === 1 ? "single-request" : "gap",
        rows: current,
      });
      current = [];
    };
    let previous: T | null = null;
    for (const row of group.requests) {
      if (previous && Date.parse(row.created_at) - Date.parse(previous.created_at) >= gapMs) {
        flush();
      }
      current.push(row);
      previous = row;
    }
    flush();
  }

  return sessions.sort(
    (a, b) => a.started_at.localeCompare(b.started_at) || a.session_id.localeCompare(b.session_id),
  );
}

/** Detailed sessionization: aggregates plus the member rows per session. */
export function sessionizeRows<T extends SessionRequestRow>(
  rows: readonly T[],
  gapMinutes: number = DEFAULT_SESSION_GAP_MINUTES,
): SessionDetail<T>[] {
  return walkSessions(rows, gapMinutes);
}

/**
 * Group request rows into sessions. Pure and deterministic: the same rows and
 * the same gap always yield identical sessions (input order is irrelevant —
 * rows are sorted internally by `created_at`, tiebreak `id`). Output is
 * ordered by (`started_at`, `session_id`).
 */
export function sessionize(
  rows: readonly SessionRequestRow[],
  gapMinutes: number = DEFAULT_SESSION_GAP_MINUTES,
): SessionRow[] {
  return walkSessions(rows, gapMinutes).map(({ rows: _memberRows, ...session }) => session);
}

// ---------------------------------------------------------------------------
// Confidence annotation
// ---------------------------------------------------------------------------

/** The machine annotation every session-derived `--json` payload must carry. */
export type SessionizationMeta = {
  method: "time-gap";
  gapMinutes: number;
  /** Always "heuristic" — session boundaries are derived, never authoritative. */
  confidence: "heuristic";
  /** The `--session <id>` scope in effect, or null. */
  override: string | null;
};

export function sessionizationAnnotation(
  gapMinutes: number,
  override: string | null = null,
): SessionizationMeta {
  return { method: "time-gap", gapMinutes, confidence: "heuristic", override };
}

/** The one-line human note paired with the annotation. */
export function sessionizationNote(gapMinutes: number): string {
  return (
    `sessions derived by ${gapMinutes}-min gap heuristic — ` +
    "boundaries are approximate, not authoritative"
  );
}

// ---------------------------------------------------------------------------
// Materialized table + query surface
// ---------------------------------------------------------------------------

export type ListSessionsQuery = {
  /** Per-invocation `--session-gap` override; config default when omitted. */
  gapMinutes?: number;
  /** `--session <id>`: scope to exactly this session (unknown id → CliError). */
  sessionId?: string;
  /**
   * Time window (ISO, compared against gateway `created_at` in UTC). A session
   * is included when its [started_at, ended_at] window INTERSECTS the filter
   * window; rollups always cover the whole session, never a clipped slice —
   * session totals must reconcile to the underlying request rows.
   */
  since?: string;
  until?: string;
};

export type ListSessionsResult = {
  sessions: SessionRow[];
  sessionization: SessionizationMeta;
};

const FINGERPRINT_KEY = "sessions_fingerprint";

function metaGet(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM sync_meta WHERE key = ?").get(key) as
    | Record<string, unknown>
    | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

function metaSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO sync_meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * Row count + watermark + threshold + key-map revision: any change
 * invalidates the materialized table. The map revision matters because
 * `agent` labels are baked into the materialized rows at rebuild time — a
 * native-key attribution sweep changes attribution without touching the
 * request rows, so the fingerprint must notice (same rows + new map →
 * different labels). SESSIONIZE_RULES_VERSION bumps when the resolution rule
 * itself changes.
 *
 * v3: local-usage correlation refinement (`requests.attributed_agent`,
 * migration 0006) feeds the agent labels, so rows rebuilt under the old
 * rule are re-baked. The refined count rides the fingerprint: a heal that
 * resolves rows in an otherwise-unchanged store (late local evidence,
 * see local-usage.ts) must re-bake the materialized labels too.
 */
export const SESSIONIZE_RULES_VERSION = 3;

/**
 * The correlation pass behind `rebuildSessions`: refine shared-key rows from
 * the agents' local usage records and persist the labels, before the
 * materialized table bakes them in. Fail-open (the correlator never throws);
 * a no-new-rows pass is a cursor no-op.
 */
function refreshCorrelationsInStore(
  db: DatabaseSync,
  rows: readonly {
    id: string;
    model: string;
    api_key: string | null;
    endpoint: string | null;
    created_at: string;
    input_tokens: number | null;
    output_tokens: number | null;
    cached_tokens: number | null;
  }[],
): void {
  if (!correlationsPending(db)) return;
  const records = collectLocalUsageRecords();
  if (records.length === 0) return;
  const keyIndex = buildHarnessIndex();
  refreshCorrelations(db, rows, records, (row) =>
    resolveHarness(keyIndex, row.api_key, row.endpoint),
  );
}

function sessionsFingerprint(db: DatabaseSync, gapMinutes: number): string {
  const count = db.prepare("SELECT COUNT(*) AS n FROM requests").get() as Record<string, unknown>;
  const watermark = db
    .prepare("SELECT id, created_at FROM requests ORDER BY created_at DESC, id DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  // Refined-row count: healing changes labels without touching count or
  // watermark, so it must invalidate on its own.
  const refined = db
    .prepare("SELECT COUNT(*) AS n FROM requests WHERE attributed_agent IS NOT NULL")
    .get() as Record<string, unknown>;
  let mapRev = "";
  try {
    mapRev = createHash("sha256").update(readFileSync(agentKeysPath(), "utf8")).digest("hex");
  } catch {
    // No map file (or unreadable): a stable sentinel keeps the fingerprint
    // deterministic — same missing map, same fingerprint.
    mapRev = "none";
  }
  return `${SESSIONIZE_RULES_VERSION}:${count?.n ?? 0}:${String(watermark?.created_at ?? "")}:${String(watermark?.id ?? "")}:${refined?.n ?? 0}:${gapMinutes}:${mapRev}`;
}

/**
 * Rebuild the `sessions` table from `requests` with the given gap. Idempotent:
 * same rows + same gap → byte-identical contents, and the fingerprint makes a
 * no-change rebuild a no-op. New request rows first get their local-usage
 * correlation pass (migration 0006 refinement), so the materialized `agent`
 * labels carry it; the fingerprint (rules version 3) then notices and this
 * rebuild is the one that bakes the refined labels in.
 */
function rebuildSessions(db: DatabaseSync, gapMinutes: number): void {
  const correlated = db
    .prepare(
      "SELECT id, model, api_key, endpoint, created_at, input_tokens, output_tokens, " +
        "cached_tokens, cost, cost_value, currency FROM requests",
    )
    .all() as unknown as (SessionRequestRow & { model: string; endpoint: string | null })[];
  refreshCorrelationsInStore(db, correlated);
  const rows = db
    .prepare(
      "SELECT id, api_key, endpoint, created_at, input_tokens, output_tokens, cached_tokens, " +
        "cost, cost_value, currency FROM requests",
    )
    .all() as unknown as SessionRequestRow[];
  const sessions = sessionize(rows, gapMinutes);

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM sessions");
    const insert = db.prepare(
      "INSERT INTO sessions (session_id, api_key, agent, started_at, ended_at, turns, " +
        "input_tokens, output_tokens, cached_tokens, cost, currency, confidence) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const session of sessions) {
      insert.run(
        session.session_id,
        session.api_key,
        session.agent,
        session.started_at,
        session.ended_at,
        session.turns,
        session.input_tokens,
        session.output_tokens,
        session.cached_tokens,
        session.cost,
        session.currency,
        session.confidence,
      );
    }
    metaSet(db, FINGERPRINT_KEY, sessionsFingerprint(db, gapMinutes));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function parseWindow(query: ListSessionsQuery): { since: number | null; until: number | null } {
  const parse = (value: string | undefined, flag: string): number | null => {
    if (value === undefined) return null;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      throw new CliError(`Invalid ${flag} value: ${value}.`, {
        hint: "Use an ISO timestamp, e.g. 2026-10-25T00:00:00Z.",
      });
    }
    return ms;
  };
  return { since: parse(query.since, "--since"), until: parse(query.until, "--until") };
}

/**
 * List sessions from the local store, rebuilding the materialized table when
 * the request set or gap has changed. Fail-open: no store / unavailable
 * node:sqlite → empty session list (with the annotation intact), never a
 * throw. `query.sessionId` scopes to one session; an unknown id is a clear
 * CliError, not empty output. Output is ordered by (`started_at`, `session_id`).
 */
export function listSessions(query: ListSessionsQuery = {}): ListSessionsResult {
  const gapMinutes = resolveGapMinutes(query.gapMinutes);
  const annotation = sessionizationAnnotation(gapMinutes, query.sessionId ?? null);

  const opened = openStore(storePath());
  if (!opened.ok) return { sessions: [], sessionization: annotation };
  const db = opened.db;

  try {
    if (metaGet(db, FINGERPRINT_KEY) !== sessionsFingerprint(db, gapMinutes)) {
      rebuildSessions(db, gapMinutes);
    }
    const rows = db
      .prepare(
        "SELECT session_id, api_key, agent, started_at, ended_at, turns, input_tokens, " +
          "output_tokens, cached_tokens, cost, currency, confidence FROM sessions " +
          "ORDER BY started_at, session_id",
      )
      .all() as unknown as SessionRow[];

    const { since, until } = parseWindow(query);
    let sessions = rows.filter((session) => {
      const start = Date.parse(session.started_at);
      const end = Date.parse(session.ended_at);
      if (since !== null && end < since) return false;
      if (until !== null && start > until) return false;
      return true;
    });

    if (query.sessionId !== undefined) {
      const scoped = sessions.filter((session) => session.session_id === query.sessionId);
      if (scoped.length === 0) {
        throw new CliError(`No session with id "${query.sessionId}" in the local store.`, {
          hint:
            "Session ids come from the --json session listing; they are derived from the " +
            `gap heuristic and change when --session-gap changes (currently ${gapMinutes} min).`,
        });
      }
      sessions = scoped;
    }

    return { sessions, sessionization: annotation };
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}
