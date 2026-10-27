import { currencySymbol } from "../cli/output.js";
import { formatMoneyFixed } from "../pricing/currency.js";
import { WEEKDAYS, zonedParts } from "./zoned-time.js";

/**
 * The 24h×7d activity heatmap (feature catalog F4, ticket #75).
 *
 * `buildHeatmapGrid` buckets store rows by day-of-week × hour in the display
 * timezone; `renderHeatmap` draws the grid with intensity buckets that
 * degrade across the terminal color ladder (truecolor → 256 → 16 → plain
 * chars). Provenance is explicit: cost is the gateway-billed store sum,
 * request counts are estimated row counts. No aggregation beyond this one
 * presentation bucketing — totals and sessions stay with the #76 engine.
 */

export const HEATMAP_METRICS = ["cost", "requests"] as const;
export type HeatmapMetric = (typeof HEATMAP_METRICS)[number];

/** The color ladder the renderer degrades across. */
export type ColorDepth = "truecolor" | "256" | "16" | "none";

export type HeatmapRow = {
  created_at: string;
  cost_value: number | null;
  currency: string | null;
};

export type HeatmapGrid = {
  metric: HeatmapMetric;
  timezone: string;
  currencyHandling: "single" | "mixed" | "none";
  /** The currency in the grid: the single one, or the dominant one when mixed. */
  currency: string | null;
  /** [weekdayIndex (Mon=0)][hour 0–23]. */
  grid: number[][];
  max: number;
  rowCount: number;
  peak: { weekday: number; hour: number; value: number } | null;
};

/** Empty 7×24 grid: every hour of every weekday carries zero. */
const EMPTY_WEEK = (): number[][] =>
  Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

/** The currency carrying the largest total (null with no priced rows). */
function dominantCurrencyOf(rows: readonly HeatmapRow[]): string | null {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.cost_value !== "number" || !Number.isFinite(row.cost_value)) continue;
    const currency = row.currency ?? "";
    totals.set(currency, (totals.get(currency) ?? 0) + row.cost_value);
  }
  let best: string | null = null;
  let bestValue = 0;
  for (const [currency, value] of totals) {
    if (value > bestValue) {
      best = currency;
      bestValue = value;
    }
  }
  return best;
}

export function buildHeatmapGrid(
  rows: readonly HeatmapRow[],
  options: { metric: HeatmapMetric; timezone: string },
): HeatmapGrid {
  // Cost mode with mixed currencies never sums across currencies: only the
  // dominant currency's rows enter the grid, and the renderer says so.
  const dominant = options.metric === "cost" ? dominantCurrencyOf(rows) : null;
  const grid = EMPTY_WEEK();
  const currencies = new Set<string>();
  let hasUnknownCurrencyCost = false;
  let rowCount = 0;

  for (const row of rows) {
    const ms = Date.parse(row.created_at);
    if (Number.isNaN(ms)) continue;
    rowCount += 1;
    const { weekday, hour } = zonedParts(ms, options.timezone);
    if (options.metric === "requests") {
      grid[weekday - 1]![hour]! += 1;
      continue;
    }
    if (typeof row.cost_value !== "number" || !Number.isFinite(row.cost_value)) continue;
    if (dominant !== null && row.currency !== dominant) continue;
    grid[weekday - 1]![hour]! += row.cost_value;
    if (row.currency === null) hasUnknownCurrencyCost = true;
    else currencies.add(row.currency);
  }
  if (hasUnknownCurrencyCost) currencies.add("");

  const currencyKeys = [...currencies].sort();
  const currencyHandling =
    currencyKeys.length === 0 ? "none" : currencyKeys.length === 1 ? "single" : "mixed";

  let max = 0;
  let peak: HeatmapGrid["peak"] = null;
  for (let d = 0; d < 7; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      const value = grid[d]![h]!;
      if (value > max) {
        max = value;
        peak = { weekday: d, hour: h, value };
      }
    }
  }

  return {
    metric: options.metric,
    timezone: options.timezone,
    currencyHandling,
    // The currency actually in the grid: the single one, or the dominant one
    // in mixed mode (only its rows entered). Null when none or unknown-"".
    currency: currencyKeys[0] !== undefined && currencyKeys[0] !== "" ? currencyKeys[0]! : null,
    grid,
    max,
    rowCount,
    peak,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Intensity glyph ramp — content, not color, so it works piped. */
const GLYPHS = ["·", "░", "▒", "▓", "█"] as const;

/** Brand-red foreground ramp for the non-zero buckets. */
const RAMP_HEX = ["#4c5160", "#9a4a50", "#d0555c", "#ef2635"] as const;

/** 16-color SGR fallbacks for the four non-zero buckets. */
const RAMP_16 = ["\x1b[90m", "\x1b[31m", "\x1b[91m", "\x1b[1;91m"] as const;

/**
 * The terminal's color depth, in evidence order: NO_COLOR kills color,
 * FORCE_COLOR forces a rung (1/2/3 → 16/256/truecolor), COLORTERM names
 * truecolor, TERM names 256. Without evidence, plain characters.
 */
export function colorDepth(env: NodeJS.ProcessEnv = process.env): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  const forced = env.FORCE_COLOR;
  if (forced === "0" || forced === "false") return "none";
  if (forced === "1") return "16";
  if (forced === "2") return "256";
  if (forced === "3") return "truecolor";
  const colorterm = env.COLORTERM?.toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  const term = env.TERM ?? "";
  if (term.includes("256color")) return "256";
  if (term.includes("16color")) return "16";
  if (term !== "" && term !== "dumb") return "16";
  return "none";
}

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Foreground SGR for a bucket (0 = plain), at the given depth. */
function bucketColor(bucket: number, depth: ColorDepth): string {
  if (bucket === 0) return "";
  const index = bucket - 1;
  if (depth === "16") return RAMP_16[index] ?? "";
  if (depth === "256") {
    const [r, g, b] = hexRgb(RAMP_HEX[index] ?? "#ef2635");
    return `\x1b[38;5;${nearest256(r, g, b)}m`;
  }
  if (depth === "truecolor") {
    const [r, g, b] = hexRgb(RAMP_HEX[index] ?? "#ef2635");
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  return "";
}

/** Nearest xterm-256 index for an RGB triple (6×6×6 cube vs grayscale). */
function nearest256(r: number, g: number, b: number): number {
  const steps = [0, 95, 135, 175, 215, 255];
  const nearest = (channel: number): number =>
    steps.reduce(
      (best, step, i) => (Math.abs(step - channel) < Math.abs(steps[best]! - channel) ? i : best),
      0,
    );
  const [ri, gi, bi] = [nearest(r), nearest(g), nearest(b)];
  return 16 + 36 * ri + 6 * gi + bi;
}

const RESET = "\x1b[39m";

/** 0–4 intensity bucket for a cell value. */
export function bucketOf(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((value / max) * 4)));
}

/**
 * The whole heatmap as one string (no trailing newline): the hour ruler,
 * seven weekday rows, the legend, and the provenance line. Zero ANSI at
 * depth "none".
 */
export function renderHeatmap(grid: HeatmapGrid, depth: ColorDepth): string {
  const lines: string[] = [];
  const label = (hour: number): string => String(hour).padStart(2, "0");
  lines.push(`     00 03 06 09 12 15 18 21  (hour, ${grid.timezone})`);
  for (let d = 0; d < 7; d += 1) {
    let row = `${WEEKDAYS[d]}  `;
    for (let h = 0; h < 24; h += 1) {
      const bucket = bucketOf(grid.grid[d]![h]!, grid.max);
      const color = bucketColor(bucket, depth);
      row += color ? `${color}${GLYPHS[bucket]}${RESET}` : GLYPHS[bucket];
    }
    lines.push(row);
  }

  lines.push("");
  const legend = GLYPHS.map((glyph, bucket) => {
    const color = bucketColor(bucket, depth);
    return color ? `${color}${glyph}${RESET}` : glyph;
  }).join("");
  lines.push(`less ${legend} more  ·  each cell is one hour-of-week`);

  if (grid.rowCount === 0) {
    lines.push("no activity in the local store for this window");
  } else if (grid.peak && grid.max > 0) {
    const peakDay = WEEKDAYS[grid.peak.weekday];
    lines.push(
      `peak: ${peakDay} ${label(grid.peak.hour)}:00 — ${formatCell(grid.peak, grid)}` +
        ` (${grid.rowCount} row${grid.rowCount === 1 ? "" : "s"} in window)`,
    );
  }
  lines.push(provenanceLine(grid));
  return lines.join("\n");
}

function formatCell(cell: { value: number }, grid: HeatmapGrid): string {
  if (grid.metric === "requests") return `${cell.value} request(s)`;
  const symbol = currencySymbol(grid.currency);
  const code = grid.currency === null || grid.currency === "usd" ? "" : `${grid.currency} `;
  return `${code}${symbol}${formatMoneyFixed(cell.value, 4)}`;
}

function provenanceLine(grid: HeatmapGrid): string {
  if (grid.metric === "requests") {
    return "requests: estimated (count of gateway /logs rows in the store)";
  }
  if (grid.currencyHandling === "mixed") {
    return (
      `cost: gateway-billed, dominant currency (${grid.currency ?? "unknown"}) only — ` +
      "mixed currencies are never summed; per-currency totals in `aiand usage`"
    );
  }
  return "cost: gateway-billed (sum of the gateway-computed per-request cost; never recomputed)";
}
