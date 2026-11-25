// The routing `.env`: the dedicated credential pair aiand bakes, read back
// the same way probe() and off() do. Bytes from bytes, like the YAML
// surgery in routing.ts — no filesystem or snapshot access here.
import { joinYamlLines, splitYamlLines, unquoteYaml } from "./yaml.js";

/** `.env` name holding the gateway key our provider block points at. */
export const HERMES_PROVIDER_API_KEY_ENV = "AIAND_HERMES_API_KEY";
/**
 * The overlay/persistent `.env` name for the gateway base URL, read back
 * only by the generated provider plugin (`env_vars` in routing's
 * buildHermesProviderFiles): the `.env` defines it, the plugin declares it,
 * Hermes injects it at runtime. Named outside routing only there — no other
 * module reads it; the plugin and the `.env` meet through the built bytes.
 */
export const HERMES_PROVIDER_BASE_URL_ENV = "AIAND_HERMES_BASE_URL";

/**
 * dotenv lines the routing owns or shadows: our own dedicated pair (a stale
 * pair from a hand-copied overlay must never win over fresh routing) and the
 * user's ANTHROPIC_* entries (Hermes prefers its saved .env over process
 * env, so they must never shadow the aiand routing, whichever end of the
 * file their dotenv loader prefers).
 */
const SHADOWED_ENV_RE =
  /^[ \t]*(?:export[ \t]+)?(?:ANTHROPIC_(?:API_KEY|BASE_URL|TOKEN)|AIAND_HERMES_(?:API_KEY|BASE_URL))[ \t]*=/;
/** Only our own dedicated pair: what off strips (user lines stay). */
const OWNED_ENV_RE = /^[ \t]*(?:export[ \t]+)?AIAND_HERMES_(?:API_KEY|BASE_URL)[ \t]*=/;

function envValuePattern(name: string): RegExp {
  return new RegExp(`^([ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*).*$`);
}

type Quote = "'" | '"';

/** Where a dotenv assignment's value begins: `KEY=`, `export KEY =`, whitespace after the `=` too. */
const ASSIGNMENT_RE = /^[ \t]*(?:export[ \t]+)?[^\s=#'"][^\s=]*[ \t]*=[ \t]*/;

/**
 * The quote still open at the end of `text`, which starts inside a value
 * opened with `quote`. Nothing after the closing quote counts, so
 * `A="x" it's` leaves nothing open.
 */
function scanQuoted(text: string, quote: Quote): Quote | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'" && text[i + 1] === "'") i += 1;
      else if (ch === "'") return null;
    } else if (ch === "\\") {
      i += 1;
    } else if (ch === '"') {
      return null;
    }
  }
  return quote;
}

/**
 * The quote an entry's first line leaves open: only a quote straight after
 * the `=` opens a value, as in python-dotenv. A stray quote inside an unquoted
 * value (`GREETING=it's fine`), a comment, or a line that is no assignment
 * opens nothing, so the lines after it stay visible to every edit.
 */
function quoteOpenedBy(header: string): Quote | null {
  const assignment = ASSIGNMENT_RE.exec(header);
  if (!assignment) return null;
  const quote = header[assignment[0].length];
  if (quote !== "'" && quote !== '"') return null;
  return scanQuoted(header.slice(assignment[0].length + 1), quote);
}

/**
 * Group the lines into dotenv entries: a value whose quote never closes on
 * its own line continues onto the next lines (the multi-line quoted form),
 * so a matched header takes its body with it. `matched` is decided on the
 * header alone, never a continuation line.
 */
function envEntries(
  lines: string[],
  match: (line: string) => boolean,
): { lines: string[]; matched: boolean }[] {
  const entries: { lines: string[]; matched: boolean }[] = [];
  let open: Quote | null = null;
  for (const line of lines) {
    if (open !== null) {
      entries.at(-1)!.lines.push(line);
      open = scanQuoted(line, open);
      continue;
    }
    entries.push({ lines: [line], matched: match(line) });
    open = quoteOpenedBy(line);
  }
  return entries;
}

/** Lines of the unmatched entries only. */
function keepUnmatched(lines: string[], match: (line: string) => boolean): string[] {
  return envEntries(lines, match).flatMap((entry) => (entry.matched ? [] : entry.lines));
}

/** The `.env` without our own pair, the way off strips it. */
export function withoutOwnedEnv(lines: string[]): string[] {
  return keepUnmatched(lines, (line) => OWNED_ENV_RE.test(line));
}

/**
 * What persistent `on` prefixes each line of a set-aside user entry with.
 * The entry stays in the user's own `.env`, commented out, so it is never
 * copied anywhere else (the record used to hold it in plaintext) and a
 * multi-line value comes back whole.
 */
const SET_ASIDE_PREFIX = "# aiand set aside: ";

/** Put set-aside entries back: every line that carries our prefix loses it. */
export function restoreSetAsideEnv(lines: string[]): string[] {
  return lines.map((line) =>
    line.startsWith(SET_ASIDE_PREFIX) ? line.slice(SET_ASIDE_PREFIX.length) : line,
  );
}

/**
 * Render the routing `.env`: every other line survives byte-identical
 * (comments, blanks, unrelated keys), shadowed entries are taken out of
 * play, and our dedicated pair is appended. JSON.stringify quotes each value
 * so a key with spaces or # stays one dotenv entry.
 *
 * `setAside: "comment"` (persistent `on`) comments the user's shadowing
 * entries out in place, for `off` to restore; the default drops them, which
 * is what a throwaway overlay wants, along with any entries a persistent
 * `on` already set aside, so the overlay never carries a copy.
 */
export function renderHermesEnv(
  existingText: string,
  { apiKey, baseUrl }: { apiKey: string; baseUrl: string },
  { setAside = "drop" }: { setAside?: "comment" | "drop" } = {},
): { text: string; droppedUserLines: string[] } {
  const droppedUserLines: string[] = [];
  const { lines, trailingNewline, eol } = splitYamlLines(existingText);
  const kept: string[] = [];
  for (const entry of envEntries(lines, (line) => SHADOWED_ENV_RE.test(line))) {
    const header = entry.lines[0]!;
    if (!entry.matched) {
      if (setAside === "drop" && header.startsWith(SET_ASIDE_PREFIX)) continue;
      kept.push(...entry.lines);
      continue;
    }
    // Stale pairs of ours go quietly; the user's own ANTHROPIC_* entries are
    // reported, so enable() can warn.
    if (OWNED_ENV_RE.test(header)) continue;
    droppedUserLines.push(header);
    if (setAside === "comment") kept.push(...entry.lines.map((line) => SET_ASIDE_PREFIX + line));
  }
  const joined = joinYamlLines(kept, trailingNewline && kept.length > 0, eol);
  const prefix = joined === "" ? "" : joined.endsWith(eol) ? joined : `${joined}${eol}`;
  return {
    text:
      `${prefix}${HERMES_PROVIDER_API_KEY_ENV}=${JSON.stringify(apiKey)}${eol}` +
      `${HERMES_PROVIDER_BASE_URL_ENV}=${JSON.stringify(baseUrl)}${eol}`,
    droppedUserLines,
  };
}

/** The value of one dotenv variable, unquoted, or undefined when absent/empty. */
export function readEnvValue(text: string, name: string): string | undefined {
  const pattern = new RegExp(
    // Horizontal whitespace only: `\s` would eat the newline and capture the
    // next line's value for an empty assignment.
    `^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`,
  );
  const { lines } = splitYamlLines(text);
  const at = lines.findIndex((line) => pattern.test(line));
  if (at === -1) return undefined;
  // A quoted value that never closes on its own line continues onto the
  // next lines: reading only the header would truncate the user's value.
  const collected: string[] = [lines[at]!];
  let open = quoteOpenedBy(lines[at]!);
  for (let i = at + 1; open !== null && i < lines.length; i++) {
    collected.push(lines[i]!);
    open = scanQuoted(lines[i]!, open);
  }
  const raw = collected
    .map((line, i) => (i === 0 ? (pattern.exec(line)![1] ?? "") : line.trim()))
    .join("\n");
  const value = unquoteYaml(raw.trim());
  return value === "" ? undefined : value;
}

/** Swap one dotenv variable's value in place; every other byte survives. */
export function replaceEnvValue(text: string, name: string, value: string): string {
  const pattern = envValuePattern(name);
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  const out: string[] = [];
  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx]!;
    if (!pattern.test(line)) {
      out.push(line);
      idx += 1;
      continue;
    }
    // A replacer function, not a `$1...` template: a key carrying `$&` must
    // land literally, not as the matched line spliced back into itself.
    out.push(line.replace(pattern, (_match, prefix) => `${prefix}${JSON.stringify(value)}`));
    idx += 1;
    // The whole multi-line quoted value goes: leaving its continuation lines
    // behind would strand them as a new (invalid) entry.
    let open = quoteOpenedBy(line);
    while (idx < lines.length && open !== null) {
      open = scanQuoted(lines[idx]!, open);
      idx += 1;
    }
  }
  return joinYamlLines(out, trailingNewline, eol);
}
