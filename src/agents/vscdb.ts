import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/* -------------------------------------------------------------------------- */
/* Generic IDE `state.vscdb` ItemTable access.                                 */
/*                                                                            */
/* Cursor (a VS Code fork) persists app state in an SQLite `state.vscdb`       */
/* whose `ItemTable(key TEXT, value BLOB)` is a key/value store. These         */
/* helpers are IDE-agnostic; the Cursor-specific adapter builds on top.        */
/* Uses the built-in node:sqlite module (Node >= 22.5). Zero-dependency.       */
/* -------------------------------------------------------------------------- */

/**
 * True for "no such table: ItemTable" errors. A missing ItemTable just means no
 * value has ever been written (e.g. a freshly installed profile that never
 * launched) and is treated as "absent". Every other error (corrupt DB,
 * permission denied, I/O failure) must propagate so callers don't silently
 * treat real failures as "absent" and overwrite the user's data.
 */
function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * Read a text value from ItemTable by key. Returns "" when the DB file, the
 * ItemTable, or the row is missing. Any other error (corrupt DB, permission
 * denied, I/O failure) propagates so callers don't silently overwrite the
 * user's data.
 */
export async function readItemTableValue(dbPath: string, key: string): Promise<string> {
  if (!dbPath || !existsSync(dbPath)) {
    return "";
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as
      | { value: string | Uint8Array | null }
      | undefined;
    const v = row?.value;
    if (v == null) {
      return "";
    }
    return typeof v === "string" ? v : new TextDecoder().decode(v);
  } catch (error) {
    // A missing ItemTable means no value yet; propagate everything else
    // (corrupt DB, permission denied, ...) so it isn't silently treated as
    // "absent" and overwritten.
    if (isMissingTableError(error)) {
      return "";
    }
    throw error;
  } finally {
    db?.close();
  }
}

/**
 * Ensure the ItemTable exists in the DB (creating the DB file if needed).
 * Cursor creates it on first launch; this lets the adapter write a secret into
 * a freshly-installed (never-launched) profile too.
 */
export async function ensureItemTable(dbPath: string): Promise<void> {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);"
    );
  } finally {
    db?.close();
  }
}

export type ItemTableMutation = { op: "set" | "del"; key: string; value?: string };

/**
 * Apply multiple ItemTable mutations (writes and/or deletes) as a single
 * atomic transaction so the DB can never be left half-applied if one write
 * fails partway through. Each entry is `{ op: "set" | "del", key, value? }`.
 */
export async function applyItemTableWrites(
  dbPath: string,
  mutations: ItemTableMutation[]
): Promise<void> {
  if (mutations.length === 0) {
    return;
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    const setStmt = db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)");
    const delStmt = db.prepare("DELETE FROM ItemTable WHERE key = ?");
    db.exec("BEGIN");
    try {
      for (const m of mutations) {
        if (m.op === "del") {
          delStmt.run(m.key);
        } else {
          setStmt.run(m.key, m.value ?? "");
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db?.close();
  }
}
