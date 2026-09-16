import { parseArgs, type ParseArgsConfig } from "node:util";
import { assertHttpsBaseUrl } from "../config.js";
import { CliError } from "./errors.js";

type OptionsConfig = NonNullable<ParseArgsConfig["options"]>;

export const GLOBAL_OPTIONS = {
  profile: { type: "string" },
  "base-url": { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const satisfies OptionsConfig;

export type Parsed = {
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  positionals: string[];
};

export function parse(argv: string[], options: OptionsConfig = {}): Parsed {
  const merged = { ...GLOBAL_OPTIONS, ...options };
  let parsed: Parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: merged,
      allowPositionals: true,
      strict: true,
    }) as Parsed;
  } catch (e) {
    const [first] = (e as Error).message.split(". ");
    const hintBase = "Run the command with --help to see its flags.";
    const raw = /Unknown option ['"]?([^'"\s.,]+)/.exec((e as Error).message)?.[1];
    const suggestion = raw ? flagSuggestion(raw, Object.keys(merged)) : undefined;
    throw new CliError(`${(first ?? "Could not parse the arguments").replace(/\.$/, "")}.`, {
      hint: suggestion ? `${hintBase}\nDid you mean --${suggestion}?` : hintBase,
    });
  }

  const baseUrl = parsed.values["base-url"];
  if (typeof baseUrl === "string") {
    assertHttpsBaseUrl(baseUrl);
    process.env.AIAND_BASE_URL = baseUrl;
  }

  return parsed;
}

/**
 * Nearest known flag for a mistyped option, or undefined when nothing is close.
 * WHY: strict parsing rejects unknown flags with only the offending name; a
 * did-you-mean hint turns a typo like --profle into a one-line fix.
 */
export function flagSuggestion(typed: string, known: readonly string[]): string | undefined {
  const clean = (typed.replace(/^-+/, "").split("=")[0] ?? "");
  return clean.length === 0 ? undefined : nearestMatch(clean, known);
}

/**
 * Closest candidate within the shared suggestion threshold, or undefined.
 * The same Levenshtein + threshold backs unknown-command and unknown-flag
 * suggestions, so both feel identical at the terminal.
 */
export function nearestMatch(typed: string, candidates: readonly string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(typed, candidate);
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  return best && best.distance <= Math.max(2, Math.floor(typed.length / 3)) ? best.name : undefined;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

export const str = (parsed: Parsed, name: string): string | undefined => {
  const value = parsed.values[name];
  return typeof value === "string" ? value : undefined;
};

export const bool = (parsed: Parsed, name: string): boolean => parsed.values[name] === true;

export function int(parsed: Parsed, name: string): number | undefined {
  const raw = str(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new CliError(`--${name} must be a whole number (got "${raw}").`);
  }
  return value;
}

export function float(parsed: Parsed, name: string): number | undefined {
  const raw = str(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new CliError(`--${name} must be a number (got "${raw}").`);
  }
  return value;
}

export function oneOf<T extends string>(
  parsed: Parsed,
  name: string,
  allowed: readonly T[],
  fallback: T
): T {
  const raw = str(parsed, name);
  if (raw === undefined) return fallback;
  if (!allowed.includes(raw as T)) {
    throw new CliError(`--${name} must be one of: ${allowed.join(", ")} (got "${raw}").`);
  }
  return raw as T;
}
