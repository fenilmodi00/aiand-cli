import { CliError } from "../../cli/errors.js";

// Pure routing edits for the Hermes adapter (`config.yaml` + `.env`).
//
// Hermes keeps routing in two files under its home dir: `config.yaml` holds
// a `providers:` dict (per-provider tuning, including our `aiand` entry) and
// a top-level `model:` section (`provider:` + `default:`), while secrets live
// in `.env` under the variable `key_env` names. Upstream once read a legacy
// `custom_providers:` list; we read it for presence but only ever write the
// dict. Like the Codex minimal TOML reader, this is indent-anchored line
// surgery, never a YAML parser: unrelated keys, sections, and comments
// survive byte-identical.

/** Provider id aiand stamps into `providers:` and `model.provider:`. */
export const HERMES_PROVIDER_ID = "aiand";
/** `.env` name holding the gateway key our provider block points at. */
export const HERMES_KEY_ENV = "AIAND_HERMES_API_KEY";

/** The ownership stamp on our `providers.aiand` dict block. */
const MANAGED_BY_VALUE = "aiand";

/** Recovery hint for a `config.yaml` shape aiand cannot edit. */
const INVALID_CONFIG_HINT = "Fix config.yaml by hand, or delete it and run aiand hermes on again.";
const FOREIGN_DICT_HINT =
  "Remove or rename the foreign block by hand, then run aiand hermes on again.";
const FOREIGN_LIST_HINT =
  "Remove or rename the foreign entry by hand, then run aiand hermes on again.";

// dotenv ---------------------------------------------------------------

const ENV_LINE = /^[ ]*(?:export[ ]+)?([A-Za-z_][A-Za-z0-9_]*)[ ]*=/;

function envNameOf(line: string): string | undefined {
  return ENV_LINE.exec(line)?.[1];
}

function unquoteEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

/** Last-wins read of one `NAME=value` line (bare, quoted, or `export`). */
export function readEnvValue(text: string, name: string): string | undefined {
  let found: string | undefined;
  for (const line of text.split("\n")) {
    if (envNameOf(line) !== name) continue;
    found = unquoteEnvValue(line.slice(line.indexOf("=") + 1));
  }
  return found;
}

/**
 * Replace the first `name=` line in place and drop later duplicates, or
 * append `name=value` when absent. Every other line stays byte-identical.
 */
export function upsertEnvPair(text: string, name: string, value: string): string {
  const pair = `${name}=${value}`;
  if (text === "") return `${pair}\n`;
  const trailing = text.endsWith("\n");
  const lines = (trailing ? text.slice(0, -1) : text).split("\n");
  let done = false;
  const out: string[] = [];
  for (const line of lines) {
    if (envNameOf(line) === name) {
      if (!done) {
        out.push(pair);
        done = true;
      }
    } else {
      out.push(line);
    }
  }
  if (!done) out.push(pair);
  return `${out.join("\n")}${trailing || !done ? "\n" : ""}`;
}

/** Drop every `name=` line; anything else stays byte-identical. */
export function removeEnvPair(text: string, name: string): string {
  if (text === "") return "";
  const trailing = text.endsWith("\n");
  const kept = (trailing ? text.slice(0, -1) : text)
    .split("\n")
    .filter((line) => envNameOf(line) !== name);
  if (kept.length === 0) return "";
  return `${kept.join("\n")}${trailing ? "\n" : ""}`;
}

// YAML line surgery -----------------------------------------------------

function splitLines(text: string): { lines: string[]; trailingNewline: boolean; eol: string } {
  if (text === "") return { lines: [], trailingNewline: false, eol: "\n" };
  // A CRLF trailing EOL is two characters: slicing only the final "\n"
  // strands a "\r" on the last line and every `$`-anchored parse fails
  // (hasHermesMarker=false, pin appends a second root `providers:`).
  // Split on /\r?\n/ and rejoin with the file's EOL. (#17 P17r-rt-2)
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, text.endsWith("\r\n") ? -2 : -1) : text;
  return { lines: body.split(/\r?\n/), trailingNewline, eol };
}

function joinLines(lines: string[], trailingNewline: boolean, eol: string): string {
  if (lines.length === 0) return "";
  return `${lines.join(eol)}${trailingNewline ? eol : ""}`;
}

function leadingSpaces(line: string): string {
  return line.match(/^ */)?.[0] ?? "";
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isCommentLine(line: string): boolean {
  return /^[ ]*#/.test(line);
}

function isSignificant(line: string): boolean {
  return !isBlank(line) && !isCommentLine(line);
}

function assertNoTabs(lines: string[]): void {
  for (const line of lines) {
    if (/^[ ]*\t/.test(line)) {
      throw new CliError("config.yaml uses tab indentation, which ai& does not edit.", {
        hint: INVALID_CONFIG_HINT,
      });
    }
  }
}

const HEADER = /^([ ]*)([A-Za-z0-9_.-]+)\s*:(.*)$/;

function parseHeader(line: string): { indent: string; key: string; rest: string } | null {
  const match = HEADER.exec(line);
  if (!match) return null;
  return { indent: match[1]!, key: match[2]!, rest: match[3]! };
}

/** Strip a trailing `# comment`, quote-aware so `#` inside strings survives. */
function stripYamlComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quote !== null) {
      if (char === "\\" && quote === '"') i++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (i === 0 || /\s/.test(value[i - 1]!))) {
      return value.slice(0, i);
    }
  }
  return value;
}

/** The inline value after `key:` — "" means a block (or null) follows. */
function inlineOf(rest: string): string {
  return stripYamlComment(rest).trim();
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/** A top-level `key:` header must carry no inline value for us to edit it. */
function assertBlockHeader(line: string, what: string): void {
  const parsed = parseHeader(line);
  if (parsed && inlineOf(parsed.rest) !== "") {
    throw new CliError(
      `config.yaml has a ${what} entry ai& does not edit (${inlineOf(parsed.rest)}).`,
      { hint: INVALID_CONFIG_HINT },
    );
  }
}
/**
 * Quoted keys (`"aiand":`) are invisible to HEADER's key class,
 * so pin would append an unquoted `aiand:` beside the quoted one
 * (a duplicate key — YAML maps need unique keys) and strip would
 * leave it behind. We do not learn to edit quoted keys. (#17 P17r-rt-6)
 */
function assertNoQuotedKeys(lines: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) {
    // Tabs are already rejected by assertNoTabs, so [ ]* covers every indent.
    if (/^[ ]*["'][^"']+["']:/.test(lines[i]!)) {
      throw new CliError("config.yaml has a quoted key ai& does not edit.", {
        hint: INVALID_CONFIG_HINT,
      });
    }
  }
}

function findTopSection(lines: string[], key: string): number {
  for (let i = 0; i < lines.length; i++) {
    const header = parseHeader(lines[i]!);
    if (header && header.indent === "" && header.key === key) return i;
  }
  return -1;
}
// Ceiling (#17 P17r-rt-7): duplicate same-key top-level sections are already invalid YAML; the walker anchors to the first, leaving the rest to a by-hand repair.

/** End of a top-level section: the next significant line back at column 0.
 * A block sequence may sit at the parent key's column (`key:\n- item`),
 * which PyYAML writes by default, so column-0 dash items stay in. */
function sectionEnd(lines: string[], headerIdx: number): number {
  let end = headerIdx + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (!isSignificant(line)) {
      end++;
      continue;
    }
    if (leadingSpaces(line).length === 0 && !/^-(\s|$)/.test(line)) break;
    end++;
  }
  return end;
}

/** Shallowest significant indent in a span: the direct-children level. */
function childIndentOf(lines: string[], start: number, end: number): string | null {
  let child: string | null = null;
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    if (!isSignificant(line)) continue;
    const indent = leadingSpaces(line);
    if (child === null || indent.length < child.length) child = indent;
  }
  return child;
}
/**
 * A sequence at the direct-children indent (`providers:\n  - openai`)
 * is a sequence-valued parent: splicing `aiand:` beside the dash
 * items is unmappable YAML, so `on` would corrupt the config.
 * Column-0 dash items (PyYAML style) land at the parent's indent. (#17 P17r-rt-1)
 */
function assertNoSequenceChildren(
  lines: string[],
  start: number,
  end: number,
  childIndent: string,
): void {
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    if (!isSignificant(line) || leadingSpaces(line) !== childIndent) continue;
    if (/^-(\s|$)/.test(line.slice(childIndent.length))) {
      throw new CliError("config.yaml has a sequence-valued section ai& does not edit.", {
        hint: INVALID_CONFIG_HINT,
      });
    }
  }
}

function findChild(
  lines: string[],
  start: number,
  end: number,
  indent: string,
  key: string,
): number {
  for (let i = start; i < end; i++) {
    const header = parseHeader(lines[i]!);
    if (header && header.indent === indent && header.key === key) return i;
  }
  return -1;
}

/** Drop trailing blank lines from a splice range so separators survive. */
function trimmedEnd(lines: string[], start: number, end: number): number {
  let cut = end;
  while (cut > start && isBlank(lines[cut - 1]!)) cut--;
  return cut;
}

/** Locate our `providers.aiand` dict block; throws on inline/flow shapes. */
function locateAiand(lines: string[]): { aiandIdx: number; blockEnd: number } | null {
  const headerIdx = findTopSection(lines, "providers");
  if (headerIdx < 0) return null;
  assertBlockHeader(lines[headerIdx]!, "`providers:`");
  const end = sectionEnd(lines, headerIdx);
  const childIndent = childIndentOf(lines, headerIdx + 1, end);
  if (childIndent === null) return null;
  assertNoSequenceChildren(lines, headerIdx + 1, end, childIndent);
  // Anchored to the direct-children indent: a deeper nested `aiand:` key
  // under another provider is never ours.
  const aiandIdx = findChild(lines, headerIdx + 1, end, childIndent, HERMES_PROVIDER_ID);
  if (aiandIdx < 0) return null;
  assertBlockHeader(lines[aiandIdx]!, "`providers.aiand:`");
  const indent = leadingSpaces(lines[aiandIdx]!);
  let blockEnd = aiandIdx + 1;
  while (blockEnd < end) {
    const line = lines[blockEnd]!;
    if (isBlank(line)) {
      blockEnd++;
      continue;
    }
    // The block ends at the first non-blank line at or above our
    // indent — comments included: a sibling note (`  # about b`)
    // belongs to the next provider. Deeper comments stay inside. (#17 P17r-rt-3)
    if (leadingSpaces(line).length <= indent.length) break;
    blockEnd++;
  }
  return { aiandIdx, blockEnd };
}

/** Scalar field off the dict block; nested maps/sequences read as undefined. */
function readBlockScalar(
  lines: string[],
  aiandIdx: number,
  blockEnd: number,
  field: string,
): string | undefined {
  const childIndent = childIndentOf(lines, aiandIdx + 1, blockEnd);
  if (childIndent === null) return undefined;
  const idx = findChild(lines, aiandIdx + 1, blockEnd, childIndent, field);
  if (idx < 0) return undefined;
  const value = inlineOf(parseHeader(lines[idx]!)!.rest);
  if (value === "" || value.startsWith("{") || value.startsWith("[")) return undefined;
  return unquoteYaml(value);
}

const DASH_ITEM = /^([ ]*)-(.*)$/;

/**
 * A legacy `custom_providers:` list entry naming aiand. Entries may key the
 * provider by `name:` or `id:` (no bundled example pins the shape, so both
 * read); only the dash-line remainder and the item's own level count, so a
 * model nested deeper can never false-positive.
 */
function legacyListHasAiand(lines: string[], headerIdx: number, end: number): boolean {
  let dashIndent: string | null = null;
  let current: string[] = [];
  const items: string[][] = [];
  for (let i = headerIdx + 1; i < end; i++) {
    const line = lines[i]!;
    if (!isSignificant(line)) continue;
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
  return items.some((item) => {
    const keyed = item
      .filter((raw) => !/^[ ]*-/.test(raw))
      .map((raw) => ({ indent: leadingSpaces(raw), text: raw.trim() }));
    const nested = keyed.filter((entry) => entry.indent !== "");
    const level =
      nested.length === 0
        ? null
        : nested.reduce(
            (min, entry) => (entry.indent.length < min.length ? entry.indent : min),
            nested[0]!.indent,
          );
    return keyed.some((entry) => {
      if (entry.indent !== "" && entry.indent !== level) return false;
      const header = parseHeader(entry.text);
      if (header) {
        if (header.key !== "name" && header.key !== "id") return false;
        const value = inlineOf(header.rest);
        if (value === "" || value.startsWith("{") || value.startsWith("[")) {
          return false;
        }
        return unquoteYaml(value) === HERMES_PROVIDER_ID;
      }
      // A plain-string item (`- aiand`, bare or quoted) names
      // the provider directly — no name:/id: key to match;
      // missing it let `on` splice beside the string. (#17 P17r-rt-4)
      return entry.indent === "" && unquoteYaml(entry.text) === HERMES_PROVIDER_ID;
    });
  });
}

/** Refuse the write when a foreign legacy list entry names aiand (read-only). */
function assertNoLegacyAiand(lines: string[]): void {
  const legacyIdx = findTopSection(lines, "custom_providers");
  if (legacyIdx < 0) return;
  assertBlockHeader(lines[legacyIdx]!, "`custom_providers:`");
  if (legacyListHasAiand(lines, legacyIdx, sectionEnd(lines, legacyIdx))) {
    throw new CliError(
      "Hermes already has a custom_providers entry named aiand that ai& does not manage.",
      { hint: FOREIGN_LIST_HINT },
    );
  }
}

function foreignDictError(): CliError {
  return new CliError("Hermes already has a providers.aiand block that ai& does not manage.", {
    hint: FOREIGN_DICT_HINT,
  });
}

/**
 * The dict block we write. `transport:`/`discover_models:` are deliberately
 * omitted: SPEC T2 marks both key names unconfirmed, and no example ships in
 * this repo to confirm them against — omitting beats guessing, since
 * upstream ignores unknown keys per key anyway.
 */
function providerBlock(childIndent: string, opts: { baseUrl: string; model?: string }): string[] {
  const inner = `${childIndent}  `;
  const block = [
    `${childIndent}${HERMES_PROVIDER_ID}:`,
    `${inner}name: ${JSON.stringify(HERMES_PROVIDER_ID)}`,
    `${inner}base_url: ${JSON.stringify(opts.baseUrl)}`,
    `${inner}key_env: ${JSON.stringify(HERMES_KEY_ENV)}`,
  ];
  if (opts.model !== undefined) {
    block.push(`${inner}default_model: ${JSON.stringify(opts.model)}`);
    block.push(`${inner}models: ${JSON.stringify([opts.model])}`);
  }
  block.push(`${inner}managed_by: ${JSON.stringify(MANAGED_BY_VALUE)}`);
  return block;
}

// config.yaml reads -----------------------------------------------------

/** Dict block OR legacy list entry — the probe's presence check. */
export function hasProviderAiand(text: string): boolean {
  const { lines } = splitLines(text);
  assertNoTabs(lines);
  if (locateAiand(lines) !== null) return true;
  const legacyIdx = findTopSection(lines, "custom_providers");
  if (legacyIdx < 0) return false;
  assertBlockHeader(lines[legacyIdx]!, "`custom_providers:`");
  return legacyListHasAiand(lines, legacyIdx, sectionEnd(lines, legacyIdx));
}

/** Our `managed_by: "aiand"` stamp inside the dict block (bare or quoted). */
export function hasHermesMarker(text: string): boolean {
  const { lines } = splitLines(text);
  assertNoTabs(lines);
  const located = locateAiand(lines);
  if (!located) return false;
  return (
    readBlockScalar(lines, located.aiandIdx, located.blockEnd, "managed_by") === MANAGED_BY_VALUE
  );
}

/** Scalar field off the dict block (`base_url`, `key_env`, `default_model`, …). */
export function readProviderField(text: string, field: string): string | undefined {
  const { lines } = splitLines(text);
  assertNoTabs(lines);
  const located = locateAiand(lines);
  if (!located) return undefined;
  return readBlockScalar(lines, located.aiandIdx, located.blockEnd, field);
}

/** Scalar off the top-level `model:` section (`provider` or `default`). */
export function readModelField(text: string, field: "provider" | "default"): string | undefined {
  const { lines } = splitLines(text);
  assertNoTabs(lines);
  const headerIdx = findTopSection(lines, "model");
  if (headerIdx < 0) return undefined;
  assertBlockHeader(lines[headerIdx]!, "`model:`");
  const end = sectionEnd(lines, headerIdx);
  const childIndent = childIndentOf(lines, headerIdx + 1, end);
  if (childIndent === null) return undefined;
  const idx = findChild(lines, headerIdx + 1, end, childIndent, field);
  if (idx < 0) return undefined;
  const value = inlineOf(parseHeader(lines[idx]!)!.rest);
  if (value === "" || value.startsWith("{") || value.startsWith("[")) return undefined;
  return unquoteYaml(value);
}

// config.yaml writes ----------------------------------------------------

/**
 * Upsert our stamped dict block. A foreign `aiand` block (dict or legacy
 * list) throws with a by-hand hint and the text is never touched.
 */
export function pinHermesProvider(text: string, opts: { baseUrl: string; model?: string }): string {
  const { lines, trailingNewline, eol } = splitLines(text);
  assertNoTabs(lines);
  assertNoLegacyAiand(lines);
  const block = providerBlock("  ", opts);
  const headerIdx = findTopSection(lines, "providers");
  if (headerIdx < 0) {
    return joinLines([...lines, "providers:", ...block], true, eol);
  }
  const end = sectionEnd(lines, headerIdx);
  // The read path already refuses flow/inline `providers:`
  // values; the pin path must too, or it splices beside one. (#17 P17r-rt-5)
  assertBlockHeader(lines[headerIdx]!, "`providers:`");
  assertNoQuotedKeys(lines, headerIdx + 1, end);
  const childIndent = childIndentOf(lines, headerIdx + 1, end) ?? "  ";
  assertNoSequenceChildren(lines, headerIdx + 1, end, childIndent);
  const aiandIdx = findChild(lines, headerIdx + 1, end, childIndent, HERMES_PROVIDER_ID);
  if (aiandIdx < 0) {
    lines.splice(trimmedEnd(lines, headerIdx + 1, end), 0, ...providerBlock(childIndent, opts));
    return joinLines(lines, trailingNewline, eol);
  }
  const located = locateAiand(lines);
  if (
    !located ||
    readBlockScalar(lines, located.aiandIdx, located.blockEnd, "managed_by") !== MANAGED_BY_VALUE
  ) {
    throw foreignDictError();
  }
  lines.splice(
    aiandIdx,
    trimmedEnd(lines, aiandIdx + 1, located.blockEnd) - aiandIdx,
    ...providerBlock(childIndent, opts),
  );
  return joinLines(lines, trailingNewline, eol);
}

/**
 * Remove our stamped dict block, dropping a `providers:` left empty. Absent
 * returns the text untouched; foreign throws; legacy list entries are
 * read-only and never touched. `allowUnmarked` is for disable()'s record
 * backstop only: a Hermes rewrite may drop the unknown stamp key while the
 * record plus the dedicated key_env still prove the block is ours — the
 * caller verifies that pair, never the record alone. (#17 P17-5)
 */
export function stripHermesProvider(text: string, opts?: { allowUnmarked?: boolean }): string {
  const { lines, trailingNewline, eol } = splitLines(text);
  assertNoTabs(lines);
  const headerIdx = findTopSection(lines, "providers");
  if (headerIdx < 0) return text;
  assertBlockHeader(lines[headerIdx]!, "`providers:`");
  assertNoQuotedKeys(lines, headerIdx + 1, sectionEnd(lines, headerIdx));
  const located = locateAiand(lines);
  if (!located) return text;
  if (
    !opts?.allowUnmarked &&
    readBlockScalar(lines, located.aiandIdx, located.blockEnd, "managed_by") !== MANAGED_BY_VALUE
  ) {
    throw foreignDictError();
  }
  lines.splice(
    located.aiandIdx,
    trimmedEnd(lines, located.aiandIdx + 1, located.blockEnd) - located.aiandIdx,
  );
  if (childIndentOf(lines, headerIdx + 1, sectionEnd(lines, headerIdx)) === null) {
    lines.splice(headerIdx, 1);
  }
  return joinLines(lines, trailingNewline, eol);
}

type DefaultOp = { kind: "set"; value: string } | { kind: "delete" } | { kind: "keep" };

function writeModelSection(text: string, provider: string, op: DefaultOp): string {
  const { lines, trailingNewline, eol } = splitLines(text);
  assertNoTabs(lines);
  const headerIdx = findTopSection(lines, "model");
  if (headerIdx < 0) {
    const block = ["model:", `  provider: ${JSON.stringify(provider)}`];
    if (op.kind === "set") block.push(`  default: ${JSON.stringify(op.value)}`);
    return joinLines([...lines, ...block], true, eol);
  }
  assertBlockHeader(lines[headerIdx]!, "`model:`");
  const setChild = (key: string, rendered: string): void => {
    const end = sectionEnd(lines, headerIdx);
    const childIndent = childIndentOf(lines, headerIdx + 1, end) ?? "  ";
    assertNoSequenceChildren(lines, headerIdx + 1, end, childIndent);
    const idx = findChild(lines, headerIdx + 1, end, childIndent, key);
    if (idx >= 0) {
      lines[idx] = `${parseHeader(lines[idx]!)!.indent}${key}: ${rendered}`;
    } else {
      lines.splice(trimmedEnd(lines, headerIdx + 1, end), 0, `${childIndent}${key}: ${rendered}`);
    }
  };
  setChild("provider", JSON.stringify(provider));
  if (op.kind === "set") {
    setChild("default", JSON.stringify(op.value));
  } else if (op.kind === "delete") {
    const end = sectionEnd(lines, headerIdx);
    const childIndent = childIndentOf(lines, headerIdx + 1, end);
    if (childIndent !== null) {
      const idx = findChild(lines, headerIdx + 1, end, childIndent, "default");
      if (idx >= 0) lines.splice(idx, 1);
    }
  }
  return joinLines(lines, trailingNewline, eol);
}

/**
 * Point `model:` at our provider. With a model, `default:` is pinned too;
 * with undefined (native) only the provider rides and `default:` is dropped.
 * Other keys in the section survive.
 */
export function pinHermesModel(text: string, model: string | undefined): string {
  return writeModelSection(
    text,
    HERMES_PROVIDER_ID,
    model === undefined ? { kind: "delete" } : { kind: "set", value: model },
  );
}

/** Flip `model.provider:` to ours, keeping whatever `default:` is servable. */
export function setHermesModelProvider(text: string): string {
  return writeModelSection(text, HERMES_PROVIDER_ID, { kind: "keep" });
}

/**
 * Undo our provider flip: put back the provider `on` found (leaving
 * `default:` exactly as it is), or drop the provider line when `on` found
 * none — dropping the `model:` section too when nothing is left in it.
 * Call only when `model.provider` is ours (`aiand`); the adapter gates on
 * that so a hand-edited provider stays with a note instead.
 */
export function restoreHermesModelProvider(text: string, previous: string | undefined): string {
  if (previous !== undefined) return writeModelSection(text, previous, { kind: "keep" });
  const { lines, trailingNewline, eol } = splitLines(text);
  assertNoTabs(lines);
  const headerIdx = findTopSection(lines, "model");
  if (headerIdx < 0) return text;
  assertBlockHeader(lines[headerIdx]!, "`model:`");
  const childIndent = childIndentOf(lines, headerIdx + 1, sectionEnd(lines, headerIdx));
  if (childIndent === null) {
    lines.splice(headerIdx, 1);
    return joinLines(lines, trailingNewline, eol);
  }
  const end = sectionEnd(lines, headerIdx);
  const idx = findChild(lines, headerIdx + 1, end, childIndent, "provider");
  if (idx >= 0) lines.splice(idx, 1);
  if (childIndentOf(lines, headerIdx + 1, sectionEnd(lines, headerIdx)) === null) {
    lines.splice(headerIdx, 1);
  }
  return joinLines(lines, trailingNewline, eol);
}
