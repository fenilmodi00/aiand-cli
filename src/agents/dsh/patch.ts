/**
 * Surgical edits to the two dsh files that carry aiand routing: the home-level
 * patch layer (`$DSH_HOME/cordis.patch.yml`) and the credential store
 * (`$DSH_HOME/.credentials.yaml`).
 *
 * Both files can hold the user's own content, so edits splice one row or one
 * credential key at a time instead of re-rendering the document: every other
 * row, comment, blank line and quoting style survives byte for byte. That also
 * keeps aiand out of dsh's YAML dialect entirely — a profile layer may carry
 * `!!js` expressions, and a parser that re-renders one would change what the
 * user booted. dsh rewrites the credential file itself (comment-preserving,
 * its own keys only) and never writes the home patch layer, which is why the
 * ownership marker can live there safely.
 *
 * Only the subset our own writes produce is read back; anything else inside a
 * row we own is a loud SyntaxError, never a silent mis-parse. A double-quoted
 * scalar follows the YAML 1.2 escape table, so a `\x41` or `\_` another tool
 * wrote reads as its character — a bad escape is that same loud SyntaxError,
 * never the raw backslashes.
 *
 * The readers that prove which rows aiand owns — and that hand them back to
 * the user — live here too, since every row shape is read by this module and
 * nowhere else. The row ids, marker and banner that identify our rows are the
 * caller's to name: this module reads shapes, never aiand's vocabulary.
 */
import { isRoutableBaseUrl } from "../../config.js";
import { DSH_BANNER } from "./rows.js";

/** One top-level row of a patch list: the `- ` line through the line before
 * the next top-level row. Comments and blanks outside a range belong to the file. */
export type RowBlock = { from: number; to: number; lines: string[] };

/** Every top-level row of a patch document, in order. Row lines drop a
 * trailing `\r` — a hand-edited or Windows-written file keeps its CRLFs in
 * the text (splices write byte-for-byte through `from`/`to`), but the
 * parsers read one shape. Block scalar bodies are text, not structure:
 * their lines leave the readable set (the splice range keeps them), so a
 * `x-aiand: true` inside someone's `script: |` never reads as our marker.
 * A tab in indentation or a second document marker is a shape this reader
 * refuses: a loud SyntaxError, never a silent mis-parse. */
function findRows(text: string): RowBlock[] {
  const lines = text.split("\n");
  // A leading BOM is legal YAML; it must not hide the first row from the
  // reader (an invisible row means on appends a duplicate dsh refuses at
  // boot). A splice that replaces line 0 drops the BOM — harmless.
  if (lines[0]?.startsWith("\uFEFF")) lines[0] = lines[0].slice(1);
  const rows: RowBlock[] = [];
  let i = 0;
  // A leading `---` opens the one document this reader knows; the same
  // marker after rows starts a second one, which this reader refuses.
  // Comments and blanks before it are the document's own prologue: a
  // `# my patch` above the marker is legal YAML, not a second document.
  while (i < lines.length) {
    const plain = stripCr(lines[i]!);
    if (plain === "---" || plain === "" || plain.trim().startsWith("#")) i += 1;
    else break;
  }
  while (i < lines.length) {
    const line = stripCr(lines[i]!);
    if (line === "---" || line === "...") {
      throw new SyntaxError(`a second document starts at line ${i + 1}`);
    }
    if (line === "-" || line.startsWith("- ")) {
      let to = i + 1;
      while (to < lines.length) {
        const next = stripCr(lines[to]!);
        if (next === "-" || next.startsWith("- ")) break;
        if (next === "---" || next === "...") {
          throw new SyntaxError(`a second document starts at line ${to + 1}`);
        }
        to += 1;
      }
      rows.push({ from: i, to, lines: readableLines(lines.slice(i, to)) });
      i = to;
    } else {
      i += 1;
    }
  }
  return rows;
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** A row's structural lines: CRLFs dropped, block scalar bodies removed,
 * tab-indented lines and document markers refused. */
function readableLines(raw: string[]): string[] {
  const kept: string[] = [];
  let blockIndent = -1;
  for (const line of raw.map(stripCr)) {
    const trimmed = line.trim();
    if (blockIndent >= 0) {
      if (trimmed === "" || leadingSpaces(line) > blockIndent) continue;
      blockIndent = -1;
    }
    if (/^[ ]*\t/.test(line)) {
      throw new SyntaxError("a tab indents a line, which YAML forbids");
    }
    if (/^(?:[ ]*(?:-\s+)?)?[\w.@-]+:\s*[|>][-+\d]*(\s+.*)?$/.test(line)) {
      blockIndent = leadingSpaces(line);
    }
    kept.push(line);
  }
  return kept;
}

/** Whether a line is a gap line: the blank or comment that sits between two
 * rows and therefore belongs to the file, not to either row. */
export function isGapLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/** Cut a trailing comment off a flow-map value. `#` opens a comment only
 * outside quotes and only after whitespace (YAML §6.6), so a quoted value
 * keeps its own hash. */
function stripFlowComment(text: string): string {
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== "") {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && i > 0 && /\s/.test(text[i - 1]!)) return text.slice(0, i).trimEnd();
  }
  return text;
}

/** The index of the `}` closing the map that opens at `open`, or a loud
 * SyntaxError: a flow map that never closes is a row no reader can see, and
 * `on` would append a second copy of it. */
function flowMapEnd(text: string, open: number): number {
  let quote = "";
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== "") {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new SyntaxError("a flow-map row never closes its braces");
}

/** The top-level `key: value` pairs of a flow map's body. A nested
 * collection's commas and colons are its own content, so only the
 * separators outside every nested collection split the keys. */
function flowMapEntries(inner: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  let quote = "";
  let depth = 0;
  /** The top-level colon of the entry being read, or -1 before it. */
  let colon = -1;
  let start = 0;
  const push = (end: number): void => {
    if (colon >= 0) {
      const key = unquote(stripFlowComment(inner.slice(start, colon).trim()));
      const value = stripFlowComment(inner.slice(colon + 1, end).trim());
      if (key !== "") {
        if (key in pairs) throw new SyntaxError(`duplicate ${key} in a flow-map row`);
        pairs[key] = value;
      }
    }
    colon = -1;
    start = end + 1;
  };
  for (let i = 0; i <= inner.length; i += 1) {
    const ch = i < inner.length ? inner[i]! : "";
    if (quote !== "") {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (depth === 0) {
      if (ch === ":" && colon < 0) colon = i;
      else if (ch === "," || i === inner.length) push(i);
    }
  }
  return pairs;
}

/** The top-level `key: value` pairs of a row written as a flow map
 * (`- {id: llm-pi-ai, config: {…}}`), or undefined when the row opens in
 * block form. A row that opens its map on the opener line keeps every key
 * there, so only this reader sees them — otherwise `on` appends a second
 * row for this one and the user's own config rides along unmanaged. The
 * row's own trailing comments sit outside the braces, so they never attach
 * to a pair (and a comment inside the braces is cut). */
export function flowRowEntries(row: RowBlock): Record<string, string> | undefined {
  const text = row.lines.join("\n");
  if (!/^-\s*\{/.test(text)) return undefined;
  const open = text.indexOf("{");
  return flowMapEntries(text.slice(open + 1, flowMapEnd(text, open)));
}

/** The row's `id`: the `- id: ...` opener, the `- {id: ...}` flow-map
 * opener, or a column-0 `id:` line when the dash sits alone on its line
 * (dsh's own block style). A trailing comment and CRLF endings are shapes a
 * hand-edited file carries; `.` in a regex matches neither, so both are
 * eaten before the value is read. */
function rowId(row: RowBlock): string | undefined {
  const opener = /^- id:\s*(.*?)\s*$/.exec(row.lines[0] ?? "");
  if (opener?.[1]?.trim()) return unquote(stripComment(opener[1].trim()));
  const flow = flowRowEntries(row);
  if (flow !== undefined) return flow.id === undefined ? undefined : unquote(flow.id);
  const first = row.lines[0] ?? "";
  // The item's first level is the opener's content column: `-  id: x` and
  // `- "id": x` put their siblings where dsh reads them, not at a guessed
  // +2 — a wrong level reads a nested `id:` as the row's and misses the
  // real one. A lone `-` still takes its level from the next content line.
  const dash = first.trim() === "-" ? undefined : /^-\s*/.exec(first)?.[0].length;
  let level: number | undefined;
  if (dash !== undefined) level = dash;
  else if (first.trim() !== "-") level = leadingSpaces(first) + 2;
  for (const line of row.lines.slice(1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = leadingSpaces(line);
    if (level === undefined) level = indent;
    if (indent < level) break;
    if (indent !== level) continue;
    const m = /^\s*(['"]?)id\1:\s*(.*?)\s*$/.exec(line);
    if (m?.[2]?.trim()) return unquote(stripComment(m[2].trim()));
  }
  return undefined;
}

/** A row that inserts rows rather than naming one. Ours never match one;
 * splicing by row range never disturbs one. */
function isInsertRow(row: RowBlock): boolean {
  return row.lines.some((line) => /^(-\s+)?insert:$/.test(line.trim()));
}

/** The row `id` names (ignoring insert blocks), when present. */
export function findRowById(text: string, id: string): RowBlock | undefined {
  return findRows(text).find((row) => !isInsertRow(row) && rowId(row) === id);
}

/** The scalar value of a `key: value` line inside a row, at any depth, or of
 * the row's own top-level pair when the row is a flow map. A bare `key:` (a
 * block, not a scalar) reads as absent. A row naming the key twice with
 * values is a foreign shape: read loudly, never last-wins. */
export function rowValue(row: RowBlock, key: string): string | undefined {
  const found: string[] = [];
  for (const line of row.lines) {
    const m = new RegExp(`^-?\\s*${escapeRe(key)}:\\s*(.*)$`).exec(line);
    if (!m) continue;
    if (m[1]!.trim() === "") continue;
    found.push(unquote(stripComment(m[1]!.trim())));
  }
  const flow = flowRowEntries(row);
  if (flow !== undefined) {
    // A flow row's keys all ride on the opener line, so the line scan above
    // sees none of them. dsh's own shape nests them one level deeper under
    // `config:` (`- {id: agent-default-model, config: {provider: p, model: m}}`),
    // which is where the gateway's provider/model live. A pair whose value is
    // a collection is not a scalar: `config: {…}` reads as absent, the way a
    // bare `config:` does, so no caller mistakes a map for a value.
    const nested =
      flow.config === undefined || !flow.config.startsWith("{")
        ? {}
        : flowMapEntries(flow.config.slice(1, flowMapEnd(flow.config, 0)));
    const fromFlow = [flow[key], nested[key]].find((value) => value !== undefined && value !== "");
    if (fromFlow !== undefined && !fromFlow.startsWith("{") && !fromFlow.startsWith("[")) {
      found.push(unquote(stripFlowComment(fromFlow)));
    }
  }
  if (found.length > 1) throw new SyntaxError(`duplicate ${key} in row ${rowId(row) ?? "?"}`);
  return found[0];
}

/** Whether a row carries this exact line (the ownership marker proof). */
export function rowHasLine(row: RowBlock, line: string): boolean {
  return row.lines.some((entry) => stripComment(entry.trim()) === line);
}

/** The route keys declared under `providers:` in a row — used to tell our row
 * from a foreign one, and to spot user routes a lower layer would shadow.
 * A flow-style declaration (`providers: {…}`, or one nested inside a flow
 * `config: {…}`) names routes we cannot enumerate: it reports a sentinel
 * rather than the empty list a caller would read as "no providers". */
export function rowProviderKeys(row: RowBlock): string[] {
  if (row.lines.some((line) => /(^|[{,]\s*)providers:\s*\{/.test(stripComment(line.trim())))) {
    return ["<flow>"];
  }
  const header = row.lines.findIndex((line) =>
    /^(-\s+)?providers:/.test(stripComment(line.trim())),
  );
  if (header < 0) return [];
  const headerIndent = leadingSpaces(row.lines[header]!);
  const value = /^\s*(?:-\s+)?providers:\s*(.*)$/.exec(row.lines[header]!)![1]!.trim();
  if (value !== "" && !/^[|>]/.test(value)) return ["<flow>"];
  const keys: string[] = [];
  for (const line of row.lines.slice(header + 1)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (leadingSpaces(line) <= headerIndent) break;
    if (trimmed.startsWith("- ") || !trimmed.endsWith(":")) continue;
    const m = /^"?([\w.@-]+)"?:\s*$/.exec(trimmed);
    if (m) keys.push(m[1]!);
  }
  return keys;
}

/** Whether a foreign llm-pi-ai row's `config:` block holds anything our
 * whole-row replace would clobber (providers, timeoutMs, anything). Empty
 * (`config:` alone, `- {id: llm-pi-ai}`) or absent is the dormant shipped
 * shape and stays replaceable; anything written as a flow map
 * (`- {id: llm-pi-ai, config: {…}}`) is content itself. */
export function rowHasConfigContent(row: RowBlock): boolean {
  // A flow-map row keeps every key in its opener, so an indented `config:`
  // line never exists: read the top-level entry, and let the line scan below
  // keep the block shapes it already understands.
  const flow = flowRowEntries(row);
  if (flow !== undefined) return (flow.config ?? "").trim() !== "";
  const header = row.lines.findIndex((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return false;
    return /^(-\s+)?config:(?=\s|$)/.test(trimmed.split("#")[0]!.trim());
  });
  if (header < 0) return false;
  // An inline value (`config: {...}`) is content itself.
  if (
    row.lines[header]!.split("#")[0]!
      .replace(/^\s*(?:-\s+)?config:\s*/, "")
      .trim() !== ""
  ) {
    return true;
  }
  const base = leadingSpaces(row.lines[header]!);
  return row.lines
    .slice(header + 1)
    .some(
      (line) => line.trim() !== "" && !line.trim().startsWith("#") && leadingSpaces(line) > base,
    );
}

/** Our route row plus whether it still carries the ownership marker. */
export type Ours = { row: RowBlock; marked: boolean };

/** Whether a row proves itself ours: the marker is present, or a rewrite
 * dropped it while the record's exact baseURL and key ref survive. The
 * record alone never proves anything — a foreign route merely named `aiand`
 * matches neither proof, so probe, off and refreshKey always agree.
 *
 * Which row, marker line and key ref count are the caller's: aiand's ids and
 * strings stay in rows.ts and are named here rather than imported, so this
 * module reads every patch layer's shapes without importing aiand's
 * vocabulary (rows.ts already imports this one). */
export function ourLlmRow(
  patchText: string,
  rowId: string,
  marker: string,
  keyRef: string,
  wroteBaseUrl: string | undefined,
): Ours | undefined {
  const row = findRowById(patchText, rowId);
  if (row === undefined) return undefined;
  if (rowHasLine(row, marker)) return { row, marked: true };
  const baseUrl = rowValue(row, "baseURL");
  const proven =
    baseUrl !== undefined &&
    baseUrl === wroteBaseUrl &&
    isRoutableBaseUrl(baseUrl) &&
    rowValue(row, "apiKeyEnv") === keyRef;
  return proven ? { row, marked: false } : undefined;
}

/** A rendered block's own lines without the trailing gap lines: the copy
 * that belongs to the file already sits below the row this block replaces,
 * and writing it a second time would stack one copy per cycle. */
function withoutTrailingGap(rendered: string): string[] {
  const lines = rendered.split("\n");
  while (lines.length > 0 && isGapLine(lines[lines.length - 1]!)) lines.pop();
  return lines;
}

/**
 * Replace the row `id` names with `rendered`, append it when absent, or prune
 * it when `rendered` is undefined. A pruned row loses only the comment lines
 * directly above it (our own banner), never a blank that separated the user's
 * rows. The replace range stops before the gap line that follows the row, so
 * on -> off -> on -> off restores the same bytes instead of repeating a
 * trailing comment once per cycle. Every unrelated line survives byte for
 * byte.
 */
export function spliceRow(text: string, id: string, rendered: string | undefined): string {
  const raw = text.split("\n");
  // A file `on` creates (empty text) is written with a terminating newline;
  // otherwise the shape is whatever the user's file ends with.
  const endsNl = text === "" || (raw.length > 1 && raw[raw.length - 1] === "");
  const lines = endsNl ? raw.slice(0, -1) : raw;
  const row = findRowById(text, id);
  if (row === undefined) {
    if (rendered === undefined) return text;
    const rows = findRows(text);
    // Append after the last row's range, so trailing blanks and comments stay
    // below our block instead of being read back into it.
    const at = rows.length > 0 ? rows[rows.length - 1]!.to : lines.length;
    lines.splice(at, 0, ...(rendered === undefined ? [] : rendered.split("\n")));
    return endsNl ? `${lines.join("\n")}\n` : lines.join("\n");
  }
  // A replaced row whose rendered block starts with its own comment lines
  // also loses the banner lines directly above it — otherwise each re-on
  // would stack one banner per run. Only the exact banner line goes: the
  // comment above our banner is the user's and stays put. A rendered block
  // with no comment head (the unmarked hand-back shape) keeps what sat
  // above the row.
  const replacesOwnComments = rendered?.trimStart().startsWith("#");
  const isBanner = (line: string | undefined): boolean =>
    line !== undefined && stripCr(line).trim() === DSH_BANNER;
  let from = row.from;
  if (replacesOwnComments || rendered === undefined) {
    while (isBanner(lines[from - 1])) from -= 1;
  }
  // Trailing comment and blank lines inside the row's range belong to the
  // next row's banner or to the blank that separated the user's rows
  // (findRows stops only at `- ` openers): never consume them when replacing
  // or pruning, or the row below loses its banner and the user's blank.
  let to = row.to;
  // findRows counts the final empty element of a newline-terminated file as
  // a line of the last row, but `lines` above dropped that element: align the
  // range with `lines`, or the EOF comment rides into the replace range and
  // dies with the row it followed.
  if (to === raw.length && raw[raw.length - 1] === "") to -= 1;
  while (
    to > row.from &&
    to - 1 < lines.length &&
    lines[to - 1] !== undefined &&
    isGapLine(lines[to - 1]!)
  ) {
    to -= 1;
  }
  const eaten = row.from - from;
  if (eaten > 0) {
    lines.splice(from, eaten);
    to -= eaten;
  }
  lines.splice(from, to - from, ...(rendered === undefined ? [] : withoutTrailingGap(rendered)));
  const out = lines.join("\n");
  // A file that ended without a final newline keeps that shape: the trailing
  // newline is the user's (or their editor's) choice, and on -> off must not
  // leave one behind as a byte-identical diff.
  return out === "" ? "" : endsNl ? `${out}\n` : out;
}

export function leadingSpaces(line: string): number {
  return /^[ ]*/.exec(line)![0].length;
}

export function stripComment(text: string): string {
  const cut = text.search(/\s#/);
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

// YAML double-quoted escapes (YAML 1.2 §5.7); JSON.parse rejects the
// YAML-only ones (`\_`, `\L`, `\a`, ...) a hand-edited file may carry.
const YAML_ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\x85",
  _: "\xa0",
  L: "\u2028",
  P: "\u2029",
};

/** A leading `"…"` scalar decoded by the YAML escape table. An unterminated
 * quote or an unknown escape is a loud SyntaxError, never the raw quoted text
 * (which would flow a backslashed value into a baseURL or key read). */
function parseDoubleQuoted(text: string): string {
  if (!/^"(?:[^"\\]|\\[\s\S])*"$/.test(text)) {
    throw new SyntaxError(`bad double-quoted scalar: ${text}`);
  }
  return text
    .slice(1, -1)
    .replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (_, esc: string) => {
      if (esc.length > 1) return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
      const out = YAML_ESCAPES[esc];
      if (out === undefined) throw new SyntaxError(`bad escape \\${esc} in: ${text}`);
      return out;
    });
}

export function unquote(value: string): string {
  if (value.startsWith('"')) return parseDoubleQuoted(value);
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Quote a scalar only when a bare form would not parse back the same. */
export function renderScalar(value: string): string {
  if (
    value === "" ||
    value !== value.trim() ||
    value.includes(": ") ||
    value.endsWith(":") ||
    /[ \t]#/.test(value) ||
    /^[#&*!|>%@`,[\]{}?:-]/.test(value) ||
    /^(?:~|null|true|false|yes|no|on|off|y|n)$/i.test(value) ||
    /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)
  ) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Drop the ownership marker line and banner comment from every row of a
 * patch document, leaving all other lines (the routing values included)
 * byte-identical: the hand-back shape for a row the user repointed, which
 * must stop reading as ours while their edits stay. The strings are exact
 * lines only aiand writes, so a user row can never lose one — unless the
 * text sits inside a block scalar body, which is the user's content: a
 * block-scalar-aware scan skips those. */
export function releaseOwnership(patchText: string, marker: string, banner: string): string {
  const lines = patchText.split("\n");
  let blockIndent = -1;
  return lines
    .filter((line) => {
      const plain = stripCr(line);
      const trimmed = plain.trim();
      if (blockIndent >= 0) {
        if (trimmed === "" || leadingSpaces(plain) > blockIndent) return true;
        blockIndent = -1;
      }
      if (/^(?:[ ]*(?:-\s+)?)?[\w.@-]+:\s*[|>][-+\d]*(\s.*)?$/.test(plain)) {
        blockIndent = leadingSpaces(plain);
      }
      return stripComment(trimmed) !== marker && trimmed !== banner;
    })
    .join("\n");
}
