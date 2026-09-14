import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { CliError } from "../cli/errors.js";

/**
 * Per-adapter on-disk persistence plumbing shared by every adapter that writes
 * a managed config file. A leaf module: adapters keep wire-format knowledge
 * (model maps, config translations) and delegate the read-or-empty, read-or-
 * CliError, and deep-equality mechanics here. This is internal to the agents
 * implementation — none of it is part of the AgentAdapter interface.
 *
 * Atomic writes stay in fsutil.ts (via config.js re-export); this module only
 * handles the read side.
 */

/**
 * Read a file, treating a missing file as empty content (enable() on a
 * brand-new config, probe() before any write). Anything other than ENOENT
 * propagates — a real read error is not a clean "off".
 */
export async function readTextIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
/**
 * Parse JSONC (comments + trailing commas) the way OpenCode does — its docs
 * promise "both JSON and JSONC" for opencode.json, so a user's commented
 * config must not wedge `on`. Stdlib-only: one string-aware scan strips line
 * and block comments and trailing commas, then JSON.parse. Not a general
 * JSONC parser — ponytail: quotes + escapes so a `//` or `,}` inside a string
 * literal survives; JSON.stringify output (all we ever write) needs none of
 * this.
 */
export function parseJsonc(text: string): unknown {
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
      i++; // consume the trailing slash; safe at EOF (loop exit leaves i past end)
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

/**
 * The single source of the `X is not valid JSON.` CliError for managed config
 * reads. Every adapter config read surfaces a syntax error through here so the
 * phrasing stays consistent and the malformed file is always named. `hint`, if
 * given, is attached verbatim (the per-adapter "fix it / run aiand X on again"
 * guidance).
 * @param {string} filePath absolute path of the malformed file
 * @param {string} [hint] the user-facing recovery hint
 * @returns {CliError} a ready-to-throw error naming the file
 */
export function notValidJsonError(filePath: string, hint?: string): CliError {
  return new CliError(
    `${filePath} is not valid JSON.`,
    hint === undefined ? {} : { hint }
  );
}

/**
 * Read a managed JSON config with strict enable() semantics: a missing file is
 * `{}`, invalid JSON is a CliError naming the file, and top-level non-object
 * JSON (a scalar or array) is treated as `{}` so a partial file can't wedge the
 * write. The recovery hint names the agent (`delete it and run aiand ${agent}
 * on again`) and, when `what` is given, the specific file to fix by hand.
 */
export async function readJsonOrEmpty(
  filePath: string,
  agent: string,
  what?: string
): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      const hint =
        what === undefined
          ? `Fix it by hand, or delete it and run aiand ${agent} on again.`
          : `Fix ${what} by hand, or delete it and run aiand ${agent} on again.`;
      throw notValidJsonError(filePath, hint);
    }
    throw error;
  }
}

/**
 * Idempotent key swap for a managed config: read → if the extracted key
 * already matches, no-op → else apply and write. Unifies the refreshKey shape
 * across adapters on a single `===` check for the key field (a structural
 * comparison is unnecessary once the key itself differs).
 *
 * `read` returns `null` when there is nothing to patch (missing/empty file).
 */
export async function swapKeyInConfig<T>(opts: {
  apiKey: string;
  read: () => Promise<T | null>;
  currentKey: (config: T) => unknown;
  apply: (config: T, apiKey: string) => T;
  write: (config: T) => Promise<void>;
}): Promise<void> {
  const current = await opts.read();
  if (current === null) return;
  if (opts.currentKey(current) === opts.apiKey) return;
  await opts.write(opts.apply(current, opts.apiKey));
}