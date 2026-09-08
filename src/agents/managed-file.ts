import { readFile } from "node:fs/promises";

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
 * Structural deep-equality that ignores object key order, used to skip a
 * redundant rewrite on an idempotent re-`on`. Arrays and scalars compare
 * positionally/strictly.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const aKey = aKeys[i];
    const bKey = bKeys[i];
    if (aKey === undefined || bKey === undefined || aKey !== bKey) return false;
    if (!deepEqual(aObj[aKey], bObj[aKey])) return false;
  }
  return true;
}