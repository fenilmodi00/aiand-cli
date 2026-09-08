import process from "node:process";

import { style } from "../cli/output.js";
import { CliError } from "../cli/errors.js";

/**
 * Interactive prompt primitive: a space-to-toggle checkbox that drives a
 * shared raw-mode render/keypress loop and accepts injectable input/output
 * streams so it can be exercised without a real terminal.
 */

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";

const OK = "\u2713";
const POINTER = "\u203a";

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
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Truncate to the terminal width; drops styling on lines that overflow. */
function fitWidth(line: string, width: number): string {
  const plain = stripAnsi(line);
  if (plain.length <= width) {
    return line;
  }
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

/** Buffers incomplete CSI sequences across input chunks. */
export function createKeyParser(): {
  hasPendingEsc(): boolean;
  push(chunk: string): string[];
  flush(): string[];
} {
  let pending = "";
  return {
    hasPendingEsc() {
      return pending === "\x1b";
    },
    push(chunk: string): string[] {
      const keys: string[] = [];
      const text = pending + chunk;
      pending = "";
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
    /** Flush a buffered lone Esc (or trailing bytes) at chunk/stream end. */
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
  };
}

/**
 * Raw-mode render/keypress loop shared by the prompts below.
 *
 * `renderLines()` returns the current frame; `onKey(seq)` mutates prompt state
 * and returns `{ done: true, value }` to finish, or nothing to re-render. The
 * frame is erased on completion — callers print their own one-line summary.
 * Ctrl-C restores the terminal and exits 130.
 */
export async function runPrompt<T>({
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
  input.setEncoding("utf8");
  output.write(HIDE_CURSOR);

  let prevLines = 0;
  let closed = false;

  const draw = () => {
    if (closed) return;
    // `|| 80`, not `?? 80` — a PTY can report columns as 0.
    const width = Math.max(20, output.columns || 80);
    const lines = renderLines().map((line) => fitWidth(line, width));
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
    input.pause();
  };

  draw();

  try {
    const parser = createKeyParser();
    let escFlush: ReturnType<typeof setImmediate> | null = null;

    return await new Promise<T>((resolve) => {
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
          restoreTerminal();
          output.write("^C\n");
          process.exit(130);
        }
        const result = onKey(seq);
        if (result?.done) {
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

      const onEnd = () => flushPendingEsc();

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
function windowFor(items: readonly unknown[], index: number, pageSize: number): { start: number; end: number } {
  if (items.length <= pageSize) {
    return { start: 0, end: items.length };
  }
  const start = Math.min(Math.max(0, index - Math.floor(pageSize / 2)), items.length - pageSize);
  return { start, end: start + pageSize };
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
    rows.push(style.dim(`  ↑ ${start} more`));
  }
  for (let i = start; i < end; i += 1) {
    rows.push(renderRow(items[i] as T, i === index, i));
  }
  if (end < items.length) {
    rows.push(style.dim(`  ↓ ${items.length - end} more`));
  }
  return rows;
}

function summaryLine(output: PromptOutput, message: string, answer: string): void {
  output.write(`${style.cyan(OK)} ${message} ${style.bold(answer)}\n`);
}

/**
 * Space-to-toggle multi-select over labeled choices. Enter confirms (an empty
 * selection is allowed — the caller decides how to handle it); Esc/q cancels
 * (returns empty array).
 */
export async function promptCheckbox({
  message,
  choices,
  initial,
  pageSize = 10,
  input,
  output = process.stdout,
}: {
  message: string;
  choices: Choice[];
  initial?: string[];
  pageSize?: number;
  input?: PromptInput;
  output?: PromptOutput;
}): Promise<string[]> {
  let index = 0;
  const checked = choices.map(
    (choice) => Boolean(initial && initial.includes(choice.value))
  );

  const picked = (): string[] =>
    choices.filter((_, i) => checked[i]).map((choice) => choice.value);

  const value = await runPrompt<string[] | null>({
    input,
    output,
    renderLines: () => [
      style.bold(`${POINTER} ${message}`),
      ...renderRows({
        items: choices,
        index,
        pageSize,
        renderRow: (choice, active, i) => {
          const box = checked[i] ? style.cyan(`[${OK}]`) : style.dim("[ ]");
          return active
            ? `${style.cyan(POINTER)} ${box} ${choice.label}`
            : `  ${box} ${choice.label}`;
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
    return [];
  }
  const names = choices.filter((_, i) => checked[i]).map((choice) => choice.label);
  summaryLine(output, message, names.join(", "));
  return value;
}
