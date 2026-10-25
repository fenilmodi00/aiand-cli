/**
 * Migration 0001: the initial store schema.
 *
 * One row per gateway LogEntry, every field stored VERBATIM (the sync engine
 * never recomputes anything the gateway reported):
 *
 *   - `api_key` holds the masked key exactly as the gateway returns it
 *     (sk-abcd…1234 shape); an unmasked key is never persisted.
 *   - `input_tokens` INCLUDES `cached_tokens` on the gateway; both columns
 *     store the reported values as-is — cached is never subtracted.
 *   - `cost` keeps the gateway's string; `cost_value` is the same number
 *     parsed for consumers that need arithmetic, NULL when unparseable.
 *   - No prompt/completion content columns: the /logs payload carries none
 *     and the store must never grow any (a schema test pins this).
 *
 * `synced_at` is the only derived column: when the row was written locally.
 * Shipped as a TS module rather than a .sql asset because tsc does not copy
 * assets to dist/ — the numbered-migration discipline is unchanged.
 */

export const version = 1;

export const name = "init";

export const sql = `
CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,
  model         TEXT NOT NULL,
  api_key       TEXT,
  status_code   INTEGER NOT NULL,
  ttft_ms       INTEGER,
  latency_ms    INTEGER,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  cost          TEXT,
  cost_value    REAL,
  currency      TEXT,
  created_at    TEXT NOT NULL,
  synced_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_created_at
  ON requests (created_at, id);

CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
