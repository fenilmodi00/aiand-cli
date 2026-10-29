/**
 * Migration 0007: envelope tool outcomes + terminal marker (T1, ticket #126).
 *
 * Extends the `envelopes` table for the v1 envelope's new optional fields:
 * `tool_outcomes` (JSON array of `{ name, ok }` in call order, mirroring the
 * `tools` cap of 32) and `terminal` ("clean" | "aborted" | "errored", or NULL).
 *
 * Privacy semantics unchanged: `ok` is a boolean — error text, prompts, and
 * completions are never captured, so no new free-text column exists beyond
 * the tool NAME the table already stores.
 *
 * Nullable by design: rows written before this migration keep NULL — the
 * reader treats absence as "unknown", never counted as ok or error.
 */

export const version = 7;

export const name = "envelope-outcomes";

export const sql = `
ALTER TABLE envelopes ADD COLUMN tool_outcomes TEXT;
ALTER TABLE envelopes ADD COLUMN terminal TEXT;
`;
