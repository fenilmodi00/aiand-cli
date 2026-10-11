import process from "node:process";
import { CliError, cancelled } from "./errors.js";
import { clipToWidth, style, visibleWidth } from "./output.js";
import { GLYPH } from "./ui/glyphs.js";
import { createTheme, hexTo256, type Theme } from "./ui/theme.js";

/**
 * Interactive prompt primitive: a space-to-toggle checkbox that drives a
 * shared raw-mode render/keypress loop and accepts injectable input/output
 * streams so it can be exercised without a real terminal.
 *
 * The focused row is a filled chip carrying a `▌` accent bar, the label in
 * bold, and the trailing hint right-aligned. The loop itself is unchanged —
 * injectable streams, Esc/q cancel, Ctrl-C restore.
 */

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";

const OK = "\u2713";

export const KEY = Object.freeze({
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  ESC: "\x1b",
  CTRL_C: "\x03",
  ENTER_CR: "\r",
  ENTER_LF: "\n",
  BACKSPACE_DEL: "\x7f",
  BACKSPACE_BS: "\b",
});

/** Terminal width when the stream reports none (non-TTY or a PTY saying 0). */
const FALLBACK_COLUMNS = 80;
/** Narrowest width a frame is clipped to, so labels stay readable. */
const MIN_COLUMNS = 20;
/** Rows visible at once before the list scrolls. */
const DEFAULT_PAGE_SIZE = 10;
/** Gutter in front of every row: the `▌` bar column. */
const ROW_GUTTER = "  ";

export type Choice = { value: string; label: string; hint?: string };

export interface PromptInput {
  isTTY: boolean;
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
  setEncoding(encoding: BufferEncoding): void;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  removeListener(event: "data", listener: (chunk: string) => void): unknown;
  removeListener(event: "end", listener: () => void): unknown;
}

export interface PromptOutput {
  write(chunk: string): void;
  columns?: number;
  rows?: number;
}

/** Buffers incomplete CSI sequences across input chunks. */
export function createKeyParser(): {
  push(chunk: string): string[];
  flush(): string[];
  hasPendingEsc(): boolean;
} {
  let pending = "";
  return {
    push(chunk: string): string[] {
      const text = pending + chunk;
      pending = "";
      const keys: string[] = [];
      let i = 0;
      while (i < text.length) {
        if (text[i] === "\x1b") {
          if (text[i + 1] === "[") {
            let j = i + 2;
            while (j < text.length && !(text[j]! >= "@" && text[j]! <= "~")) {
              j += 1;
            }
            if (j < text.length) {
              keys.push(text.slice(i, j + 1));
              i = j + 1;
            } else {
              pending = text.slice(i);
              return keys;
            }
          } else if (i === text.length - 1) {
            pending = "\x1b";
            return keys;
          } else {
            keys.push("\x1b");
            i += 1;
          }
        } else {
          keys.push(text[i]!);
          i += 1;
        }
      }
      return keys;
    },
    flush(): string[] {
      const keys: string[] = [];
      if (pending === "\x1b") {
        keys.push("\x1b");
      } else if (pending) {
        keys.push(...pending);
      }
      pending = "";
      return keys;
    },
    hasPendingEsc(): boolean {
      return pending === "\x1b";
    },
  };
}

/**
 * Raw-mode render/keypress loop shared by the prompts below.
 *
 * `renderLines()` returns the current frame; `onKey(seq)` mutates prompt state
 * and returns `{ done: true, value }` to finish, or nothing to re-render. The
 * frame is erased on completion — callers print their own one-line summary.
 * Ctrl-C restores the terminal and rejects with a 130 CliError, like every
 * other cancel, so callers' finally blocks still run.
 */
async function runPrompt<T>({
  input = process.stdin,
  output = process.stdout,
  renderLines,
  onKey,
}: {
  input?: PromptInput;
  output?: PromptOutput;
  renderLines: () => string[];
  onKey: (seq: string) => { done: true; value: T } | undefined;
}): Promise<T> {
  if (!input.isTTY) {
    throw new CliError("This prompt needs an interactive terminal.", {
      hint: "Pipe non-interactive input through flags or a config instead.",
    });
  }

  input.setRawMode(true);
  input.resume();
  output.write(HIDE_CURSOR);

  let prevLines = 0;
  let closed = false;

  const draw = () => {
    if (closed) return;
    // `||`, not `??`: a PTY can report columns as 0.
    const width = Math.max(MIN_COLUMNS, output.columns || FALLBACK_COLUMNS);
    const lines = renderLines().map((line) => clipToWidth(line, width));
    let frame = prevLines > 0 ? `\x1b[${prevLines}A\r` : "\r";
    frame += lines.map((line) => `${CLEAR_LINE}${line}`).join("\n");
    if (lines.length < prevLines) {
      const extra = prevLines - lines.length;
      frame += `\n${(`${CLEAR_LINE}\n`).repeat(extra - 1)}${CLEAR_LINE}\x1b[${extra}A`;
    }
    output.write(`${frame}\n`);
    prevLines = lines.length;
  };
  const erase = () => {
    if (prevLines > 0) {
      output.write(`\x1b[${prevLines}A\r\x1b[J`);
      prevLines = 0;
    }
  };
  const restoreTerminal = () => {
    output.write(SHOW_CURSOR);
    input.setRawMode(false);
    // Do not pause stdin: a later piped read (login --with-token) or
    // confirm() would hang on a paused stream. resume() is idempotent.
  };

  draw();

  try {
    const parser = createKeyParser();
    let escFlush: ReturnType<typeof setImmediate> | null = null;

    return await new Promise<T>((resolve, reject) => {
      const stop = () => {
        if (escFlush) {
          clearImmediate(escFlush);
          escFlush = null;
        }
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
      };

      const handleSeq = (seq: string): boolean => {
        if (seq === KEY.CTRL_C) {
          closed = true;
          stop();
          erase();
          output.write("^C\n");
          reject(cancelled());
          return true;
        }
        const result = onKey(seq);
        if (result?.done) {
          closed = true;
          stop();
          resolve(result.value);
          return true;
        }
        return false;
      };

      const flushPendingEsc = () => {
        for (const seq of parser.flush()) {
          if (handleSeq(seq)) {
            return;
          }
        }
        draw();
      };

      const onData = (chunk: string) => {
        if (escFlush) {
          clearImmediate(escFlush);
          escFlush = null;
        }
        for (const seq of parser.push(chunk)) {
          if (handleSeq(seq)) {
            return;
          }
        }
        if (parser.hasPendingEsc()) {
          escFlush = setImmediate(flushPendingEsc);
        } else {
          draw();
        }
      };

      const onEnd = () => {
        flushPendingEsc();
        if (closed) return;
        closed = true;
        stop();
        reject(
          new CliError("Input ended.", {
            hint: "This prompt needs an interactive terminal.",
          }),
        );
      };

      input.on("data", onData);
      input.on("end", onEnd);
    });
  } finally {
    closed = true;
    erase();
    restoreTerminal();
  }
}

function isEnter(seq: string): boolean {
  return seq === KEY.ENTER_CR || seq === KEY.ENTER_LF;
}

/** Visible slice of `items` keeping `index` inside a `pageSize` window. */
function windowFor(
  items: readonly unknown[],
  index: number,
  pageSize: number,
): { start: number; end: number } {
  if (items.length <= pageSize) {
    return { start: 0, end: items.length };
  }
  const start = Math.min(Math.max(0, index - Math.floor(pageSize / 2)), items.length - pageSize);
  return { start, end: start + pageSize };
}

/** The theme's focus-fill background SGR, or "" when color is off. */
function focusFill(theme: Theme): string {
  if (!theme.color) return "";
  if (theme.support === "truecolor") {
    const [r, g, b] = hexRgb(theme.palette.fill);
    return `\x1b[48;2;${r};${g};${b}m`;
  }
  return `\x1b[48;5;${hexTo256(theme.palette.fill)}m`;
}

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Focused-row chip: a `▌` accent bar, the label in bold, the trailing hint
 * right-aligned, all over the theme's focus fill.
 */
function focusedRow(theme: Theme, label: string, right: string, width: number): string {
  const bar = theme.hex(theme.palette.accent)(GLYPH.focusBar);
  const hint = right ? theme.muted(right) : "";
  const fill = focusFill(theme);
  const body = `${bar} ${theme.bold(label)}`;
  const gap = " ".repeat(Math.max(1, width - visibleWidth(body) - visibleWidth(hint) - 1));
  const inner = `${body}${gap}${hint}`;
  return fill ? `${fill}${inner}\x1b[49m\x1b[39m` : inner;
}

/** Renderable inner width, matching the loop's own clip width. */
function rowWidth(output: PromptOutput): number {
  return Math.max(MIN_COLUMNS, output.columns || FALLBACK_COLUMNS);
}

function renderRows<T>({
  items,
  index,
  pageSize,
  renderRow,
}: {
  items: readonly T[];
  index: number;
  pageSize: number;
  renderRow: (item: T, active: boolean, i: number) => string;
}): string[] {
  const { start, end } = windowFor(items, index, pageSize);
  const rows: string[] = [];
  if (start > 0) {
    rows.push(style.dim(`  ${GLYPH.up} ${start} more`));
  }
  for (let i = start; i < end; i += 1) {
    rows.push(renderRow(items[i] as T, i === index, i));
  }
  if (end < items.length) {
    rows.push(style.dim(`  ${GLYPH.down} ${items.length - end} more`));
  }
  return rows;
}

function summaryLine(output: PromptOutput, message: string, answer: string): void {
  output.write(`${style.cyan(OK)} ${message} ${style.bold(answer)}\n`);
}

function rowHint(choice: Choice): string {
  return choice.hint ?? "";
}

/**
 * Space-to-toggle multi-select over labeled choices. Enter confirms (an empty
 * selection is allowed — the caller decides how to handle it); Esc/q cancels
 * (null), so a cancel never reads as an empty selection.
 */
export async function promptCheckbox({
  message,
  choices,
  initial,
  pageSize = DEFAULT_PAGE_SIZE,
  input,
  output = process.stdout,
}: {
  message: string;
  choices: Choice[];
  initial?: string[];
  pageSize?: number;
  input?: PromptInput;
  output?: PromptOutput;
}): Promise<string[] | null> {
  if (choices.length === 0) {
    return [];
  }
  let index = 0;
  const checked = choices.map((choice) => Boolean(initial?.includes(choice.value)));

  const picked = (): string[] => choices.filter((_, i) => checked[i]).map((choice) => choice.value);

  const value = await runPrompt<string[] | null>({
    input,
    output,
    renderLines: () => [
      `${GLYPH.prompt} ${message}`,
      ...renderRows({
        items: choices,
        index,
        pageSize,
        renderRow: (choice, active, i) => {
          const box = checked[i] ? style.cyan(`[${OK}]`) : style.dim("[ ]");
          const hint = rowHint(choice);
          if (active) {
            return focusedRow(
              createTheme({ isTTY: true }),
              `${box} ${choice.label}`,
              hint,
              rowWidth(output),
            );
          }
          const body = `${ROW_GUTTER}${box} ${choice.label}`;
          return hint ? `${body}  ${style.dim(hint)}` : body;
        },
      }),
      style.dim("Space toggle · Enter confirm · Esc cancel"),
    ],
    onKey: (seq) => {
      if (seq === KEY.UP) {
        index = (index - 1 + choices.length) % choices.length;
      } else if (seq === KEY.DOWN) {
        index = (index + 1) % choices.length;
      } else if (seq === " ") {
        checked[index] = !checked[index];
      } else if (isEnter(seq)) {
        return { done: true, value: picked() };
      } else if (seq === KEY.ESC || seq === "q") {
        return { done: true, value: null };
      }
      return undefined;
    },
  });

  if (value === null) {
    return null;
  }
  const names = choices.filter((_, i) => checked[i]).map((choice) => choice.label);
  summaryLine(output, message, names.join(", "));
  return value;
}

/**
 * Single-select over labeled choices. Arrow keys move, Enter confirms (the
 * picked choice's value), Esc/q cancels (null). An empty choices array
 * returns null without entering the prompt loop.
 */
export async function promptSelect({
  message,
  choices,
  initial,
  pageSize = DEFAULT_PAGE_SIZE,
  input,
  output = process.stdout,
}: {
  message: string;
  choices: Choice[];
  initial?: string;
  pageSize?: number;
  input?: PromptInput;
  output?: PromptOutput;
}): Promise<string | null> {
  if (choices.length === 0) {
    return null;
  }
  let index = Math.max(
    0,
    choices.findIndex((choice) => choice.value === initial),
  );

  const value = await runPrompt<string | null>({
    input,
    output,
    renderLines: () => [
      `${GLYPH.prompt} ${message}`,
      ...renderRows({
        items: choices,
        index,
        pageSize,
        renderRow: (choice, active) => {
          const hint = rowHint(choice);
          if (active) {
            return focusedRow(createTheme({ isTTY: true }), choice.label, hint, rowWidth(output));
          }
          const body = `${ROW_GUTTER}${choice.label}`;
          return hint ? `${body}  ${style.dim(hint)}` : body;
        },
      }),
      style.dim("Enter confirm · Esc cancel"),
    ],
    onKey: (seq) => {
      if (seq === KEY.UP) {
        index = (index - 1 + choices.length) % choices.length;
      } else if (seq === KEY.DOWN) {
        index = (index + 1) % choices.length;
      } else if (isEnter(seq)) {
        return { done: true, value: choices[index]!.value };
      } else if (seq === KEY.ESC || seq === "q") {
        return { done: true, value: null };
      }
      return undefined;
    },
  });

  if (value === null) {
    return null;
  }
  summaryLine(output, message, choices[index]!.label);
  return value;
}
