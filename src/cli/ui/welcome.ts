import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../../fsutil.js";
import type { PromptInput, PromptOutput } from "../select.js";
import { normalizeBannerArt, renderBannerLine } from "./banner-render.js";
import { BANNER_ART } from "./banners/art.js";
import { createTheme } from "./theme.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const REDRAW = "\x1b[H\x1b[2J";

/** Cadence after TogetherLink's welcome: hold, slide, gap, sparkle, wordmark. */
const HOLD_MS = 500;
const SLIDE_MS = 150;
const GAP_MS = 220;
const SPARKLE_MS = 220;
const WORDMARK_MS = 900;
const SLIDE_STEPS = 7;

/** Two blocks sliding toward the center; the gap closes two columns a step. */
function slideArt(step: number): string {
  const row = `██${" ".repeat(16 - step * 2)}██`;
  return `${row}\n${row}`;
}

/**
 * First-run welcome animation on an alt screen: block slides resolve into the
 * ai& wordmark. Any input byte skips instantly. Returns when done or skipped;
 * on a non-TTY it returns immediately having written nothing.
 */
export async function playWelcome(
  opts: { input?: PromptInput; output?: PromptOutput & { isTTY?: boolean } } = {},
): Promise<void> {
  const input: PromptInput = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) return;
  if (process.env.AIAND_NO_WELCOME === "1") return;

  const theme = createTheme(output);
  const wordmark = normalizeBannerArt(BANNER_ART)
    .split("\n")
    .map((line) => renderBannerLine(line, theme))
    .join("\n");
  const frames: Array<[string, number]> = [];
  for (let step = 0; step < SLIDE_STEPS; step++) {
    frames.push([slideArt(step), step === 0 ? HOLD_MS : SLIDE_MS]);
  }
  frames.push(["", GAP_MS]);
  frames.push([theme.brand("  ✦ ✦ ✦  "), SPARKLE_MS]);
  frames.push([wordmark, WORDMARK_MS]);

  let skip = false;
  let wake: (() => void) | null = null;
  const onData = (): void => {
    skip = true;
    wake?.();
  };
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (skip) return resolve();
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  input.setRawMode(true);
  input.resume();
  input.on("data", onData);
  try {
    output.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
    for (const [art, ms] of frames) {
      if (skip) break;
      output.write(`${REDRAW}${art}\n`);
      await wait(ms);
    }
  } finally {
    wake = null;
    input.removeListener("data", onData);
    input.setRawMode(false);
    // Never pause stdin: the launcher menu's raw-mode loop resumes it next.
    output.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  }
}

const STATE_FILE = "state.json";

/** First run only: false once state.json records the welcome as played. */
export function shouldPlayWelcome(stateDir: string): boolean {
  try {
    const state = JSON.parse(readFileSync(join(stateDir, STATE_FILE), "utf8")) as Record<
      string,
      unknown
    >;
    return state.welcome !== 1;
  } catch {
    return true;
  }
}

/** Record the welcome as played, merging into any existing state.json keys. */
export function markWelcomePlayed(stateDir: string): void {
  try {
    const statePath = join(stateDir, STATE_FILE);
    let state: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        state = parsed as Record<string, unknown>;
      }
    } catch {
      // No readable state yet — start a fresh one.
    }
    mkdirSync(stateDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    writeFileSync(statePath, `${JSON.stringify({ ...state, welcome: 1 })}\n`, {
      mode: PRIVATE_FILE_MODE,
    });
  } catch {
    // Best-effort: a state write failure must never block the launcher.
  }
}
