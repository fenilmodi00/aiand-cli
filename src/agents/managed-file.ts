import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../cli/errors.js";
import { writeFileAtomic } from "../config.js";
import { PRIVATE_FILE_MODE } from "../fsutil.js";
import { fileCreatedByUs } from "./snapshot.js";

/** A plain object's own record, or undefined for arrays, null and primitives. */
export const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
/**
 * Managed-file plumbing shared by adapters: read-or-empty, JSONC parse, the
 * invalid-JSON error, surgical JSONC text edits, the stripped-file write, and
 * the throwaway session overlay. Adapters keep the wire-format knowledge;
 * atomic writes live in fsutil.ts.
 */

/** Read a file, treating only ENOENT as empty: a real read error is not a clean "off". */
export async function readTextIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
/**
 * Parse JSONC the way OpenCode accepts it: one string-aware scan strips line
 * and block comments and trailing commas, then JSON.parse. A `//` or `,}`
 * inside a string literal survives.
 */
export function parseJsonc(text: string): unknown {
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === "\\") {
        out += char;
        escaped = true;
      } else {
        if (char === '"') inString = false;
        out += char;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      if (i >= text.length) {
        throw new SyntaxError("Unterminated block comment");
      }
      i++; // consume the trailing slash
      continue;
    }
    // Trailing comma: drop `,` when the next non-ws / non-comment token is
    // `]` or `}`. Lookahead skips whitespace and comments so `,\n // c\n}`
    // still strips; string values never reach here.
    if (char === ",") {
      let j = i + 1;
      while (j < text.length) {
        const c = text[j];
        const n = text[j + 1];
        if (c === " " || c === "\t" || c === "\r" || c === "\n") {
          j++;
          continue;
        }
        if (c === "/" && n === "/") {
          while (j < text.length && text[j] !== "\n") j++;
          continue;
        }
        if (c === "/" && n === "*") {
          j += 2;
          while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
          j += 2;
          continue;
        }
        break;
      }
      if (text[j] === "]" || text[j] === "}") continue;
    }
    out += char;
  }
  return JSON.parse(out);
}

/** The one `X is not valid JSON.` error for managed config reads, naming the file. */
export function notValidJsonError(filePath: string, hint?: string): CliError {
  return new CliError(`${filePath} is not valid JSON.`, hint === undefined ? {} : { hint });
}

/**
 * Surgical JSONC object edits. We write into files another program also
 * writes, so comments, key order, and trailing commas have to survive: parse
 * + JSON.stringify would drop them. These helpers splice one property in the
 * original text and leave every other byte alone.
 */

type PropLoc = {
  keyStart: number;
  valueStart: number;
  valueEnd: number;
  commaAfter: number | null;
  /** Index of the comma that precedes this property, if any. */
  commaBefore: number | null;
};

function skipTrivia(text: string, i: number): number {
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      i++;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      if (i >= text.length) throw new SyntaxError("Unterminated block comment");
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

function skipString(text: string, i: number): number {
  if (text[i] !== '"') throw new SyntaxError("Expected string");
  i++;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i++;
  }
  throw new SyntaxError("Unterminated string");
}

function skipValue(text: string, i: number): number {
  i = skipTrivia(text, i);
  const char = text[i];
  if (char === '"') return skipString(text, i);
  if (char === "{") return skipObject(text, i).end;
  if (char === "[") return skipArray(text, i);
  if (char === "t" || char === "f" || char === "n") {
    while (i < text.length && /[a-z]/.test(text[i]!)) i++;
    return i;
  }
  if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) {
    i++;
    while (i < text.length && /[0-9eE.+-]/.test(text[i]!)) i++;
    return i;
  }
  throw new SyntaxError(`Unexpected value at ${i}`);
}

function skipArray(text: string, i: number): number {
  if (text[i] !== "[") throw new SyntaxError("Expected array");
  i++;
  i = skipTrivia(text, i);
  if (text[i] === "]") return i + 1;
  while (i < text.length) {
    i = skipValue(text, i);
    i = skipTrivia(text, i);
    if (text[i] === ",") {
      i++;
      i = skipTrivia(text, i);
      if (text[i] === "]") return i + 1;
      continue;
    }
    if (text[i] === "]") return i + 1;
    throw new SyntaxError("Expected comma or ]");
  }
  throw new SyntaxError("Unterminated array");
}

function skipObject(text: string, i: number): { end: number; props: Map<string, PropLoc> } {
  if (text[i] !== "{") throw new SyntaxError("Expected object");
  const props = new Map<string, PropLoc>();
  i++;
  i = skipTrivia(text, i);
  if (text[i] === "}") return { end: i + 1, props };
  let commaBefore: number | null = null;
  while (i < text.length) {
    if (text[i] !== '"') throw new SyntaxError("Expected property name");
    const keyStart = i;
    const keyEnd = skipString(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipTrivia(text, keyEnd);
    if (text[i] !== ":") throw new SyntaxError("Expected colon");
    i++;
    const valueStart = skipTrivia(text, i);
    const valueEnd = skipValue(text, valueStart);
    i = skipTrivia(text, valueEnd);
    let commaAfter: number | null = null;
    if (text[i] === ",") {
      commaAfter = i;
      i++;
    }
    props.set(key, { keyStart, valueStart, valueEnd, commaAfter, commaBefore });
    i = skipTrivia(text, i);
    if (text[i] === "}") return { end: i + 1, props };
    if (commaAfter === null) throw new SyntaxError("Expected comma or }");
    commaBefore = commaAfter;
  }
  throw new SyntaxError("Unterminated object");
}

function locate(
  text: string,
  path: string[],
): {
  parentStart: number;
  parentEnd: number;
  parent: Map<string, PropLoc>;
  prop: PropLoc | undefined;
} {
  let parentStart = skipTrivia(text, 0);
  if (path.length === 0) throw new Error("jsonc path must not be empty");
  let { end: parentEnd, props: parent } = skipObject(text, parentStart);
  for (let depth = 0; depth < path.length - 1; depth++) {
    const loc = parent.get(path[depth]!);
    if (!loc) {
      return { parentStart, parentEnd, parent, prop: undefined };
    }
    const valueHead = skipTrivia(text, loc.valueStart);
    if (text[valueHead] !== "{") {
      throw new SyntaxError(`jsonc path ${path.slice(0, depth + 1).join(".")} is not an object`);
    }
    parentStart = valueHead;
    ({ end: parentEnd, props: parent } = skipObject(text, parentStart));
  }
  return { parentStart, parentEnd, parent, prop: parent.get(path[path.length - 1]!) };
}

function indentOf(text: string, objectStart: number): string {
  const close = skipObject(text, objectStart).end - 1;
  const lineStart = text.lastIndexOf("\n", close);
  const closeIndent =
    lineStart >= 0 ? (text.slice(lineStart + 1, close).match(/^[ \t]*/)?.[0] ?? "") : "";
  return `${closeIndent}  `;
}

function renderValue(value: unknown, indent: string): string {
  const raw = JSON.stringify(value, null, 2);
  if (!raw.includes("\n")) return raw;
  return raw.replace(/\n/g, `\n${indent}`);
}

function withBom(text: string, fn: (body: string) => string): string {
  const bom = text.startsWith("\uFEFF");
  return (bom ? "\uFEFF" : "") + fn(bom ? text.slice(1) : text);
}

/**
 * Set `path` to `value` in JSONC object text. Missing parents along the path
 * are created as objects. Existing values at `path` are replaced in place.
 * Empty / whitespace-only input becomes a new object.
 */
export function jsoncSet(text: string, path: string[], value: unknown): string {
  if (path.length === 0) throw new Error("jsoncSet path must not be empty");
  return withBom(text, (text) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      let built: unknown = value;
      for (let i = path.length - 1; i >= 0; i--) {
        built = { [path[i]!]: built };
      }
      return `${JSON.stringify(built, null, 2)}\n`;
    }

    // Create missing parent objects from the left.
    for (let depth = 0; depth < path.length - 1; depth++) {
      const prefix = path.slice(0, depth + 1);
      let found: PropLoc | undefined;
      try {
        found = locate(text, prefix).prop;
      } catch {
        found = undefined;
      }
      if (!found) {
        text = jsoncSet(text, prefix, {});
      }
    }

    const { parentStart, parentEnd, parent, prop } = locate(text, path);
    const key = path[path.length - 1]!;
    const indent = indentOf(text, parentStart);
    const rendered = renderValue(value, indent);
    if (prop) {
      return text.slice(0, prop.valueStart) + rendered + text.slice(prop.valueEnd);
    }
    const close = parentEnd - 1;
    if (parent.size === 0) {
      return `${text.slice(0, close)}\n${indent}"${key}": ${rendered}\n${text.slice(close)}`;
    }
    // Preserve trailing-comma style so delete can drop just our line. Anchor
    // after the last value (or its trailing comma) so the comma stays on the
    // prior line and the closing brace keeps its own line — normal JSON
    // layout survives in both comma styles.
    const last = [...parent.values()].at(-1);
    if (last?.commaAfter != null) {
      // The file ends its last property with a comma: our line takes one too,
      // so jsoncDelete drops just our line via commaAfter.
      const anchor = last.commaAfter + 1;
      return `${text.slice(0, anchor)}\n${indent}"${key}": ${rendered},${text.slice(anchor)}`;
    }
    const anchor = last?.valueEnd ?? close;
    return `${text.slice(0, anchor)},\n${indent}"${key}": ${rendered}${text.slice(anchor)}`;
  });
}

/**
 * Delete `path` from JSONC object text. Missing paths are a no-op. A property
 * that is the only remaining key leaves `{}` (or the parent object empty).
 */
export function jsoncDelete(text: string, path: string[]): string {
  if (path.length === 0 || text.trim().length === 0) return text;
  return withBom(text, (text) => {
    let loc: ReturnType<typeof locate>;
    try {
      loc = locate(text, path);
    } catch {
      return text;
    }
    const { prop } = loc;
    if (!prop) return text;

    // Include the indent/newline that prefixes the key so we drop the whole line.
    let from = prop.keyStart;
    while (from > 0 && (text[from - 1] === " " || text[from - 1] === "\t")) from--;
    if (from > 0 && text[from - 1] === "\n") from--;

    if (prop.commaAfter !== null) {
      return text.slice(0, from) + text.slice(prop.commaAfter + 1);
    }
    if (prop.commaBefore !== null) {
      return text.slice(0, prop.commaBefore) + text.slice(prop.valueEnd);
    }
    return text.slice(0, from) + text.slice(prop.valueEnd);
  });
}

/**
 * Read a JSONC config file as an object: missing/blank reads as {}, a parse
 * error is the shared invalid-JSON CliError. `hint` is the adapter's
 * recovery advice for that error.
 */
export async function readJsoncObject(
  path: string,
  hint?: string,
): Promise<Record<string, unknown>> {
  const text = await readTextIfExists(path);
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw notValidJsonError(path, hint);
    throw error;
  }
  return asObject(parsed) ?? {};
}

/** Re-parse text an adapter just wrote, which is always an object or empty. */
export function parseWrittenObject(text: string): Record<string, unknown> {
  return asObject(parseJsonc(text)) ?? {};
}

/** Write a stripped file back, or unlink it when our `on` created it and nothing is left. */
export async function writeStrippedJsonc(
  agentId: string,
  path: string,
  before: string,
  after: string,
  mode: number,
): Promise<void> {
  if (after === before) return;
  if (
    Object.keys(parseWrittenObject(after)).length === 0 &&
    (await fileCreatedByUs(agentId, path))
  ) {
    await rm(path, { force: true });
  } else {
    await writeFileAtomic(path, after, { mode });
  }
}

/**
 * A throwaway overlay dir holding `files` (name -> contents) at 0600. A
 * failed write removes the dir (and any half-written key file) before
 * rethrowing; cleanup removes it after the child exits.
 */
export async function createSessionOverlay(
  prefix: string,
  files: Record<string, string>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(dir, name), contents, { mode: PRIVATE_FILE_MODE });
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
