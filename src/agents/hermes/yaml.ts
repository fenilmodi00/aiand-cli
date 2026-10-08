// Indent-anchored YAML line surgery, split from routing.ts by responsibility
// (the repo's 650-line module gate). Not a YAML parser: unrelated keys,
// sections, and comments survive every edit byte-identical. Generic
// primitives only — the guards that turn un-editable shapes into by-hand
// hints live in routing.ts.

// YAML double-quoted escapes (YAML 1.2 §5.7). JSON.parse rejects the
// YAML-only ones (`\_`, `\L`, `\a`, `\x41`, ...) that PyYAML emits for
// non-printable and special-space characters, and a mis-decoded scalar
// reads as "you edited it" and strands our record — so decode with YAML's
// own table instead.
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

/** Decode a double-quoted YAML scalar; bad escapes and unterminated quotes throw. */
export function parseDoubleQuoted(text: string): string {
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

/** A YAML scalar without its quotes: ours are JSON-stringified, the user's may be bare. */
export function unquoteYaml(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    // Reads never throw: a bad escape stays literal so probe/enable/off
    // see the user's bytes instead of a SyntaxError mid-edit.
    try {
      return parseDoubleQuoted(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

/**
 * Drop a lone `{}` child (PyYAML's dump of an empty dict): it means
 * "no children", so the splice adds the block under the bare header
 * instead of writing invalid YAML beside the flow container. A lone `[]`
 * is deliberately NOT dropped: that is a real empty sequence, and
 * swallowing it would clobber a user's list (omp yaml.ts:522 policy) —
 * routing.ts refuses it with INVALID_CONFIG_HINT instead.
 */
export function dropLoneFlowLine(lines: string[], at: number, end: number): boolean {
  let only = -1;
  for (let i = at + 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || isCommentLine(line)) continue;
    if (only !== -1) return false;
    only = i;
  }
  if (only !== -1 && lines[only]!.trim() === "{}") {
    lines.splice(only, 1);
    return true;
  }
  return false;
}

/**
 * The `#…` suffix of a line when it starts outside single/double quotes
 * and is preceded by whitespace (YAML comment), else "". A `#` inside
 * quotes (`"a#b"`) or glued to a scalar (`a#b`) is data, not a comment.
 */
function trailingComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inSingle) {
      if (ch === "'" && line[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(i);
  }
  return "";
}

/** A line with its trailing `#…` comment removed; quoted `#` survives. */
export function stripTrailingComment(line: string): string {
  const comment = trailingComment(line);
  return comment === "" ? line : line.slice(0, line.length - comment.length).replace(/[ \t]+$/, "");
}

/** A comment line never ends a section: it floats wherever YAML allows. */
export function isCommentLine(line: string): boolean {
  return line.trimStart().startsWith("#");
}

/** Split text into lines with the file's EOL, so edits never mix endings. */
export type YamlLines = { lines: string[]; trailingNewline: boolean; eol: string };

/**
 * Split on LF or CRLF and remember which: every `$`-anchored parse would
 * otherwise fail on lines ending in `\r` (a stranded carriage return reads
 * as data — a marked block probes inactive, a pin appends a second root
 * `providers:`), and rejoining must restore the same EOL. The empty file
 * splits to a single empty line, matching `"".split("\n")`, so callers keep
 * their current empty-input behavior byte-identical.
 * (env.ts reuses this pair for the dotenv `.env` — same line/EOL model,
 * nothing YAML-specific crosses that boundary.)
 */
export function splitYamlLines(text: string): YamlLines {
  if (text === "") return { lines: [""], trailingNewline: false, eol: "\n" };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, text.endsWith("\r\n") ? -2 : -1) : text;
  return { lines: body.split(/\r?\n/), trailingNewline, eol };
}

/** Rejoin split lines with the EOL the split remembered. */
export function joinYamlLines(lines: string[], trailingNewline: boolean, eol: string): string {
  if (lines.length === 0) return "";
  return `${lines.join(eol)}${trailingNewline ? eol : ""}`;
}

/**
 * True when a matched child line carries a value that continues on later
 * lines: a block scalar (`|`/`>` header, folded body follows) or a wrapped
 * plain scalar (a deeper-indented continuation line). Replacing or deleting
 * the header line alone would strand the body as invalid YAML.
 */
export function childValueIsMultiLine(body: string[], idx: number, indent: string): boolean {
  const line = body[idx]!;
  const inline = line.slice(line.indexOf(":") + 1).trim();
  if (/^[|>]([+-]?[0-9]*\s*(#.*)?)?$/.test(inline)) return true;
  for (let j = idx + 1; j < body.length; j++) {
    const next = body[j]!;
    if (next.trim() === "" || isCommentLine(next)) continue;
    // A sibling carries the indent without extra depth; anything still
    // deeper-indented belongs to this value. Column-0 lines end the section.
    return next.startsWith(`${indent} `);
  }
  return false;
}

/** Whether a line belongs to the section body: indented, blank, or a comment. */
export function isSectionBodyLine(line: string): boolean {
  return line.trim() === "" || /^\s/.test(line) || isCommentLine(line);
}

/** A top-level `name:` section's body: scalar sections (fresh `model: ""`) carry none. */
export function sectionRange(lines: string[], name: string): { at: number; end: number } | null {
  const at = lines.findIndex((line) => new RegExp(`^${name}\\s*:`).test(line));
  if (at === -1) return null;
  // A trailing `#…` comment is not data: `providers:  # keep` is the bare
  // header, not a scalar section (the same strip pinHermesProvider and
  // pinHermesModel apply before their scalar tests in routing.ts).
  const scalar = new RegExp(`^${name}\\s*:\\s*\\S`).test(stripTrailingComment(lines[at]!));
  let end = at + 1;
  if (!scalar) {
    while (end < lines.length && isSectionBodyLine(lines[end]!)) end += 1;
    while (end > at + 1 && lines[end - 1]!.trim() === "") end -= 1;
  }
  return { at, end };
}

/** The `providers:` body plus our block's span inside it, anchored to the section indent. */
export function aiandBlockSpan(
  lines: string[],
): { at: number; end: number; indent: string; subAt: number; subEnd: number } | null {
  const section = sectionRange(lines, "providers");
  if (!section) return null;
  const body = lines.slice(section.at + 1, section.end);
  const indent = /^(\s+)\S/.exec(body.find((line) => /^\s+\S/.test(line)) ?? "")?.[1] ?? "  ";
  // Anchored to the section indent, so a deeper `aiand:` nested inside
  // another provider's own config can never match.
  const subAt = body.findIndex((line) => new RegExp(`^${indent}aiand\\s*:`).test(line));
  if (subAt === -1) return null;
  // The block's body runs while lines stay more indented than its own key.
  let subEnd = subAt + 1;
  while (
    subEnd < body.length &&
    (body[subEnd]!.trim() === "" ||
      body[subEnd]!.startsWith(`${indent} `) ||
      isCommentLine(body[subEnd]!))
  )
    subEnd += 1;
  return { at: section.at, end: section.end, indent, subAt, subEnd };
}

/** The `model:` section's scalar value (a fresh `model: ""` sentinel), if it is one. */
export function modelScalar(text: string): string | undefined {
  const lines = splitYamlLines(text).lines;
  const at = lines.findIndex((line) => /^model\s*:/.test(line));
  // A trailing `#…` comment is not data: `model:  # keep` is the bare header,
  // not a scalar section.
  if (at === -1 || !/^model\s*:\s*\S/.test(stripTrailingComment(lines[at]!))) return undefined;
  // A trailing `#…` comment is not data.
  return unquoteYaml(stripTrailingComment(lines[at]!).replace(/^model\s*:\s*/, ""));
}

/** The `  #…` suffix of a line (gap plus comment), or "" when none. */
export function commentSuffix(original: string): string {
  const comment = trailingComment(original);
  if (comment === "") return "";
  const code = original.slice(0, original.length - comment.length);
  const gap = /[ \t]+$/.exec(code)?.[0] ?? " ";
  return `${gap}${comment}`;
}

/** A bare `name:` header with its trailing `#…` comment preserved. */
export function keepHeaderComment(name: string, original: string): string {
  const suffix = commentSuffix(original);
  return suffix ? `${name}:${suffix}` : `${name}:`;
}

/** A rewritten line with the original line's trailing `#…` comment preserved. */
export function keepLineComment(fresh: string, original: string): string {
  const suffix = commentSuffix(original);
  return suffix ? `${fresh}${suffix}` : fresh;
}

/**
 * End of a list-shaped top-level section: blank lines, comments, indented
 * lines, and dash items at the header's own column (the block-sequence style
 * PyYAML writes by default) all stay in; anything else ends it.
 */
export function listSectionEnd(lines: string[], at: number): number {
  let end = at + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (line.trim() === "" || isCommentLine(line) || /^\s/.test(line) || /^-(\s|$)/.test(line))
      end++;
    else break;
  }
  return end;
}

/**
 * Split a list section into its dash-led items, each as the raw lines that
 * form it: the dash-line remainder first (trimmed), then the item's own
 * lines. A deeper dash belongs to its item's body, never a new item, so a
 * value nested deeper can never match an item-level test. Generic grouping
 * only — what counts as a match is the caller's shape to know.
 */
export function splitListItems(lines: string[], at: number, end: number): string[][] {
  const DASH_ITEM = /^([ ]*)-(.*)$/;
  let dashIndent: string | null = null;
  let current: string[] = [];
  const items: string[][] = [];
  for (let i = at + 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || isCommentLine(line)) continue;
    const dash = DASH_ITEM.exec(line);
    if (dash && dashIndent !== null && dash[1]!.length > dashIndent.length) continue;
    if (dash && (dashIndent === null || dash[1] === dashIndent)) {
      if (dashIndent === null) dashIndent = dash[1]!;
      items.push(current);
      current = [];
      if (dash[2]!.trim() !== "") current.push(dash[2]!.trim());
      continue;
    }
    if (dashIndent === null) continue;
    current.push(line);
  }
  items.push(current);
  return items;
}

/** One dash-item line parsed for matching: indent, `key:` split, raw text. */
export type ListEntry = {
  indent: string;
  key: string;
  rest: string;
  text: string;
  isHeader: boolean;
};

/** Parse one item's lines for matching: comment-stripped, quote-aware. */
export function parseListEntries(item: string[]): ListEntry[] {
  return item
    .filter((raw) => !/^[ ]*-/.test(raw))
    .map((raw) => {
      const code = stripTrailingComment(raw).trim();
      const header = /^([ ]*)([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(code);
      // The line's own indent: dash-line remainders arrive pre-trimmed (the
      // item's own level), while a deeper continuation keeps its indent and
      // never counts at the item's level.
      const indent = /^([ ]*)/.exec(raw)?.[1] ?? "";
      return {
        indent,
        key: header ? header[2]! : "",
        rest: header ? header[3]! : "",
        text: code,
        isHeader: header !== null,
      };
    });
}
