/**
 * Surgical edits to dsh's credential store (`$DSH_HOME/.credentials.yaml`).
 *
 * dsh rewrites this file itself, comment-preserving, key by key, so aiand
 * does too: one credential ref is set or deleted at a time, never by
 * re-rendering the document. The store is parsed by dsh with `uniqueKeys`,
 * so a second `refs:` key anywhere — block or flow form — is a file that
 * refuses to boot, and both writers here rewrite the map in place instead.
 *
 * The credential file is the one place a secret can sit, so a parse error
 * never quotes the offending line: a file whose first line is a bare secret
 * must not leak its content through an error message.
 */
import { escapeRe, leadingSpaces, renderScalar, stripComment, unquote } from "./patch.js";

/** The parts of a flow-map line (`refs: {…}` plus any trailing comment):
 * text before the brace, the map's inner text, and what follows the close
 * brace. False for anything else, including a comment-less `refs:` header. */
function flowRefs(line: string): { head: string; inner: string; tail: string } | undefined {
  const plain = line.trim();
  // A comment's own braces are not part of a map, so the open brace is
  // looked for only in what precedes a trailing comment.
  const comment = plain.search(/\s#/);
  const open = (comment >= 0 ? plain.slice(0, comment) : plain).indexOf("{");
  if (open < 0) return undefined;
  let depth = 0;
  let quote = "";
  for (let i = open; i < plain.length; i++) {
    const ch = plain[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        // What follows the close brace (whitespace, maybe a comment) is
        // the user's: keep it verbatim rather than regenerating it.
        return {
          head: plain.slice(0, open + 1),
          inner: plain.slice(open + 1, i),
          tail: plain.slice(i + 1),
        };
      }
    }
  }
  throw new SyntaxError("an unterminated flow map on the refs line");
}

/** A flow map's top-level `key: value` pair, tight to its own text: the
 * whitespace on either side belongs to the seam, not to the pair. */
type FlowPair = { start: number; end: number };

/** Character ranges of a flow map's top-level `key: value` pairs, each tight
 * to its own text: the whitespace either side of a pair belongs to the seam,
 * so writers that replace a pair from `start` to `end` never claim the gap
 * the user left before the closing brace. */
function flowPairs(inner: string): FlowPair[] {
  const pairs: FlowPair[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i <= inner.length; i += 1) {
    const ch = i < inner.length ? inner[i]! : "";
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if ((depth === 0 && ch === ",") || i === inner.length) {
      const lead = /^\s*/.exec(inner.slice(start, i))?.[0].length ?? 0;
      const body = inner.slice(start, i).trim();
      if (body !== "") pairs.push({ start: start + lead, end: start + lead + body.length });
      start = i + 1;
    }
  }
  return pairs;
}

/** Whether a flow pair's key is `name`. A pair's range covers only its own
 * text — `key: value` with no surrounding whitespace — so the value read past
 * the colon stops at the pair's end rather than swallowing the next pair's
 * separator. */
function refKeyMatches(inner: string, range: FlowPair, name: string): boolean {
  const key = /^"?([^":]+)"?:/.exec(inner.slice(range.start, range.end).trim());
  return key !== null && unquote(key[1]!.trim()) === name;
}

/** A flow pair rewritten with `value`: only the text after the key's colon
 * replaced, in place, so the whitespace the user left before the closing
 * brace survives. The pair's own range ends at its last non-space character,
 * so rebuilding the pair from the colon discards that gap; splicing at the
 * colon keeps it. The colon is located in `inner`, because a nested map's
 * colon is not the key's. */
function rewriteFlowPair(inner: string, pairs: FlowPair[], at: number, value: string): string {
  const { start, end } = pairs[at]!;
  const colon = inner.indexOf(":", start);
  return `${inner.slice(0, colon + 1)} ${renderScalar(value)}${inner.slice(end)}`;
}

/** A flow map's inner text with the pair at `at` gone: its own text plus the
 * separator that joined it to a neighbour, so a map the user wrote as
 * `{ A: 'a', B: "b" }` returns with that space intact — the gap before `}`
 * sits outside the last pair's range, so deleting that pair never claims it. */
function deleteFlowPair(inner: string, pairs: FlowPair[], at: number): string {
  // A first pair owns the separator that opened the next one, so deleting it
  // must reach the next pair's start: stopping at its own end leaves a stray
  // `, ` and a map dsh refuses to parse. The cut starts at the pair's own
  // text, not at the map's opening, so the gap the user left after `{` — the
  // leading half of `{ A: 'a' }` — survives. Every later pair is reached
  // across the separator its predecessor left, so its own end is the edge.
  const [from, to] =
    at === 0
      ? [pairs[at]!.start, pairs[1]?.start ?? pairs[at]!.end]
      : [pairs[at - 1]!.end, pairs[at]!.end];
  return `${inner.slice(0, from)}${inner.slice(to)}`;
}

/** A flow map's inner text with `entry` appended after its last pair. An empty
 * map just takes the entry; a map with pairs and a gap the user left before
 * the closing brace keeps that gap, so `off` — which drops exactly the
 * separator written here — hands the file back byte for byte. */
function appendFlowEntry(inner: string, entry: string): string {
  const trimmed = inner.replace(/\s+$/, "");
  return trimmed === "" ? entry : `${trimmed}, ${entry}${inner.slice(trimmed.length)}`;
}

/** The raw value of credential ref `name` — unquoted — whether the store is
 * block (`refs:` then an indented `name: value`) or flow (`refs: {name: value}`)
 * form; dsh writes the latter once its last ref is gone, so both shapes have to
 * read back. Undefined when the ref is absent or the file is not a credentials
 * document, which callers read as a plain "not set", never an error. */
export function readCredentialRef(text: string, name: string): string | undefined {
  const lines = text.split("\n");
  const header = lines.findIndex((line) => /^refs:(?:\s|$)/.test(stripComment(line.trim())));
  if (header >= 0) {
    const flow = flowRefs(lines[header]!);
    if (flow) {
      const pair = flowPairs(flow.inner).find((range) => refKeyMatches(flow.inner, range, name));
      if (pair === undefined) return undefined;
      // The value is everything past the key's own colon, trailing gap before
      // the comma or closing brace included; unquote leaves a quoted value's
      // quotes behind unless they are stripped first.
      const colon = flow.inner.indexOf(":", pair.start);
      return unquote(flow.inner.slice(colon + 1, pair.end).trim());
    }
  }
  const key = new RegExp(`^"?${escapeRe(name)}"?:`);
  for (const line of lines) {
    const trimmed = line.trim();
    if (key.test(trimmed))
      return unquote(
        stripComment(trimmed)
          .slice(trimmed.indexOf(":") + 1)
          .trim(),
      );
  }
  return undefined;
}

/** Set credential ref `name` to `value`: rewrite its line when present, else
 * append it under `refs:`, creating the `version: 1` document for a file that
 * does not exist yet. A file that is not a credentials document is a loud
 * SyntaxError, so a foreign file is never corrupted. */
export function credentialRefSet(text: string, name: string, value: string): string {
  const entry = `  ${name}: ${renderScalar(value)}`;
  if (text.trim() === "") return `version: 1\nrefs:\n${entry}\n`;
  const lines = text.split("\n");
  const first = lines.find((line) => line.trim() !== "" && !line.trim().startsWith("#")) ?? "";
  if (!/^(version|refs):/.test(first.trim())) {
    throw new SyntaxError("not a credentials document (it must start with version: or refs:)");
  }
  const header = lines.findIndex((line) => /^refs:(?:\s|$)/.test(stripComment(line.trim())));
  if (header < 0) return `${lines.join("\n").replace(/\n$/, "")}\nrefs:\n${entry}\n`;
  const flow = flowRefs(lines[header]!);
  if (flow) {
    // A flow map (`refs: {}` is what dsh itself writes once its last ref is
    // gone): rewrite it in place. Appending a block under it instead would
    // duplicate the key, and dsh parses credentials with uniqueKeys.
    const pairs = flowPairs(flow.inner);
    const entry = `${name}: ${renderScalar(value)}`;
    const at = pairs.findIndex((range) => refKeyMatches(flow.inner, range, name));
    if (at < 0) {
      // Ours rides right after the last pair's own text, the gap the user
      // left before the closing brace staying where it was: off drops
      // exactly the `, ` written here, so the map they wrote comes back
      // byte for byte.
      return [
        ...lines.slice(0, header),
        `${flow.head}${appendFlowEntry(flow.inner, entry)}}${flow.tail}`,
        ...lines.slice(header + 1),
      ].join("\n");
    }
    // Rewrite only our own pair's value: the gap the user left before `}`
    // belongs to the map, not to us, so a rotation cannot eat it.
    const inner = rewriteFlowPair(flow.inner, pairs, at, value);
    return [
      ...lines.slice(0, header),
      `${flow.head}${inner}}${flow.tail}`,
      ...lines.slice(header + 1),
    ].join("\n");
  }
  if (stripComment(lines[header]!.trim()) !== "refs:") {
    throw new SyntaxError(
      "a refs header aiand cannot read (expected a key block or a one-line flow map)",
    );
  }
  const key = new RegExp(`^"?${escapeRe(name)}"?:`);
  for (let i = header + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (leadingSpaces(lines[i]!) < 1) break;
    if (key.test(trimmed)) {
      lines[i] = entry;
      return `${lines.join("\n")}`;
    }
  }
  // Insert after the refs block's last content line, so a following
  // `records:` section and any trailing comment keep their place.
  let at = header + 1;
  for (let i = header + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (leadingSpaces(lines[i]!) < 1) break;
    at = i + 1;
  }
  lines.splice(at, 0, entry);
  return `${lines.join("\n")}`;
}

/** Delete credential ref `name`; an emptied flow map keeps its `refs: {}`
 * line, while a block map drops its emptied header. Both forms stay single
 * maps, so there is never a second `refs:` key. A missing name is a no-op. */
export function credentialRefDelete(text: string, name: string): string {
  const lines = text.split("\n");
  const key = new RegExp(`^"?${escapeRe(name)}"?:`);
  const header = lines.findIndex((line) => /^refs:(?:\s|$)/.test(stripComment(line.trim())));
  if (header >= 0) {
    const flow = flowRefs(lines[header]!);
    if (flow) {
      // A flow map is rewritten in place; removing one key by line never
      // applies.
      const inner = flow.inner;
      const pairs = flowPairs(inner);
      const at = pairs.findIndex((range) => refKeyMatches(inner, range, name));
      if (at < 0) return text;
      // Drop the pair plus the seam that followed it. The last pair's seam is
      // the gap the user left before the closing brace, so it stays: an
      // emptied map reads `refs: {}` rather than losing their spacing, and
      // `{ A: 'a', B: "b" }` comes back with its space.
      return [
        ...lines.slice(0, header),
        `${flow.head}${deleteFlowPair(inner, pairs, at)}}${flow.tail}`,
        ...lines.slice(header + 1),
      ].join("\n");
    }
  }
  const index = lines.findIndex((line) => line.trim() !== "" && key.test(stripComment(line)));
  if (index < 0) return text;
  lines.splice(index, 1);
  const refsHeader = lines.findIndex((line) => stripComment(line.trim()) === "refs:");
  if (refsHeader >= 0) {
    const stillHolds = lines
      .slice(refsHeader + 1)
      .some(
        (line) => line.trim() !== "" && !line.trim().startsWith("#") && leadingSpaces(line) > 0,
      );
    if (!stillHolds) lines.splice(refsHeader, 1);
  }
  return `${lines.join("\n")}`;
}

/** True when only `version:`, comments and blanks are left. */
export function credentialDocumentEmpty(text: string): boolean {
  return text
    .split("\n")
    .every(
      (line) => line.trim() === "" || line.trim().startsWith("#") || /^version:/.test(line.trim()),
    );
}
