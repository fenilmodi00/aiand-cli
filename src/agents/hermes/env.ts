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
export const OWNED_ENV_RE = /^[ \t]*(?:export[ \t]+)?AIAND_HERMES_(?:API_KEY|BASE_URL)[ \t]*=/;

function envValuePattern(name: string): RegExp {
  return new RegExp(`^([ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*).*$`);
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
  const kept: string[] = [];
  const droppedUserLines: string[] = [];
  const { lines, trailingNewline, eol } = splitYamlLines(existingText);
  for (const line of lines) {
    if (!SHADOWED_ENV_RE.test(line)) {
      kept.push(line);
      continue;
    }
    // Stale pairs of ours go quietly; the user's own ANTHROPIC_* lines are
    // reported, so enable() can warn and off can hand them back.
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
  // Horizontal whitespace only: `\s` would eat the newline and capture the
  // next line's value for an empty assignment.
  const match = new RegExp(
    `^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`,
    "m",
  ).exec(text);
  if (!match) return undefined;
  const value = unquoteYaml(match[1] ?? "");
  return value === "" ? undefined : value;
}

/** Swap one dotenv variable's value in place; every other byte survives. */
export function replaceEnvValue(text: string, name: string, value: string): string {
  const pattern = envValuePattern(name);
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  // A replacer function, not a `$1...` template: a key carrying `$&` must
  // land literally, not as the matched line spliced back into itself.
  return joinYamlLines(
    lines.map((line) =>
      pattern.test(line)
        ? line.replace(pattern, (_match, prefix) => `${prefix}${JSON.stringify(value)}`)
        : line,
    ),
    trailingNewline,
    eol,
  );
}
