/**
 * Migration 0002: the derived `sessions` table (OBS-P0-3, #66).
 *
 * Sessions are a materialized rollup, never a second source of truth: every
 * row is recomputed deterministically from `requests` (gap-based grouping per
 * `api_key`, see src/store/sessions.ts) whenever the request set or the gap
 * threshold changes. The table exists so readers (#62 `aiand sessions`,
 * #64 harness stats) do not re-group the whole request log on every call.
 *
 *   - `session_id` is a deterministic hash of (api_key, started_at) — stable
 *     across rebuilds, reveals no secret.
 *   - `agent` comes from the key→agent map; `unknown` when unmapped, never
 *     guessed.
 *   - Token columns are verbatim gateway sums: `input_tokens` INCLUDES
 *     `cached_tokens`, exactly as the store's `requests` rows report them.
 *   - `cost` is the summed parsed gateway cost (`requests.cost_value`);
 *     NULL only when every request in the session had an unparseable cost.
 *
 * Rebuilds are idempotent: same request rows + same threshold → byte-identical
 * table contents (DELETE + re-INSERT inside one transaction).
 */

export const version = 2;

export const name = "sessions";

export const sql = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  api_key       TEXT,
  agent         TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT NOT NULL,
  turns         INTEGER NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  cost          REAL,
  currency      TEXT,
  confidence    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at
  ON sessions (started_at, session_id);
`;
