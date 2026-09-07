/** Truecolor / SGR helpers for the banner theme (zero runtime deps). */

export const RESET = "\x1b[39m";

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const raw = hex.replace("#", "");
  const n = Number.parseInt(raw, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function fgHex(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export type StyleFn = (text: string) => string;

function wrap(open: string, close: string): StyleFn {
  return (text) => `${open}${text}${close}`;
}

export function plainHex(hex: string): StyleFn {
  return wrap(fgHex(hex), RESET);
}

export function dim(): StyleFn {
  return wrap("\x1b[2m", "\x1b[22m");
}

export function boldWhite(): StyleFn {
  return wrap("\x1b[1m\x1b[97m", `${RESET}\x1b[22m`);
}
