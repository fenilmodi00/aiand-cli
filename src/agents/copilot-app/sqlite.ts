import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { systemToolEnv } from "../../cli/spawn-env.js";
import { findWindowsExecutable, type PathLookup } from "../../cli/win-spawn.js";

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

/**
 * What to spawn for the sqlite3 CLI, or null. On Windows it is resolved by our
 * PATH walk and spawned by absolute path, since a bare name would let libuv try
 * the current directory first. Only a real `sqlite3.exe` counts: spawnSync
 * cannot run a `.cmd` or `.bat` (CVE-2024-27980), and routing one through
 * cmd.exe would put the SQL on a command line. Asking for the `.exe` by name
 * also finds one that sits after a shim on PATH.
 */
export function sqlite3Command(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  lookup?: PathLookup,
): string | null {
  return platform === "win32" ? findWindowsExecutable("sqlite3.exe", env, lookup) : "sqlite3";
}

function runSqlite3(args: string[], options: SpawnSyncOptionsWithStringEncoding) {
  const command = sqlite3Command();
  if (command === null) {
    const error = Object.assign(new Error("spawn sqlite3 ENOENT"), { code: "ENOENT" });
    return { error, status: null, stdout: "", stderr: "" };
  }
  return spawnSync(command, args, { ...options, env: systemToolEnv() });
}

/** Escape a JS string into a SQL string literal body (single quotes doubled). */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A finite number as a SQL literal, else NULL. */
function sqlNumberOrNull(value: number | null): string {
  return value !== null && Number.isFinite(value) ? String(Math.trunc(value)) : "NULL";
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

/**
 * True when data.db could not be opened for use (mode 000, a locked-down
 * parent dir, ACLs). node:sqlite reports "unable to open database file";
 * the sqlite3 CLI and Node fs probes surface the errno text instead. On
 * Windows a mode-000 db still opens (the read-only flag is all chmod can
 * express) and fails at the first write with SQLITE_READONLY — "attempt to
 * write a readonly database" is the same unusable-store failure.
 */
export function isCopilotDbAccessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unable to open database file|EACCES|EPERM|permission denied|readonly database/i.test(
    message,
  );
}

/**
 * Fail closed when the file's own mode has no bit for the operation. SQLite
 * already reports EACCES for every non-root user, but root bypasses mode
 * bits: without this probe a root-run `on` would commit rows into a 0o000
 * db the app can never read, and the command would report success. A file
 * with no read (or, for writes, no write) bit is a deliberate lock, not a
 * usable store, whoever runs the CLI.
 */
function assertCopilotDbMode(dbPath: string, action: "read" | "write"): void {
  let mode: number;
  try {
    mode = statSync(dbPath).mode;
  } catch {
    // Missing/unstattable: let SQLite (or the caller's existsSync gate)
    // report it with its own message.
    return;
  }
  if ((mode & (action === "read" ? 0o444 : 0o222)) !== 0) return;
  throw Object.assign(new Error(`unable to open database file: EACCES '${dbPath}'`), {
    code: "EACCES",
  });
}

/** Execute a batch of statements as one atomic unit; any failure rolls back all. */
export async function execCopilotSql(dbPath: string, statements: string[]): Promise<void> {
  if (statements.length === 0) return;
  assertCopilotDbMode(dbPath, "write");
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
  const result = runSqlite3(["-bail", dbPath], {
    input: `BEGIN;\n${statements.join("\n")}\nCOMMIT;`,
    encoding: "utf8",
  });
  if (result.error) throw new Error(`sqlite3 failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`sqlite3 exited ${result.status}: ${(result.stderr ?? "").trim()}`);
  }
}

/**
 * Rebuild data.db in place. A DELETE only unlinks rows: their bytes stay
 * readable in freed pages until the file is rewritten, so the session key
 * baked into settings_json must be VACUUM-ed away. VACUUM cannot run inside
 * a transaction — call it after the delete batch commits.
 */
export async function vacuumCopilotSql(dbPath: string): Promise<void> {
  assertCopilotDbMode(dbPath, "write");
  const Database = await loadDatabaseSync();
  if (Database) {
    const db = new Database(dbPath);
    try {
      db.exec("VACUUM");
    } finally {
      db.close();
    }
    return;
  }
  const result = runSqlite3(["-bail", dbPath], { input: "VACUUM;", encoding: "utf8" });
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
  assertCopilotDbMode(dbPath, "read");
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
  const result = runSqlite3(["-json", dbPath, sql], {
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
  maxPromptTokens: number;
  maxOutputTokens: number | null;
  /** JSON text of the effort list; the app hides its picker for NULL. */
  reasoningEfforts: string;
};

/** The provider_models INSERT for one model; the column list lives here only. */
export function copilotModelInsert(providerId: string, model: CopilotAppModel): string {
  return `INSERT INTO provider_models (id, provider_id, model_id, wire_model, display_name, max_prompt_tokens, max_output_tokens, wire_api_override, supported_reasoning_efforts) VALUES (${sqlString(randomUUID())}, ${sqlString(providerId)}, ${sqlString(model.id)}, ${sqlString(model.id)}, ${sqlString(model.name)}, ${sqlNumberOrNull(model.maxPromptTokens)}, ${sqlNumberOrNull(model.maxOutputTokens)}, ${sqlString("completions")}, ${sqlTextOrNull(model.reasoningEfforts)});`;
}
