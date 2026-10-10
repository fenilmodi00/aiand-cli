import { colorTier, tierFg } from "./color.js";

/** SGR reset. */
const RESET = "\x1b[39m";

/** ai& brand — banner art and the theme accent (from aiand.com). */
const BRAND = {
  red: "#C70007",
} as const;

type StyleFn = (text: string) => string;

export type Theme = {
  color: boolean;
  brand: StyleFn;
  muted: StyleFn;
};

/**
 * Banner theme. Command tables still use cli/output.ts. The color tier (not
 * just on/off) decides the brand encoding, so an ansi256 terminal gets the
 * nearest cube color instead of raw truecolor escapes.
 */
export function createTheme(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Theme {
  const tier = colorTier(stream, env);

  if (tier === "none") {
    const plain: StyleFn = (text) => text;
    return { color: false, brand: plain, muted: plain };
  }

  const brandOpen = tierFg(tier, BRAND.red);
  return {
    color: true,
    brand: (text) => `${brandOpen}${text}${RESET}`,
    muted: (text) => `\x1b[2m${text}\x1b[22m`,
  };
}
