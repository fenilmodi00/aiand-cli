import { colorsEnabled } from "./color.js";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dimFaint: "\x1b[2m",
  muted: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  orange: "\x1b[38;5;208m",
} as const;

let enabled = colorsEnabled();

/** Whether styling is currently active (test hook + help coloring). */
export function isStyleEnabled(): boolean {
  return enabled;
}

/** Test hook: force styling on/off regardless of the ambient terminal. */
export function _setColorEnabled(value: boolean): void {
  enabled = Boolean(value);
}

function wrap(open: string, close: string) {
  return (text: string) => (enabled ? `${open}${text}${close}` : String(text));
}

export const bold = wrap(ANSI.bold, "\x1b[22m");
export const dim = wrap(ANSI.dimFaint, "\x1b[22m");
export const muted = wrap(ANSI.muted, "\x1b[39m");
export const red = wrap(ANSI.red, "\x1b[39m");
export const yellow = wrap(ANSI.yellow, "\x1b[39m");
export const cyan = wrap(ANSI.cyan, "\x1b[39m");
export const orange = wrap(ANSI.orange, "\x1b[39m");

export function accent(text: string, stream?: { isTTY?: boolean }): string {
  const useColor = stream === undefined ? enabled : colorsEnabled(stream);
  return useColor ? `${ANSI.cyan}${text}\x1b[39m` : String(text);
}

function unicodeOk(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform === "win32") {
    return false;
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/i.test(locale);
}

const glyphs = unicodeOk()
  ? { ok: "\u2713", fail: "\u2717", warn: "!", bullet: "\u2022", pointer: "\u203a" }
  : { ok: "ok", fail: "x", warn: "!", bullet: "*", pointer: ">" };

export const symbols = Object.freeze(glyphs);

export function ok(message: string): string {
  return `${cyan(symbols.ok)} ${message}`;
}

export function fail(message: string): string {
  return `${red(symbols.fail)} ${message}`;
}

export function warn(message: string): string {
  return `${yellow(symbols.warn)} ${message}`;
}

export function yesNo(value: boolean): string {
  return value ? cyan("yes") : red("no");
}

/** Cyan success glyph, stream-gated like the rest of the layer. */
export function check(stream: { isTTY?: boolean } = process.stdout): string {
  return enabled || colorsEnabled(stream) ? cyan(symbols.ok) : symbols.ok;
}

/**
 * Paint raw text with an open sequence when the stream takes color,
 * otherwise return it untouched.
 */
export function paint(
  openSeq: string,
  text: string,
  stream: { isTTY?: boolean } = process.stdout
): string {
  return colorsEnabled(stream) ? `${openSeq}${text}${ANSI.reset}` : text;
}
