import { join } from "node:path";
import type { Model } from "../../api/models.js";
import { agentHome, DEFAULT_BASE_URL, trimSlash } from "../../config.js";
import { asObject } from "../managed-file.js";

/** Provider id in providers.json and the key of its auth.json credential. */
export const COMMANDCODE_PROVIDER_ID = "aiand";
/** Model selections that route to our row are `aiand/<id>`. */
export const COMMANDCODE_SELECTION_PREFIX = `${COMMANDCODE_PROVIDER_ID}/`;
/**
 * Ownership marker aiand stamps so off/logout strip surgically.
 * It lives on the providers.json row: Command Code drops
 * unknown keys inside a model entry when it rewrites models,
 * but spreads the raw row on every write (live-proven: row
 * keys survive byte-identical after runs).
 */
const COMMANDCODE_MARKER_KEY = "managedBy";
const COMMANDCODE_MARKER = "aiand";

/** Recovery hint for a Command Code config file that cannot be parsed or edited. */
export const INVALID_CONFIG_HINT =
  "Fix it by hand, or delete it and run aiand commandcode on again.";

/**
 * Command Code's config root: ~/.commandcode/, resolved from
 * HOME (live-proven: no dedicated config-root env var exists).
 * The launcher's overlay redirects HOME, which relocates it.
 */
function commandcodeDir(): string {
  return join(agentHome(), ".commandcode");
}

export function commandcodeProvidersPath(): string {
  return join(commandcodeDir(), "providers.json");
}

export function commandcodeAuthPath(): string {
  return join(commandcodeDir(), "auth.json");
}

export function commandcodeConfigPath(): string {
  return join(commandcodeDir(), "config.json");
}

export const COMMANDCODE_MANAGED_FILES = [
  commandcodeProvidersPath,
  commandcodeAuthPath,
  commandcodeConfigPath,
] as const;

/** The `aiand` provider row in providers.json `provider`, when shaped like one. */
export function aiandRow(providers: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(asObject(providers.provider)?.[COMMANDCODE_PROVIDER_ID]);
}

/** True when the `aiand` row carries our ownership marker. */
export function isOurRow(row: Record<string, unknown> | undefined): boolean {
  return row !== undefined && row[COMMANDCODE_MARKER_KEY] === COMMANDCODE_MARKER;
}

/** The `aiand` credential block in auth.json, when it is an object. */
export function aiandCredential(
  auth: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return asObject(auth[COMMANDCODE_PROVIDER_ID]);
}

export const commandCodeBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

/**
 * The one builder for the aiand provider row in providers.json,
 * used by enable() and sessionLaunch() so the two cannot drift.
 *
 * The row carries no apiKey: Command Code resolves the request
 * key from the auth.json credential first (live-proven), and a
 * raw literal in a row is warned and ignored anyway — only
 * `$VAR`, `{env:VAR}` and `!command` reference forms are
 * honored. The ai-sdk appends `/chat/completions` to the
 * baseURL, so the route is `<origin>/v1`.
 */
export function buildCommandCodeProvider({
  baseUrl,
  catalog,
}: {
  baseUrl: string;
  catalog: Model[];
}): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  for (const model of catalog) {
    models[model.id] = { name: model.name, contextWindow: model.context_window };
  }
  return {
    name: "ai&",
    [COMMANDCODE_MARKER_KEY]: COMMANDCODE_MARKER,
    api: "openai-completions",
    baseURL: baseUrl,
    models,
  };
}
