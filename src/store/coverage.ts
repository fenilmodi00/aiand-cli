import { createdSince, openStore, storePath } from "./index.js";

/**
 * Coverage-gap honesty (feature catalog H4, ticket #68).
 *
 * The gateway serves only 15m–30days of /logs, and the local archive only
 * exists from its first successful sync onward. Any range a report asks for
 * can therefore be partially uncovered: before the archive began, during a
 * sync failure, or while ingestion lags. The honest move is to enumerate
 * those gaps — never to average over them.
 *
 * `computeCoverage` reads only local state (the store + its sync meta); it
 * never touches the network, so a report can attach it to any payload.
 * Days are UTC calendar days, matching the store's `created_at` strings.
 */

type SyncStatus = "synced" | "failed" | "skipped" | "never";

export type CoverageReport = {
  /** The requested window id (a LOG_RANGES value). */
  range: string;
  /** The concrete UTC window the range resolved to, [since, until]. */
  window: { since: string; until: string };
  /** ISO time of the last successful sync, null when the store never synced. */
  lastSyncAt: string | null;
  sync: { status: SyncStatus; at: string | null; error?: string };
  /** Seconds between now and the newest stored row; null on an empty store. */
  lagSeconds: number | null;
  /** Oldest and newest rows actually in the local store (the archive extent). */
  localRange: { since: string | null; until: string | null };
  /**
   * UTC dates inside the window with zero local rows. Only days the archive
   * could have covered are listed: a day entirely before the store's oldest
   * row was never synced, and calling it "missing" would misstate the gap.
   */
  missingDays: string[];
};

/** Sync outcome a reporting command observed for its own pre-command sync. */
export type SyncOutcome = { ok: true } | { ok: false; error: string } | { skipped: true };

/** The requested window durations, in ms. LOG_RANGES values plus generic forms. */
export function rangeDurationMs(range: string): number {
  const match = /^(\d+)(m|h|d|days?)$/.exec(range);
  if (!match) throw new Error(`Unknown range: ${range}`);
  const n = Number(match[1]);
  switch (match[2]) {
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return n * 86_400_000;
  }
}

/** UTC calendar date (YYYY-MM-DD) of an ISO timestamp. */
function utcDate(iso: string): string {
  return iso.slice(0, 10);
}

function datePlusDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export type ComputeCoverageOptions = {
  /** Overrides `Date.now()` — tests pin time for deterministic windows. */
  now?: Date;
  /**
   * What the pre-command sync did. Omitted means "no sync was attempted by
   * the caller"; the status then comes from the store's own meta (never
   * synced → "never", otherwise "synced", with a recorded failure winning).
   */
  sync?: SyncOutcome;
};

/**
 * The coverage of the local store for a requested range. Never throws and
 * never touches the network: a missing or broken store yields an empty,
 * honestly-labeled report.
 */
export function computeCoverage(
  range: string,
  options: ComputeCoverageOptions = {},
): CoverageReport {
  const now = options.now ?? new Date();
  const until = now.toISOString();
  const since = new Date(now.getTime() - rangeDurationMs(range)).toISOString();
  const report: CoverageReport = {
    range,
    window: { since, until },
    lastSyncAt: null,
    sync: { status: "never", at: null },
    lagSeconds: null,
    localRange: { since: null, until: null },
    missingDays: [],
  };

  const opened = openStore(storePath());
  if (!opened.ok) {
    report.sync.status = "never";
    return report;
  }
  const db = opened.db;
  try {
    const meta = (key: string): string | null => {
      const row = db.prepare("SELECT value FROM sync_meta WHERE key = ?").get(key) as
        | Record<string, unknown>
        | undefined;
      return typeof row?.value === "string" ? row.value : null;
    };

    report.lastSyncAt = meta("last_sync_at");
    const syncError = meta("last_sync_error");

    if (options.sync) {
      if ("skipped" in options.sync) {
        report.sync = { status: "skipped", at: report.lastSyncAt };
      } else if (options.sync.ok) {
        report.sync = { status: "synced", at: report.lastSyncAt };
      } else {
        report.sync = { status: "failed", at: report.lastSyncAt, error: options.sync.error };
      }
    } else if (syncError) {
      report.sync = { status: "failed", at: report.lastSyncAt, error: syncError };
    } else if (report.lastSyncAt) {
      report.sync = { status: "synced", at: report.lastSyncAt };
    }

    const extent = db
      .prepare("SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM requests")
      .get() as Record<string, unknown>;
    report.localRange = {
      since: typeof extent.oldest === "string" ? extent.oldest : null,
      until: typeof extent.newest === "string" ? extent.newest : null,
    };
    if (report.localRange.until) {
      report.lagSeconds = Math.max(0, (now.getTime() - Date.parse(report.localRange.until)) / 1000);
    }

    // Per-day row presence from the window start onward (the created_at index
    // makes the lower bound a range scan, not a full-table walk). Only when
    // the store HAS rows: an archive that never synced covers nothing, and
    // calling every day "missing" would restate what sync.status already says.
    if (report.localRange.since) {
      const present = new Set<string>(
        (
          db
            .prepare(
              `SELECT DISTINCT substr(created_at, 1, 10) AS d FROM requests WHERE ${createdSince()}`,
            )
            .all(since) as Record<string, unknown>[]
        ).map((row) => String(row.d)),
      );

      // Only days the archive could have covered: on or after the store's
      // oldest row (before that, the gateway window had simply not been pulled
      // yet — the 30-day boundary is stated, not guessed at).
      let firstAssessed = utcDate(since);
      if (report.localRange.since) {
        firstAssessed = maxDate(firstAssessed, utcDate(report.localRange.since));
      }
      const lastAssessed = utcDate(until);
      for (let day = firstAssessed; day <= lastAssessed; day = datePlusDays(day, 1)) {
        if (!present.has(day)) report.missingDays.push(day);
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  return report;
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

// ---------------------------------------------------------------------------
// Human rendering helpers
// ---------------------------------------------------------------------------

/** The one-line human summary of the sync state, for the top of a report. */
export function syncWarningLine(coverage: CoverageReport): string | null {
  if (coverage.sync.status === "failed") {
    return `sync failed${coverage.sync.error ? ` (${coverage.sync.error})` : ""} — showing local data only; it may be stale`;
  }
  if (coverage.sync.status === "skipped") {
    return "sync skipped (--no-sync) — showing local data as-is";
  }
  return null;
}

/** The coverage lines a report prints under a "Coverage" heading. */
export function coverageLines(coverage: CoverageReport): string[] {
  const lines: string[] = [];
  const lastSync = coverage.sync.at
    ? `${coverage.sync.at.replace("T", " ").slice(0, 19)}Z`
    : "never";
  lines.push(`coverage: last sync ${lastSync} (${coverage.sync.status})`);
  if (coverage.lagSeconds !== null) {
    lines.push(
      `coverage: ingestion lag ${Math.round(coverage.lagSeconds)}s since the newest stored request`,
    );
  }
  if (coverage.missingDays.length > 0) {
    lines.push(
      `coverage: no local data for ${coverage.missingDays.length} day(s): ${coverage.missingDays.join(", ")}` +
        " — those days are absent from local aggregates, not averaged over",
    );
  }
  return lines;
}
