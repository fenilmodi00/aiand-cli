import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

/**
 * SQLite access to the Copilot desktop app's provider store in data.db.
 *
 * The app (github.com/github/app) keeps BYOK providers in two tables whose
 * schema is undocumented and reverse-engineered (app issues #3602/#4249):
 *
 *   model_providers (id, name, type, settings_json, account_id, ...)
 *   provider_models (id, provider_id, model_id, wire_model, display_name,
 *                    max_prompt_tokens, max_output_tokens,
 *                    wire_api_override, supported_reasoning_efforts)
 *
 * Row ownership is natural: our provider rows carry the stable `aiand-` id
 * prefix, so off deletes exactly our rows and never a user-created provider.
 *
 * Two execution paths, tried in order: `node:sqlite` and the `sqlite3` CLI.
 * Both run a batch as one transaction, so a half-applied write is
 * impossible.
 */

let databaseSync: typeof DatabaseSync | null | undefined;

async function loadDatabaseSync(): Promise<typeof DatabaseSync | null> {
  if (databaseSync === undefined) {
    try {
      // Runtime-selected on purpose: node:sqlite is flag-free only on Node
      // >= 22.13 and the engines floor is 22.0.0 — a static import would
      // crash the CLI at load below that. The sqlite3 CLI is the fallback.
      const sqlite = await import("node:sqlite");
      databaseSync = sqlite.DatabaseSync;
    } catch {
      databaseSync = null;
    }
  }
  return databaseSync;
}

/** Escape a JS string into a SQL string literal body (single quotes doubled). */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A finite number as a SQL literal, else NULL. */
function sqlNumberOrNull(value: number): string {
  return Number.isFinite(value) ? String(Math.trunc(value)) : "NULL";
}

/** A non-empty string as a quoted SQL literal, else NULL. */
function sqlTextOrNull(value: string | null | undefined): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? sqlString(text) : "NULL";
}

/** True for failures that mean the undocumented app schema moved under us. */
export function isCopilotSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /no such (?:table|column)|not a database/i.test(message);
}

/** Execute a batch of statements as one atomic unit; any failure rolls back all. */
export async function execCopilotSql(dbPath: string, statements: string[]): Promise<void> {
  if (statements.length === 0) return;
  const Database = await loadDatabaseSync();
  if (Database) {
    const db = new Database(dbPath);
    try {
      db.exec("BEGIN");
      try {
        for (const statement of statements) db.exec(statement);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
    return;
  }
  // sqlite3 auto-commits per statement; the explicit BEGIN/COMMIT is what
  // makes the batch atomic, matching the node:sqlite path above. -bail stops
  // the shell at the first error so a mid-batch failure never reaches COMMIT.
  const result = spawnSync("sqlite3", ["-bail", dbPath], {
    input: `BEGIN;\n${statements.join("\n")}\nCOMMIT;`,
    encoding: "utf8",
  });
  if (result.error) throw new Error(`sqlite3 failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`sqlite3 exited ${result.status}: ${(result.stderr ?? "").trim()}`);
  }
}

/** Run one SELECT and return object rows; a missing table reads as empty. */
export async function queryCopilotSql(
  dbPath: string,
  sql: string,
): Promise<Record<string, string | number | null>[]> {
  if (!existsSync(dbPath)) return [];
  const Database = await loadDatabaseSync();
  if (Database) {
    const db = new Database(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all() as Record<string, string | number | null>[];
    } catch (error) {
      if (/no such (?:table|column)/i.test((error as Error).message)) return [];
      throw error;
    } finally {
      db.close();
    }
  }
  const result = spawnSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (/no such (?:table|column)/i.test(result.stderr ?? "")) return [];
    throw new Error(`sqlite3 exited ${result.status}: ${(result.stderr ?? "").trim()}`);
  }
  const text = result.stdout.trim();
  return text ? (JSON.parse(text) as Record<string, string | number | null>[]) : [];
}

/** Stable prefix for ai&-owned model_providers rows: the marker and the id. */
export const COPILOT_APP_PROVIDER_PREFIX = "aiand-";

/** A fresh owned provider id. */
export function newCopilotProviderId(): string {
  return `${COPILOT_APP_PROVIDER_PREFIX}${randomUUID()}`;
}

/** One catalog model rendered for the app's provider_models row shape. */
export type CopilotAppModel = {
  id: string;
  name: string;
  contextWindow: number;
  /** JSON text of the effort list; the app hides its picker for NULL. */
  reasoningEfforts: string;
};

/** The provider_models INSERT for one model; the column list lives here only. */
export function copilotModelInsert(providerId: string, model: CopilotAppModel): string {
  return `INSERT INTO provider_models (id, provider_id, model_id, wire_model, display_name, max_prompt_tokens, max_output_tokens, wire_api_override, supported_reasoning_efforts) VALUES (${sqlString(randomUUID())}, ${sqlString(providerId)}, ${sqlString(model.id)}, ${sqlString(model.id)}, ${sqlString(model.name)}, ${sqlNumberOrNull(model.contextWindow)}, ${sqlNumberOrNull(model.contextWindow)}, ${sqlString("completions")}, ${sqlTextOrNull(model.reasoningEfforts)});`;
}
