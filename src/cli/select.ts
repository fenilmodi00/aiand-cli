import process from "node:process";

import { style } from "../cli/output.js";
import { CliError } from "../cli/errors.js";

/**
 * Interactive prompt primitives: arrow-key single select, space-to-toggle
 * checkbox, and an incremental type-to-filter search. All three drive a shared
 * raw-mode render/keypress loop and accept injectable input/output streams so
 * they can be exercised without a real terminal.
 */

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";

const OK = "\u2713";
const POINTER = "\u203a";

export const KEY = Object.freeze({
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  RIGHT: "\x1b[C",
  LEFT: "\x1b[D",
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

/**
 * Split a raw input chunk into key sequences: CSI escape sequences (arrows,
 * etc.) come out whole; everything else char-by-char.
 */
export function* splitKeys(chunk: string): Generator<string> {
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "\x1b" && chunk[i + 1] === "[") {
      let j = i + 2;
      while (j < chunk.length && !(chunk[j]! >= "@" && chunk[j]! <= "~")) {
        j += 1;
      }
      if (j < chunk.length) {
        yield chunk.slice(i, j + 1);
        i = j + 1;
      } else {
        yield chunk.slice(i);
        break;
      }
    } else {
      yield chunk[i]!;
      i += 1;
    }
  }
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

function isBackspace(seq: string): boolean {
  return seq === KEY.BACKSPACE_DEL || seq === KEY.BACKSPACE_BS;
}

function isPrintable(seq: string): boolean {
  return seq.length === 1 && seq >= " " && seq !== "\x7f";
}

/** 1-based menu shortcut; returns the choice index or -1. */
function choiceIndexFromDigit(seq: string, length: number): number {
  if (seq.length !== 1 || seq < "1" || seq > "9") {
    return -1;
  }
  const idx = Number(seq) - 1;
  return idx < length ? idx : -1;
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
 * Arrow-key single select over labeled choices. Digits 1-9 pick directly;
 * Enter confirms the highlighted row; Esc/q cancels (returns empty string).
 */
export async function promptSelect({
  message,
  choices,
  pageSize = 10,
  initialIndex = 0,
  input,
  output = process.stdout,
}: {
  message: string;
  choices: Choice[];
  pageSize?: number;
  initialIndex?: number;
  input?: PromptInput;
  output?: PromptOutput;
}): Promise<string> {
  let index = Math.min(Math.max(0, initialIndex), Math.max(0, choices.length - 1));

  const value = await runPrompt<Choice | null>({
    input,
    output,
    renderLines: () => [
      style.bold(`${POINTER} ${message}`),
      ...renderRows({
        items: choices,
        index,
        pageSize,
        renderRow: (choice, active) =>
          active ? `${style.cyan(POINTER)} ${choice.label}` : `  ${choice.label}`,
      }),
      style.dim("↑/↓ move · 1-9 select · Enter confirm · Esc cancel"),
    ],
    onKey: (seq) => {
      if (seq === KEY.UP) {
        index = (index - 1 + choices.length) % choices.length;
      } else if (seq === KEY.DOWN) {
        index = (index + 1) % choices.length;
      } else if (isEnter(seq)) {
        return { done: true, value: choices[index] ?? null };
      } else {
        const picked = choiceIndexFromDigit(seq, choices.length);
        if (picked >= 0) {
          return { done: true, value: choices[picked] ?? null };
        }
      }
      if (seq === KEY.ESC || seq === "q") {
        return { done: true, value: null };
      }
      return undefined;
    },
  });

  if (value === null) {
    return "";
  }
  summaryLine(output, message, value.label);
  return value.value;
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

/**
 * Incremental type-to-filter select: printable keys narrow `items` live via
 * `filter`, arrows move, Enter picks the highlighted row. Returns the chosen
 * value, or empty string on Esc.
 */
export async function promptSearch<T>({
  message,
  items,
  filter,
  toChoice,
  pageSize = 10,
  input,
  output = process.stdout,
}: {
  message: string;
  items: T[];
  filter: (items: T[], term: string) => T[];
  toChoice: (item: T) => Choice;
  pageSize?: number;
  input?: PromptInput;
  output?: PromptOutput;
}): Promise<string> {
  let term = "";
  let index = 0;
  let matches = items;

  const refilter = () => {
    matches = filter(items, term);
    index = Math.min(index, Math.max(0, matches.length - 1));
  };

  const value = await runPrompt<T | null>({
    input,
    output,
    renderLines: () => {
      const lines = [style.bold(`${POINTER} ${message} ${term}${style.cyan("▏")}`)];
      if (matches.length === 0) {
        lines.push(style.dim("  (no matches — Backspace to widen)"));
      } else {
        lines.push(
          ...renderRows({
            items: matches,
            index,
            pageSize,
            renderRow: (item, active) => {
              const choice = toChoice(item);
              return active
                ? `${style.cyan(POINTER)} ${choice.label}`
                : `  ${choice.label}`;
            },
          })
        );
        const detail = toChoice(matches[index] as T).hint;
        if (detail) {
          lines.push(style.dim(`  ${detail}`));
        }
      }
      lines.push(style.dim("Type to filter · ↑/↓ move · Enter select · Esc cancel"));
      return lines;
    },
    onKey: (seq) => {
      if (seq === KEY.UP && matches.length > 0) {
        index = (index - 1 + matches.length) % matches.length;
      } else if (seq === KEY.DOWN && matches.length > 0) {
        index = (index + 1) % matches.length;
      } else if (isEnter(seq)) {
        if (matches.length > 0) {
          return { done: true, value: matches[index] ?? null };
        }
      } else if (seq === KEY.ESC) {
        return { done: true, value: null };
      } else if (isBackspace(seq)) {
        term = term.slice(0, -1);
        refilter();
      } else if (isPrintable(seq)) {
        term += seq;
        refilter();
      }
      return undefined;
    },
  });

  if (value === null) {
    return "";
  }
  const choice = toChoice(value);
  summaryLine(output, message, choice.label);
  return choice.value;
}