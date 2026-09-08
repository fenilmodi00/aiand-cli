import { EOL } from "node:os";

import { colorsEnabled } from "./ui/color.js";

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

export const style = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
};

export function out(line = ""): void {
  process.stdout.write(line + EOL);
}

export function err(line = ""): void {
  process.stderr.write(line + EOL);
}

export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + EOL);
}

const ANSI_RE = new RegExp(`\\x1b\\[[0-9;]*m`, "g");

const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1b000, 0x1b001], [0x1f200, 0x1f251],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
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
    Math.max(width(c.header), ...cells.map((r) => width(r[i] ?? "")))
  );

  if (columns.some((c) => c.header !== "")) {
    out(
      columns
        .map((c, i) => style.dim(pad(c.header.toUpperCase(), widths[i]!, c.align ?? "left")))
        .join("  ")
        .trimEnd()
    );
  }

  for (const row of cells) {
    out(
      row
        .map((cell, i) => pad(cell, widths[i]!, columns[i]!.align ?? "left"))
        .join("  ")
        .trimEnd()
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
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function spinner(text: string): { stop: (final?: string) => void } {
  if (!process.stderr.isTTY) {
    return { stop: (final?: string) => void (final && err(final)) };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    process.stderr.write(`\r${style.cyan(frames[i++ % frames.length]!)} ${text}`);
  }, 80);
  timer.unref();
  return {
    stop: (final?: string) => {
      clearInterval(timer);
      process.stderr.write(`\r${ESC}2K`);
      if (final) err(final);
    },
  };
}
