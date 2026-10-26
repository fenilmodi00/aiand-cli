import { existsSync, mkdirSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Session } from "../api/client.js";
import { getLogsPaged, LOG_PAGE_MAX, type LogEntry } from "../api/logs.js";
import { ApiError } from "../cli/errors.js";
import { configDir, PRIVATE_DIR_MODE, withFileLock } from "../fsutil.js";
import { MIGRATIONS } from "./migrations/index.js";

/**
 * The local request store: a metadata-only SQLite mirror of the gateway's
 * /logs rows at `<config dir>/store.db`, plus the incremental sync engine
 * that keeps it current (feature catalog A1/A2).
 *
 * Concurrency: SQLite in WAL mode with a 5s busy_timeout, one connection per
 * operation (CLI processes are short-lived), and the sync path additionally
 * serialized across processes with `withFileLock` on
 * `<config dir>/locks/store-sync` — so two simultaneous `aiand` invocations
 * cannot interleave watermark updates, and a reader never blocks a writer
 * for long.
 *
 * Fail-open: nothing here throws at a caller. A corrupt store is quarantined
 * (renamed with a timestamp) and recreated empty; a sync failure comes back
 * as `{ ok: false }` so commands warn and serve local data.
 *
 * Privacy: the schema stores gateway metadata only — no prompt or completion
 * content columns exist, and a schema test pins that.
 */

/** Equals the latest migration number (see ./migrations/). */
export const STORE_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** The store file lives next to config.json and credentials.json. */
export function storePath(): string {
  return join(configDir(), "store.db");
}

/**
 * #86 — Normalized timestamp comparison for SQL window filters.
 *
 * Gateway rows are stored verbatim (`2026-10-26 05:02:11.844519+00`, space
 * separator), and callers bind ISO `T` strings (`new Date(...).toISOString()`).
 * A bare `created_at >= ?` compares text, and `' ' < 'T'`, so same-day
 * windows silently match nothing. The helpers rewrite both sides into a
 * strict-ISO UTC string SQLite's `datetime()` accepts:
 *
 * - `+00` (the gateway's offset spelling, rejected by SQLite's parser)
 *   becomes `Z`; the space separator is handled by `datetime()` itself;
 * - fractional seconds are re-parsed as a number and re-formatted to
 *   milliseconds (SQLite's `datetime()` truncates to whole seconds, which
 *   would make `...:59.999+00` fall inside a window ending at
 *   `...:59.999Z`); sub-millisecond tails are clamped down to `59.995`
 *   so a `:59.999999` row can never spill past a `:59.999` inclusive
 *   boundary (sub-millisecond precision is knowingly dropped — the
 *   gateway serves millisecond windows);
 * - `trim()` guards against SQLite 3.52+ returning `NULL` for the
 *   whitespace-padded strict-ISO form.
 *
 * Result: stored wire format and ISO binds compare on the same normalized
 * timeline; stored rows stay verbatim.
 */
const normalizedExpr = (col = "created_at"): string => {
  const g = `replace(trim(${col}),'+00','Z')`;
  return (
    `printf('%s%02d:%02d:%sZ', substr(${g},1,11), ` +
    `CAST(substr(${g},12,2) AS INT), CAST(substr(${g},15,2) AS INT), ` +
    `CASE WHEN CAST(substr(${g},18) AS REAL) > 59.995 THEN '59.995' ` +
    `ELSE printf('%06.3f', CAST(substr(${g},18) AS REAL)) END)`
  );
};

/** Normalized window expression over `col` with SQL operator `op`. */
const windowExpr = (op: ">=" | "<=" | "<", col = "created_at"): string =>
  `datetime(${normalizedExpr(col)}) ${op} datetime(?)`;

/**
 * Normalized lower-bound comparison (`>=`) for SQL window filters; bind the
 * ISO instant string as the sole parameter. See {@link normalizedExpr}.
 */
export const createdSince = (col = "created_at"): string => windowExpr(">=", col);

/** Normalized inclusive upper bound (`<=`); see {@link createdSince}. */
export const createdUntilIncl = (col = "created_at"): string => windowExpr("<=", col);

/** Normalized exclusive upper bound (`<`); see {@link createdSince}. */
export const createdUntilExcl = (col = "created_at"): string => windowExpr("<", col);

export type StoreStatus =
  | "ok" // open, migrated, healthy
  | "missing" // no db file yet (never synced)
  | "corrupt-recovered" // quarantined + recreated (fail-open)
  | "unavailable" // node:sqlite missing (Node <22.5) — degrade, never crash
  | "stale"; // open but last sync older than the threshold (informational)

export type StoreInfo = {
  path: string;
  status: StoreStatus;
  /** Request rows stored. */
  rows: number;
  /** Applied schema version. */
  storeVersion: number;
  /** storeVersion === STORE_VERSION. */
  migrationsCurrent: boolean;
  /** ISO time of the last successful sync (watermark update). */
  lastSyncAt: string | null;
  /** Max created_at among stored rows. */
  newestCreatedAt: string | null;
  /** Reason of the most recent sync failure, null when none since the last success. */
  lastSyncError: string | null;
  /** ISO time of that most recent sync failure. */
  lastSyncErrorAt: string | null;
  /** Human note: quarantine path, error reason… */
  detail?: string;
};

export type SyncResult =
  | { ok: true; inserted: number; pages: number; watermark: { createdAt: string; id: string } }
  | { ok: false; error: string; code?: "network" | "auth" | "store" };

/**
 * The `--no-sync` opt-out shared by every observability command: a parsed
 * `--no-sync` flag OR the config-key equivalent env `AIAND_NO_SYNC=1` reads
 * the local store without touching the network. (Auto-sync before reading
 * commands is wired up by later tickets; the convention lands here.)
 */
export function noSyncRequested(): boolean {
  const value = process.env.AIAND_NO_SYNC;
  return value === "1" || value === "true" || value === "yes";
}

// ---------------------------------------------------------------------------
// node:sqlite, loaded lazily through the CJS bridge
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

let databaseSync: typeof DatabaseSync | null | undefined;

/**
 * Synchronous lazy load: node:sqlite is flag-free only on Node >= 22.5
 * (>= 22.13 without a warning) and the engines floor is 22.0 — a static
 * import would crash the CLI at load below that. `require` on a builtin
 * never hits the network or the disk cache, so the whole open path can stay
 * synchronous (the contract's getStoreInfo is sync). Same pattern as
 * src/agents/copilot-app/sqlite.ts, which uses a dynamic import instead.
 */
function loadDatabaseSync(): typeof DatabaseSync | null {
  if (databaseSync === undefined) {
    try {
      databaseSync = (require("node:sqlite") as { DatabaseSync: typeof DatabaseSync }).DatabaseSync;
    } catch {
      databaseSync = null;
    }
  }
  return databaseSync;
}

const UNAVAILABLE_MESSAGE =
  "The local request store needs node:sqlite (Node >= 22.5). " +
  "Upgrade Node to keep long-term history; nothing else is affected.";

// ---------------------------------------------------------------------------
// Open + migrate (+ corrupt recovery)
// ---------------------------------------------------------------------------

const BUSY_TIMEOUT_MS = 5_000;

/**
 * An opened store handle. Exported for the store's own submodules
 * (src/store/sessions.ts); the caller owns closing `db`. `ok: false`
 * degrades with a reason — open never throws.
 */
export type OpenedStore =
  | { ok: true; db: DatabaseSync; status: "ok" | "corrupt-recovered"; detail?: string }
  | { ok: false; reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * A marker of the file being unreadable as our store (garbage bytes, a
 * half-written file). Anything else — a missing parent dir, permissions — is
 * NOT corruption: recreating would loop forever without fixing the cause, so
 * those surface as the open failure instead.
 */
function isStoreCorruption(error: unknown): boolean {
  return /not a database|database disk image is malformed|malformed|corrupt/i.test(
    errorMessage(error),
  );
}

function quarantineStore(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantined = `${path}.corrupt-${stamp}`;
  renameSync(path, quarantined);
  // WAL sidecars would resurrect the corrupt image into the fresh db.
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${path}${suffix}`;
    if (existsSync(sidecar)) {
      try {
        renameSync(sidecar, `${quarantined}${suffix}`);
      } catch {
        // a locked sidecar must not block recovery; SQLite recreates it
      }
    }
  }
  return quarantined;
}

function openDatabase(Database: typeof DatabaseSync, path: string): DatabaseSync {
  const db = new Database(path);
  try {
    // WAL lets a reader work while another process writes; the busy timeout
    // covers the short window two writers overlap before the file lock.
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    migrate(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // already gone
    }
    throw error;
  }
}

/**
 * Open the store, applying pending migrations. A file that cannot be read as
 * our schema is quarantined (renamed with a timestamp) and recreated empty —
 * observability degrades, the CLI keeps working.
 */
/** Exported for the store's submodules (sessions.ts); not a public surface. */
export function openStore(path: string): OpenedStore {
  const Database = loadDatabaseSync();
  if (!Database) return { ok: false, reason: UNAVAILABLE_MESSAGE };

  try {
    mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch (error) {
    return { ok: false, reason: `Could not create the config directory: ${errorMessage(error)}` };
  }

  try {
    return { ok: true, db: openDatabase(Database, path), status: "ok" };
  } catch (error) {
    if (!isStoreCorruption(error)) {
      return { ok: false, reason: `Could not open the request store: ${errorMessage(error)}` };
    }
  }

  let quarantined: string;
  try {
    quarantined = quarantineStore(path);
  } catch (error) {
    return { ok: false, reason: `Could not quarantine a corrupt store: ${errorMessage(error)}` };
  }
  try {
    const db = openDatabase(Database, path);
    return {
      ok: true,
      db,
      status: "corrupt-recovered",
      detail:
        `The request store was corrupt and has been quarantined to ${quarantined}; ` +
        "a fresh store was created. History from before the corruption is in the quarantined file.",
    };
  } catch (error) {
    return { ok: false, reason: `Could not recreate the request store: ${errorMessage(error)}` };
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (" +
      "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number((row as Record<string, unknown>).version)),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Store info
// ---------------------------------------------------------------------------

/** A store not synced for this long reports status "stale" (informational). */
const STALE_AFTER_MS = 60 * 60 * 1000;

function meta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM sync_meta WHERE key = ?").get(key) as
    | Record<string, unknown>
    | undefined;
  const value = row?.value;
  return typeof value === "string" ? value : null;
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO sync_meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

function watermarkOf(db: DatabaseSync): { createdAt: string; id: string } | null {
  const row = db
    .prepare("SELECT created_at, id FROM requests ORDER BY created_at DESC, id DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  const createdAt = row?.created_at;
  const id = row?.id;
  if (typeof createdAt !== "string" || typeof id !== "string") return null;
  return { createdAt, id };
}

/** Never throws: doctor and every command call this on any machine state. */
export function getStoreInfo(): StoreInfo {
  const path = storePath();
  const info: StoreInfo = {
    path,
    status: "ok",
    rows: 0,
    storeVersion: 0,
    migrationsCurrent: false,
    lastSyncAt: null,
    newestCreatedAt: null,
    lastSyncError: null,
    lastSyncErrorAt: null,
  };

  if (!existsSync(path)) {
    info.status = "missing";
    info.detail = "No local request store yet — it is created on first sync.";
    return info;
  }

  const opened = openStore(path);
  if (!opened.ok) {
    info.status = "unavailable";
    info.detail = opened.reason;
    return info;
  }

  info.status = opened.status;
  info.detail = opened.detail;
  try {
    info.rows = Number(
      (opened.db.prepare("SELECT COUNT(*) AS n FROM requests").get() as Record<string, unknown>).n,
    );
    const versions = opened.db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number((row as Record<string, unknown>).version));
    info.storeVersion = versions.length > 0 ? Math.max(...versions) : 0;
    info.lastSyncAt = meta(opened.db, "last_sync_at");
    info.newestCreatedAt = watermarkOf(opened.db)?.createdAt ?? null;
    info.lastSyncError = meta(opened.db, "last_sync_error");
    info.lastSyncErrorAt = meta(opened.db, "last_sync_error_at");
  } catch (error) {
    info.detail = [info.detail, errorMessage(error)].filter(Boolean).join(" ");
  } finally {
    try {
      opened.db.close();
    } catch {
      // already closed
    }
  }
  info.migrationsCurrent = info.storeVersion === STORE_VERSION;

  if (
    info.status === "ok" &&
    info.lastSyncAt !== null &&
    Date.now() - Date.parse(info.lastSyncAt) > STALE_AFTER_MS
  ) {
    info.status = "stale";
  }
  return info;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Largest page the gateway serves. */
const SYNC_PAGE_SIZE = LOG_PAGE_MAX;
/** The widest /logs window the gateway serves — the sync's pull range. */
const SYNC_RANGE = "30days";
/** Re-fetch this far behind the watermark; INSERT OR IGNORE dedupes. */
const OVERLAP_MS = 5 * 60 * 1000;

/**
 * Incremental watermark pull of /logs into the store. Never throws: a
 * network/auth failure returns { ok: false } so the calling command warns
 * and serves local data. Pages forward from the watermark (max stored
 * created_at, tiebreak max id) minus a small overlap window, updating the
 * watermark after every successful page — an interrupted sync resumes where
 * it stopped, and re-syncing a fully synced store inserts 0 rows.
 */
export async function syncStore(
  session: Session,
  opts: { range?: string } = {},
): Promise<SyncResult> {
  try {
    // Cross-process serialization on top of WAL + busy_timeout: the
    // watermark must advance one writer at a time.
    return await withFileLock(join(configDir(), "locks", "store-sync"), () =>
      syncStoreLocked(session, opts),
    );
  } catch (error) {
    return { ok: false, error: errorMessage(error), code: classifyError(error) };
  }
}

async function syncStoreLocked(session: Session, opts: { range?: string }): Promise<SyncResult> {
  const opened = openStore(storePath());
  if (!opened.ok) return { ok: false, error: opened.reason, code: "store" };
  const db = opened.db;

  try {
    const range = opts.range ?? SYNC_RANGE;
    const start = watermarkOf(db);
    // A few minutes of overlap re-serves edge rows; INSERT OR IGNORE makes
    // that free, and it covers gateway-side clock/cursor jitter.
    const after = start
      ? new Date(Date.parse(start.createdAt) - OVERLAP_MS).toISOString()
      : undefined;

    let inserted = 0;
    let pages = 0;
    let cursor = after;
    for (;;) {
      const { entries, truncated } = await getLogsPaged(session, {
        range: range as Parameters<typeof getLogsPaged>[1]["range"],
        limit: SYNC_PAGE_SIZE,
        after: cursor,
      });
      pages += 1;
      inserted += insertEntries(db, entries);

      if (entries.length > 0) {
        // Watermark = max stored created_at (tiebreak max id), read back
        // from the store so it stays true even across overlap refetches.
        const watermark = watermarkOf(db);
        if (watermark) {
          setMeta(db, "watermark_created_at", watermark.createdAt);
          setMeta(db, "watermark_id", watermark.id);
          setMeta(db, "last_sync_at", new Date().toISOString());
        }
      }

      if (!truncated || entries.length === 0) break;
      const last = entries[entries.length - 1];
      if (!last) break;
      cursor = last.created_at;
    }

    setMeta(db, "last_sync_at", new Date().toISOString());
    // A success clears the failure markers: coverage must report the CURRENT
    // sync state, not a stale failure that has since been resolved.
    db.prepare(
      "DELETE FROM sync_meta WHERE key IN ('last_sync_error', 'last_sync_error_at')",
    ).run();
    const watermark = watermarkOf(db);
    return {
      ok: true,
      inserted,
      pages,
      watermark: watermark ?? { createdAt: "", id: "" },
    };
  } catch (error) {
    // Recorded so coverage/reporting can say "sync failed at T because …"
    // instead of silently serving stale data as if it were current.
    const message = errorMessage(error);
    try {
      setMeta(db, "last_sync_error", message);
      setMeta(db, "last_sync_error_at", new Date().toISOString());
    } catch {
      // a store too broken for meta writes cannot record the failure either
    }
    return { ok: false, error: message, code: classifyError(error) };
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

function insertEntries(db: DatabaseSync, entries: readonly LogEntry[]): number {
  if (entries.length === 0) return 0;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO requests " +
      "(id, model, api_key, status_code, ttft_ms, latency_ms, input_tokens, " +
      "output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const syncedAt = new Date().toISOString();
  let inserted = 0;
  db.exec("BEGIN");
  try {
    for (const entry of entries) {
      // Verbatim, always: input_tokens INCLUDES cached_tokens on the
      // gateway, so both numbers are stored exactly as reported.
      const result = insert.run(
        entry.id,
        entry.model,
        entry.api_key,
        entry.status_code,
        entry.ttft_ms,
        entry.latency_ms,
        entry.input_tokens,
        entry.output_tokens,
        entry.cached_tokens,
        entry.cost,
        parseCost(entry.cost),
        entry.currency,
        entry.created_at,
        syncedAt,
      );
      inserted += Number(result.changes);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return inserted;
}

/** The gateway cost string parsed for arithmetic; NULL when unparseable. */
function parseCost(cost: string | null): number | null {
  if (cost === null) return null;
  const value = Number(cost);
  return Number.isFinite(value) ? value : null;
}

function classifyError(error: unknown): "network" | "auth" | "store" {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return "auth";
    return "network";
  }
  if (
    error instanceof Error &&
    /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET/i.test(error.message)
  ) {
    return "network";
  }
  return "store";
}
