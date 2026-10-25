import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CliError } from "../cli/errors.js";
import { openStore, storePath } from "../store/index.js";

/**
 * The ccusage import adapter (feature catalog G4, ticket #73).
 *
 * Ingests the JSON output of `ccusage daily|weekly|monthly|session|blocks
 * --json` into the store as EXTERNAL imported rows. ccusage is consumed, not
 * forked (plan §4): its report shapes are parsed and normalized here, and
 * its price-table-derived costs are kept in their own lane — separate table,
 * separate source row in reports, excluded from gateway totals by default
 * (the CodeBurn gateway-totals include/exclude pattern, default-exclude).
 *
 * Accepted shapes (top-level key → entries):
 *   - `daily` / `weekly` / `monthly`: `date` (`YYYY-MM-DD`; monthly
 *     `YYYY-MM`), `inputTokens`, `outputTokens`, `costUSD` (older ccusage:
 *     `totalCost`), optional `cacheReadTokens` / `cacheCreationTokens`,
 *     optional per-model `models: [{ modelName, … }]` (--breakdown output).
 *   - `sessions`: `sessionId`, `inputTokens`, `outputTokens`, `costUSD`, and
 *     one timestamp field (`mostRecentAktivity` — ccusage's own spelling —
 *     or `mostRecentTimestamp` / `lastActivity` / `startedAt` / `firstActivity`).
 *   - `blocks`: `id`, `startTime`, `endTime`, `inputTokens`, `outputTokens`,
 *     `costUSD` (tokens may sit flat or under ccusage's `tokenCounts` object).
 *
 * Never-guess discipline: a payload whose top level carries none of the
 * known report keys (or several at once), or an entry missing a required
 * field / carrying it with the wrong type, is refused loudly with a CliError
 * naming the problem — nothing is imported partial or invented.
 *
 * Idempotency: the import identity is the SHA-256 of the exact payload
 * bytes (ledger table `ccusage_imports`); re-importing identical input is a
 * no-op. A DIFFERENT payload overlapping the same report periods replaces
 * those periods' rows inside one transaction (an import owns its periods
 * wholesale), so overlapping ccusage runs update instead of double-count.
 *
 * Normalization: ccusage reports `inputTokens` EXCLUDING cache tokens; rows
 * are stored in the gateway convention (input includes cached) so report
 * columns mean the same thing across sources. Costs are ccusage's
 * price-table-derived USD equivalents and stay in the USD currency lane;
 * they are never labeled gateway-billed (#68/#73 honesty conventions).
 */

const IMPORT_SOURCE = "imported-ccusage";

/** The report shapes the adapter accepts, keyed by their ccusage top key. */
const CCUSAGE_REPORT_KEYS = ["daily", "weekly", "monthly", "sessions", "blocks"] as const;
type CcusageReportKind = (typeof CCUSAGE_REPORT_KEYS)[number];

const AGGREGATE_MODEL = "";

const SESSION_TIME_FIELDS = [
  "startedAt",
  "firstActivity",
  "mostRecentAktivity", // ccusage's own field spelling upstream
  "mostRecentTimestamp",
  "lastActivity",
];

type ImportedRow = {
  reportKind: CcusageReportKind;
  period: string;
  /** '' for aggregate rows; the model name for per-model (--breakdown) rows. */
  model: string;
  /** Gateway convention: input INCLUDES cached. */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costValue: number;
  /** ccusage reports USD equivalents; kept in their own currency lane. */
  currency: string;
  startedAt: string;
  endedAt: string | null;
};

export type ImportSummary = {
  source: typeof IMPORT_SOURCE;
  reportKind: CcusageReportKind;
  /** `imported(ccusage@<import-date>)` — the source label reports display. */
  sourceLabel: string;
  contentHash: string;
  /** Rows written; 0 when the payload was already imported (dedupe). */
  inserted: number;
  /** True when the content hash matched the ledger — nothing was written. */
  deduped: boolean;
};

// ---------------------------------------------------------------------------
// Reading the payload
// ---------------------------------------------------------------------------

/** Read the import payload: a file path, or `-` for stdin. Never syncs. */
export function readImportPayload(target: string): string {
  if (target === "-") {
    try {
      return readFileSync(0, "utf8");
    } catch (error) {
      throw new CliError(`Could not read ccusage JSON from stdin: ${messageOf(error)}`, {
        hint: "Pipe the report in: ccusage daily --json | aiand usage --import-ccusage -",
      });
    }
  }
  try {
    return readFileSync(target, "utf8");
  } catch (error) {
    throw new CliError(`Could not read ccusage JSON file ${target}: ${messageOf(error)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

// ---------------------------------------------------------------------------
// Parse + validate + normalize (pure)
// ---------------------------------------------------------------------------

type RawEntry = Record<string, unknown>;

export type ParsedCcusagePayload = {
  reportKind: CcusageReportKind;
  rows: ImportedRow[];
  contentHash: string;
  importDate: string;
};

/** Parse and normalize a payload; every field is type-checked, none guessed. */
export function parseCcusagePayload(raw: string, now: Date = new Date()): ParsedCcusagePayload {
  const contentHash = sha256(raw);
  const importDate = now.toISOString().slice(0, 10);

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`ccusage import failed: the input is not valid JSON (${messageOf(error)}).`);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new CliError(
      "ccusage import failed: expected a ccusage --json report object " +
        `(top-level key one of ${CCUSAGE_REPORT_KEYS.join(", ")}).`,
    );
  }
  const top = document as Record<string, unknown>;
  const present = CCUSAGE_REPORT_KEYS.filter((key) => top[key] !== undefined);
  if (present.length === 0) {
    throw new CliError("ccusage import failed: no supported ccusage report found in the payload.", {
      hint:
        "This adapter reads `ccusage daily|weekly|monthly|session|blocks --json` output " +
        `(top-level key one of ${CCUSAGE_REPORT_KEYS.join(", ")}). ` +
        "Unknown schemas are refused loudly, never guessed.",
    });
  }
  if (present.length > 1) {
    throw new CliError(
      `ccusage import failed: ambiguous payload — several report keys present (${present.join(", ")}).`,
      { hint: "Import one report at a time so periods cannot double-count." },
    );
  }
  const reportKind = present[0]!;
  const entries = top[reportKind];
  if (!Array.isArray(entries)) {
    throw new CliError(
      `ccusage import failed: "${reportKind}" must be an array of report rows, got ${typeof entries}.`,
    );
  }

  const rows = entries.flatMap((entry, index) => normalizeEntry(reportKind, entry, index));
  return { reportKind, rows, contentHash, importDate };
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function entryObject(reportKind: string, raw: unknown, index: number): RawEntry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError(
      `ccusage import failed: ${reportKind}[${index}] is not a report row object.`,
    );
  }
  return raw as RawEntry;
}

/** Require a non-negative finite number field; refuse loudly otherwise. */
function numField(entry: RawEntry, field: string, where: string): number {
  const value = entry[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CliError(
      `ccusage import failed: ${where} has no usable "${field}" ` +
        `(expected a non-negative number, got ${value === undefined ? "missing" : JSON.stringify(value)}).`,
      { hint: "Unknown or malformed schemas are refused, never guessed." },
    );
  }
  return value;
}

function optionalNum(entry: RawEntry, field: string, where: string): number {
  if (entry[field] === undefined) return 0;
  return numField(entry, field, where);
}

/** Cost: `costUSD` in current ccusage reports, `totalCost` in older ones. */
function costField(entry: RawEntry, where: string): number {
  if (entry.costUSD === undefined && entry.totalCost === undefined) {
    return numField(entry, "costUSD", where);
  }
  return numField(entry, entry.costUSD !== undefined ? "costUSD" : "totalCost", where);
}

function strField(entry: RawEntry, field: string, where: string): string {
  const value = entry[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(
      `ccusage import failed: ${where} has no usable "${field}" ` +
        `(expected a non-empty string, got ${value === undefined ? "missing" : JSON.stringify(value)}).`,
    );
  }
  return value;
}

function dateField(entry: RawEntry, fields: readonly string[], where: string): string {
  for (const field of fields) {
    const value = entry[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw new CliError(
        `ccusage import failed: ${where} field "${field}" is not a parseable timestamp.`,
      );
    }
    return new Date(Date.parse(value)).toISOString();
  }
  throw new CliError(
    `ccusage import failed: ${where} carries no timestamp ` +
      `(expected one of ${fields.join(", ")}) — imported rows must be placeable in time, never guessed.`,
  );
}

/** The period identity of an entry, per report kind. */
function periodOf(reportKind: CcusageReportKind, entry: RawEntry, where: string): string {
  if (reportKind === "sessions") return strField(entry, "sessionId", where);
  if (reportKind === "blocks") return strField(entry, "id", where);
  return strField(entry, "date", where);
}

function startOf(reportKind: CcusageReportKind, entry: RawEntry, where: string): string {
  if (reportKind === "sessions") return dateField(entry, SESSION_TIME_FIELDS, where);
  if (reportKind === "blocks") return dateField(entry, ["startTime"], where);
  return dateField(entry, ["date"], where);
}

/**
 * One entry → 0..N rows: per-model rows when the entry carries a `models`
 * array (ccusage --breakdown; the aggregate is their sum, so importing both
 * would double-count within the imported lane), otherwise one aggregate row.
 */
function normalizeEntry(reportKind: CcusageReportKind, raw: unknown, index: number): ImportedRow[] {
  let entry = entryObject(reportKind, raw, index);
  const where = `${reportKind}[${index}]`;

  // Blocks payloads may nest the token counts under a `tokenCounts` object.
  if (entry.tokenCounts !== undefined) {
    if (
      entry.tokenCounts === null ||
      typeof entry.tokenCounts !== "object" ||
      Array.isArray(entry.tokenCounts)
    ) {
      throw new CliError(`ccusage import failed: ${where} "tokenCounts" must be an object.`);
    }
    entry = { ...entry, ...(entry.tokenCounts as RawEntry) };
  }

  const period = periodOf(reportKind, entry, where);
  const startedAt = startOf(reportKind, entry, where);
  const endedAt =
    reportKind === "blocks" && entry.endTime !== undefined
      ? dateField(entry, ["endTime"], where)
      : null;

  const models = entry.models;
  if (models !== undefined && !Array.isArray(models)) {
    throw new CliError(`ccusage import failed: ${where} "models" must be an array.`);
  }

  const shared = {
    reportKind,
    period,
    startedAt,
    endedAt,
    currency: "USD",
  };

  if (Array.isArray(models) && models.length > 0) {
    return models.map((modelRaw, m) => {
      const modelEntry = entryObject(`${where}.models`, modelRaw, m);
      const modelWhere = `${where}.models[${m}]`;
      const cacheRead = optionalNum(modelEntry, "cacheReadTokens", modelWhere);
      const cacheCreation = optionalNum(modelEntry, "cacheCreationTokens", modelWhere);
      const cache = cacheRead + cacheCreation;
      return {
        ...shared,
        model: strField(modelEntry, "modelName", modelWhere),
        inputTokens: numField(modelEntry, "inputTokens", modelWhere) + cache,
        outputTokens: numField(modelEntry, "outputTokens", modelWhere),
        cachedTokens: cache,
        costValue: costField(modelEntry, modelWhere),
      };
    });
  }

  const cacheRead = optionalNum(entry, "cacheReadTokens", where);
  const cacheCreation = optionalNum(entry, "cacheCreationTokens", where);
  const cache = cacheRead + cacheCreation;
  return [
    {
      ...shared,
      model: AGGREGATE_MODEL,
      // ccusage input EXCLUDES cache; gateway convention includes it.
      inputTokens: numField(entry, "inputTokens", where) + cache,
      outputTokens: numField(entry, "outputTokens", where),
      cachedTokens: cache,
      costValue: costField(entry, where),
    },
  ];
}

// ---------------------------------------------------------------------------
// The import transaction
// ---------------------------------------------------------------------------

/**
 * Import parsed rows into the store. Content-hash dedupe first (identical
 * payload → 0 rows), then one transaction: each imported period replaces any
 * previously stored rows for the same (report_kind, period) — an import owns
 * its periods wholesale — and the payload is recorded in the ledger.
 */
export function importCcusage(payload: ParsedCcusagePayload): ImportSummary {
  const sourceLabel = `imported(ccusage@${payload.importDate})`;
  const opened = openStore(storePath());
  if (!opened.ok) {
    throw new CliError(`ccusage import failed: ${opened.reason}`);
  }
  const db = opened.db;
  try {
    const seen = db
      .prepare("SELECT row_count FROM ccusage_imports WHERE content_hash = ?")
      .get(payload.contentHash) as Record<string, unknown> | undefined;
    if (seen) {
      return {
        source: IMPORT_SOURCE,
        reportKind: payload.reportKind,
        sourceLabel,
        contentHash: payload.contentHash,
        inserted: 0,
        deduped: true,
      };
    }

    const importedAt = new Date().toISOString();
    let inserted = 0;
    db.exec("BEGIN");
    try {
      // The ledger row first: imported_usage rows carry a foreign key to it.
      db.prepare(
        "INSERT INTO ccusage_imports (content_hash, report_kind, row_count, imported_at) " +
          "VALUES (?, ?, ?, ?)",
      ).run(payload.contentHash, payload.reportKind, payload.rows.length, importedAt);
      const replace = db.prepare(
        "INSERT OR REPLACE INTO imported_usage " +
          "(content_hash, source, report_kind, period, model, input_tokens, output_tokens, " +
          "cached_tokens, cost_value, currency, started_at, ended_at, imported_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const clearPeriod = db.prepare(
        "DELETE FROM imported_usage WHERE report_kind = ? AND period = ?",
      );
      const cleared = new Set<string>();
      for (const row of payload.rows) {
        // A period is replaced wholesale ONCE per import (per-model rows and
        // aggregates never coexist for one period).
        if (!cleared.has(row.period)) {
          clearPeriod.run(row.reportKind, row.period);
          cleared.add(row.period);
        }
        replace.run(
          payload.contentHash,
          IMPORT_SOURCE,
          row.reportKind,
          row.period,
          row.model,
          row.inputTokens,
          row.outputTokens,
          row.cachedTokens,
          row.costValue,
          row.currency,
          row.startedAt,
          row.endedAt,
          importedAt,
        );
        inserted += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return {
      source: IMPORT_SOURCE,
      reportKind: payload.reportKind,
      sourceLabel,
      contentHash: payload.contentHash,
      inserted,
      deduped: false,
    };
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------
// Report-side read (imported rows stay OUT of every gateway aggregate)
// ---------------------------------------------------------------------------

/** A report-facing imported row; api_key is always null → agent "unknown". */
export type ImportedReportRow = {
  sourceLabel: string;
  model: string;
  created_at: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_value: number;
  currency: string;
};

/**
 * Imported rows in the report window, one read for the report's imported
 * section. The gateway `requests` read is untouched: callers aggregate the
 * two separately (default-exclude; `--include-imported` folds them into the
 * grand total explicitly).
 */
export function loadImportedRows(window: {
  sinceMs: number | null;
  untilMs: number | null;
}): ImportedReportRow[] {
  const opened = openStore(storePath());
  if (!opened.ok) return [];
  const db = opened.db;
  try {
    const conditions: string[] = [];
    const args: (string | number)[] = [];
    if (window.sinceMs !== null) {
      conditions.push("started_at >= ?");
      args.push(new Date(window.sinceMs).toISOString());
    }
    if (window.untilMs !== null) {
      conditions.push("started_at <= ?");
      args.push(new Date(window.untilMs).toISOString());
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(
        "SELECT report_kind, imported_at, model, input_tokens, output_tokens, cached_tokens, " +
          "cost_value, currency, started_at FROM imported_usage" +
          where +
          " ORDER BY started_at, report_kind, period, model",
      )
      .all(...args) as unknown as {
      report_kind: string;
      imported_at: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cost_value: number;
      currency: string;
      started_at: string;
    }[];
    return rows.map((row) => ({
      sourceLabel: `imported(ccusage@${row.imported_at.slice(0, 10)})·${row.report_kind}`,
      model: row.model,
      created_at: row.started_at,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cached_tokens: row.cached_tokens,
      cost_value: row.cost_value,
      currency: row.currency,
    }));
  } catch {
    // Fail open like every other report read: an unreadable store serves an
    // empty imported section, never a broken report.
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}
