/**
 * First-run splash, the intro animation for a fresh install:
 *
 *   1. openingHold 500ms — the runner block sits at the far left, the
 *      gradient logo at the far right, "press any key to skip" at the bottom.
 *   2. runStep 150ms × 7 — the runner travels left→center while the logo
 *      travels right→center, on every frame interpolated by t/7.
 *   3. impactStep 220ms × 2 — the two collide into a `✦` burst, small then big.
 *   4. titleHold — the wordmark in white with the second half in the ai& red,
 *      the title card.
 *
 * Any keypress skips it. A non-TTY, CI, `--json`, or NO_COLOR run renders a
 * single still frame instead; nothing throws.
 */
import { GLYPH } from "./glyphs.js";
import { createTheme, type Theme } from "./theme.js";

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CLEAR = "\x1b[H\x1b[2J";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** Frame timings. */
const OPENING_HOLD_MS = 500;
const RUN_STEP_MS = 150;
const IMPACT_STEP_MS = 220;
const TITLE_HOLD_MS = 900;

/** Total run frames. */
const RUN_FRAMES = 7;

/** Grid rows and the narrowest width the splash draws. */
const GRID_ROWS = 14;
const MIN_COLUMNS = 24;

/** The runner block: 10 wide, 5 tall, two alternating stride frames. */
const RUNNER = [
  ["  ██████  ", "  █ ███ █  ", "████████████", "  ██████  ", "  █ █ █ █ "],
  ["  ██████  ", "  █ ███ █  ", "████████████", "  ██████  ", " █ █ █ █  "],
];

/**
 * The logo mark: the ai& mark stamped three times, one per stop of the red
 * gradient, offset by the ported columns (+9, +5, +4 rows).
 */
const LOGO = [" ▄██▄ ", "██████", " ▀██▀ "];

/** The two impact frames: the burst ring grows between them. */
const BURST_FRAMES = [
  ["   · ✦ ·", " ✦ ▄██▄ ✦", "· ██████ ·", " ✦ ▀██▀ ✦", "   · ✦ ·"],
  ["     ✦", "  · ✦✦ ·", " ✦ ▄██▄ ✦", "  · ✦✦ ·", "     ✦"],
];

/** Row the runner and logo travel on, and the row the title lands on. */
const MARK_ROW = 1;
const TITLE_ROW = 3;
/** Row the skip hint sits on. */
const HINT_ROW = 12;

/**
 * 5-row block font, extended with the glyphs ai& needs so the title reads as
 * one wordmark.
 */
const FONT: Record<string, string[]> = {
  A: [" ███ ", "█   █", "█████", "█   █", "█   █"],
  I: ["█████", "  █  ", "  █  ", "  █  ", "█████"],
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  D: ["████ ", "█   █", "█   █", "█   █", "████ "],
  C: [" ████", "█    ", "█    ", "█    ", " ████"],
  L: ["█    ", "█    ", "█    ", "█    ", "█████"],
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
  O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
  G: [" ███ ", "█    ", "█ ███", "█   █", " ███ "],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  H: ["█   █", "█   █", "█████", "█   █", "█   █"],
  R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
};

/** Palette role names a cell may carry. */
type CellColor = "brand" | "dagger" | "accent" | "hint" | "title";

type Cell = { char: string; color?: CellColor };

/** Terminal surface the splash needs; satisfied by process/std streams. */
interface SplashStream {
  isTTY?: boolean;
  columns?: number;
  write?: (data: string) => boolean;
}

interface SplashInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  on?: (event: string, listener: (chunk: unknown) => void) => void;
  removeListener?: (event: string, listener: (chunk: unknown) => void) => void;
}

export type SplashOptions = {
  /** First word of the title; the second rides the accent color. */
  title?: [first: string, second: string];
  version?: string;
  stdin?: SplashInput;
  stdout?: SplashStream;
  /** Skip the animation but still render the still title. */
  animation?: boolean;
  /** Bypass width snapping for a fixed-width render (used by tests). */
  columns?: number;
};

function grid(columns: number): Cell[][] {
  return Array.from({ length: GRID_ROWS }, () =>
    Array.from({ length: columns }, (): Cell => ({ char: " " })),
  );
}

function stamp(canvas: Cell[][], art: string, col: number, row: number, color?: CellColor): void {
  art.split("\n").forEach((line, r) => {
    [...line].forEach((char, c) => {
      if (char === " ") return;
      const target = canvas[row + r]?.[col + c];
      if (target) {
        target.char = char;
        if (color) target.color = color;
      }
    });
  });
}

/** Render a word in the block font. */
function renderWord(word: string): string {
  const rows = Array.from({ length: 5 }, () => "");
  for (const char of word.toUpperCase()) {
    const glyph = FONT[char];
    if (!glyph) continue;
    for (let r = 0; r < 5; r += 1) rows[r] = `${rows[r]} ${glyph[r]}`;
  }
  return rows.join("\n").trim();
}

function widest(art: string): number {
  return art
    .split("\n")
    .map((line) => line.length)
    .reduce((a, b) => Math.max(a, b), 0);
}

/**
 * Paint the grid to an ANSI string, coalescing runs by color, which avoids a
 * reset between adjacent same-color cells.
 */
function paint(canvas: Cell[][], theme: Theme): string {
  if (!theme.color) {
    return canvas
      .map((row) =>
        row
          .map((cell) => cell.char)
          .join("")
          .replace(/\s+$/u, ""),
      )
      .join("\n");
  }
  return canvas
    .map((row) => {
      let out = "";
      let open: CellColor | undefined;
      for (const cell of row) {
        const next = cell.color;
        if (next !== open) {
          if (open) out += "\x1b[39m";
          out += next ? theme.fg(next)(cell.char) : cell.char;
          open = next;
        } else {
          out += cell.char;
        }
      }
      if (open) out += "\x1b[39m";
      return out.replace(/\s+$/u, "");
    })
    .join("\n");
}

/** A run frame: the runner and logo at their interpolated columns for step `t`. */
function runFrame(columns: number, step: number, title: [string, string], theme: Theme): string {
  const canvas = grid(columns);
  const half = Math.max(12, Math.floor(columns / 2));
  const progress = step / RUN_FRAMES;
  const runnerCol = Math.round(Math.max(0, half - 10) * progress);
  const logoStart = Math.max(16, columns - 15);
  const logoCol = Math.round(logoStart + (half - logoStart) * progress);

  stamp(canvas, RUNNER[step % RUNNER.length]!.join("\n"), runnerCol, MARK_ROW, "brand");
  stamp(canvas, LOGO.join("\n"), logoCol, MARK_ROW, "accent");
  stamp(canvas, LOGO.join("\n"), logoCol + 9, MARK_ROW, "dagger");
  stamp(canvas, LOGO.join("\n"), logoCol + 5, MARK_ROW + 3, "brand");
  stamp(canvas, hint(title), 0, HINT_ROW, "hint");
  return paint(canvas, theme);
}

/** The impact burst. `big` picks the wider frame. */
function burstFrame(columns: number, big: boolean, title: [string, string], theme: Theme): string {
  const canvas = grid(columns);
  stamp(
    canvas,
    BURST_FRAMES[big ? 1 : 0]!.join("\n"),
    Math.max(0, Math.floor(columns / 2) - 7),
    MARK_ROW,
    "dagger",
  );
  stamp(canvas, hint(title), 0, HINT_ROW, "hint");
  return paint(canvas, theme);
}

/** The title card: `first` in white, `second` in the accent color. */
function titleFrame(
  columns: number,
  title: [string, string],
  version: string | undefined,
  theme: Theme,
): string {
  const canvas = grid(columns);
  const first = renderWord(title[0]);
  const second = renderWord(title[1]);
  const gap = 2;
  const totalWide = widest(first) + gap + widest(second);
  const at = Math.max(0, Math.floor((columns - totalWide) / 2));
  stamp(canvas, first, at, TITLE_ROW, "title");
  stamp(canvas, second, at + widest(first) + gap, TITLE_ROW, "brand");
  if (version) {
    const label = `v${version}`;
    stamp(
      canvas,
      label,
      Math.max(0, Math.floor((columns - label.length) / 2)),
      TITLE_ROW + 8,
      "hint",
    );
  }
  return paint(canvas, theme);
}

/** Bottom-left skip hint. */
function hint(title: [string, string]): string {
  return `press any key to skip  ${GLYPH.ellipsis} ${title[0].toLowerCase()} ${title[1].toLowerCase()}`.trim();
}

/**
 * Play the first-run splash. Resolves on the last frame or on any keypress,
 * whichever comes first. Any failure degrades to the still title.
 */
export async function playSplash(options: SplashOptions = {}): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const animate = options.animation ?? true;
  const title = options.title ?? ["ai", "and"];

  const columns =
    options.columns ??
    Math.max(
      MIN_COLUMNS,
      Math.min(72, (stdout.columns && stdout.columns >= MIN_COLUMNS ? stdout.columns : 74) - 2),
    );
  const theme = createTheme(stdout);

  const still = (): void => {
    stdout.write?.(`${titleFrame(columns, title, options.version, theme)}\n`);
  };

  // No terminal to animate on, or color off: one still title frame.
  if (!stdin.isTTY || !stdout.isTTY || !animate || !theme.color) {
    still();
    return;
  }

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    stdin.removeListener?.("data", onData);
    try {
      stdin.setRawMode?.(false);
    } catch {
      // Raw-mode restore is best-effort: a closed stdin throws on some pty drivers.
    }
    stdout.write?.(`${SHOW_CURSOR}${ALT_OFF}`);
  };

  /** One gate for the whole run: a keypress resolves the current hold. */
  let current: (() => void) | null = null;
  let skipped = false;
  const skip = (): void => {
    skipped = true;
    current?.();
  };
  const onData = (): void => skip();

  stdout.write?.(`${ALT_ON}${HIDE_CURSOR}`);
  stdin.on?.("data", onData);

  const draw = (frame: string): void => {
    stdout.write?.(`${CLEAR}${frame}`);
  };
  const hold = (ms: number): Promise<void> => {
    if (skipped) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    // Ref'd: during the splash nothing else keeps the loop alive.
    const timer = setTimeout(() => {
      current = null;
      resolve();
    }, ms);
    current = () => {
      clearTimeout(timer);
      resolve();
    };
    return promise;
  };

  try {
    draw(runFrame(columns, 0, title, theme));
    await hold(OPENING_HOLD_MS);
    for (let step = 1; step <= RUN_FRAMES; step += 1) {
      if (skipped) return;
      draw(runFrame(columns, step, title, theme));
      await hold(RUN_STEP_MS);
    }
    if (skipped) return;
    draw(burstFrame(columns, false, title, theme));
    await hold(IMPACT_STEP_MS);
    if (skipped) return;
    draw(burstFrame(columns, true, title, theme));
    await hold(IMPACT_STEP_MS);
    if (skipped) return;
    draw(titleFrame(columns, title, options.version, theme));
    await hold(TITLE_HOLD_MS);
  } catch {
    still();
  } finally {
    restore();
  }
}
