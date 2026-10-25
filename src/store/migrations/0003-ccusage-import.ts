/**
 * Migration 0003: imported usage (OBS-P3-3, #73).
 *
 * `aiand usage --import-ccusage` ingests `ccusage --json` report output
 * (daily/weekly/monthly/session/blocks) as EXTERNAL rows. Anti-double-count
 * is structural: imported rows never touch the gateway-mirrored `requests`
 * table — they live here, in their own table, and every report aggregates
 * `requests` and `imported_usage` separately (imported data is excluded from
 * gateway totals by default, folded into a separate grand total only on
 * `--include-imported`).
 *
 *   - `ccusage_imports` is the import ledger: one row per ingested payload,
 *     keyed by the SHA-256 content hash of the exact bytes. Re-importing the
 *     same file is a no-op (hash hit → 0 rows written).
 *   - `imported_usage` rows carry `source` = 'imported-ccusage' and the
 *     import date; the report renders them as
 *     `imported(ccusage@<import-date>)` per the #68/#73 vocabulary.
 *   - `period` is the report's own row identity (a date, a session id, a
 *     block id) and, with `model` ('' = aggregate row, per-model rows when
 *     the payload carried `models`), forms the replace key: importing a
 *     NEWER file over the same periods replaces those periods' rows inside
 *     one transaction, so overlapping imports update instead of stacking.
 *   - ccusage costs are price-table-derived (USD equivalents), stored in
 *     their own USD currency lane; they are never labeled gateway-billed.
 *   - Tokens are normalized to the gateway convention on the way in:
 *     ccusage reports `inputTokens` EXCLUDING cache, so
 *     `input_tokens = inputTokens + cacheReadTokens + cacheCreationTokens`
 *     and `cached_tokens = cacheReadTokens + cacheCreationTokens`, matching
 *     how the store's `requests` rows mean "input includes cached".
 */

export const version = 3;

export const name = "ccusage-import";

export const sql = `
CREATE TABLE IF NOT EXISTS ccusage_imports (
  content_hash TEXT PRIMARY KEY,
  report_kind  TEXT NOT NULL,
  row_count    INTEGER NOT NULL,
  imported_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imported_usage (
  row_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash  TEXT NOT NULL REFERENCES ccusage_imports(content_hash),
  source        TEXT NOT NULL,
  report_kind   TEXT NOT NULL,
  period        TEXT NOT NULL,
  model         TEXT NOT NULL DEFAULT '',
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  cost_value    REAL NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  imported_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_usage_key
  ON imported_usage (report_kind, period, model);

CREATE INDEX IF NOT EXISTS idx_imported_usage_window
  ON imported_usage (started_at);
`;
