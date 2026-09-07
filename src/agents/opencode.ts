import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Model } from "../api/models.js";
import { publicJson } from "../api/client.js";
import { CliError } from "../cli/errors.js";
import { writeFileAtomic } from "../io/atomic.js";
import { resolveDefault } from "./catalog.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { detectForeign } from "./foreign.js";
import { agentHome } from "./paths.js";
import type { AgentAdapter, DetectResult, EnableInput, ProbeResult, SessionLaunchInput } from "./types.js";

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

/**
 * Read opencode.json with strict semantics for enable(): missing → `{}`;
 * invalid JSON → a CliError pointing the user at the malformed file.
 */
async function readConfig(): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(opencodeConfigPath(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new CliError(`${opencodeConfigPath()} is not valid JSON.`, {
        hint: "Fix it by hand, or delete it and run aiand opencode on again.",
      });
    }
    throw error;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Structural deep-equality that ignores object key order, used to skip a
 * redundant rewrite on an idempotent re-`on`. Arrays and scalars compare
 * positionally/strictly.
 */
function deepEqual(a: unknown, b: unknown): boolean {
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
    foreignTool: await detectForeign([opencodeConfigPath()]),
  };
}

async function enable(
  input: EnableInput
): Promise<{ model: string; filesWritten: string[] }> {
  const current = await readConfig();

  // Live api.json carries the canonical OpenCode model map (with real
  // limit.output) — take it verbatim so the picker matches the gateway.
  const api = await publicJson<{ opencode?: { models?: Record<string, OpencodeModelEntry> } }>(
    `${input.baseUrl}/v1/api.json`
  );
  const models = api.opencode?.models ?? {};

  const next = {
    // Preserve every unrelated key the user already had (theme, keybinds, …);
    // buildOpencodeConfig contributes provider/model/lockdown on top.
    ...current,
    ...buildOpencodeConfig({
      apiKey: input.apiKey,
      model: input.model,
      models,
      options: OPENCODE_OPTIONS,
    }),
  };

  // Idempotency guard: a re-`on` whose computed config already matches the
  // file skips the rewrite entirely (keeps the first snapshot authoritative).
  if (!deepEqual(current, next)) {
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
    // config byte-for-byte, and there is no aiand-owned file of ours to clean
    // up. A no-op is the whole contract.
    return Promise.resolve();
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