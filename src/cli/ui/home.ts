/**
 * The ai& home screen: brand header with the two status dots, then titled
 * sections of `command  description` rows aligned on one column, then notes.
 * Width-aware, so a narrow terminal drops the aligned description to an
 * indented second line rather than overflowing.
 */
import { visibleWidth } from "../output.js";
import { createTheme, type Theme } from "./theme.js";

/** One `command  description` row. */
type HomeRow = [command: string, description: string];

type HomeSection = { title: string; rows: HomeRow[] };

export type HomeModel = {
  brand: string;
  version?: string;
  tagline?: string;
  sections: HomeSection[];
  notes?: string[];
};

/** Two-space indent, the row gutter. */
const GUTTER = "  ";
/** Cap on the aligned command column. */
const MAX_COMMAND_WIDTH = 34;
/** Narrowest width a row is laid out at before wrapping. */
const MIN_COLUMNS = 24;
/** Widest home screen; beyond this the layout stops centering usefully. */
const MAX_HOME_COLUMNS = 100;

/**
 * Renderable width. A PTY that reports 0 (or absurdly few) columns falls back
 * to the 80-column default, the same convention the prompt loop uses.
 */
function columns(terminalColumns: number | undefined): number {
  const width = terminalColumns && terminalColumns >= MIN_COLUMNS ? terminalColumns : 80;
  return Math.max(MIN_COLUMNS, Math.min(MAX_HOME_COLUMNS, width));
}

function header(theme: Theme, model: HomeModel, width: number): string[] {
  // The brand name is printed as a two-tone wordmark, not two status dots.
  const brand = model.brand ?? "";
  const split = Math.ceil(visibleWidth(brand) / 2);
  const line = `${theme.brand(brand.slice(0, split))}${theme.accent(brand.slice(split))}`;
  const version = model.version ? theme.muted(`v${model.version}`) : "";
  const gap = " ".repeat(Math.max(1, width - visibleWidth(line) - visibleWidth(version) - 2));
  const rows = ["", `${line}${gap}${version}`];
  if (model.tagline) rows.push(theme.muted(model.tagline));
  return rows.map((entry) => GUTTER + entry);
}

function sectionLines(theme: Theme, section: HomeSection, width: number): string[] {
  const commandWidth = Math.max(...section.rows.map(([command]) => visibleWidth(command)), 0);
  const gutter = Math.min(commandWidth, MAX_COMMAND_WIDTH);
  const aligned = gutter + 5 <= width;

  const lines: string[] = ["", GUTTER + theme.accent(section.title)];
  for (const [command, description] of section.rows) {
    if (
      aligned &&
      visibleWidth(command) <= gutter &&
      gutter + 5 + visibleWidth(description) <= width
    ) {
      const filler = " ".repeat(Math.max(0, gutter - visibleWidth(command)));
      lines.push(`${GUTTER}${command}${filler}   ${theme.muted(description)}`);
      continue;
    }
    lines.push(`${GUTTER}${theme.bold(command)}`);
    for (const wrapped of wrapText(description, width - gutter - 5)) {
      lines.push(`${GUTTER}${" ".repeat(Math.min(gutter + 3, 8))}${theme.muted(wrapped)}`);
    }
  }
  return lines;
}

function noteLines(theme: Theme, notes: string[], width: number): string[] {
  const lines: string[] = [];
  for (const note of notes) {
    lines.push("");
    for (const wrapped of wrapText(note, width)) lines.push(`${GUTTER}${theme.muted(wrapped)}`);
  }
  return lines;
}

/** Render the home screen to a string. */
export function renderHome(
  model: HomeModel,
  options: { theme?: Theme; columns?: number } = {},
): string {
  const theme = options.theme ?? createTheme(process.stdout);
  const width = columns(options.columns ?? process.stdout.columns ?? 80);

  const lines: string[] = header(theme, model, width);
  for (const section of model.sections) {
    lines.push(...sectionLines(theme, section, width));
  }
  if (model.notes?.length) {
    lines.push(...noteLines(theme, model.notes, width));
  }
  return lines.join("\n");
}

/** Wrap plain text to a visible width, breaking on spaces. */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current === "") {
      current = word;
    } else if (visibleWidth(`${current} ${word}`) <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}
