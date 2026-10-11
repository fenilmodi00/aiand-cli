/**
 * ai& brand theme for the ai& CLI.
 *
 * Palette is the ai& brand system: the red gradient #EF2635 → #E2091A →
 * #C70007, graphite #303037 → #151517, and warm neutrals for fills. Truecolor when the stream supports it,
 * xterm-256 otherwise, and plain text under NO_COLOR — a three-tier
 * capability ladder.
 */
import { colorsEnabled } from "./color.js";

const RESET = "\x1b[39m";
/** SGR reset for bold/dim attributes (22 = normal intensity). */
const ATTR_RESET = "\x1b[22m";

type Palette = {
  /** The anchor red from the ai& wordmark: the wordmark and splash title. */
  brand: string;
  /** The gradient's bright stop: menu chrome, focus bars, search highlights. */
  accent: string;
  /** ai& graphite: the filled chip behind a focused row. */
  fill: string;
  success: string;
  warning: string;
  danger: string;
  /** White: the first half of the splash title. */
  title: string;
  /** Mid stop of the red gradient: the splash burst ring and logo stamps. */
  dagger: string;
  /** Dim gray: the "press any key to skip" hint. */
  hint: string;
};

/** Terminal-facing dark palette: the ai& reds and graphite. */
const DARK_PALETTE: Palette = {
  brand: "#C70007",
  accent: "#EF2635",
  fill: "#303037",
  success: "#8BD5A0",
  warning: "#F0B660",
  danger: "#FF7F79",
  title: "#FFFFFF",
  dagger: "#E2091A",
  hint: "#8A8F98",
};

/** Light terminal palette, same roles, shifted for contrast on light bg. */
const LIGHT_PALETTE: Palette = {
  brand: "#C70007",
  accent: "#E2091A",
  fill: "#EEE9E9",
  success: "#1A7F37",
  warning: "#9A6700",
  danger: "#CF222E",
  title: "#151517",
  dagger: "#E2091A",
  hint: "#4C5160",
};

const XTERM_STEPS = [0, 95, 135, 175, 215, 255];

type ColorSupport = "truecolor" | "256" | "none";

/** Resolve how much color the stream carries, in order of evidence. */
function colorSupport(env: NodeJS.ProcessEnv = process.env): ColorSupport {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  const forced = env.FORCE_COLOR;
  if (forced === "0" || forced === "false") return "none";
  if (forced === "3" || env.COLORTERM?.toLowerCase() === "truecolor") return "truecolor";
  if (env.COLORTERM?.toLowerCase() === "24bit") return "truecolor";
  // Anything else, FORCE_COLOR included, is treated as a 256-color terminal.
  return "256";
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function truecolor(hex: string, ground: 38 | 48): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[${ground};2;${r};${g};${b}m`;
}

/** Nearest xterm-256 index for a hex color (6×6×6 cube, then grayscale). */
export function hexTo256(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  const nearest = (channel: number): number =>
    XTERM_STEPS.reduce(
      (best, step, i) =>
        Math.abs(step - channel) < Math.abs(XTERM_STEPS[best]! - channel) ? i : best,
      0,
    );
  const [ri, gi, bi] = [nearest(r), nearest(g), nearest(b)];
  const cubeDistance =
    (XTERM_STEPS[ri]! - r) ** 2 + (XTERM_STEPS[gi]! - g) ** 2 + (XTERM_STEPS[bi]! - b) ** 2;
  const gray = Math.round((r + g + b) / 3);
  const grayIndex = Math.max(0, Math.min(23, Math.round((gray - 8) / 10)));
  const grayLevel = 8 + grayIndex * 10;
  const grayDistance = (grayLevel - r) ** 2 + (grayLevel - g) ** 2 + (grayLevel - b) ** 2;
  return grayDistance < cubeDistance ? 232 + grayIndex : 16 + 36 * ri + 6 * gi + bi;
}

type StyleFn = (text: string) => string;

/** Theme bound to one stream: colors, palette, and every style helper. */
export type Theme = {
  color: boolean;
  support: ColorSupport;
  palette: Palette;
  brand: StyleFn;
  accent: StyleFn;
  muted: StyleFn;
  bold: StyleFn;
  success: StyleFn;
  warning: StyleFn;
  danger: StyleFn;
  /** Foreground by palette role. */
  fg: (role: keyof Palette) => StyleFn;
  /** Foreground for a literal hex, for art that carries its own colors. */
  hex: (color: string) => StyleFn;
};

const NOCOLOR = (text: string): string => text;

/**
 * Bind a theme to a stream. Light vs dark is chosen from COLORFGBG (the
 * terminal's own background) with an explicit AIAND_THEME override.
 */
export function createTheme(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Theme {
  const support = colorSupport(env);
  const color = colorsEnabled(stream, env) && support !== "none";
  const dark = isDarkBackground(env);
  const palette = dark ? DARK_PALETTE : LIGHT_PALETTE;

  if (!color) {
    return {
      color: false,
      support,
      palette,
      brand: NOCOLOR,
      accent: NOCOLOR,
      muted: NOCOLOR,
      bold: NOCOLOR,
      success: NOCOLOR,
      warning: NOCOLOR,
      danger: NOCOLOR,
      fg: () => NOCOLOR,
      hex: () => NOCOLOR,
    };
  }

  const wrapFg =
    (hex: string): StyleFn =>
    (text) =>
      `${paint(hex, 38, support)}${text}${RESET}`;
  const brand = wrapFg(palette.brand);
  return {
    color: true,
    support,
    palette,
    brand,
    accent: wrapFg(palette.accent),
    muted: (text) => `${ATTR_DIM}${text}${ATTR_RESET}`,
    bold: (text) => `${ATTR_BOLD}${text}${ATTR_RESET}`,
    success: wrapFg(palette.success),
    warning: wrapFg(palette.warning),
    danger: wrapFg(palette.danger),
    fg: (role) => wrapFg(palette[role]),
    hex: wrapFg,
  };
}

const ATTR_BOLD = "\x1b[1m";
const ATTR_DIM = "\x1b[2m";

function paint(hex: string, ground: 38 | 48, support: ColorSupport): string {
  if (support === "truecolor") return truecolor(hex, ground);
  return `\x1b[${ground};5;${hexTo256(hex)}m`;
}

/** COLORFGBG's background slot; >=9 or 7 means light. */
function isDarkBackground(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.AIAND_THEME?.trim().toLowerCase();
  if (override === "light") return false;
  if (override === "dark") return true;
  const raw = env.COLORFGBG?.split(";").at(-1);
  const bg = raw === undefined ? Number.NaN : Number(raw);
  if (Number.isInteger(bg)) return bg !== 7 && bg < 9;
  return true;
}
