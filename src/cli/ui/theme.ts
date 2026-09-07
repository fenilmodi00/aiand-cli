import { colorsEnabled } from "./color.js";
import { BRAND } from "./tokens.js";
import { boldWhite, dim, fgHex, plainHex, type StyleFn } from "./ansi.js";

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
