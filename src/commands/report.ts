import { join, resolve } from "node:path";
import { openSession } from "../api/client.js";
import { bool, int, list, oneOf, parse, str } from "../cli/args.js";
import { openBrowser } from "../cli/browser.js";
import { err, out, style } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { writeFileAtomic } from "../fsutil.js";
import { storeBudgetWarning } from "../obs/forecast.js";
import {
  assertTimezone,
  buildReportData,
  DEFAULT_TOP_SESSIONS,
  parseSectionList,
  REPORT_SECTIONS,
  type ReportSection,
  resolveWindow,
  syncWarningFor,
} from "../report/data.js";
import { renderHtml } from "../report/render-html.js";
import type { SyncOutcome } from "../store/coverage.js";
import { noSyncRequested, syncStore } from "../store/index.js";

/**
 * `aiand report` (feature catalog F1, ticket #76): the offline HTML report —
 * ONE self-contained file (inline CSS/SVG, no CDN, no server, no JS), fed by
 * a single local-store load. Auto-syncs before reading (fail-open);
 * `--no-sync` / AIAND_NO_SYNC=1 reads the local store as-is.
 */

export const help = `${style.bold("aiand report")} -- a self-contained offline HTML usage report

Usage
  aiand report
  aiand report --last 7d --open
  aiand report --sections timeseries,sessions --theme dark --out report.html

Options
  --since <date>        start of the window (2026-10-01 or an ISO timestamp)
  --until <date>        end of the window (a bare date means end-of-day)
  --last <n><unit>      relative window: m|h|d|w, e.g. --last 7d
  --range <window>      15m, 1h, 6h, 24h, 7days, 30days
  --timezone <tz>       IANA timezone for day boundaries (default UTC)
  --harness <name>      filter to one harness (repeatable)
  --model <glob>        filter to models matching a glob (repeatable)
  --sections <list>     timeseries,matrix,sessions,budget (default all)
  --top <n>             most expensive sessions to include (default 20)
  --theme <mode>        light, dark, or auto (prefers-color-scheme; default auto)
  --out <path>          output file (default ./aiand-report-<timestamp>.html)
  --out-dir <dir>       directory for the default output file name
  --open                open the report in the default browser after writing
  --no-cost             mask monetary columns
  --no-sync             skip the pre-read store sync and read the local store as-is
  --json                machine-readable summary of the written report`;

/** Local-time `YYYYMMDD-HHmmss` for the default file name. */
function timestampName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    range: { type: "string" },
    timezone: { type: "string" },
    harness: { type: "string", multiple: true },
    model: { type: "string", multiple: true },
    sections: { type: "string" },
    top: { type: "string" },
    theme: { type: "string" },
    out: { type: "string" },
    "out-dir": { type: "string" },
    open: { type: "boolean", default: false },
    "no-cost": { type: "boolean", default: false },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const timezone = str(parsed, "timezone") ?? "UTC";
  assertTimezone(timezone);
  const theme = oneOf(parsed, "theme", ["light", "dark", "auto"], "auto");
  const sections: ReportSection[] = parseSectionList(str(parsed, "sections"), REPORT_SECTIONS) ?? [
    ...REPORT_SECTIONS,
  ];
  const top = int(parsed, "top") ?? DEFAULT_TOP_SESSIONS;
  if (top < 1) {
    throw new Error("--top must be a positive number.");
  }

  // -- one sync, then ONE store read for every section --------------------------
  const skipSync = bool(parsed, "no-sync") || noSyncRequested();
  let sync: SyncOutcome | null;
  if (skipSync) {
    sync = { skipped: true };
  } else {
    try {
      const session = await openSession(resolveProfile(str(parsed, "profile")));
      const result = await syncStore(session);
      sync = result.ok ? { ok: true, error: result.error } : { ok: false, error: result.error };
    } catch (error) {
      // Fail-open: a sign-in or network problem never blocks the local report.
      sync = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const now = new Date();
  const { sinceMs, untilMs } = resolveWindow(
    {
      since: str(parsed, "since"),
      until: str(parsed, "until"),
      last: str(parsed, "last"),
      range: str(parsed, "range"),
    },
    timezone,
    now,
  );
  const data = buildReportData({
    timezone,
    sinceMs,
    untilMs,
    harnesses: list(parsed, "harness"),
    models: list(parsed, "model"),
    sections,
    top,
    sync,
    now,
  });

  // The sync state is surfaced on stderr in every output mode.
  const syncWarning = syncWarningFor(data.meta.sync);
  if (syncWarning) err(style.yellow(`Warning: ${syncWarning}`));
  const budgetWarning = storeBudgetWarning();
  if (budgetWarning && !bool(parsed, "no-cost")) err(style.yellow(budgetWarning));

  const html = renderHtml(data, {
    theme,
    showCost: !bool(parsed, "no-cost"),
    sections,
  });

  const outPath =
    str(parsed, "out") ??
    join(str(parsed, "out-dir") ?? process.cwd(), `aiand-report-${timestampName(now)}.html`);
  const absolute = resolve(outPath);
  await writeFileAtomic(absolute, html);

  if (bool(parsed, "json")) {
    const { json } = await import("../cli/output.js");
    json({
      report: absolute,
      bytes: Buffer.byteLength(html),
      sections,
      meta: data.meta,
    });
    return;
  }

  out(`Report written: ${absolute}`);
  if (bool(parsed, "open")) {
    const opened = await openBrowser(absolute);
    if (!opened) out("Could not open a browser — open the file above to view the report.");
  }
}
