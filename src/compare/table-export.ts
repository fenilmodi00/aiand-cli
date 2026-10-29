/**
 * Table export serializers for the compare surfaces (ticket #135, plan §5 P3
 * "optional export of the compare table"). Pure string shaping: callers pass
 * plain headers, per-column alignment, and already-rendered cell text; the
 * serializers strip ANSI so colored terminal cells export clean while
 * preserving everything the cell carries — winners (▸), `n=` counts, em-dash
 * uncovered cells. The lane-B run table (Wilson CIs, cost/solve) reuses the
 * same two serializers when it lands.
 */

export type ExportAlign = "left" | "right";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Markdown pipe table (GitHub-flavored): header, alignment rule, body. */
export function toMarkdownTable(
  headers: readonly string[],
  aligns: readonly ExportAlign[],
  rows: readonly string[][],
): string[] {
  const strip = (s: string) => s.replace(ANSI_RE, "");
  const head = `| ${headers.map(strip).join(" | ")} |`;
  const rule = `|${aligns.map((a) => (a === "right" ? "---:" : "---")).join("|")}|`;
  const body = rows.map((cells) => `| ${cells.map(strip).join(" | ")} |`);
  return [head, rule, ...body];
}

/** Quote a cell for RFC 4180 CSV when it contains a comma, quote, or newline. */
function csvCell(s: string): string {
  const v = s.replace(ANSI_RE, "");
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV rows: one line per cell array, CRLF-safe, minimal quoting. */
export function toCsvRows(headers: readonly string[], rows: readonly string[][]): string[] {
  const lines = [headers.map(csvCell).join(",")];
  for (const cells of rows) lines.push(cells.map(csvCell).join(","));
  return lines;
}

/**
 * Export format for an `--out` path: explicit `--format` wins; otherwise the
 * file extension decides (.md/.markdown, .csv, .json) and anything else
 * defaults to markdown.
 */
export function inferExportFormat(
  filePath: string,
  explicit: string | undefined,
): "markdown" | "csv" | "json" {
  if (explicit !== undefined) return explicit as "markdown" | "csv" | "json";
  if (/\.csv$/i.test(filePath)) return "csv";
  if (/\.json$/i.test(filePath)) return "json";
  return "markdown";
}
