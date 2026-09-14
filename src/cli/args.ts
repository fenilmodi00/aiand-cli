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
  let parsed: Parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    }) as Parsed;
  } catch (e) {
    const [first] = (e as Error).message.split(". ");
    throw new CliError(`${(first ?? "Could not parse the arguments").replace(/\.$/, "")}.`, {
      hint: "Run the command with --help to see its flags.",
    });
  }

  const baseUrl = parsed.values["base-url"];
  if (typeof baseUrl === "string") {
    assertHttpsBaseUrl(baseUrl);
    process.env.AIAND_BASE_URL = baseUrl;
  }

  return parsed;
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
