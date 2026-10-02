// The CLI takes no runtime dependencies, so this is only the block-style
// YAML the omp adapter's two config files use (models.yml, config.yml):
// nested mappings, scalars, block sequences and comments. Anything outside
// that subset is a SyntaxError — fail loud, never silently mis-parse.

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

const NUMBER = /^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)$/;
// `key:` or `key: value` — quoted or bare keys; the value may hold colons.
const KEY_LINE = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^:#\s"'][^:#]*?)\s*:(?:[ \t]+(.*))?$/;
// `-` or `- item` — a sequence entry.
const SEQ_LINE = /^-(?:[ \t]+(.*))?$/;

// YAML double-quoted escapes (YAML 1.2 §5.7); JSON.parse rejects the
// YAML-only ones (`\_`, `\L`, `\a`, ...) that omp's writer emits.
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

/** A scalar's value: quoted strings stay strings, `null`/`true`/`false` and
 * JSON-number shapes map to their type, everything else is a bare string
 * (model selectors like `aiand/zai-org/glm-5.3` included). */
export function parseScalar(raw: string): YamlValue {
  const text = raw.trim();
  if (text === "" || text === "~" || text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith('"')) return parseDoubleQuoted(text);
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) {
      throw new SyntaxError(`bad single-quoted scalar: ${text}`);
    }
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (NUMBER.test(text)) return Number(text);
  return text;
}

/** Render a scalar the parser reads back identically. */
export function renderScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);
  if (
    value === "" ||
    value === "~" ||
    value === "null" ||
    value === "true" ||
    value === "false" ||
    NUMBER.test(value) ||
    value !== value.trim() ||
    /^["'#&*!|>%@`[\]{}?:,-]/.test(value) ||
    value.includes(": ") ||
    value.endsWith(":") ||
    value.includes(" #") ||
    value.includes("\n")
  ) {
    return JSON.stringify(value);
  }
  return value;
}

/** Index of a `#` that starts a comment: outside quotes, after whitespace. */
function findComment(text: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote === '"') {
      if (char === "\\") i++;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) return i;
  }
  return -1;
}

function stripComment(text: string): string {
  const cut = findComment(text);
  return cut >= 0 ? text.slice(0, cut).trimEnd() : text;
}

function unquoteKey(key: string): string {
  if (key.startsWith('"')) {
    try {
      return JSON.parse(key) as string;
    } catch {
      throw new SyntaxError(`bad double-quoted key: ${key}`);
    }
  }
  if (key.startsWith("'")) {
    if (key.length < 2 || !key.endsWith("'")) throw new SyntaxError(`bad quoted key: ${key}`);
    return key.slice(1, -1).replace(/''/g, "'");
  }
  return key;
}

type KeyLine = {
  key: string;
  /** The key as written, quoting included: a rewrite keeps it. */
  keyText: string;
  valueText: string | null;
  comment: string | null;
};

/** One `key: value` line: valueText null means `key:` alone (nested block or
 * null). Sequence lines, comments and non-mapping lines are not key lines. */
function parseKeyLine(raw: string): KeyLine | null {
  const content = raw.trim();
  if (content === "" || content.startsWith("#")) return null;
  if (SEQ_LINE.test(content)) return null;
  const body = stripComment(content);
  const match = KEY_LINE.exec(body);
  if (!match) return null;
  const valueText = match[2] ?? null;
  const effective = valueText !== null && valueText.trim() === "" ? null : valueText;
  const commentAt = findComment(content);
  return {
    key: unquoteKey(match[1]!),
    keyText: match[1]!,
    valueText: effective,
    comment: commentAt >= 0 ? content.slice(commentAt) : null,
  };
}

/** Split a flow-sequence body on commas that sit outside quotes. */
function splitFlowItems(inner: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!;
    if (quote === '"') {
      cur += char;
      if (char === "\\") {
        cur += inner[i + 1] ?? "";
        i++;
      } else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      cur += char;
      if (char === "'") {
        if (inner[i + 1] === "'") {
          cur += "'";
          i++;
        } else quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      cur += char;
      continue;
    }
    if (char === ",") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += char;
  }
  parts.push(cur);
  return parts;
}

/** An inline value: `{}` / `[a, b]` flow, else a scalar. */
function parseInline(raw: string): YamlValue {
  const text = raw.trim();
  if (text === "{}") return {};
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlowItems(inner).map((part) => parseScalar(part));
  }
  if (text.startsWith("{")) throw new SyntaxError(`flow mappings are not supported: ${text}`);
  return parseScalar(text);
}

type Line = { indent: number; text: string; raw: string };

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const leading = /^[ \t]*/.exec(raw)![0];
    if (leading.includes("\t")) throw new SyntaxError("tab indentation is not valid YAML");
    out.push({ indent: leading.length, text: raw.slice(leading.length), raw });
  }
  return out;
}

function withBom<T>(text: string, fn: (body: string) => T): T {
  const bom = text.startsWith("﻿");
  if (!bom) return fn(text);
  const out = fn(text.slice(1));
  return (typeof out === "string" ? `﻿${out}` : out) as T;
}

/** Parse block YAML: nested mappings, block sequences (scalars and nested
 * mappings as items), comments, quoted keys and scalars. Throws SyntaxError
 * on anything else. */
export function parseYaml(text: string): unknown {
  return withBom(text, (body) => {
    const lines = splitLines(body);
    let cursor = 0;

    // The next content line, skipping blanks and whole-line comments.
    const next = (): Line | undefined => {
      while (cursor < lines.length) {
        const line = lines[cursor]!;
        if (line.text !== "" && !line.text.startsWith("#")) break;
        cursor++;
      }
      return cursor < lines.length ? lines[cursor] : undefined;
    };

    function parseValueBelow(indent: number): YamlValue {
      const line = next();
      if (line === undefined || line.indent <= indent) return null;
      return parseBlock(line.indent);
    }

    function parseBlock(indent: number): YamlValue {
      const line = next();
      if (line === undefined) return null;
      // omp's writer (Bun.YAML.stringify) puts an empty container on its
      // own indented line: `modelRoles:\n  {}`.
      if (line.text.startsWith("{") || line.text.startsWith("[")) {
        cursor++;
        return parseInline(stripComment(line.text));
      }
      if (SEQ_LINE.test(line.text)) return parseSeq(indent);
      return parseMap(indent);
    }

    function parseMap(indent: number, firstEntry?: KeyLine): Record<string, YamlValue> {
      const out: Record<string, YamlValue> = {};
      // A pre-parsed first entry came off a `- key:` line, which parseSeq
      // already advanced past: its value block starts at the next line.
      if (firstEntry !== undefined) {
        out[firstEntry.key] =
          firstEntry.valueText === null
            ? parseValueBelow(indent)
            : parseInline(firstEntry.valueText);
      }
      for (;;) {
        const line = next();
        if (line === undefined || line.indent < indent) break;
        if (line.indent > indent) throw new SyntaxError(`unexpected indent: ${line.raw}`);
        const parsed = parseKeyLine(line.raw);
        if (parsed === null) {
          if (SEQ_LINE.test(line.text))
            throw new SyntaxError(`sequence item in a mapping: ${line.raw}`);
          throw new SyntaxError(`not a mapping line: ${line.raw}`);
        }
        cursor++;
        out[parsed.key] =
          parsed.valueText === null ? parseValueBelow(indent) : parseInline(parsed.valueText);
      }
      return out;
    }

    function parseSeq(dashIndent: number): YamlValue[] {
      const items: YamlValue[] = [];
      for (;;) {
        const line = next();
        if (line === undefined || line.indent < dashIndent) break;
        if (line.indent > dashIndent) throw new SyntaxError(`unexpected indent: ${line.raw}`);
        const match = SEQ_LINE.exec(line.text);
        if (!match) break; // a sibling key: the enclosing map continues
        cursor++;
        const rest = (match[1] ?? "").trim();
        if (rest === "") {
          const below = next();
          items.push(below && below.indent > dashIndent ? parseBlock(below.indent) : null);
          continue;
        }
        const parsed = parseKeyLine(rest);
        if (parsed) {
          // `- key: …` starts a mapping item; its sibling keys sit at the
          // column where the key begins, right of the dash.
          const itemIndent = dashIndent + line.text.indexOf(rest);
          items.push(parseMap(itemIndent, parsed));
          continue;
        }
        items.push(parseInline(stripComment(rest)));
      }
      return items;
    }

    const first = next();
    if (first === undefined) return null;
    if (first.indent !== 0) throw new SyntaxError(`unexpected indent: ${first.raw}`);
    return parseBlock(0);
  });
}

/** Parse and narrow to a root mapping; `{}` for empty/whitespace text. */
export function readYamlMapping(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const parsed = parseYaml(text);
  if (parsed === null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("root is not a mapping");
  }
  return parsed as Record<string, unknown>;
}

// --- Surgical text edits -----------------------------------------------------
// We write into files omp also writes, so key order, comments and quoting
// of untouched lines must survive: parse + re-render would drop them. The
// editors below splice line ranges; only the edited entry's lines change.

function indentOf(raw: string): number {
  return /^[ \t]*/.exec(raw)![0].length;
}

/**
 * First line index after keyIndex that is NOT part of the key's block:
 * content dedenting to <= keyIndent, or — when only blank lines follow —
 * the line after the block's last content line, so blank separators around
 * an entry are never absorbed into the edit.
 */
function blockEnd(lines: string[], keyIndex: number, keyIndent: number): number {
  let last = keyIndex;
  for (let i = keyIndex + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (indentOf(raw) <= keyIndent) break;
    last = i;
  }
  return last + 1;
}

function findKeyLine(
  lines: string[],
  key: string,
  indent: number,
  from: number,
  to: number,
): number {
  for (let i = from; i < to; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "" || indentOf(raw) !== indent) continue;
    if (parseKeyLine(raw)?.key === key) return i;
  }
  return -1;
}

function rootInsertIndex(lines: string[]): number {
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "") last = i;
  }
  return last + 1;
}

/** The child mapping under `key:` — null when the key holds no block. */
type Mapping = { from: number; to: number; indent: number; insertAt: number };

function childMapping(lines: string[], keyIndex: number, keyIndent: number): Mapping | null {
  const end = blockEnd(lines, keyIndex, keyIndent);
  let first = -1;
  let last = keyIndex;
  for (let i = keyIndex + 1; i < end; i++) {
    const raw = lines[i]!;
    const text = raw.trim();
    // A whole-line comment is not content — parseYaml skips it the same
    // way — so it neither decides the block's shape nor marks the first
    // content line. Neither is a lone `{}`: omp's writer puts an empty map
    // on its own indented line, which is no block yet. An empty sequence
    // (`[]`) is left as content so a key that is really a list fails loud
    // in parseKeyLine below instead of being clobbered by a mapping.
    if (text === "" || text.startsWith("#") || text === "{}") continue;
    if (first === -1) first = i;
    last = i;
  }
  if (first === -1) return null;
  // The block must be a mapping: a sequence (or any other non-key
  // first content line) cannot take spliced entries, and writing
  // into it would corrupt the file. Fail loud instead; the adapter
  // maps the SyntaxError to the recovery hint like readOmpFile does.
  if (parseKeyLine(lines[first]!) === null) {
    throw new SyntaxError(`not a mapping block: ${lines[keyIndex]!} followed by ${lines[first]!}`);
  }
  return { from: keyIndex + 1, to: end, indent: indentOf(lines[first]!), insertAt: last + 1 };
}

/** A generated key, quoted when a bare form would not parse back
 * as the same key (a `:` or `#` in it, or a leading `#`). */
function renderKey(key: string): string {
  return parseKeyLine(`${key}: v`)?.key === key ? key : JSON.stringify(key);
}

/** One mapping entry rendered as lines: scalars inline, nested maps and
 * sequences as an indented block. A replaced line's trailing comment
 * rides on the first rendered line, where it sat. */
function renderEntryLines(
  key: string,
  value: YamlValue,
  indent: number,
  comment?: string | null,
): string[] {
  const pad = " ".repeat(indent);
  const tail = comment ? ` ${comment}` : "";
  if (value === null || typeof value !== "object") {
    return [`${pad}${renderKey(key)}: ${renderScalar(value)}${tail}`];
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (item === null || typeof item !== "object") return `${pad}  - ${renderScalar(item)}`;
      throw new Error("yamlRender cannot nest a mapping inside a sequence");
    });
    return [`${pad}${renderKey(key)}:${tail}`, ...items];
  }
  const out = [`${pad}${renderKey(key)}:${tail}`];
  for (const [k, v] of Object.entries(value)) out.push(...renderEntryLines(k, v, indent + 2));
  return out;
}

/** Build the nested mapping a path addresses, ending at value. */
function chainTo(path: readonly string[], value: YamlValue): YamlValue {
  let out: YamlValue = value;
  for (let i = path.length - 1; i >= 0; i--) out = { [path[i]!]: out };
  return out;
}

/** Rewrite `key: <old>` keeping the line's indent, its original key
 * quoting, and its trailing comment. */
function rewriteKeyLine(raw: string, key: string, valueText: string | null): string {
  const parsed = parseKeyLine(raw);
  const comment = parsed?.comment;
  const value = valueText === null ? "" : ` ${valueText}`;
  return `${" ".repeat(indentOf(raw))}${parsed?.keyText ?? key}:${value}${comment ? ` ${comment}` : ""}`;
}

function joinBack(lines: string[], endsNl: boolean): string {
  const text = lines.join("\n");
  return endsNl || text === "" ? `${text}\n` : text;
}

function toLines(text: string): { lines: string[]; endsNl: boolean } {
  const endsNl = text.endsWith("\n");
  const lines = text.split("\n");
  if (endsNl) lines.pop();
  return { lines, endsNl };
}

/** Set `path` to `value`. Missing parents become mappings; a scalar where a
 * mapping must go is replaced; every unrelated line survives byte-for-byte. */
export function yamlSet(text: string, path: readonly string[], value: YamlValue): string {
  if (path.length === 0) throw new Error("yamlSet path must not be empty");
  return withBom(text, (body) => {
    const { lines, endsNl } = toLines(body);
    if (lines.every((line) => line.trim() === "")) return yamlRender(chainTo(path, value));

    let mapping: Mapping = {
      from: 0,
      to: lines.length,
      indent: 0,
      insertAt: rootInsertIndex(lines),
    };

    for (let depth = 0; depth < path.length - 1; depth++) {
      const key = path[depth]!;
      const keyIndex = findKeyLine(lines, key, mapping.indent, mapping.from, mapping.to);
      if (keyIndex === -1) {
        // Missing intermediate: create the rest of the chain here.
        lines.splice(
          mapping.insertAt,
          0,
          ...renderEntryLines(key, chainTo(path.slice(depth + 1), value), mapping.indent),
        );
        return joinBack(lines, endsNl);
      }
      const child = childMapping(lines, keyIndex, mapping.indent);
      if (child === null) {
        // No block yet (a bare `key:` or an inline scalar): open one.
        // childMapping already ignored any lone `{}`, so the new entry must
        // land where that placeholder sat, not above it — omp reads the
        // last key, and a surviving `{}` after a real child is a broken doc.
        const end = blockEnd(lines, keyIndex, mapping.indent);
        let placeholder = keyIndex + 1;
        while (placeholder < end) {
          const text = lines[placeholder]!.trim();
          if (text === "" || text.startsWith("#")) {
            placeholder++;
            continue;
          }
          if (text === "{}") lines.splice(placeholder, 1);
          break;
        }
        lines[keyIndex] = rewriteKeyLine(lines[keyIndex]!, key, null);
        lines.splice(
          keyIndex + 1,
          0,
          ...renderEntryLines(
            path[depth + 1]!,
            chainTo(path.slice(depth + 2), value),
            mapping.indent + 2,
          ),
        );
        return joinBack(lines, endsNl);
      }
      mapping = child;
    }

    const leaf = path[path.length - 1]!;
    const leafIndex = findKeyLine(lines, leaf, mapping.indent, mapping.from, mapping.to);
    if (leafIndex === -1) {
      lines.splice(mapping.insertAt, 0, ...renderEntryLines(leaf, value, mapping.indent));
      return joinBack(lines, endsNl);
    }
    const end = blockEnd(lines, leafIndex, mapping.indent);
    if (value === null || typeof value !== "object") {
      // Scalar: rewrite the key line (keeping its comment), drop any block.
      lines.splice(
        leafIndex,
        end - leafIndex,
        rewriteKeyLine(lines[leafIndex]!, leaf, renderScalar(value)),
      );
    } else {
      // A mapping replacing this entry keeps the line's trailing
      // comment, on the first rendered line where it sat.
      lines.splice(
        leafIndex,
        end - leafIndex,
        ...renderEntryLines(leaf, value, mapping.indent, parseKeyLine(lines[leafIndex]!)?.comment),
      );
    }
    return joinBack(lines, endsNl);
  });
}

/** Delete `path`; a mapping our delete leaves empty is pruned too, up to the
 * root. Missing paths are a no-op. */
export function yamlDelete(text: string, path: readonly string[]): string {
  if (path.length === 0) return text;
  return withBom(text, (body) => {
    const { lines, endsNl } = toLines(body);
    if (lines.every((line) => line.trim() === "")) return body;

    let mapping: Mapping = { from: 0, to: lines.length, indent: 0, insertAt: lines.length };
    const parents: number[] = [];
    for (let depth = 0; depth < path.length - 1; depth++) {
      const keyIndex = findKeyLine(lines, path[depth]!, mapping.indent, mapping.from, mapping.to);
      if (keyIndex === -1) return body;
      const child = childMapping(lines, keyIndex, mapping.indent);
      if (child === null) return body; // no mapping below: nothing deeper exists
      parents.push(keyIndex);
      mapping = child;
    }
    const leafIndex = findKeyLine(
      lines,
      path[path.length - 1]!,
      mapping.indent,
      mapping.from,
      mapping.to,
    );
    if (leafIndex === -1) return body;

    const end = blockEnd(lines, leafIndex, mapping.indent);
    lines.splice(leafIndex, end - leafIndex);
    for (let i = parents.length - 1; i >= 0; i--) {
      const parent = parents[i]!;
      // A parent whose block now holds only comments is NOT empty:
      // dropping `parent:` would orphan them into dangling indents.
      // Blank-only tails are separators, not content — that husk goes.
      let hasCommentTail = false;
      let hasContent = false;
      for (let j = parent + 1; j < lines.length; j++) {
        const text = lines[j]!.trim();
        if (text === "") continue;
        if (text.startsWith("#")) {
          hasCommentTail = true;
          continue;
        }
        if (indentOf(lines[j]!) > indentOf(lines[parent]!)) hasContent = true;
        break;
      }
      if (hasContent || !hasCommentTail) {
        // A trailing blank is only the file's own spacing when something
        // else follows in the file (a sibling key); with no record of a
        // following key, the husk goes with the entry.
        if (hasCommentTail || hasContent) break;
        lines.splice(parent, 1);
      } else break;
    }
    return joinBack(lines, endsNl);
  });
}

/** Render a whole mapping document (2-space indents, trailing newline). */
export function yamlRender(value: YamlValue): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("yamlRender renders a mapping document");
  }
  return `${Object.entries(value)
    .flatMap(([key, inner]) => renderEntryLines(key, inner, 0))
    .join("\n")}\n`;
}
