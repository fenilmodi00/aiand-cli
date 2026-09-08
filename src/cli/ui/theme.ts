import { colorsEnabled } from "./color.js";

/** Terminal reset for the banner theme (zero runtime deps). */
export const RESET = "\x1b[39m";

/** ai& brand — banner art and truecolor theme (from aiand.com). */
export const BRAND = {
  red: "#C70007",
  glow: "#D84D51",
  deep: "#7B0004",
  mid: "#A30006",
  rose: "#B19A9C",
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

export function dim(): StyleFn {
  return wrap("\x1b[2m", "\x1b[22m");
}

export function boldWhite(): StyleFn {
  return wrap("\x1b[1m\x1b[97m", `${RESET}\x1b[22m`);
}

export type Theme = {
  color: boolean;
  brand: StyleFn;
  muted: StyleFn;
  interactive: StyleFn;
  success: StyleFn;
  warn: StyleFn;
  error: StyleFn;
  heading: StyleFn;
  spark: StyleFn;
  burst: StyleFn;
  core: StyleFn;
  trail: StyleFn;
  ember: StyleFn;
  /** Open sequences for nested banner rendering (reopen after child close). */
  opens: Record<string, string>;
  symbols: {
    success: string;
    warn: string;
    error: string;
    info: string;
  };
};

/**
 * Banner-only truecolor theme. Command tables still use cli/output.ts.
 * Color on/off is decided solely by colorsEnabled(stream).
 */
export function createTheme(stream: { isTTY?: boolean } = process.stdout): Theme {
  const color = colorsEnabled(stream);

  if (!color) {
    const plain = (text: string) => text;
    return {
      color: false,
      brand: plain,
      muted: plain,
      interactive: plain,
      success: plain,
      warn: plain,
      error: plain,
      heading: plain,
      spark: plain,
      burst: plain,
      core: plain,
      trail: plain,
      ember: plain,
      opens: {},
      symbols: {
        success: "*",
        warn: "!",
        error: "x",
        info: ">",
      },
    };
  }

  const cyan = plainHex("#22D3EE");
  const yellow = plainHex("#EAB308");
  const red = plainHex("#EF4444");

  return {
    color: true,
    brand: plainHex(BRAND.red),
    muted: dim(),
    interactive: cyan,
    success: cyan,
    warn: yellow,
    error: red,
    heading: boldWhite(),
    spark: plainHex(BRAND.glow),
    burst: plainHex(BRAND.mid),
    core: boldWhite(),
    trail: plainHex(BRAND.deep),
    ember: plainHex(BRAND.rose),
    opens: {
      spark: fgHex(BRAND.glow),
      burst: fgHex(BRAND.mid),
      core: `\x1b[1m\x1b[97m`,
      trail: fgHex(BRAND.deep),
      ember: fgHex(BRAND.rose),
      brand: fgHex(BRAND.red),
      fuse: "\x1b[2m",
    },
    symbols: {
      success: "\u2713",
      warn: "!",
      error: "\u2717",
      info: "\u2192",
    },
  };
}