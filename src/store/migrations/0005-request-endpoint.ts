/**
 * Migration 0005: `requests.endpoint` (dialect-aware attribution).
 *
 * The gateway serves the wire-dialect request path per /logs row
 * ("/v1/chat/completions", "/v1/messages", "/v1/responses"); the CLI was
 * dropping it, so rows sharing a baked-in session key collapsed to harness
 * "shared". Storing the path lets attribution narrow by dialect.
 *
 * Nullable: rows synced before this migration keep NULL, gateways without
 * the field omit it, and deep history beyond the sync overlap window is
 * never re-served — those fall back to key-only attribution.
 */

export const version = 5;

export const name = "request-endpoint";

export const sql = `
ALTER TABLE requests ADD COLUMN endpoint TEXT;
`;
