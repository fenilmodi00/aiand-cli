import { openSession } from "../api/client.js";
import { bool, oneOf, parse, str } from "../cli/args.js";
import { err, json, out, style } from "../cli/output.js";
import { assertSafeProfileName, resolveProfile } from "../config.js";
import {
  buildWrappedStory,
  renderWrappedText,
  WRAPPED_FORMATS,
  type WrappedFormat,
} from "../obs/wrapped.js";
import {
  assertTimezone,
  buildReportData,
  resolveWindow,
  syncWarningFor,
  type WindowSpec,
} from "../report/data.js";
import type { SyncOutcome } from "../store/coverage.js";
import { noSyncRequested, syncStore } from "../store/index.js";

/**
 * `aiand wrapped` (feature catalog F5, ticket #75): the share-friendly period
 * story. Purely a presentation layer over the #76 report engine — the story
 * builder lives in src/obs/wrapped.ts and never re-aggregates.
 */

export const help = `${style.bold("aiand wrapped")} — your period, wrapped

Usage
  aiand wrapped
  aiand wrapped --range 30days
  aiand wrapped --last 4w --format markdown

Options
  --range <window>    15m, 1h, 6h, 24h, 7days, 30days
  --since <date>      start of the window (a bare date is midnight)
  --until <date>      end of the window (a bare date means end-of-day)
  --last <n><unit>    relative window: m|h|d|w, e.g. --last 7d
  --timezone <tz>     IANA timezone for day buckets (default UTC)
  --format <kind>     text (default) or markdown — paste- or post-ready
  --no-cost           share without the money figures
  --json              the story as a machine-readable object
  --no-sync           skip the pre-read store sync and read as-is

Every number carries its provenance in the footer: costs are gateway-billed,
savings are estimated from catalog prices, sessions are the time-gap
heuristic. Harness names come from your key map — nothing project-private is
included.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    range: { type: "string" },
    timezone: { type: "string" },
    format: { type: "string" },
    "no-cost": { type: "boolean", default: false },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const timezone = str(parsed, "timezone") ?? "UTC";
  assertTimezone(timezone);
  const format = oneOf(parsed, "format", [...WRAPPED_FORMATS], "text") as WrappedFormat;

  // One fail-open sync before the read; the story itself is offline.
  // #87: validate --profile even when sync is skipped or fails open.
  const profileName = str(parsed, "profile");
  if (profileName !== undefined) assertSafeProfileName(profileName);
  const skipSync = bool(parsed, "no-sync") || noSyncRequested();
  let sync: SyncOutcome | null = null;
  if (skipSync) {
    sync = { skipped: true };
  } else {
    try {
      const session = await openSession(resolveProfile(profileName));
      const result = await syncStore(session);
      sync = result.ok ? { ok: true } : { ok: false, error: result.error };
    } catch (error) {
      sync = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const now = new Date();
  const windowSpec: WindowSpec = {
    since: str(parsed, "since"),
    until: str(parsed, "until"),
    last: str(parsed, "last"),
    range: str(parsed, "range"),
  };
  const window = resolveWindow(windowSpec, timezone, now);
  const data = buildReportData({
    timezone,
    sinceMs: window.sinceMs,
    untilMs: window.untilMs,
    harnesses: [],
    models: [],
    sections: ["totals", "sessions", "daily"],
    // The whole window's sessions: the story names the biggest one.
    top: Number.MAX_SAFE_INTEGER,
    sync,
    now,
  });

  const warning = syncWarningFor(data.meta.sync);
  if (warning) err(style.yellow(`Warning: ${warning}`));

  const story = buildWrappedStory(data);
  if (bool(parsed, "json")) return json(story);
  out(renderWrappedText(story, { format, showCost: !bool(parsed, "no-cost") }));
}
