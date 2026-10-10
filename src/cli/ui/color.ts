/**
 * Single color-enable policy for the UI layer. Honors NO_COLOR, FORCE_COLOR,
 * TERM=dumb, and TTY — per no-color.org and common Node/chalk conventions.
 * An empty `NO_COLOR` does not disable color (no-color.org: only a non-empty value does).
 */
export function colorsEnabled(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") {
    return true;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }
  if (env.TERM === "dumb") {
    return false;
  }
  return Boolean(stream?.isTTY);
}

/** How much color a terminal can show; "none" means styling is off entirely. */
export type ColorTier = "none" | "ansi256" | "truecolor";

const TRUECOLOR_TERM_PROGRAMS: Record<string, true> = {
  "iTerm.app": true,
  vscode: true,
  WezTerm: true,
  ghostty: true,
  Hyper: true,
  WarpTerminal: true,
  rio: true,
  tabby: true,
};

/**
 * Detect the terminal's color tier. Same signals as colorsEnabled plus the
 * truecolor probes (COLORTERM, known TERM_PROGRAMs, Windows Terminal, kitty).
 * FORCE_COLOR=2/1 gets the safe ansi256 floor — never raw truecolor escapes
 * on a terminal that did not ask for them.
 */
export function colorTier(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): ColorTier {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.FORCE_COLOR === "0" || env.FORCE_COLOR === "false") return "none";
  if (env.FORCE_COLOR) return env.FORCE_COLOR === "3" ? "truecolor" : "ansi256";
  if (!stream?.isTTY) return "none";
  if (env.TERM === "dumb") return "none";
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "truecolor";
  if (env.TERM_PROGRAM && TRUECOLOR_TERM_PROGRAMS[env.TERM_PROGRAM]) return "truecolor";
  if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.TERM?.includes("kitty")) return "truecolor";
  return "ansi256";
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** Nearest xterm-256 index: the 6×6×6 color cube or the 24-step gray ramp. */
function nearestAnsi256(r: number, g: number, b: number): number {
  const cube = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 35) / 40));
  const ri = cube(r);
  const gi = cube(g);
  const bi = cube(b);
  let best = 16 + 36 * ri + 6 * gi + bi;
  let bestDist =
    (r - CUBE_LEVELS[ri]!) ** 2 + (g - CUBE_LEVELS[gi]!) ** 2 + (b - CUBE_LEVELS[bi]!) ** 2;
  for (let i = 0; i < 24; i++) {
    const gray = 8 + 10 * i;
    const dist = (r - gray) ** 2 + (g - gray) ** 2 + (b - gray) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = 232 + i;
    }
  }
  return best;
}

/**
 * Foreground SGR open sequence for a hex color at a tier ("" at "none").
 * The caller closes with its own reset. On ansi256 the hex falls back to the
 * nearest cube/gray-ramp index — never a raw ESC[38;2 sequence.
 */
export function tierFg(tier: ColorTier, hex: string): string {
  if (tier === "none") return "";
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  if (tier === "truecolor") return `\x1b[38;2;${r};${g};${b}m`;
  return `\x1b[38;5;${nearestAnsi256(r, g, b)}m`;
}
