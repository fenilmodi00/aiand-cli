import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Model } from "../api/models.js";
import { publicJson } from "../api/client.js";
import { resolveDefault } from "./catalog.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { agentHome, configDir, writeFileAtomic } from "../config.js";
import { readJsonOrEmpty, swapKeyInConfig } from "./managed-file.js";
import type { AgentAdapter, DetectResult, EnableInput, ProbeResult, SessionLaunchInput } from "./types.js";
import { err } from "../cli/output.js";

/** OpenAI-compatible base URL OpenCode dials for every ai& model. */
export const OPENCODE_BASE_URL = "https://api.aiand.com/v1";

/** Provider id in the OpenCode config — the "aiand/" model ref prefix too. */
const OPENCODE_PROVIDER_ID = "aiand";

/**
 * One model entry inside `provider.aiand.models`. Built from a live ai&
 * `Model` for session configs; for `on` the same map is taken verbatim from
 * `/v1/api.json` because that endpoint already carries OpenCode-shaped entries
 * (its `limit.output` is real, unlike the Model[] catalog which has no
 * output-token field).
 */
type OpencodeModelEntry = Record<string, unknown>;
function opencodeConfigPath(): string {
  return join(agentHome(), ".config", "opencode", "opencode.json");
}

/** Last-good `/v1/api.json` model map, so `on` survives an unreachable gateway. */
const OPENCODE_API_CACHE_FILE = "opencode-api.json";

type ApiJsonCache = {
  fetchedAt: number;
  baseUrl: string;
  models: Record<string, OpencodeModelEntry>;
};

/**
 * Live api.json carries the canonical OpenCode model map (with real
 * limit.output) — take it verbatim so the picker matches the gateway. The
 * fetched map is cached per base URL; a failed fetch falls back to the last
 * good map instead of failing `on` outright (offline machine, fixture env).
 */
async function getApiModels(baseUrl: string): Promise<Record<string, OpencodeModelEntry>> {
  const cachePath = join(configDir(), OPENCODE_API_CACHE_FILE);
  try {
    const api = await publicJson<{ opencode?: { models?: Record<string, OpencodeModelEntry> } }>(
      `${baseUrl}/v1/api.json`
    );
    const models = api.opencode?.models ?? {};
    await writeFileAtomic(
      cachePath,
      `${JSON.stringify({ fetchedAt: Date.now(), baseUrl, models }, null, 2)}\n`,
      { mode: 0o600 }
    );
    return models;
  } catch (error) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as Partial<ApiJsonCache>;
      if (cached?.baseUrl === baseUrl && cached.models && typeof cached.models === "object") {
        err("OpenCode model map unreachable; using the last cached map.");
        return cached.models as Record<string, OpencodeModelEntry>;
      }
    } catch {
      // No usable cache — fall through to the original fetch error.
    }
    throw error;
  }
}

/**
 * Options shared by every provider write: npm adapter, picker label, and the
 * gateway origin. Kept as one type so enable and sessionLaunch assemble the
 * same provider block.
 */
type OpencodeProviderOptions = {
  npm: string;
  name: string;
  baseURL: string;
};

/**
 * Assemble the OpenCode config object. BOTH enable() and sessionLaunch() build
 * through this single helper so the two shapes can never drift: a provider
 * block pointed at the gateway with a baked literal key, a root `aiand/<model>`
 * ref, and the enabled/disabled provider lockdown. `models` is pre-formed —
 * enable supplies api.json's entries verbatim, sessionLaunch supplies entries
 * derived from the live Model[] catalog.
 */
export function buildOpencodeConfig({
  apiKey,
  model,
  models,
  options,
}: {
  apiKey: string;
  model: string;
  models: Record<string, OpencodeModelEntry>;
  options: OpencodeProviderOptions;
}): Record<string, unknown> {
  return {
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: options.npm,
        name: options.name,
        options: {
          apiKey,
          baseURL: options.baseURL,
        },
        models,
      },
    },
    model: `${OPENCODE_PROVIDER_ID}/${model}`,
    // The ONLY provider OpenCode loads. This hides every built-in provider
    // (Anthropic, OpenAI, Gemini, Bedrock…) from the picker so /models stays
    // restricted to the ai& set we declare.
    enabled_providers: [OPENCODE_PROVIDER_ID],
    // Belt-and-suspenders: also explicitly disable OpenCode's Zen gateway
    // provider ("opencode", the `opencode/*` namespace — its auto-loaded
    // models are pure clutter here). disabled_providers takes priority over
    // enabled_providers, so this stays effective either way.
    disabled_providers: ["opencode"],
  };
}

/**
 * Derive one OpenCode model entry from a live `Model`. There is no output-token
 * field on Model, so limit.output mirrors context_window (a serverless cap the
 * gateway enforces, and the only signal we have). Cost is per 1M-token price
 * scaled to OpenCode's per-token unit (per_1m/1000). Modalities are derived
 * from the capability list (vision→image, video→video, document→pdf on top of
 * the always-present text).
 */
function modelEntryFromCatalog(model: Model): OpencodeModelEntry {
  const caps = model.capabilities;
  const input: string[] = ["text"];
  if (caps.includes("vision")) input.push("image");
  if (caps.includes("video")) input.push("video");
  if (caps.includes("document")) input.push("pdf");
  const price = (value: string | null): number =>
    Number.parseFloat(value ?? "0") / 1000;
  return {
    name: model.name,
    attachment: caps.includes("vision") || caps.includes("attachment"),
    reasoning: model.reasoning_efforts != null && model.reasoning_efforts.length > 0,
    temperature: true,
    tool_call: caps.includes("tool_calling"),
    limit: { context: model.context_window, output: model.context_window },
    modalities: { input, output: ["text"] },
    cost: {
      input: price(model.input_per_1m),
      output: price(model.output_per_1m),
      cache_read: price(model.cached_input_per_1m),
    },
  };
}

/**
 * Build the provider models map for a session from the live catalog. Every
 * entry is derived from a Model through modelEntryFromCatalog.
 */
function modelsFromCatalog(catalog: Model[]): Record<string, OpencodeModelEntry> {
  const out: Record<string, OpencodeModelEntry> = {};
  for (const model of catalog) out[model.id] = modelEntryFromCatalog(model);
  return out;
}

const OPENCODE_OPTIONS: OpencodeProviderOptions = {
  npm: "@ai-sdk/openai-compatible",
  name: "ai&",
  baseURL: OPENCODE_BASE_URL,
};

async function probe(): Promise<ProbeResult> {
  let provider: Record<string, unknown> | undefined;
  let model: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(opencodeConfigPath(), "utf8")) as {
      provider?: Record<string, Record<string, unknown>>;
      model?: string;
    };
    provider = parsed.provider;
    const rootModel = typeof parsed.model === "string" ? parsed.model : "";
    if (rootModel.startsWith(`${OPENCODE_PROVIDER_ID}/`)) {
      model = rootModel.slice(OPENCODE_PROVIDER_ID.length + 1);
    }
  } catch {
    // Missing or invalid config → inactive, never a crash (a file mid-edit
    // shouldn't wedge `opencode status`).
    provider = undefined;
    model = null;
  }
  const aiand = provider?.[OPENCODE_PROVIDER_ID] as
    | { options?: { baseURL?: unknown } }
    | undefined;
  const baseURL = aiand?.options?.baseURL;
  const active = typeof baseURL === "string" && baseURL.startsWith("https://api.aiand.com");
  return {
    active,
    // True ai& routing, read from the real file: the model is whatever the
    // root `model` ref says once it's ours (aiand/…), null otherwise.
    model: active ? model : null,
  };
}

async function enable(
  input: EnableInput
): Promise<{ model: string; filesWritten: string[] }> {
  const current = await readJsonOrEmpty(opencodeConfigPath(), "opencode");

  const models = await getApiModels(input.baseUrl);

  const built = buildOpencodeConfig({
    apiKey: input.apiKey,
    model: input.model,
    models,
    options: OPENCODE_OPTIONS,
  });
  // Replace only the `aiand` provider, preserving any foreign providers the
  // user already configured (same merge-preserve rule as pi.ts enable).
  const currentProviders =
    current.provider &&
    typeof current.provider === "object" &&
    !Array.isArray(current.provider)
      ? (current.provider as Record<string, unknown>)
      : {};
  const builtProvider = built.provider as Record<string, unknown>;

  const next = {
    // Preserve every unrelated key the user already had (theme, keybinds, …);
    // buildOpencodeConfig contributes model/lockdown on top.
    ...current,
    ...built,
    provider: {
      ...currentProviders,
      [OPENCODE_PROVIDER_ID]: builtProvider[OPENCODE_PROVIDER_ID],
    },
  };

  // Idempotency guard: a re-`on` whose computed config already matches the
  // file skips the rewrite entirely (keeps the first snapshot authoritative).
  if (!isDeepStrictEqual(current, next)) {
    // 0600 — the config carries a literal session key.
    await writeFileAtomic(opencodeConfigPath(), `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  return { model: input.model, filesWritten: [opencodeConfigPath()] };
}

const OPENCODE_INSTALL = INSTALL_HINTS.opencode!;

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  label: "OpenCode",
  bin: "opencode",
  install: OPENCODE_INSTALL,
  detect(): DetectResult {
    return detectBinary("opencode");
  },
  managedFiles(): string[] {
    return [opencodeConfigPath()];
  },
  probe,
  enable,
  async disable(): Promise<void> {
    // Nothing beyond manifest restore: the engine restores the snapshotted
    // config byte-for-byte, and there is no aiand-owned side file of ours to
    // clean up. A no-op is the whole contract.
    return Promise.resolve();
  },

  /**
   * Swap ONLY the `provider.aiand.options.apiKey` literal in an already-active
   * opencode.json, preserving the model ref, the full provider model map, and
   * every unrelated key. Reads/patches/writes through the same
   * readConfig/writeFileAtomic pair enable() uses (mode 0600). Idempotent.
   */
  async refreshKey(input: { apiKey: string; home: string }): Promise<void> {
    await swapKeyInConfig({
      apiKey: input.apiKey,
      read: async () => {
        const current = await readJsonOrEmpty(opencodeConfigPath(), "opencode");
        const provider = current.provider as Record<string, Record<string, unknown>> | undefined;
        const aiand = provider?.[OPENCODE_PROVIDER_ID] as
          | { options?: { apiKey?: unknown } }
          | undefined;
        // No options block yet → nothing surgical to patch; leave the file alone.
        if (!aiand?.options) return null;
        return current;
      },
      currentKey: (current) => {
        const provider = current.provider as Record<string, Record<string, unknown>>;
        const aiand = provider[OPENCODE_PROVIDER_ID] as { options: { apiKey?: unknown } };
        return aiand.options.apiKey;
      },
      apply: (current, apiKey) => {
        const provider = current.provider as Record<string, Record<string, unknown>>;
        const aiand = provider[OPENCODE_PROVIDER_ID] as { options: Record<string, unknown> };
        return {
          ...current,
          provider: {
            ...provider,
            [OPENCODE_PROVIDER_ID]: { ...aiand, options: { ...aiand.options, apiKey } },
          },
        };
      },
      write: async (next) => {
        await writeFileAtomic(opencodeConfigPath(), `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600,
        });
      },
    });
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Session launches must work with NO prior `on`: the whole config rides
    // inline via OPENCODE_CONFIG_CONTENT (highest precedence, nothing written
    // to disk), with the session key baked as the literal options.apiKey.
    // Resolve a default model from the catalog when the launcher passed none,
    // because OpenCode needs a concrete `aiand/<id>` root ref.
    const model = input.model ?? resolveDefault(input.catalog);
    const config = buildOpencodeConfig({
      apiKey: input.apiKey,
      model,
      models: modelsFromCatalog(input.catalog),
      options: OPENCODE_OPTIONS,
    });
    return {
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      clear: [],
    };
  },
};