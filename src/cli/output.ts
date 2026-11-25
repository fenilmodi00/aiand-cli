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

/**
 * An ESC-introduced string (OSC, DCS, SOS, PM, APC) that has not ended after
 * this many characters is abandoned, so one unterminated sequence cannot
 * swallow the rest of a stream.
 */
const MAX_STRING_LENGTH = 4096;

const BEL = 0x07;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const CAN = 0x18;
const SUB = 0x1a;
const ESC_CODE = 0x1b;
const DEL = 0x7f;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

function isBidiControl(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

export type SanitizeOptions = {
  /** Fold newlines and tabs to spaces: table cells, fields, labels, one-line notes. */
  singleLine?: boolean;
};

type SanitizerState = "ground" | "esc" | "escIntermediate" | "csi" | "string" | "stringEsc";

/**
 * Stateful terminal sanitiser for text a server or model controls. `push()`
 * returns what is safe to print now and holds back only a partial escape
 * sequence, a trailing CR, or a trailing high surrogate, so a sequence or a
 * character split across stream chunks is still removed or printed whole.
 * `flush()` ends the stream.
 *
 * Removed: every ESC- or C1-introduced sequence (CSI, OSC to BEL or ST,
 * DCS/SOS/PM/APC to ST, two-character ESC sequences), C0 controls other than
 * LF and TAB, DEL, the C1 range, and the bidi embedding/override/isolate
 * controls (Trojan Source). CR survives only as part of CRLF; a lone CR is
 * printed as LF, because a bare CR returns the cursor so later text can
 * overwrite what came before it, and dropping it instead would run two lines
 * together. Every printable code point, combining marks, ZWJ and variation
 * selectors included, passes through unchanged.
 *
 * A string sequence opened with ESC ends at its terminator, at CAN, SUB or
 * LF, or after MAX_STRING_LENGTH characters, and prints none of itself. The
 * 8-bit introducers of a string (U+0090, U+0098, U+009D to U+009F) are dropped
 * as single code points and open no state: they turn up as stray bytes in
 * mojibake (`â€\u009d`), where a state would swallow everything after them.
 */
export class TerminalSanitizer {
  private state: SanitizerState = "ground";
  private pendingCr = false;
  private pendingHighSurrogate = "";
  private stringLength = 0;
  private readonly singleLine: boolean;

  constructor(options: SanitizeOptions = {}) {
    this.singleLine = options.singleLine ?? false;
  }

  push(chunk: string): string {
    let out = "";
    for (let i = 0; i < chunk.length; i += 1) {
      out += this.step(chunk.charCodeAt(i), chunk[i]!);
    }
    return out;
  }

  flush(): string {
    let out = this.pendingCr ? this.newline() : "";
    out += this.pendingHighSurrogate;
    this.pendingCr = false;
    this.pendingHighSurrogate = "";
    this.state = "ground";
    this.stringLength = 0;
    return out;
  }

  private newline(): string {
    return this.singleLine ? " " : "\n";
  }

  private step(code: number, ch: string): string {
    if (this.pendingHighSurrogate) {
      const high = this.pendingHighSurrogate;
      this.pendingHighSurrogate = "";
      if (isLowSurrogate(code)) return high + ch;
      return high + this.step(code, ch);
    }
    switch (this.state) {
      case "esc":
        return this.afterEsc(code, ch);
      case "escIntermediate":
        if (code >= 0x20 && code <= 0x2f) return "";
        this.state = "ground";
        return code >= 0x30 && code <= 0x7e ? "" : this.ground(code, ch);
      case "csi":
        return this.inCsi(code, ch);
      case "string":
        return this.inString(code, ch);
      case "stringEsc":
        if (code === 0x5c) {
          this.state = "ground";
          return "";
        }
        this.state = "esc";
        return this.afterEsc(code, ch);
      default:
        return this.ground(code, ch);
    }
  }

  private inString(code: number, ch: string): string {
    if (code === ESC_CODE) {
      this.state = "stringEsc";
      return "";
    }
    if (code === LF) {
      this.state = "ground";
      return this.ground(code, ch);
    }
    this.stringLength += 1;
    if (
      code === BEL ||
      code === C1_ST ||
      code === CAN ||
      code === SUB ||
      this.stringLength >= MAX_STRING_LENGTH
    ) {
      this.state = "ground";
    }
    return "";
  }

  private afterEsc(code: number, ch: string): string {
    if (code === 0x5b) {
      this.state = "csi";
      return "";
    }
    if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
      this.state = "string";
      this.stringLength = 0;
      return "";
    }
    if (code === ESC_CODE) return "";
    if (code >= 0x20 && code <= 0x2f) {
      this.state = "escIntermediate";
      return "";
    }
    this.state = "ground";
    if (code >= 0x30 && code <= 0x7e) return "";
    return this.ground(code, ch);
  }

  private inCsi(code: number, ch: string): string {
    if (code >= 0x20 && code <= 0x3f) return "";
    this.state = "ground";
    return code >= 0x40 && code <= 0x7e ? "" : this.ground(code, ch);
  }

  private ground(code: number, ch: string): string {
    let prefix = "";
    if (this.pendingCr) {
      this.pendingCr = false;
      if (code === LF) return this.singleLine ? " " : "\r\n";
      prefix = this.newline();
    }
    if (code === CR) {
      this.pendingCr = true;
      return prefix;
    }
    if (code === LF) return prefix + this.newline();
    if (code === TAB) return prefix + (this.singleLine ? " " : "\t");
    if (code === ESC_CODE) {
      this.state = "esc";
      return prefix;
    }
    if (code === C1_CSI) {
      this.state = "csi";
      return prefix;
    }
    if (code < 0x20 || code === DEL || (code >= 0x80 && code <= 0x9f) || isBidiControl(code)) {
      return prefix;
    }
    if (isHighSurrogate(code)) {
      this.pendingHighSurrogate = ch;
      return prefix;
    }
    return prefix + ch;
  }
}

/**
 * Make server- or model-supplied text safe to print to a terminal (see
 * TerminalSanitizer for what is removed). Use for anything a person reads:
 * table cells, fields, prompt labels, error messages. `--json` output needs
 * none of this; JSON.stringify already escapes every control character.
 */
export function sanitizeForTerminal(text: string, options: SanitizeOptions = {}): string {
  const sanitizer = new TerminalSanitizer(options);
  return sanitizer.push(text) + sanitizer.flush();
}

/** One line, unstyled: a server string bound for a table cell, field, label, or note. */
export function safeLine(text: string): string {
  return sanitizeForTerminal(text, { singleLine: true });
}

/** Dim stderr notes built from text a server or an adapter may quote: one safe line each. */
export function printNotes(lines: readonly string[], indent = ""): void {
  for (const line of lines) err(style.dim(`${indent}${safeLine(line)}`));
}

/**
 * Text plus the `style` function to paint it with. Table and field cells take
 * these instead of pre-styled strings: the text is sanitised whole and only
 * then painted, so the escapes in a cell are always the styling layer's, and
 * none at all when styling is off (piped output, NO_COLOR).
 */
export type Styled = { readonly text: string; readonly paint: (text: string) => string };

export const styled = (paint: (text: string) => string, text: string): Styled => ({ text, paint });

/** A cell is plain text, painted text, or a run of both (`name (id)` with a dim id). */
export type CellValue = string | Styled | (string | Styled)[];

export function renderCell(value: CellValue): string {
  if (Array.isArray(value)) return value.map(renderCell).join("");
  if (typeof value === "object" && value !== null && typeof value.paint === "function") {
    return value.paint(safeLine(String(value.text)));
  }
  return safeLine(String(value));
}

/**
 * Writer for streamed model output: sanitises when `stream` is a terminal and
 * passes bytes through untouched when it is a pipe or file, so `aiand run >
 * out.txt` keeps exactly what the model sent.
 */
export function streamWriter(stream: NodeJS.WriteStream): {
  write(text: string, decorate?: (s: string) => string): void;
  /** Flush a held sequence, CR or surrogate, then end the line if output did not. */
  endLine(): void;
} {
  const sanitizer = stream.isTTY ? new TerminalSanitizer() : null;
  // A pipe gets the model's bytes untouched, but a surrogate pair cut between
  // two chunks must still reach it whole, or each half is written as U+FFFD.
  let heldHigh = "";
  let last = "";
  const emit = (text: string, decorate: (s: string) => string) => {
    if (!text) return;
    stream.write(decorate(text));
    last = text.slice(-1);
  };
  const passThrough = (text: string): string => {
    const whole = heldHigh + text;
    const tail = whole.charCodeAt(whole.length - 1);
    heldHigh = isHighSurrogate(tail) ? whole.slice(-1) : "";
    return heldHigh ? whole.slice(0, -1) : whole;
  };
  return {
    write(text, decorate = (s) => s) {
      emit(sanitizer ? sanitizer.push(text) : passThrough(text), decorate);
    },
    endLine() {
      emit(sanitizer?.flush() ?? heldHigh, (s) => s);
      heldHigh = "";
      if (last && last !== "\n") stream.write("\n");
      last = "";
    },
  };
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
  value: (row: T) => CellValue;
  align?: "left" | "right";
};

/** Cells print on one line and are sanitised before they are painted, so a
 * server string cannot break the layout or reach the terminal as a control sequence. */
export function table<T>(rows: T[], columns: Column<T>[]): void {
  if (rows.length === 0) return;
  const headers = columns.map((c) => renderCell(c.header.toUpperCase()));
  const cells = rows.map((row) => columns.map((c) => renderCell(c.value(row))));
  const widths = columns.map((_, i) =>
    Math.max(width(headers[i]!), ...cells.map((r) => width(r[i] ?? ""))),
  );

  if (headers.some((h) => h !== "")) {
    out(
      columns
        .map((c, i) => style.dim(pad(headers[i]!, widths[i]!, c.align ?? "left")))
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

export function fields(pairs: [string, CellValue][]): void {
  const keyWidth = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    out(`${style.dim(pad(k, keyWidth, "left"))}  ${renderCell(v)}`);
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

export function delta(current: number, previous: number): Styled {
  if (previous === 0) {
    return current === 0 ? styled(style.dim, "--") : styled(style.green, "new");
  }
  const pct = ((current - previous) / previous) * 100;
  const label = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  return styled(pct >= 0 ? style.green : style.red, label);
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
