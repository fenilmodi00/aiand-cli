/**
 * Migration 0006: `requests.attributed_agent` (local-usage correlation).
 *
 * The gateway's /logs rows identify only a masked key + wire-dialect
 * endpoint, so chat-family agents sharing one key stay "shared". The agents'
 * own local usage records (omp/pi session JSONL, opencode.db) carry the
 * per-request token counts, so a gateway row that uniquely matches one of
 * those records (same model, same tokens, within a small time window) can be
 * refined to that agent.
 *
 * Nullable TEXT: NULL means "no correlation evidence" — the row keeps the
 * key+endpoint attribution. Only rows the current rule labels `shared`
 * (or `unknown`) are ever refined; a non-shared label is never overridden.
 * Written by the correlator on sync/read (idempotent re-label), fail-open.
 */

export const version = 6;

export const name = "local-usage";

export const sql = `
ALTER TABLE requests ADD COLUMN attributed_agent TEXT;
`;
