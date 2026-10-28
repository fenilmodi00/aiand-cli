import { EOL } from "node:os";
import { DAY_SECONDS, HOUR_SECONDS, MINUTE_SECONDS, SECOND_MS } from "../time.js";
import { colorsEnabled } from "./ui/color.js";
import { GLYPH } from "./ui/glyphs.js";
import { createTheme } from "./ui/theme.js";

const ESC = "\x1b[";

let enabled = colorsEnabled();

/** Whether styling is currently active (test hook + help coloring). */
export function isStyleEnabled(): boolean {
  return enabled;
}

/** Test hook: force styling on/off regardless of the ambient terminal. */
export function _setColorEnabled(value: boolean): void {
  enabled = Boolean(value);
}

const wrap = (open: string, close: string) => (s: string) =>
  enabled ? `${ESC}${open}m${s}${ESC}${close}m` : s;

/**
 * The shared command-output style. The color roles are bound to the ai&
 * brand palette — the same theme the menu chrome paints with — so command
 * output and menu chrome share one visual language: red/green/yellow/cyan
 * are the theme's danger/success/warning/accent roles. The theme is bound
 * per call, like the menu's own render, so a changed color env applies
 * without a process restart; plain text whenever color is off.
 */
export const style = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  red: (s: string) => (enabled ? createTheme({ isTTY: true }).danger(s) : s),
  green: (s: string) => (enabled ? createTheme({ isTTY: true }).success(s) : s),
  yellow: (s: string) => (enabled ? createTheme({ isTTY: true }).warning(s) : s),
  cyan: (s: string) => (enabled ? createTheme({ isTTY: true }).accent(s) : s),
};

/**
 * A section heading in the menu's own visual language: the focus-bar glyph
 * in the accent color, then the title bold. The one heading every command
 * output and the menu chrome share, so a tiled view reads as one surface.
 */
export function heading(title: string): void {
  out(`${style.cyan(GLYPH.focusBar)} ${style.bold(title)}`);
}

const CURRENCY_SYMBOL: Record<string, string> = { usd: "$", jpy: "¥" };

/** Prefix for a gateway currency code; unknown codes print bare. */
export function currencySymbol(currency: string | null | undefined): string {
  return (currency && CURRENCY_SYMBOL[currency]) ?? "";
}

/**
 * While a spinner runs, every payload write must coordinate with it: clear
 * the spinner line, print below it, let the spinner redraw underneath —
 * otherwise frames and output glue into one broken line.
 */
let activeSpinner: {
  suspend(): void;
  resume(): void;
  pause(): void;
  unpause(): void;
} | null = null;

function writeCoordinated(write: () => void): void {
  if (!activeSpinner) {
    write();
    return;
  }
  activeSpinner.suspend();
  try {
    write();
  } finally {
    activeSpinner.resume();
  }
}

export function out(line = ""): void {
  writeCoordinated(() => process.stdout.write(line + EOL));
}

export function err(line = ""): void {
  writeCoordinated(() => process.stderr.write(line + EOL));
}

export function json(value: unknown): void {
  writeCoordinated(() => process.stdout.write(JSON.stringify(value, null, 2) + EOL));
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1b000, 0x1b001],
  [0x1f200, 0x1f251],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const VARIATION_SELECTOR_16 = "\ufe0f";
const segmenter = new Intl.Segmenter();

function isWideCodePoint(cp: number): boolean {
  for (const [low, high] of WIDE_RANGES) {
    if (cp >= low && cp <= high) return true;
    if (cp < low) break;
  }
  return false;
}

function width(s: string): number {
  const plain = s.replace(ANSI_RE, "");
  let columns = 0;

  for (const { segment } of segmenter.segment(plain)) {
    const cp = segment.codePointAt(0);
    if (cp === undefined) continue;

    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;

    const wide =
      isWideCodePoint(cp) ||
      (cp >= 0x1f000 && PICTOGRAPHIC.test(segment)) ||
      segment.includes(VARIATION_SELECTOR_16);

    columns += wide ? 2 : 1;
  }

  return columns;
}

/**
 * Visible column count, ignoring ANSI SGR sequences and counting wide
 * code points as two. The one width helper the UI layer shares, so a row
 * layout and a clip never disagree.
 */
export function visibleWidth(text: string): number {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  let count = 0;
  for (const char of plain) count += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
  return count;
}

/** Right-pad `text` to a visible width. */
export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Clip to a visible width, ending in an ellipsis when it overflows. */
export function ellipsize(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return "\u2026";
  return `${text.slice(0, width - 1)}\u2026`;
}

/** Visible-column truncate; drops styling on overflow and appends an ellipsis. */
export function clipToWidth(line: string, columns: number): string {
  if (width(line) <= columns) return line;
  const plain = line.replace(ANSI_RE, "");
  const budget = Math.max(0, columns - 1);
  let used = 0;
  let out = "";
  for (const { segment } of segmenter.segment(plain)) {
    const w = width(segment);
    if (used + w > budget) break;
    out += segment;
    used += w;
  }
  return `${out}…`;
}

function pad(s: string, to: number, align: "left" | "right"): string {
  const gap = " ".repeat(Math.max(0, to - width(s)));
  return align === "right" ? gap + s : s + gap;
}

export type Column<T> = {
  header: string;
  value: (row: T) => string;
  align?: "left" | "right";
};

export function table<T>(rows: T[], columns: Column<T>[]): void {
  if (rows.length === 0) return;
  const cells = rows.map((row) => columns.map((c) => c.value(row)));
  const widths = columns.map((c, i) =>
    Math.max(width(c.header), ...cells.map((r) => width(r[i] ?? ""))),
  );

  if (columns.some((c) => c.header !== "")) {
    out(
      columns
        .map((c, i) => style.dim(pad(c.header.toUpperCase(), widths[i]!, c.align ?? "left")))
        .join("  ")
        .trimEnd(),
    );
  }

  for (const row of cells) {
    out(
      row
        .map((cell, i) => pad(cell, widths[i]!, columns[i]!.align ?? "left"))
        .join("  ")
        .trimEnd(),
    );
  }
}

export function fields(pairs: [string, string][]): void {
  const keyWidth = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    out(`${style.dim(pad(k, keyWidth, "left"))}  ${v}`);
  }
}

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max === 0) return SPARK[0]!.repeat(values.length);
  return values
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.round((v / max) * (SPARK.length - 1)))]!)
    .join("");
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}

export function delta(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? style.dim("--") : style.green("new");
  const pct = ((current - previous) / previous) * 100;
  const label = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  return pct >= 0 ? style.green(label) : style.red(label);
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / SECOND_MS));
  if (seconds < MINUTE_SECONDS) return `${seconds}s ago`;
  if (seconds < HOUR_SECONDS) return `${Math.round(seconds / MINUTE_SECONDS)}m ago`;
  if (seconds < DAY_SECONDS) return `${Math.round(seconds / HOUR_SECONDS)}h ago`;
  return `${Math.round(seconds / DAY_SECONDS)}d ago`;
}

const SPINNER_FRAME_MS = 80;

export function spinner(text: string): { stop: (final?: string) => void } {
  if (!process.stderr.isTTY) {
    return { stop: (final?: string) => void (final && err(final)) };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const frame = () => `${style.cyan(frames[i++ % frames.length]!)} ${text}`;
  let timer: ReturnType<typeof setInterval> | null = null;
  const startTimer = () => {
    timer = setInterval(() => {
      process.stderr.write(`\r${ESC}2K${frame()}`);
    }, SPINNER_FRAME_MS);
    timer.unref();
  };
  process.stderr.write(`\x1b[?25l`);
  startTimer();
  let stopped = false;
  let paused = false;
  const stop = () => {
    stopped = true;
    activeSpinner = null;
    if (timer) clearInterval(timer);
    timer = null;
    process.stderr.write(`\r${ESC}2K\x1b[?25h`);
  };
  activeSpinner = {
    // Clear the spinner line and move to a fresh line below for the payload.
    suspend: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        process.stderr.write(`\r${ESC}2K\n`);
      }
    },
    // Redraw the spinner beneath the payload. No-op while a paused prompt
    // still owns the line (see pause) or the spinner has stopped.
    resume: () => {
      if (!stopped && !paused && !timer) {
        process.stderr.write(frame());
        startTimer();
      }
    },
    // An interactive prompt takes the line over: stop the frames, clear in
    // place (no newline — the question owns this line), show the cursor.
    // Without this, the 80ms redraw erases the question as it is asked and
    // the prompt reads as a hung spinner (the login/logout "deadlock").
    pause: () => {
      if (stopped || paused) return;
      paused = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stderr.write(`\r${ESC}2K\x1b[?25h`);
    },
    unpause: () => {
      if (stopped || !paused) return;
      paused = false;
      process.stderr.write(`\x1b[?25l`);
      process.stderr.write(frame());
      startTimer();
    },
  };
  return {
    stop: (final?: string) => {
      stop();
      if (final) err(final);
    },
  };
}

/**
 * Run an interactive read with the active spinner (if any) paused, so its
 * 80ms frame redraw cannot erase the question while the user answers.
 * No-op when no spinner is running. The spinner object is captured at
 * entry, so a `stop()` during the read cannot resurrect frames.
 */
export async function withoutSpinner<T>(fn: () => Promise<T>): Promise<T> {
  const spin = activeSpinner;
  if (!spin) return fn();
  spin.pause();
  try {
    return await fn();
  } finally {
    spin.unpause();
  }
}
