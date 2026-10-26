import { agentForMaskedKey } from "../api/agent-keys.js";
import { openSession } from "../api/client.js";
import { bool, list, oneOf, parse, str } from "../cli/args.js";
import { err, out, style } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import {
  buildHeatmapGrid,
  type ColorDepth,
  colorDepth,
  HEATMAP_METRICS,
  type HeatmapMetric,
  renderHeatmap,
} from "../obs/heatmap.js";
import { assertTimezone, resolveWindow, syncWarningFor, type WindowSpec } from "../report/data.js";
import type { SyncOutcome } from "../store/coverage.js";
import {
  createdSince,
  createdUntilIncl,
  noSyncRequested,
  openStore,
  storePath,
  syncStore,
} from "../store/index.js";

/**
 * `aiand heatmap` (feature catalog F4, ticket #75): the 24h×7d spend
 * (or request-count) grid over the local store, in the display timezone.
 * Color degrades with the terminal: truecolor → 256 → 16 → plain
 * characters, and a piped run is pure ASCII/block characters with zero
 * escape codes. `--range` follows the shared window resolution.
 */

export const help = `${style.bold("aiand heatmap")} -- 24h x 7d activity heatmap of the local store

Usage
  aiand heatmap
  aiand heatmap --metric requests --range 30days
  aiand heatmap --last 7d --timezone America/New_York

Options
  --metric <kind>     cost (default) or requests
  --range <window>    15m, 1h, 6h, 24h, 7days, 30days
  --since <date>      start of the window (2026-10-01 or an ISO timestamp)
  --until <date>      end of the window (a bare date means end-of-day)
  --last <n><unit>    relative window: m|h|d|w, e.g. --last 7d
  --timezone <tz>     IANA timezone for the hour-of-week buckets
                      (default UTC)
  --harness <name>    filter to one harness (repeatable)
  --model <glob>      filter to models matching a glob (repeatable)
  --no-sync           skip the pre-read store sync and read as-is

Rows are weekdays (Mon top), columns are hours 00-23 in your timezone.
Intensity is one of five buckets; the glyph carries the level even with no
color at all. Cost is gateway-billed; with mixed currencies only the
dominant currency's rows enter the grid, and the footer says so.`;

/** Store row shape the heatmap consumes. */
export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    metric: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    range: { type: "string" },
    timezone: { type: "string" },
    harness: { type: "string", multiple: true },
    model: { type: "string", multiple: true },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const timezone = str(parsed, "timezone") ?? "UTC";
  assertTimezone(timezone);
  const metric = oneOf<HeatmapMetric>(parsed, "metric", [...HEATMAP_METRICS], "cost");

  // Fail-open sync, the established report pattern.
  const skipSync = bool(parsed, "no-sync") || noSyncRequested();
  let sync: SyncOutcome | null;
  if (skipSync) {
    sync = { skipped: true };
  } else {
    try {
      const session = await openSession(resolveProfile(str(parsed, "profile")));
      const result = await syncStore(session);
      sync = result.ok ? { ok: true } : { ok: false, error: result.error };
    } catch (error) {
      sync = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const spec: WindowSpec = {
    since: str(parsed, "since"),
    until: str(parsed, "until"),
    last: str(parsed, "last"),
    range: str(parsed, "range"),
  };
  const { sinceMs, untilMs } = resolveWindow(spec, timezone, new Date());
  // One store read; harness/model filters use the report engine's glob and
  // masked-key attribution semantics — the hour×day grid is the only
  // presentation bucketing here.
  const rows = filterRows(readHeatRows({ sinceMs, untilMs }), {
    harnesses: list(parsed, "harness"),
    models: list(parsed, "model"),
  });

  const syncState =
    sync === null
      ? { status: "ok" as const, at: null }
      : "skipped" in sync
        ? { status: "skipped" as const, at: null }
        : sync.ok
          ? { status: "ok" as const, at: null }
          : { status: "failed" as const, at: null, error: sync.error };
  const warning = syncWarningFor(syncState);
  if (warning) err(style.yellow(`Warning: ${warning}`));

  const grid = buildHeatmapGrid(rows, { metric, timezone });
  const depth: ColorDepth = colorDepth();
  out(renderHeatmap(grid, depth));
}

// ---------------------------------------------------------------------------
// Row read + filters (same glob semantics as the report engine)
// ---------------------------------------------------------------------------

type HeatRow = {
  created_at: string;
  cost_value: number | null;
  currency: string | null;
  api_key: string | null;
  model: string;
};

function readHeatRows(window: { sinceMs: number | null; untilMs: number | null }): HeatRow[] {
  const opened = openStore(storePath());
  if (!opened.ok) return [];
  const db = opened.db;
  try {
    const conditions: string[] = [];
    const args: (string | number)[] = [];
    if (window.sinceMs !== null) {
      conditions.push(createdSince());
      args.push(new Date(window.sinceMs).toISOString());
    }
    if (window.untilMs !== null) {
      conditions.push(createdUntilIncl());
      args.push(new Date(window.untilMs).toISOString());
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(
        "SELECT created_at, cost_value, currency, api_key, model FROM requests" +
          where +
          " ORDER BY created_at",
      )
      .all(...args);
    return rows as unknown as HeatRow[];
  } catch {
    // Fail open: an unreadable store is an empty grid, never a crash.
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function filterRows(
  rows: readonly HeatRow[],
  filters: { harnesses: string[]; models: string[] },
): HeatRow[] {
  const harnessWanted = filters.harnesses.length > 0 ? new Set(filters.harnesses) : null;
  const patterns = filters.models.map(globToRegExp);
  if (harnessWanted === null && patterns.length === 0) return [...rows];
  return rows.filter((row) => {
    if (harnessWanted !== null) {
      const harness =
        row.api_key === null ? "unknown" : (agentForMaskedKey(row.api_key) ?? "unknown");
      if (!harnessWanted.has(harness)) return false;
    }
    if (patterns.length > 0 && !patterns.some((re) => re.test(row.model))) return false;
    return true;
  });
}
