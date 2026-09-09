import { colorsEnabled } from "./color.js";

/** Terminal reset for the banner theme (zero runtime deps). */
export const RESET = "\x1b[39m";

/** ai& brand — banner art and truecolor theme (from aiand.com). */
export const BRAND = {
  red: "#C70007",
} as const;

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

export type Theme = {
  color: boolean;
  brand: StyleFn;
  muted: StyleFn;
};

/**
 * Banner-only truecolor theme. Command tables still use cli/output.ts.
 * Color on/off is decided solely by colorsEnabled(stream).
 */
export function createTheme(stream: { isTTY?: boolean } = process.stdout): Theme {
  const color = colorsEnabled(stream);

  if (!color) {
    const plain = (text: string) => text;
    return { color: false, brand: plain, muted: plain };
  }

  return {
    color: true,
    brand: plainHex(BRAND.red),
    muted: wrap("\x1b[2m", "\x1b[22m"),
  };
}