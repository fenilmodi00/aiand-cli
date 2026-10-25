import process from "node:process";
import { CliError, cancelled } from "./errors.js";
import { clipToWidth, ellipsize, padEnd, visibleWidth } from "./output.js";
import { createKeyParser, type PromptInput, type PromptOutput } from "./select.js";
import { GLYPH } from "./ui/glyphs.js";
import { createTheme, hexTo256, type Theme } from "./ui/theme.js";

/**
 * Interactive menu: a brand header, a search bar that filters by label and
 * keyword, grouped rows with shortcut and state text, a detail line under a
 * rule for the focused item, a scrolling window, and a footer of key
 * hints.
 *
 * Built on the same raw-mode render/keypress loop as the checkbox and
 * single-select prompts, with injectable streams so it can be exercised
 * without a real terminal.
 */

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";

/** Terminal width when the stream reports none (non-TTY or a PTY saying 0). */
const FALLBACK_COLUMNS = 80;
/** Narrowest width a frame is clipped to, so labels stay readable. */
const MIN_COLUMNS = 24;
/** Cap on the layout width, keeping frames readable on wide terminals. */
const MAX_COLUMNS = 100;
/** Gutter in front of every row. */
const GUTTER = "  ";
/** Width reserved for the trailing shortcut/hint column. */
const MAX_LABEL_WIDTH = 34;
/** Gap between the label and its inline hint. */
const LABEL_GAP = "   ";

type MenuState = { text: string; tone: "neutral" | "success" | "warning" | "danger" };

export type MenuItem = {
  value: string;
  label: string;
  /** Group heading this row renders under; a row with no group is skipped. */
  group?: string;
  /** Trailing muted text on the row. */
  hint?: string;
  /** Small badge appended to the label, e.g. "beta". */
  badge?: string;
  /** The command suggested in the shortcut column. */
  shortcut?: string;
  /** Status text plus its tone, rendered right-aligned in warning/success. */
  state?: MenuState;
  /** Extra search terms beyond the label. */
  keywords?: readonly string[];
  /** Detail line shown under the rule while this row is focused. */
  detail?: string;
};

type MenuBrand = { name: string; tagline?: string; version?: string };

export type MenuPrompt = {
  message?: string;
  brand?: MenuBrand;
  items: MenuItem[];
  /** Rows visible at once; the menu itself scrolls within this budget. */
  rows?: number;
  input?: PromptInput;
  output?: PromptOutput;
};

const searchPlaceholder = "Type to search agents and apps";

export const KEY = {
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  ENTER_CR: "\r",
  ENTER_LF: "\n",
  CTRL_C: "\x03",
  ESC: "\x1b",
  BACKSPACE_DEL: "\x7f",
  BACKSPACE_BS: "\b",
  TAB: "\t",
};

/** Whether a key is a printable character that enters the search query. */
function isTypeable(seq: string): boolean {
  if (seq.length !== 1) return false;
  const cp = seq.codePointAt(0) ?? 0;
  // Letters, numbers, and the punctuation a query accepts.
  return /^[\p{L}\p{N} ._-]$/u.test(seq) && cp > 0x20 && cp !== 0x7f;
}

/** Every word of a string, lowercased, for search matching. */
function words(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Rows matching `query`. A query matches when every one of its words appears
 * in the row's searchable text — the label, its group, hint, badge, and
 * keywords — either as a substring of any of them or as a word prefix.
 */
function filterItems(items: MenuItem[], query: string): MenuItem[] {
  const terms = words(query);
  if (terms.length === 0) return items;
  return items.filter((item) => {
    const haystacks = [
      item.label,
      item.group ?? "",
      item.hint ?? "",
      item.badge ?? "",
      item.shortcut ?? "",
      ...(item.keywords ?? []),
    ];
    return terms.every((term) =>
      haystacks.some(
        (hay) => hay.toLowerCase().includes(term) || words(hay).some((w) => w.startsWith(term)),
      ),
    );
  });
}

/** Wrap `index` into `[0, length)`, so movement wraps at both ends. */
function wrap(index: number, length: number): number {
  if (length === 0) return 0;
  return (index + length) % length;
}

/** One row of the menu, with the optional interleaved heading. */
type Row = { text: string; item?: number };

/** Rows rendered as visible text, with group headings interleaved. */
function buildRows(
  items: MenuItem[],
  selected: number,
  columns: number,
  query: string,
  theme: Theme,
): Row[] {
  const labelWidth = Math.min(
    MAX_LABEL_WIDTH,
    items.reduce(
      (widest, item) =>
        Math.max(widest, visibleWidth(`${item.label}${item.badge ? ` ${item.badge}` : ""}`)),
      0,
    ),
  );
  const rows: Row[] = [];
  let previousGroup: string | undefined;

  items.forEach((item, index) => {
    if (!item.group) return;
    if (item.group !== previousGroup) {
      // A blank line separates the groups.
      if (rows.length > 0) rows.push({ text: "" });
      rows.push({ text: `${GUTTER}${muted(item.group)}` });
      previousGroup = item.group;
    }
    rows.push({
      text: rowText(item, index === selected, labelWidth, columns, query, theme),
      item: index,
    });
  });
  return rows;
}

function rowText(
  item: MenuItem,
  focused: boolean,
  labelWidth: number,
  columns: number,
  query: string,
  theme: Theme,
): string {
  const label = `${item.label}${item.badge ? ` ${item.badge}` : ""}`;
  // A label wider than the aligned column is clipped with an ellipsis, so
  // the trailing columns never shift.
  const shown = ellipsize(label, labelWidth);
  // The trailing column carries the state text when there is one, else the
  // shortcut. A state is colored by tone; a shortcut is muted.
  const trailing = item.state
    ? (item.state.tone === "warning"
        ? theme.warning
        : item.state.tone === "success"
          ? theme.success
          : item.state.tone === "danger"
            ? theme.danger
            : muted)(item.state.text)
    : (item.shortcut ?? "");
  // The hint sits inline beside the label, right-aligned to its column.
  const hintSpace = columns - 2 - labelWidth - 3 - visibleWidth(trailing) - 2;
  const hint = item.hint && hintSpace > 3 ? ellipsize(item.hint, hintSpace) : "";
  const head = `${GUTTER}${padEnd(shown, labelWidth)}${hint ? `${LABEL_GAP}${muted(hint)}` : ""}`;
  // The trailing state or shortcut sits flush right, so every row's command
  // lands in one column.
  const body = focused
    ? focusedLabel(highlight(shown, query), hint, labelWidth, trailing, columns)
    : flushRight(head, trailing, columns);
  return body.replace(/\s+$/u, "");
}

/** The focused row: an accent bar, bold label, hint inline, trailing right. */
function focusedLabel(
  label: string,
  hint: string,
  labelWidth: number,
  trailing: string,
  columns: number,
): string {
  const theme = createTheme({ isTTY: true });
  const bar = theme.hex(theme.palette.accent)(GLYPH.focusBar);
  const padded = padEnd(label, labelWidth);
  const right = trailing ? muted(trailing) : "";
  const left = hint ? `${padded}   ${muted(hint)}` : padded;
  const gap = " ".repeat(Math.max(1, columns - visibleWidth(left) - visibleWidth(right) - 4));
  const inner = `${bar} ${bold(left)}${gap}${right}`;
  const fill = focusFill(theme);
  return fill ? `${fill}${inner}\x1b[49m\x1b[39m` : inner;
}

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

/** Highlight the matched substring in the accent color. */
function highlight(label: string, query: string): string {
  const terms = words(query);
  if (terms.length === 0) return label;
  const theme = createTheme({ isTTY: true });
  let out = label;
  for (const term of terms) {
    const at = label.toLowerCase().indexOf(term);
    if (at < 0) continue;
    const head = label.slice(0, at);
    const match = label.slice(at, at + term.length);
    const tail = label.slice(at + term.length);
    out = `${head}${theme.hex(theme.palette.accent)(match)}${tail}`;
    break;
  }
  return out;
}

function flushRight(head: string, trailing: string, columns: number): string {
  const spaces = " ".repeat(Math.max(1, columns - visibleWidth(head) - visibleWidth(trailing)));
  return `${head}${spaces}${trailing}`;
}

/**
 * The brand header: the wordmark in the two ai& reds, the version flush
 * right on the same line, and the tagline under two status dots.
 */
function header(theme: Theme, brand: MenuBrand, columns: number): string[] {
  // The caller may pass either "0.6.0" or "v0.6.0"; render exactly one "v".
  const version = brand.version ? muted(`v${brand.version.replace(/^v/, "")}`) : "";
  const gap = " ".repeat(
    Math.max(1, columns - GUTTER.length - visibleWidth(brand.name) - visibleWidth(version) - 1),
  );
  // The wordmark opens the list, in brand red on the accent orange. If the
  // tagline already names the brand, drop the repeat and keep the sentence.
  const rows = ["", `${GUTTER}${wordmark(brand.name, theme)}${gap}${version}`];
  // The wordmark already names the product, so the tagline only adds what it
  // does not say.
  if (brand.tagline) {
    rows.push(`${GUTTER}${muted(brand.tagline)}`);
  }
  return rows;
}

/**
 * The wordmark as a two-tone logo: the first half in the deep ai& red and
 * the second half in the bright stop, like the wordmark's own gradient.
 */
function wordmark(name: string, theme: Theme): string {
  const split = Math.ceil(name.length / 2);
  return `${theme.brand(name.slice(0, split))}${theme.accent(name.slice(split))}`;
}

/**
 * The search bar: a prompt glyph in the accent color, the query with a block
 * cursor, the match count at the right. With no query
 * and no message heading the list, it shows the placeholder instead.
 */
function searchBar(query: string, matched: number, total: number, message?: string): string {
  const count = query ? muted(`${matched} of ${total}`) : "";
  const inner = Math.max(4, MAX_COLUMNS - 10 - visibleWidth(count));
  const shown =
    visibleWidth(query) > inner ? `${GLYPH.ellipsis}${query.slice(-(inner - 1))}` : query;
  if (query) {
    return `${GUTTER}${accent(GLYPH.prompt)} ${muted(shown)}${accent(GLYPH.cursor)}${count ? `  ${count}` : ""}`;
  }
  // A message already heads the list, so the bar stays out of the way.
  return message ? "" : `${GUTTER}${accent(GLYPH.prompt)} ${muted(searchPlaceholder)}`;
}

/** The footer of key hints. */
function footer(hasQuery: boolean): string {
  const parts = [
    `${GLYPH.up}${GLYPH.down} move`,
    "enter open",
    ...(hasQuery ? ["esc clear"] : ["type to search", "esc quit"]),
  ];
  return `${GUTTER}${muted(parts.join("   "))}`;
}

/** Slice `rows` so `selected` stays inside a `rows`-budget window. */
function window(
  rows: Row[],
  selected: number,
  budget: number,
): { start: number; end: number; above: number; below: number } {
  if (rows.length <= budget) {
    return { start: 0, end: rows.length, above: 0, below: 0 };
  }
  // One centered window that always contains the focused row: the start is
  // clamped to both ends, which needs no corrective re-anchoring.
  const itemIndex = rows.findIndex((row) => row.item === selected);
  const keep = budget - 2;
  const centered = itemIndex - Math.floor(keep / 2);
  const start = Math.max(0, Math.min(centered, rows.length - keep));
  const end = Math.min(rows.length, start + keep);
  const above = rows.slice(0, start).filter((row) => row.item !== undefined).length;
  const below = rows.slice(end).filter((row) => row.item !== undefined).length;
  return { start, end, above, below };
}

/**
 * The full frame for the current state, as one string. `all` is the menu's own
 * filtered item list — ungrouped rows are gone before it gets here — so the
 * count and the search both agree on what is on the screen.
 */
function render(
  prompt: MenuPrompt,
  all: MenuItem[],
  state: { query: string; selected: number },
  rows: number,
): string[] {
  const theme = createTheme({ isTTY: true });
  const columns = Math.max(
    MIN_COLUMNS,
    Math.min(MAX_COLUMNS, prompt.output?.columns || FALLBACK_COLUMNS),
  );
  const shown = filterItems(all, state.query);
  const focused = shown[state.selected];
  const list = buildRows(shown, state.selected, columns, state.query, theme);

  const head = prompt.brand
    ? header(theme, prompt.brand, columns)
    : [`${GUTTER}${bold(prompt.message ?? "")}`];
  const bar = [searchBar(state.query, shown.length, all.length, prompt.message)];

  // The message replaces the search placeholder while there is no query, so
  // the bar reads as one line rather than two stacked prompts.
  const message = prompt.message
    ? [`${GUTTER}${theme.hex(theme.palette.accent)(GLYPH.prompt)} ${bold(prompt.message)}`]
    : [];

  const detail =
    focused?.detail !== undefined
      ? [muted("\u2500".repeat(Math.max(0, columns - 2))), `${GUTTER}${muted(focused.detail)}`]
      : [];

  const foot = [footer(state.query !== "")];

  const empty = [`${GUTTER}${muted(`No matches for "${state.query}"`)}`];

  // The chrome around the list — header, message, search bar, detail, footer —
  // takes fixed lines, so the list gets whatever is left of the row budget.
  const chrome = head.length + message.length + bar.length + detail.length + foot.length + 4;
  const budget = Math.max(3, rows - chrome);

  const visibleRows =
    shown.length === 0
      ? empty
      : (() => {
          const w = window(list, state.selected, budget);
          const lines = w.start > 0 ? [`${GUTTER}${muted(`${GLYPH.up} ${w.above} more`)}`] : [];
          for (let i = w.start; i < w.end; i += 1) lines.push(list[i]!.text);
          if (w.below > 0) lines.push(`${GUTTER}${muted(`${GLYPH.down} ${w.below} more`)}`);
          return lines;
        })();

  return ["", ...head, "", ...message, ...bar, "", ...detail, "", ...visibleRows, "", ...foot];
}

/**
 * Run the menu. Enter resolves with `{ cancelled: false, value }`; Esc/q
 * resolves `null`; Ctrl-C rejects with a 130 CliError. The loop leaves the
 * terminal as it found it.
 */
export async function promptMenu(prompt: MenuPrompt): Promise<string | null> {
  const input = (prompt.input ?? process.stdin) as PromptInput;
  const output = (prompt.output ?? process.stdout) as PromptOutput;
  const items = prompt.items.filter((item) => Boolean(item.group));

  if (items.length === 0) return null;

  if (!input.isTTY) {
    throw new CliError("This prompt needs an interactive terminal.", {
      hint: "Pass a flag instead, or run it in a terminal.",
    });
  }

  let query = "";
  let selected = 0;
  // `||`, not `??`: a PTY can report 0 rows, which means "unknown" here.
  const rows = prompt.rows ?? Math.max(6, Math.min(30, output.rows || 20));

  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  output.write(HIDE_CURSOR);

  let prevLines = 0;
  let closed = false;

  const draw = (): void => {
    if (closed) return;
    const width = Math.max(MIN_COLUMNS, output.columns || FALLBACK_COLUMNS);
    const lines = render(prompt, items, { query, selected }, rows).map((line) =>
      clipToWidth(line, width),
    );
    let frame = prevLines > 0 ? `\x1b[${prevLines}A\r` : "\r";
    frame += lines.map((line) => `${CLEAR_LINE}${line}`).join("\n");
    if (lines.length < prevLines) {
      const extra = prevLines - lines.length;
      frame += `\n${(`${CLEAR_LINE}\n`).repeat(extra - 1)}${CLEAR_LINE}\x1b[${extra}A`;
    }
    output.write(`${frame}\n`);
    prevLines = lines.length;
  };
  const erase = (): void => {
    if (prevLines > 0) {
      output.write(`\x1b[${prevLines}A\r\x1b[J`);
      prevLines = 0;
    }
  };

  draw();

  try {
    const parser = createKeyParser();
    let escFlush: ReturnType<typeof setImmediate> | null = null;

    return await new Promise<string | null>((resolve, reject) => {
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

        const shown = filterItems(items, query);

        if (seq === KEY.ESC) {
          if (query) {
            query = "";
            selected = 0;
            return false;
          }
          closed = true;
          stop();
          resolve(null);
          return true;
        }

        if (seq === KEY.ENTER_CR || seq === KEY.ENTER_LF) {
          const picked = shown[selected];
          // No matches under the current query: Enter is a no-op, not a quit.
          if (!picked) return false;
          closed = true;
          stop();
          resolve(picked.value);
          return true;
        }

        if (seq === KEY.UP) {
          selected = wrap(selected - 1, shown.length);
        } else if (seq === KEY.DOWN || seq === KEY.TAB) {
          selected = wrap(selected + 1, shown.length);
        } else if (seq === KEY.BACKSPACE_DEL || seq === KEY.BACKSPACE_BS) {
          query = query.slice(0, -1);
          selected = 0;
        } else if (/^[1-9]$/.test(seq)) {
          const index = Number(seq) - 1;
          if (index < shown.length) selected = index;
        } else if (isTypeable(seq)) {
          query += seq;
          selected = 0;
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

      const onData = (chunk: string): void => {
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
    output.write(SHOW_CURSOR);
    input.setRawMode(false);
  }
}

// --- style helpers ----------------------------------------------------------

const themeCache = createTheme({ isTTY: true });

const bold = (text: string) => themeCache.bold(text);
const muted = (text: string) => themeCache.muted(text);
const accent = (text: string) => themeCache.accent(text);
