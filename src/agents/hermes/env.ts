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

/** The quote state a dotenv line leaves, carried from the state it started in. */
function quoteState(
  line: string,
  open: { single: boolean; double: boolean },
): { single: boolean; double: boolean } {
  let single = open.single;
  let double = open.double;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (single) {
      if (ch === "'" && line[i + 1] === "'") i += 1;
      else if (ch === "'") single = false;
    } else if (double) {
      if (ch === "\\") i += 1;
      else if (ch === '"') double = false;
    } else if (ch === "'") single = true;
    else if (ch === '"') double = true;
  }
  return { single, double };
}

/**
 * Split the lines into the kept ones and the dropped headers: a dotenv value
 * whose quote never closes on its own line continues onto the next lines
 * (the multi-line quoted form), so a line-wise drop must take the body with
 * the header or strand it in the file. Only a matched header is reported as
 * dropped, never a continuation line.
 */
function filterEnvLines(
  lines: string[],
  match: (line: string) => boolean,
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  let skipping = false;
  let open = { single: false, double: false };
  for (const line of lines) {
    if (skipping) {
      open = quoteState(line, open);
      skipping = open.single || open.double;
      continue;
    }
    if (!match(line)) {
      kept.push(line);
      continue;
    }
    dropped.push(line);
    open = quoteState(line, { single: false, double: false });
    skipping = open.single || open.double;
  }
  return { kept, dropped };
}

/** The `.env` without our own pair, the way off strips it. */
export function withoutOwnedEnv(lines: string[]): string[] {
  return filterEnvLines(lines, (line) => OWNED_ENV_RE.test(line)).kept;
}

/**
 * Render the routing `.env`: every other line survives byte-identical
 * (comments, blanks, unrelated keys), shadowed lines are dropped, and our
 * dedicated pair is appended. JSON.stringify quotes each value so a key
 * with spaces or # stays one dotenv entry.
 */
export function renderHermesEnv(
  existingText: string,
  { apiKey, baseUrl }: { apiKey: string; baseUrl: string },
): { text: string; droppedUserLines: string[] } {
  const droppedUserLines: string[] = [];
  const { lines, trailingNewline, eol } = splitYamlLines(existingText);
  const { kept, dropped } = filterEnvLines(lines, (line) => SHADOWED_ENV_RE.test(line));
  // Stale pairs of ours go quietly; the user's own ANTHROPIC_* lines are
  // reported, so enable() can warn and off can hand them back.
  for (const line of dropped) {
    if (!OWNED_ENV_RE.test(line)) droppedUserLines.push(line);
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
  const collected: string[] = [];
  let open = { single: false, double: false };
  for (let i = at; i < lines.length; i++) {
    const line = lines[i]!;
    collected.push(line);
    open = quoteState(line, open);
    if (!open.single && !open.double) break;
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
    let open = quoteState(line, { single: false, double: false });
    while (idx < lines.length && (open.single || open.double)) {
      open = quoteState(lines[idx]!, open);
      idx += 1;
    }
  }
  return joinYamlLines(out, trailingNewline, eol);
}
