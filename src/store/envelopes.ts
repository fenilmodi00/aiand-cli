import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ENVELOPE_SCHEMA_VERSION, type EnvelopeV1, parseEnvelope } from "../agents/envelope.js";
import { createdSince, createdUntilExcl, openStore, storePath } from "./index.js";

/**
 * Envelope storage (ticket #78): read/write access to the `envelopes` table
 * (migration 0003). The table holds locally captured `aiand-envelope/v1`
 * records — see src/agents/envelope.ts for the schema and its privacy rules.
 *
 * Rows link to the gateway request rows by the same masked `api_key` plus
 * `created_at`; `session_id`/`request_id` are best-effort links, nullable.
 * All writes are plain INSERTs (capture is append-only); reads are ordered
 * (`created_at`, `id`) so envelope sequences are deterministic inputs for the
 * classifier and the one-shot/retry metric.
 */

/** One stored envelope row, with its linkage columns. */
export type EnvelopeRow = {
  id: string;
  schema_version: string;
  agent: string;
  model: string | null;
  api_key: string | null;
  session_id: string | null;
  request_id: string | null;
  created_at: string;
  /** The parsed envelope; null when the stored JSON failed the schema check. */
  envelope: EnvelopeV1 | null;
  project_root_id: string | null;
  git_branch: string | null;
  captured_at: string;
};

export type InsertEnvelopeInput = {
  envelope: EnvelopeV1;
  agent: string;
  model?: string | null;
  apiKey?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  createdAt?: string;
  id?: string;
};

/** Insert one envelope row. Returns the row id (caller-supplied or generated). */
export function insertEnvelope(db: DatabaseSync, input: InsertEnvelopeInput): string {
  const id = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  db.prepare(
    "INSERT INTO envelopes " +
      "(id, schema_version, agent, model, api_key, session_id, request_id, " +
      "created_at, tools, edit_targets, project_root_id, git_branch, captured_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.envelope.schema_version,
    input.agent,
    input.model ?? null,
    input.apiKey ?? null,
    input.sessionId ?? null,
    input.requestId ?? null,
    createdAt,
    JSON.stringify(input.envelope.tools),
    JSON.stringify(input.envelope.edit_targets),
    input.envelope.project_root_id,
    input.envelope.git_branch,
    new Date().toISOString(),
  );
  return id;
}

function rowToEnvelope(row: Record<string, unknown>): EnvelopeRow {
  const toolsJson = typeof row.tools === "string" ? row.tools : "[]";
  const targetsJson = typeof row.edit_targets === "string" ? row.edit_targets : "[]";
  // Reassemble the envelope from the columns: tools/edit_targets JSON plus
  // the identity fields. A row written by a future schema version that adds
  // unknown fields still round-trips here (unknown fields are dropped — the
  // v1 contract), which keeps readers forward-compatible.
  const envelope: EnvelopeV1 = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    tools: safeParseArray(toolsJson),
    edit_targets: safeParseArray(targetsJson),
    project_root_id: asStringOrNull(row.project_root_id),
    git_branch: asStringOrNull(row.git_branch),
  };
  return {
    id: String(row.id),
    schema_version: asStringOrNull(row.schema_version) ?? ENVELOPE_SCHEMA_VERSION,
    agent: String(row.agent),
    model: asStringOrNull(row.model),
    api_key: asStringOrNull(row.api_key),
    session_id: asStringOrNull(row.session_id),
    request_id: asStringOrNull(row.request_id),
    created_at: String(row.created_at),
    envelope: parseEnvelope(JSON.stringify(envelope)),
    project_root_id: envelope.project_root_id,
    git_branch: envelope.git_branch,
    captured_at: String(row.captured_at),
  };
}

function safeParseArray(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export type ListEnvelopesQuery = {
  /** Inclusive ISO lower bound on `created_at`. */
  since?: string;
  /** Exclusive ISO upper bound on `created_at`. */
  until?: string;
};

/** Envelope rows in deterministic (`created_at`, `id`) order. */
export function listEnvelopes(query: ListEnvelopesQuery = {}): EnvelopeRow[] {
  const opened = openStore(storePath());
  if (!opened.ok) return [];
  try {
    return listEnvelopesFromDb(opened.db, query);
  } finally {
    try {
      opened.db.close();
    } catch {
      // already closed
    }
  }
}

/** Same query against a caller-owned handle (tests, in-process pipelines). */
export function listEnvelopesFromDb(
  db: DatabaseSync,
  query: ListEnvelopesQuery = {},
): EnvelopeRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (query.since !== undefined) {
    conditions.push(createdSince());
    params.push(query.since);
  }
  if (query.until !== undefined) {
    conditions.push(createdUntilExcl());
    params.push(query.until);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM envelopes ${where} ORDER BY created_at, id`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(rowToEnvelope);
}

/** Count of envelope rows, for coverage fractions. */
export function countEnvelopes(): number {
  const opened = openStore(storePath());
  if (!opened.ok) return 0;
  try {
    return countEnvelopesInDb(opened.db);
  } finally {
    try {
      opened.db.close();
    } catch {
      // already closed
    }
  }
}

export function countEnvelopesInDb(db: DatabaseSync): number {
  return Number(
    (db.prepare("SELECT COUNT(*) AS n FROM envelopes").get() as Record<string, unknown>).n,
  );
}
