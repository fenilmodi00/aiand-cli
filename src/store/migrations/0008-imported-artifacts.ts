/**
 * Migration 0008: imported harness artifacts (T8, ticket #133).
 *
 * A dedicated table for markers read from the harnesses' own session files
 * (Claude projects JSONL, Codex rollouts, OpenCode SQLite) — the plan §2.3
 * artifact-import lane. Chosen over widening the envelopes table: envelopes
 * are capture-time, per-request rows keyed to gateway request ids, while an
 * imported marker has no gateway row, its own harness-local session id, and
 * a file-level dedup identity. A separate table keeps the envelope privacy
 * and identity contracts untouched.
 *
 * Privacy semantics: `tool_name` is a name (same rule as `envelopes.tools`);
 * `outcome` is an enum. No prompt, completion, tool-argument, or file-content
 * column exists — a schema test pins this (test/artifact-import.test.mjs).
 *
 * `dedup_key` (SHA-256 of structural keys: harness + session + marker
 * identity + timestamp) is UNIQUE, so re-importing the same files inserts
 * zero rows — idempotency is a DDL guarantee, not app discipline.
 */

export const version = 8;

export const name = "imported-artifacts";

export const sql = `
CREATE TABLE IF NOT EXISTS imported_artifacts (
  dedup_key TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool_name TEXT,
  outcome TEXT,
  seq INTEGER,
  at TEXT,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imported_artifacts_session
  ON imported_artifacts (harness, session_id);
`;
