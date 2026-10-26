import { openSession } from "../api/client.js";
import { bool, list, parse, str } from "../cli/args.js";
import { CliError, cancelled } from "../cli/errors.js";
import { clipToWidth, currencySymbol, err, out, style, visibleWidth } from "../cli/output.js";
import { createKeyParser, KEY, type PromptInput, type PromptOutput } from "../cli/select.js";
import { resolveProfile } from "../config.js";
import {
  buildHarnessStats,
  compareWinners,
  type HarnessRequestRow,
  type HarnessStats,
  WINNER_MARKER,
} from "../obs/harness-stats.js";
import { zonedDayStartUtc, zonedMonthStartUtc } from "../obs/zoned-time.js";
import {
  assertTimezone,
  buildReportData,
  type LoadFn,
  type ReportData,
  resolveWindow,
  syncWarningFor,
} from "../report/data.js";
import { renderOverviewText } from "../report/overview.js";
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
 * `aiand dashboard` (feature catalog F2, ticket #75): the interactive
 * spend/burn TUI, drawn by hand in ANSI — zero runtime dependencies, so no
 * react/ink. The keyboard model is CodeBurn's (period keys 1–6, arrows,
 * harness cycle, compare view, refresh-in-place); every number comes from
 * the #76 report engine and the #64 harness stats — nothing here
 * re-aggregates.
 *
 * Non-interactive: when stdout is not a TTY (or `--no-tui`), the command
 * prints the plain-text overview (#76) and exits — scripts and CI never
 * hang.
 */

// ---------------------------------------------------------------------------
// Periods (CodeBurn's Today / 7d / 30d / Month / 6mo / Lifetime)
// ---------------------------------------------------------------------------

const DASH_PERIODS = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "month", label: "Month" },
  { id: "6mo", label: "6mo" },
  { id: "lifetime", label: "Lifetime" },
] as const;
export type DashPeriodId = (typeof DASH_PERIODS)[number]["id"];

const DAY_MS = 86_400_000;
const SIX_MONTHS_MS = 183 * DAY_MS;

/** The UTC window a dashboard period covers (until is always "now"). */
export function windowForPeriod(
  id: DashPeriodId,
  now: Date,
  timezone: string,
): { sinceMs: number | null; untilMs: number | null } {
  const nowMs = now.getTime();
  switch (id) {
    case "today":
      return { sinceMs: zonedDayStartUtc(nowMs, timezone), untilMs: null };
    case "7d":
      return { sinceMs: nowMs - 7 * DAY_MS, untilMs: null };
    case "30d":
      return { sinceMs: nowMs - 30 * DAY_MS, untilMs: null };
    case "month":
      return { sinceMs: zonedMonthStartUtc(nowMs, timezone), untilMs: null };
    case "6mo":
      return { sinceMs: nowMs - SIX_MONTHS_MS, untilMs: null };
    case "lifetime":
      return { sinceMs: null, untilMs: null };
  }
}

/**
 * Responsive breakpoints (documented in the help): under 60 columns one
 * panel per row, 60–99 two side by side, 100+ three.
 */
const COLUMN_BREAKPOINTS = { one: 60, two: 100 } as const;

export function columnsFor(width: number): 1 | 2 | 3 {
  if (width < COLUMN_BREAKPOINTS.one) return 1;
  if (width < COLUMN_BREAKPOINTS.two) return 2;
  return 3;
}

/** The auto-refresh default and floor (ticket: in-place refresh at ≥60s). */
const REFRESH_DEFAULT_MS = 60_000;
const REFRESH_MIN_MS = 60_000;

// ---------------------------------------------------------------------------
// Store read for the compare view (#64 rows: model, status, ttft)
// ---------------------------------------------------------------------------

type CompareRow = HarnessRequestRow;

type CompareLoader = (window: { sinceMs: number | null; untilMs: number | null }) => CompareRow[];

function readCompareRows(window: { sinceMs: number | null; untilMs: number | null }): CompareRow[] {
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
        "SELECT id, model, api_key, created_at, input_tokens, output_tokens, cached_tokens, " +
          "cost, cost_value, currency, status_code, ttft_ms FROM requests" +
          where +
          " ORDER BY created_at, id",
      )
      .all(...args);
    return rows as unknown as CompareRow[];
  } catch {
    // Fail open, like every store read: a locked store shows an empty view.
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const help = `${style.bold("aiand dashboard")} -- interactive spend/burn dashboard

Usage
  aiand dashboard                 interactive TUI (a real terminal)
  aiand dashboard --no-tui        plain-text overview, even in a terminal

Keys (interactive)
  1..6 / arrows       period: Today, 7d, 30d, Month, 6mo, Lifetime
  j / k               scroll the per-day list (PgDn / PgUp too)
  p                   cycle harness scope (all, then each harness)
  c                   toggle the harness compare view (#64 winners)
  r                   refresh now
  q / Esc             quit (Ctrl-C quits too)

Options
  --since <date>        start of the fallback-overview window
  --until <date>        end of the window (a bare date means end-of-day)
  --last <n><unit>      relative window: m|h|d|w, e.g. --last 7d
  --range <window>      15m, 1h, 6h, 24h, 7days, 30days
  --timezone <tz>       IANA timezone for Today/Month and displayed times
                        (default UTC)
  --harness <name>      start scoped to this harness (p cycles)
  --model <glob>        filter to models matching a glob (repeatable)
  --no-cost             mask monetary figures
  --no-tui              print the plain-text overview instead of the TUI
  --refresh <seconds>   auto-refresh interval (minimum 60, default 60)
  --no-sync             skip the pre-read store sync and read as-is

Layout is responsive: 1 column under 60 terminal columns, 2 columns from 60,
3 from 100. The five most expensive sessions stay pinned under the period
tabs in every period, layout, and scroll position. The view refreshes in
place every 60s and your scroll position survives the redraw.

Non-interactive runs (piped stdout) print the plain-text overview and exit —
nothing ever hangs waiting for a terminal.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    range: { type: "string" },
    timezone: { type: "string" },
    harness: { type: "string", multiple: true },
    model: { type: "string", multiple: true },
    "no-cost": { type: "boolean", default: false },
    "no-tui": { type: "boolean", default: false },
    refresh: { type: "string" },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const timezone = str(parsed, "timezone") ?? "UTC";
  assertTimezone(timezone);

  const refreshRaw = str(parsed, "refresh");
  let refreshMs = REFRESH_DEFAULT_MS;
  if (refreshRaw !== undefined) {
    const seconds = Number(refreshRaw);
    if (!Number.isFinite(seconds) || seconds < REFRESH_MIN_MS / 1000) {
      throw new CliError(
        `--refresh must be at least ${REFRESH_MIN_MS / 1000} seconds (got "${refreshRaw}").`,
        { hint: "The dashboard never polls faster than once a minute." },
      );
    }
    refreshMs = seconds * 1000;
  }

  // One fail-open sync before the first read; the loop itself is offline.
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
      sync = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const showCost = !bool(parsed, "no-cost");
  const models = list(parsed, "model");
  const initialHarness = str(parsed, "harness") ?? null;

  // Non-interactive: the plain-text overview, then exit (no hang).
  if (bool(parsed, "no-tui") || process.stdout.isTTY !== true) {
    const now = new Date();
    const window = resolveWindow(
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
      sinceMs: window.sinceMs,
      untilMs: window.untilMs,
      harnesses: initialHarness === null ? [] : [initialHarness],
      models,
      sections: ["totals", "by-harness", "models", "busiest", "daily", "sessions"],
      top: 5,
      sync,
      now,
    });
    const warning = syncWarningFor(data.meta.sync);
    if (warning) err(style.yellow(`Warning: ${warning}`));
    out(
      renderOverviewText(data, {
        showCost,
        sections: ["totals", "by-harness", "models", "busiest", "daily"],
      }),
    );
    return;
  }

  await runDashboardUi({
    timezone,
    models,
    initialHarness,
    showCost,
    refreshMs,
    sync,
  });
}

// ---------------------------------------------------------------------------
// The TUI loop
// ---------------------------------------------------------------------------

export type DashboardUiOptions = {
  input?: PromptInput;
  output?: PromptOutput;
  timezone: string;
  models: string[];
  initialHarness: string | null;
  showCost: boolean;
  refreshMs: number;
  sync: SyncOutcome | null;
  /** Overrides Date.now() — tests pin time. */
  now?: Date;
  /** Injected report loader (tests); defaults to the real store read. */
  load?: LoadFn;
  /** Injected compare loader (tests); defaults to the real store read. */
  loadCompare?: CompareLoader;
};

type DashboardState = {
  periodIndex: number;
  scope: string; // "all" or a harness name
  compare: boolean;
  scroll: number;
  data: ReportData | null;
  harnesses: string[];
  compareStats: HarnessStats | null;
  lastRefreshAt: number;
};

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";

/**
 * The raw-mode loop: draw, wait for keys or the interval, redraw in place.
 * The frame erases with cursor-up + clear (no alternate screen), so the
 * terminal's own scroll position survives every refresh, and the frame's
 * scroll offset survives the timer-driven data refresh.
 */
export async function runDashboardUi(options: DashboardUiOptions): Promise<void> {
  const input = options.input ?? (process.stdin as unknown as PromptInput);
  const output = options.output ?? (process.stdout as unknown as PromptOutput);
  if (!input.isTTY) {
    throw new CliError("The dashboard needs an interactive terminal.", {
      hint: "Piped runs print the plain-text overview instead — this path never sees a pipe.",
    });
  }

  const state: DashboardState = {
    periodIndex: 0,
    scope: options.initialHarness ?? "all",
    compare: false,
    scroll: 0,
    data: null,
    harnesses: [],
    compareStats: null,
    lastRefreshAt: 0,
  };

  const refresh = (): void => {
    const now = options.now ?? new Date();
    const period = DASH_PERIODS[state.periodIndex]!;
    const window = windowForPeriod(period.id, now, options.timezone);
    state.data = buildReportData({
      timezone: options.timezone,
      sinceMs: window.sinceMs,
      untilMs: window.untilMs,
      harnesses: state.scope === "all" ? [] : [state.scope],
      models: options.models,
      sections: ["totals", "by-harness", "models", "busiest", "daily", "sessions"],
      top: 5,
      sync: options.sync,
      now,
      load: options.load,
    });
    state.harnesses = state.data.byHarness.map((row) => row.harness);
    if (state.scope !== "all" && !state.harnesses.includes(state.scope)) state.scope = "all";
    const loadCompare = options.loadCompare ?? readCompareRows;
    state.compareStats = buildHarnessStats(loadCompare(window), {
      range: {
        since: window.sinceMs === null ? null : new Date(window.sinceMs).toISOString(),
        until: null,
      },
      timezone: options.timezone,
    });
    state.lastRefreshAt = now.getTime();
  };

  refresh();

  input.setRawMode(true);
  input.resume();
  output.write(HIDE_CURSOR);

  let prevLines = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let listening = false;
  // Settle holders so the key/end handlers (defined above the promise) can
  // finish the loop promise without capturing the executor's bindings.
  let onResolve: (() => void) | null = null;
  let onReject: ((error: unknown) => void) | null = null;

  const width = (): number => Math.max(20, output.columns || 80);
  const height = (): number => Math.max(12, output.rows || 24);

  const draw = (): void => {
    const lines = renderFrame(state, {
      width: width(),
      height: height(),
      showCost: options.showCost,
      timezone: options.timezone,
      refreshMs: options.refreshMs,
      nowMs: state.lastRefreshAt,
    });
    let frame = prevLines > 0 ? `\x1b[${prevLines}A\r` : "\r";
    frame += lines.map((line) => `${CLEAR_LINE}${clipToWidth(line, width())}`).join("\n");
    output.write(`${frame}\n`);
    prevLines = lines.length;
  };

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (listening) {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      listening = false;
    }
  };

  const restore = (): void => {
    if (prevLines > 0) {
      output.write(`\x1b[${prevLines}A\r\x1b[J`);
      prevLines = 0;
    }
    output.write(SHOW_CURSOR);
    input.setRawMode(false);
  };

  const handleKey = (seq: string): boolean => {
    if (seq === KEY.CTRL_C) {
      stop();
      restore();
      output.write("^C\n");
      onReject?.(cancelled());
      return true;
    }
    if (seq === "q" || seq === KEY.ESC) {
      stop();
      restore();
      onResolve?.();
      return true;
    }
    const digit = /^[1-6]$/.exec(seq);
    if (digit) {
      state.periodIndex = Number(digit[0]) - 1;
      state.scroll = 0;
      refresh();
    } else if (seq === KEY.UP || seq === "\x1b[D") {
      state.periodIndex = (state.periodIndex + DASH_PERIODS.length - 1) % DASH_PERIODS.length;
      state.scroll = 0;
      refresh();
    } else if (seq === KEY.DOWN || seq === "\x1b[C") {
      state.periodIndex = (state.periodIndex + 1) % DASH_PERIODS.length;
      state.scroll = 0;
      refresh();
    } else if (seq === "j" || seq === "\x1b[6~") {
      state.scroll += 1;
    } else if (seq === "k" || seq === "\x1b[5~") {
      state.scroll = Math.max(0, state.scroll - 1);
    } else if (seq === "p") {
      const scopes = ["all", ...state.harnesses];
      state.scope = scopes[(scopes.indexOf(state.scope) + 1) % scopes.length]!;
      state.scroll = 0;
      refresh();
    } else if (seq === "c") {
      state.compare = !state.compare;
      state.scroll = 0;
    } else if (seq === "r") {
      refresh();
    } else {
      return false;
    }
    draw();
    return true;
  };

  const keyParser = createKeyParser();
  const onData = (chunk: string): void => {
    for (const seq of keyParser.push(chunk)) {
      if (handleKey(seq)) return;
    }
    draw();
  };

  const onEnd = (): void => {
    stop();
    restore();
    onReject?.(
      new CliError("Input ended.", { hint: "The dashboard needs an interactive terminal." }),
    );
  };

  try {
    return await new Promise<void>((resolve, reject) => {
      onResolve = resolve;
      onReject = reject;
      draw();
      listening = true;
      input.on("data", onData);
      input.on("end", onEnd);

      timer = setInterval(() => {
        // stop() clears this timer; nothing else removes the listeners.
        refresh();
        draw();
      }, options.refreshMs);
      timer.unref?.();
    });
  } finally {
    stop();
    restore();
  }
}

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

const HINTS = "1-6/←→ period · j/k scroll · p harness · c compare · r refresh · q quit";

function renderFrame(
  state: DashboardState,
  view: {
    width: number;
    height: number;
    showCost: boolean;
    timezone: string;
    refreshMs: number;
    nowMs: number;
  },
): string[] {
  const period = DASH_PERIODS[state.periodIndex]!;
  const lines: string[] = [];

  // -- header + period tabs ---------------------------------------------------
  const scopeLabel = state.scope === "all" ? "all harnesses" : state.scope;
  lines.push(
    `${style.bold("ai& dashboard")}  ${style.dim(`${period.label} · ${scopeLabel} · ${view.timezone}`)}`,
  );
  const tabs = DASH_PERIODS.map((entry, i) => {
    const text = `${i + 1} ${entry.label}`;
    return i === state.periodIndex ? style.bold(`[${text}]`) : style.dim(text);
  }).join("  ");
  lines.push(tabs);
  lines.push("");

  // -- pinned top-5 sessions (never scrolled away) -------------------------------
  lines.push(style.bold("Top 5 sessions (pinned)"));
  const sessions = state.data?.sessions ?? [];
  if (sessions.length === 0) {
    lines.push(style.dim("  no sessions in this window yet — press r after a sync"));
  } else {
    for (let i = 0; i < Math.min(5, sessions.length); i += 1) {
      const session = sessions[i]!;
      const cost =
        !view.showCost || session.cost === null
          ? ""
          : `  ${formatMoney(session.cost, session.currency)}`;
      lines.push(
        `  ${String(i + 1).padStart(2)}. ${session.session_id}  ${session.agent}  ` +
          `${session.turns}t${cost}`,
      );
    }
  }
  lines.push(style.dim("─".repeat(Math.min(view.width, 60))));

  // -- body: responsive panels + scrollable per-day list, or the compare view ----
  if (state.compare) {
    lines.push(...renderCompare(state, view.width));
  } else {
    const panels = renderPanels(state, view);
    const columns = columnsFor(view.width);
    lines.push(...composeColumns(panels, columns, view.width));
    lines.push("");
    // Fixed chrome so far, plus the blank + footer still to come.
    const fixed = lines.length + 2;
    lines.push(...renderDailyList(state, view, fixed, view.height));
  }

  // -- footer -------------------------------------------------------------------
  lines.push("");
  const refreshed = new Date(view.nowMs).toTimeString().slice(0, 8);
  lines.push(
    style.dim(`${HINTS} · auto-refresh ${Math.round(view.refreshMs / 1000)}s (last ${refreshed})`),
  );
  return lines;
}

function formatMoney(value: number, currency: string | null): string {
  const symbol = currencySymbol(currency);
  const code = currency === null || currency === "usd" ? "" : `${currency} `;
  return `${code}${symbol}${value.toFixed(4)}`;
}

function formatCosts(costs: Record<string, number>): string {
  const entries = Object.entries(costs);
  if (entries.length === 0) return "-";
  return entries
    .map(([currency, value]) => formatMoney(value, currency === "" ? null : currency))
    .join("; ");
}

// -- panels -------------------------------------------------------------------

function renderPanels(
  state: DashboardState,
  view: { showCost: boolean },
): { title: string; lines: string[] }[] {
  const data = state.data;
  const panels: { title: string; lines: string[] }[] = [];

  // Panel 1: totals (+ savings when known).
  const totals = data?.totals;
  const totalsLines: string[] = [];
  if (!totals || totals.requests === 0) {
    totalsLines.push(style.dim("no requests in this window"));
  } else {
    totalsLines.push(`requests      ${totals.requests}`);
    totalsLines.push(`tokens in     ${totals.inputTokens}  (cached ${totals.cachedTokens})`);
    totalsLines.push(`tokens out    ${totals.outputTokens}`);
    if (view.showCost) {
      totalsLines.push(`cost          ${formatCosts(totals.costs)}`);
      if (totals.savings !== null) {
        totalsLines.push(
          `est. saved    ${formatMoney(totals.savings, data?.meta.currency ?? null)}`,
        );
      }
    }
  }
  panels.push({ title: "Totals", lines: totalsLines });

  // Panel 2: by-harness share.
  const harnessLines: string[] = [];
  const byHarness = data?.byHarness ?? [];
  if (byHarness.length === 0) {
    harnessLines.push(style.dim("no harness data"));
  } else {
    for (const row of byHarness.slice(0, 6)) {
      const share = row.share === null ? "n/a%" : `${Math.round(row.share * 100)}%`;
      const cost = view.showCost ? `  ${formatCosts(row.costs)}` : "";
      harnessLines.push(`${row.harness.padEnd(10)} ${share.padStart(5)}${cost}`);
    }
  }
  panels.push({ title: "By harness", lines: harnessLines });

  // Panel 3: top models.
  const modelLines: string[] = [];
  const topModels = data?.topModels ?? [];
  if (topModels.length === 0) {
    modelLines.push(style.dim("no model data"));
  } else {
    for (const model of topModels.slice(0, 5)) {
      const cost = view.showCost ? `  ${formatCosts(model.costs)}` : "";
      modelLines.push(`${model.key}  ${model.requests} req${cost}`);
    }
  }
  panels.push({ title: "Top models", lines: modelLines });

  return panels;
}

/** Lay panels out in 1/2/3 columns, each clipped to its column width. */
function composeColumns(
  panels: { title: string; lines: string[] }[],
  columns: 1 | 2 | 3,
  width: number,
): string[] {
  const gutter = 3;
  const colWidth = Math.max(20, Math.floor((width - gutter * (columns - 1)) / columns));
  const groups: { title: string; lines: string[] }[][] =
    columns === 3
      ? [panels.slice(0, 1), panels.slice(1, 2), panels.slice(2, 3)]
      : columns === 2
        ? [panels.slice(0, 1), panels.slice(1, 3)]
        : [panels];

  const blocks = groups
    .filter((group) => group.length > 0)
    .map((group) => {
      const lines: string[] = [];
      for (const panel of group) {
        lines.push(style.bold(panel.title));
        lines.push(...panel.lines);
        lines.push("");
      }
      return lines.map((line) => clipToWidth(line, colWidth));
    });

  const height = Math.max(...blocks.map((block) => block.length));
  const rows: string[] = [];
  for (let i = 0; i < height; i += 1) {
    let row = "";
    for (let b = 0; b < blocks.length; b += 1) {
      const cell = blocks[b]![i] ?? "";
      const pad =
        b < blocks.length - 1
          ? " ".repeat(Math.max(0, colWidth - visibleWidth(cell) + gutter))
          : "";
      row += cell + pad;
    }
    rows.push(row.replace(/\s+$/, ""));
  }
  return rows;
}

// -- scrollable per-day list ---------------------------------------------------

function renderDailyList(
  state: DashboardState,
  view: { showCost: boolean },
  fixedLines: number,
  termHeight: number,
): string[] {
  const days = state.data?.days ?? [];
  const lines: string[] = [style.bold("Per day")];
  if (days.length === 0) {
    lines.push(style.dim("  no daily data in this window"));
    return lines;
  }
  // The visible budget is what the terminal has left after the fixed chrome
  // above and below; the pinned top-5 block is never part of the scroll.
  const visible = Math.max(1, termHeight - fixedLines);
  const scroll = Math.min(state.scroll, Math.max(0, days.length - visible));
  state.scroll = scroll;
  if (scroll > 0) lines.push(style.dim(`  ↑ ${scroll} more`));
  for (let i = scroll; i < Math.min(days.length, scroll + visible); i += 1) {
    const day = days[i]!;
    const cost = view.showCost ? `  ${formatCosts(day.costs)}` : "";
    lines.push(
      `  ${day.day}  ${String(day.requests).padStart(6)} req  ` +
        `${day.inputTokens + day.outputTokens} tok${cost}`,
    );
  }
  if (scroll + visible < days.length) {
    lines.push(style.dim(`  ↓ ${days.length - scroll - visible} more`));
  }
  return lines;
}

// -- compare view ----------------------------------------------------------------

function renderCompare(state: DashboardState, width: number): string[] {
  const lines: string[] = [style.bold("Harness compare")];
  const stats = state.compareStats;
  if (!stats || stats.harnesses.length === 0) {
    lines.push(style.dim("  no harness sessions in this window"));
    return lines;
  }
  const winners = compareWinners(stats.harnesses);
  lines.push(style.dim("  harness        reqs  sess  cost/sess p50   cache%  err%  ttft p50"));
  for (const row of stats.harnesses) {
    const cell = (value: string, winner: string | null): string =>
      winner === row.harness ? `${style.bold(value)} ${WINNER_MARKER}` : ` ${value} `;
    const costP50 =
      row.costPerSession.p50 === null
        ? "n/a"
        : formatMoney(row.costPerSession.p50, row.currency).trim();
    const cache = `${Math.round(row.cacheHitRatio * 100)}`.padStart(3);
    const errRate = `${(row.errorRate * 100).toFixed(1)}`.padStart(4);
    const ttft = row.ttft.p50 === null ? "n/a" : `${Math.round(row.ttft.p50)}ms`;
    lines.push(
      clipToWidth(
        ` ${row.harness.padEnd(12)}  ${String(row.requests).padStart(5)}  ` +
          `${String(row.sessions).padStart(4)}  ` +
          `${cell(costP50, winners.costPerSessionP50).padEnd(15)} ` +
          `${cache}     ${errRate}  ` +
          cell(ttft, winners.ttftP50),
        width,
      ),
    );
  }
  if (stats.provenance.excludedMixed > 0) {
    lines.push(
      style.dim(
        `  ${stats.provenance.excludedMixed} mixed-model session(s) excluded from every row`,
      ),
    );
  }
  lines.push(style.dim(`  ${stats.provenance.labels.costPerSession}`));
  return lines;
}
