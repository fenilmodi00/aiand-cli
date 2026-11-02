import type { DatabaseSync } from "node:sqlite";
import { createdSince, createdUntilExcl, openStore, storePath } from "./index.js";

/**
 * Reader for the `imported_artifacts` table (migration 0008 — ticket #133's
 * writer, this file is #146's read path). The table holds behavioral markers
 * backfilled by `aiand harness import` from the harnesses' own session files:
 * tool outcomes (name + ok), terminal states, compaction events, keyed by
 * harness + harness-local session id. No prompt, completion, tool-argument,
 * or file-content column exists — the reader never widens that contract.
 *
 * This module is deliberately read-only and db-injecting: it never imports
 * `node:sqlite` at runtime and never opens the store itself (the convenience
 * wrapper below is the only caller that does). Fail-open throughout — a
 * missing table, an old store version, or a locked db contributes zero
 * markers, never a thrown error in a stats path.
 */

/** One imported behavioral marker row, verbatim from the store. */
export type ImportedArtifactRow = {
  dedup_key: string;
  harness: string;
  session_id: string;
  /** "tool" | "terminal" | "compaction". */
  kind: string;
  tool_name: string | null;
  outcome: string | null;
  seq: number | null;
  at: string | null;
  imported_at: string;
};

export type ListImportedArtifactsQuery = {
  /** Inclusive ISO lower bound on the marker's window stamp. */
  since?: string;
  /** Exclusive ISO upper bound on the marker's window stamp. */
  until?: string;
};

/**
 * The window stamp: the marker's own timestamp when the artifact carried
 * one, else the import time. A bare column comparison would miss the
 * nullable `at` half of the table.
 */
const WINDOW_COL = "COALESCE(at, imported_at)";

/** The projected columns, in contract order — never `SELECT *`. */
const COLUMNS =
  "dedup_key, harness, session_id, kind, tool_name, outcome, seq, at, imported_at";

/** Coerce one raw row; a row without its id is unusable and skipped. */
function rowToImported(row: Record<string, unknown>): ImportedArtifactRow | null {
  if (typeof row.dedup_key !== "string" || row.dedup_key === "") return null;
  return {
    dedup_key: row.dedup_key,
    harness: typeof row.harness === "string" ? row.harness : "",
    session_id: typeof row.session_id === "string" ? row.session_id : "",
    kind: typeof row.kind === "string" ? row.kind : "",
    tool_name: typeof row.tool_name === "string" ? row.tool_name : null,
    outcome: typeof row.outcome === "string" ? row.outcome : null,
    seq: typeof row.seq === "number" ? row.seq : null,
    at: typeof row.at === "string" ? row.at : null,
    imported_at: typeof row.imported_at === "string" ? row.imported_at : "",
  };
}

/**
 * Imported markers in deterministic (harness, session_id, seq, at) order —
 * the order per-session walks (last terminal wins, seq-ordered tools)
 * depend on. Defensively deduped by `dedup_key` (UNIQUE in DDL; the guard
 * covers callers that hand us rows from elsewhere).
 */
export function listImportedArtifactsFromDb(
  db: DatabaseSync,
  query: ListImportedArtifactsQuery = {},
): ImportedArtifactRow[] {
  try {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (query.since !== undefined) {
      conditions.push(createdSince(WINDOW_COL));
      params.push(query.since);
    }
    if (query.until !== undefined) {
      conditions.push(createdUntilExcl(WINDOW_COL));
      params.push(query.until);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT ${COLUMNS} FROM imported_artifacts${where} ORDER BY harness, session_id, seq, at`,
      )
      .all(...params) as Record<string, unknown>[];
    const seen = new Set<string>();
    const markers: ImportedArtifactRow[] = [];
    for (const row of rows) {
      const marker = rowToImported(row);
      if (marker === null || seen.has(marker.dedup_key)) continue;
      seen.add(marker.dedup_key);
      markers.push(marker);
    }
    return markers;
  } catch {
    // fail-open: no table / locked db → no markers, never a throw
    return [];
  }
}

/** Same query against the default store (opens and closes its own handle). */
export function listImportedArtifacts(
  query: ListImportedArtifactsQuery = {},
): ImportedArtifactRow[] {
  const opened = openStore(storePath());
  if (!opened.ok) return [];
  try {
    return listImportedArtifactsFromDb(opened.db, query);
  } finally {
    try {
      opened.db.close();
    } catch {
      // already closed
    }
  }
}
