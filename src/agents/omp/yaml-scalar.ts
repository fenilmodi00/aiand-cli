// Scalars for the omp YAML subset: reading plain, single- and double-quoted
// values back, and rendering any string so every YAML 1.2 reader sees the
// same single value (no line break, comment, indicator or retyped word).
import type { YamlValue } from "./yaml.js";

const NUMBER = /^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)$/;

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

/**
 * A string that may stay a plain scalar: the characters model ids, keys and
 * URLs use, starting with a letter, `_` or `/`. Anything else is quoted, so
 * no catalog string can smuggle a line break, comment, flow or tag
 * indicator, or a value another YAML reader would type differently.
 */
const SAFE_PLAIN = /^[A-Za-z_/][A-Za-z0-9_./@+=~:-]*$/;
/** Plain words YAML 1.1 or 1.2 readers turn into booleans, nulls, or numbers. */
const RESERVED_PLAIN = /^(?:y|n|yes|no|on|off|true|false|null|nan|inf)$/i;
/**
 * Characters JSON.stringify leaves raw but a YAML double-quoted scalar must
 * escape: DEL and the C1 range are not printable, NEL and U+2028/2029 are
 * line breaks a reader folds to a space, and a BOM is not content.
 */
const RAW_IN_JSON = /[\x7f-\x9f\u2028\u2029\ufeff]/g;
const NAMED_ESCAPES: Record<string, string> = {
  "\x85": "\\N",
  "\u2028": "\\L",
  "\u2029": "\\P",
};

/** Double-quote `value` with escapes every YAML 1.2 reader accepts. */
export function quoteYaml(value: string): string {
  return JSON.stringify(value).replace(RAW_IN_JSON, (char) => {
    const named = NAMED_ESCAPES[char];
    if (named !== undefined) return named;
    const code = char.charCodeAt(0);
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** Render a scalar the parser reads back identically. */
export function renderScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);
  const plain = SAFE_PLAIN.test(value) && !RESERVED_PLAIN.test(value) && !value.endsWith(":");
  return plain ? value : quoteYaml(value);
}
