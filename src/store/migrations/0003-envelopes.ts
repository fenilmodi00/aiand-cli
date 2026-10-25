/**
 * Migration 0003: the `envelopes` table (OBS-P3-6, ticket #78).
 *
 * One row per locally captured adapter envelope — the compact per-request
 * metadata (`aiand-envelope/v1`, see src/agents/envelope.ts) that unlocks
 * one-shot/retry, task classification, and project/branch attribution while
 * the gateway cannot forward envelopes yet (OBS-GW-1).
 *
 * Privacy, pinned by the schema and its tests: metadata only. No prompt or
 * completion columns exist; edit targets and the project root are stored
 * already-hashed by the capture layer — the table never sees a full path.
 *
 * Linkage: rows carry the same masked `api_key` the gateway /logs rows use
 * plus `created_at`, so attribution (#78) joins an envelope to the request
 * rows it describes without a server-side id. `session_id` links to
 * `sessions.session_id` when the caller knows it; `request_id` when a gateway
 * echo has landed. Both nullable — linkage is best-effort, never guessed.
 *
 * `agent` is the harness id that captured the turn ("opencode", "claude", …),
 * `model` the model id in effect, both as reported by the caller.
 */

export const version = 3;

export const name = "envelopes";

export const sql = `
CREATE TABLE IF NOT EXISTS envelopes (
  id              TEXT PRIMARY KEY,
  schema_version  TEXT NOT NULL,
  agent           TEXT NOT NULL,
  model           TEXT,
  api_key         TEXT,
  session_id      TEXT,
  request_id      TEXT,
  created_at      TEXT NOT NULL,
  tools           TEXT NOT NULL,
  edit_targets    TEXT NOT NULL,
  project_root_id TEXT,
  git_branch      TEXT,
  captured_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_envelopes_created_at
  ON envelopes (created_at, id);

CREATE INDEX IF NOT EXISTS idx_envelopes_api_key
  ON envelopes (api_key, created_at);
`;
