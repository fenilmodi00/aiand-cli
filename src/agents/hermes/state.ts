// The Hermes adapter's shared reading layer: where the managed files live,
// what `on` recorded, and the one ownership question every verb asks —
// "is this providers.aiand block ours?". Split from adapter.ts by the
// repo's 650-line module rule; nothing here touches the filesystem beyond
// reading, and the record holds no secret (raw model lines, modes, flags).
import { join } from "node:path";
import { agentHome, DEFAULT_BASE_URL, isRoutableBaseUrl, trimSlash } from "../../config.js";
import { readTextIfExists } from "../managed-file.js";
import { getAddedState } from "../snapshot.js";
import type { ProbeResult } from "../types.js";
import { HERMES_PROVIDER_API_KEY_ENV, readEnvValue } from "./env.js";
import {
  HERMES_PROVIDER_ID,
  hasHermesMarker,
  hasProviderAiand,
  type ModelFieldSpot,
  readModelField,
  readProviderField,
} from "./routing.js";

export const HERMES_ID = "hermes";
export const HERMES_BIN = "hermes";

/** Hermes's home: the real one persistent wiring writes, the launcher overlays. */
export const hermesHome = () => process.env.HERMES_HOME || join(agentHome(), ".hermes");
export const hermesEnvPath = () => join(hermesHome(), ".env");
export const hermesConfigPath = () => join(hermesHome(), "config.yaml");
export const hermesProviderDir = () =>
  join(hermesHome(), "plugins", "model-providers", HERMES_PROVIDER_ID);
export const hermesInitPyPath = () => join(hermesProviderDir(), "__init__.py");
export const hermesPluginYamlPath = () => join(hermesProviderDir(), "plugin.yaml");

/**
 * What enable() recorded so off can tell its values from the user's. The
 * baked key never appears here: only raw `model:` lines (ids, no secrets),
 * file modes, created flags, and the shadowed env lines off hands back.
 */
export type HermesRecord = {
  /** Where the `provider:` line sat before on (undefined = absent, or already ours). */
  previousProviderSpot?: ModelFieldSpot;
  /** Where the `default:` line sat before on (undefined = absent). */
  previousDefaultSpot?: ModelFieldSpot;
  /**
   * Where the `base_url:` line sat before on (undefined = absent). Hermes
   * prefers it over the provider's own endpoint whenever the provider
   * matches, so on drops it; off puts it back exactly there.
   */
  previousBaseUrlSpot?: ModelFieldSpot;
  /** The default this on wrote; off hands back or removes it. */
  wroteDefault?: string;
  /** Whether this on routed the top-level provider through aiand. */
  wroteProvider?: boolean;
  /** Base URL this on wrote into the provider block; refreshKey's repoint proof. */
  wroteBaseUrl?: string;
  /** File mode before `on` wrote it, per file off rewrites. */
  previousEnvMode?: number;
  previousConfigMode?: number;
  /** Whether each file is ours to unlink once stripped empty. */
  createdEnv?: boolean;
  createdConfig?: boolean;
  createdPlugin?: boolean;
  /** User ANTHROPIC_* lines enable() set aside; off appends them back. */
  strippedEnvLines?: string[];
};

/**
 * The base URL the `aiand` provider dials: `--base-url` + `/v1`, or the
 * production gateway. Hermes's `chat_completions` transport posts to
 * `${base_url}/chat/completions` (OpenAI-compatible: the docs show
 * `https://openrouter.ai/api/v1`, `http://localhost:11434/v1`, and "if a
 * server implements /v1/chat/completions, you can point Hermes at it"), so
 * the stored base_url carries `/v1` like codex/opencode to reach
 * `/v1/chat/completions` (and `/v1/models` for discovery).
 */
export function hermesBaseUrl(baseUrl?: string): string {
  return `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;
}

/**
 * The one ownership rule every verb shares: the `providers.aiand` block is
 * ours while our stamp sits on it, or while the prior on's record plus a
 * key_env still naming the dedicated var prove it (a Hermes rewrite may
 * drop the stamp). A repointed block is the user's even with a live record;
 * a foreign block merely named `aiand` never passes.
 */
export function hermesBlockIsOurs(configText: string, added: HermesRecord | null): boolean {
  if (hasHermesMarker(configText)) return true;
  return added !== null && readProviderField(configText, "key_env") === HERMES_PROVIDER_API_KEY_ENV;
}

/** Whether a wired home is live: our block, our key var, our endpoint, our key. */
export async function probe(): Promise<ProbeResult> {
  try {
    const [configText, envText] = await Promise.all([
      readTextIfExists(hermesConfigPath()),
      readTextIfExists(hermesEnvPath()),
    ]);
    if (!hasProviderAiand(configText)) return { active: false, model: null };
    const marked = hasHermesMarker(configText);
    // Always load the record: wroteBaseUrl is how a stamped block that the
    // user repointed stops counting as on. A missing record falls back to
    // the gateway default, same as refreshKey.
    const added = await getAddedState<HermesRecord>(HERMES_ID);
    if (!hermesBlockIsOurs(configText, marked ? null : added))
      return { active: false, model: null };
    // Same repoint rule as refreshKey and off: a block aimed at the user's
    // origin or env var is not routing through ai&, even with the stamp.
    if (readProviderField(configText, "key_env") !== HERMES_PROVIDER_API_KEY_ENV) {
      return { active: false, model: null };
    }
    if (readProviderField(configText, "base_url") !== (added?.wroteBaseUrl ?? hermesBaseUrl())) {
      return { active: false, model: null };
    }
    if (!isRoutableBaseUrl(readProviderField(configText, "base_url"))) {
      return { active: false, model: null };
    }
    if (readEnvValue(envText, HERMES_PROVIDER_API_KEY_ENV) === undefined) {
      return { active: false, model: null };
    }
    return { active: true, model: readModelField(configText, "default") ?? null };
  } catch {
    // A file mid-edit must not wedge `hermes status`.
    return { active: false, model: null };
  }
}
