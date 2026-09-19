import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Model } from "../api/models.js";
import { publicJson } from "../api/client.js";
import { CATALOG_TTL_MS, resolveDefault } from "./catalog.js";
import { CliError } from "../cli/errors.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { agentHome, configDir, isLoopbackHost, writeFileAtomic } from "../config.js";
import { existingFileMode } from "../fsutil.js";
import { notValidJsonError, parseJsonc, readTextIfExists, jsoncSet, jsoncDelete, swapKeyInConfig } from "./managed-file.js";
import type { AgentAdapter, DetectResult, DisableResult, EnableInput, ProbeResult, SessionLaunchInput } from "./types.js";
import { fileCreatedByUs, getAddedState, recordAddedState } from "./snapshot.js";
import { err } from "../cli/output.js";

/** OpenAI-compatible base URL OpenCode dials for every ai& model. */
export const OPENCODE_BASE_URL = "https://api.aiand.com/v1";

/** Provider id in the OpenCode config — the "aiand/" model ref prefix too. */
const OPENCODE_PROVIDER_ID = "aiand";
/**
 * Ownership marker aiand stamps so off/logout strip surgically.
 *
 * OpenCode 1.18.15 (and the published `config.json` schema) uses `.strict()`
 * at the root and on each provider object: a top-level `x-aiand` makes the
 * binary refuse to load the file (`Unrecognized key: x-aiand`). Provider
 * `options` allow extra keys, so the stamp lives there. 1.18.30 is lenient
 * at the root, which hid this on Linux CI; it is still illegal on the schema
 * and on older binaries. A legacy root marker from earlier writes still
 * counts as ours until the next `on` migrates it.
 */
const OPENCODE_MARKER_KEY = "x-aiand";
const OPENCODE_MARKER_PATH = ["provider", OPENCODE_PROVIDER_ID, "options", OPENCODE_MARKER_KEY];

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
  const trimmedBase = (baseUrl ?? "").replace(/\/+$/, "");
  try {
    const api = await publicJson<{ opencode?: { models?: Record<string, OpencodeModelEntry> } }>(
      `${trimmedBase}/v1/api.json`
    );
    const models = api.opencode?.models ?? {};
    await writeFileAtomic(
      cachePath,
      `${JSON.stringify({ fetchedAt: Date.now(), baseUrl: trimmedBase, models }, null, 2)}\n`,
      { mode: 0o600 }
    );
    return models;
  } catch (error) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as Partial<ApiJsonCache>;
      if (
        cached?.baseUrl === trimmedBase &&
        cached.models &&
        typeof cached.models === "object" &&
        typeof cached.fetchedAt === "number" &&
        Date.now() - cached.fetchedAt < CATALOG_TTL_MS
      ) {
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
 * ref, and optional provider lockdown. `models` is pre-formed — enable supplies
 * api.json's entries verbatim, sessionLaunch supplies entries derived from the
 * live Model[] catalog.
 */
export function buildOpencodeConfig({
  apiKey,
  model,
  models,
  options,
  lockdown,
}: {
  apiKey: string;
  model: string;
  models: Record<string, OpencodeModelEntry>;
  options: OpencodeProviderOptions;
  lockdown?: boolean;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: options.npm,
        name: options.name,
        options: {
          apiKey,
          baseURL: options.baseURL,
          // Nested: OpenCode's root/provider objects reject unknown keys.
          [OPENCODE_MARKER_KEY]: true,
        },
        models,
      },
    },
    model: `${OPENCODE_PROVIDER_ID}/${model}`,
  };
  if (lockdown) {
    // The ONLY provider OpenCode loads. This hides every built-in provider
    // (Anthropic, OpenAI, Gemini, Bedrock…) from the picker so /models stays
    // restricted to the ai& set we declare.
    config.enabled_providers = [OPENCODE_PROVIDER_ID];
    // Belt-and-suspenders: also explicitly disable OpenCode's Zen gateway
    // provider ("opencode", the `opencode/*` namespace — its auto-loaded
    // models are pure clutter here). disabled_providers takes priority over
    // enabled_providers, so this stays effective either way.
    config.disabled_providers = ["opencode"];
  }
  return config;
}

/**
 * Derive one OpenCode model entry from a live `Model`. There is no output-token
 * field on Model, so limit.output mirrors context_window (a serverless cap the
 * gateway enforces, and the only signal we have). Cost is the per 1M-token price
 * from the catalog, which matches OpenCode's per-million cost unit.
 * Modalities are derived from the capability list (vision→image, video→video,
 * document→pdf on top of the always-present text).
 */
function modelEntryFromCatalog(model: Model): OpencodeModelEntry {
  const caps = model.capabilities;
  const input: string[] = ["text"];
  if (caps.includes("vision")) input.push("image");
  if (caps.includes("video")) input.push("video");
  if (caps.includes("document")) input.push("pdf");
  const price = (value: string | null): number =>
    Number.parseFloat(value ?? "0");
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
 * Gateway base URL OpenCode dials: `--base-url` (trailing slashes trimmed) +
 * `/v1`, defaulting to the prod constant when no override is given. Shared
 * by enable() and sessionLaunch() so the two can never drift.
 */
function opencodeBaseURL(baseUrl?: string): string {
  const base = (baseUrl ?? "").replace(/\/+$/, "");
  return base ? `${base}/v1` : OPENCODE_BASE_URL;
}

function providerOptions(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  const provider = parsed.provider;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return undefined;
  const aiand = (provider as Record<string, unknown>)[OPENCODE_PROVIDER_ID];
  if (!aiand || typeof aiand !== "object" || Array.isArray(aiand)) return undefined;
  const options = (aiand as Record<string, unknown>).options;
  if (!options || typeof options !== "object" || Array.isArray(options)) return undefined;
  return options as Record<string, unknown>;
}

/** True when the nested options stamp or a legacy root stamp is present. */
function hasOwnershipMarker(parsed: Record<string, unknown>): boolean {
  if (parsed[OPENCODE_MARKER_KEY] === true) return true;
  return providerOptions(parsed)?.[OPENCODE_MARKER_KEY] === true;
}

/**
 * Ownership predicate: is this opencode.json ours? True only when the
 * `x-aiand` marker we stamp on every write is present and the `aiand` provider
 * baseURL is https or loopback http. Marker-only
 * (no prod-URL legacy path): this is the first shipped PR, so dual ownership
 * rules would be upgrade debt with no users to protect. A foreign provider
 * that merely reuses the "aiand" name lacks the marker, so it reads inactive
 * forever — off/logout can never delete it. A marked config with a garbage
 * URL still reads inactive (never throw).
 */
function configIsOurs(parsed: Record<string, unknown>): boolean {
  if (!hasOwnershipMarker(parsed)) return false;
  const provider = parsed.provider as Record<string, Record<string, unknown>> | undefined;
  const aiand = provider?.[OPENCODE_PROVIDER_ID] as
    | { options?: { baseURL?: unknown; apiKey?: unknown } }
    | undefined;
  const baseURL = aiand?.options?.baseURL;
  if (typeof baseURL !== "string") return false;
  try {
    const url = new URL(baseURL);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.protocol === "https:") return true;
    return isLoopbackHost(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/** Deep clone of a provider block with session key omitted — snapshot copies must not retain apiKey. */
function withoutApiKey(block: unknown): unknown {
  if (!block || typeof block !== "object" || Array.isArray(block)) return block;
  const clone = structuredClone(block) as Record<string, unknown>;
  const options = clone.options;
  if (options && typeof options === "object" && !Array.isArray(options)) {
    const rest = { ...(options as Record<string, unknown>) };
    delete rest.apiKey;
    clone.options = rest;
  }
  return clone;
}


/**
 * Tolerant read of opencode.json: OpenCode accepts JSONC, so parse with
 * comments + trailing commas stripped. Missing file is {} (probe before any
 * write); top-level non-objects are {} so a partial file can't wedge the
 * write; syntax errors surface as CliError with the standard opencode
 * recovery hint. Writes stay strict JSON.stringify (JSONC on read only).
 */
async function readOpencodeConfig(): Promise<Record<string, unknown>> {
  const path = opencodeConfigPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed: unknown = parseJsonc(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw notValidJsonError(
        path,
        "Fix it by hand, or delete it and run aiand opencode on again."
      );
    }
    throw error;
  }
}

async function probe(): Promise<ProbeResult> {
  let parsed: Record<string, unknown>;
  try {
    parsed = await readOpencodeConfig();
  } catch {
    // Missing or invalid config → inactive, never a crash (a file mid-edit
    // shouldn't wedge `opencode status`).
    return { active: false, model: null };
  }
  const rootModel = typeof parsed.model === "string" ? parsed.model : "";
  const active = configIsOurs(parsed);
  return {
    active,
    // True ai& routing: the effective root model ref whenever the config is ours.
    model: active && rootModel ? rootModel : null,
  };
}

async function enable(
  input: EnableInput
): Promise<{ model: string; filesWritten: string[]; warnings?: string[] }> {
  const path = opencodeConfigPath();
  const raw = await readTextIfExists(path);
  // Only a missing file counts as created by us: a pre-existing empty file
  // belongs to the user, and `off` must never unlink it.
  let created = false;
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    created = true;
  }
  let current: Record<string, unknown> = {};
  if (raw.trim().length !== 0) {
    try {
      const parsed: unknown = parseJsonc(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw notValidJsonError(
          path,
          "Fix it by hand, or delete it and run aiand opencode on again."
        );
      }
      current = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw notValidJsonError(
          path,
          "Fix it by hand, or delete it and run aiand opencode on again."
        );
      }
      throw error;
    }
  }

  if (
    current.provider !== undefined &&
    (typeof current.provider !== "object" || current.provider === null || Array.isArray(current.provider))
  ) {
    throw notValidJsonError(
      path,
      "Fix it by hand, or delete it and run aiand opencode on again."
    );
  }

  const currentProviders = (current.provider ?? {}) as Record<string, unknown>;
  const existingAiand = currentProviders[OPENCODE_PROVIDER_ID];
  const foreignAiand = Boolean(existingAiand) && !hasOwnershipMarker(current);

  if (foreignAiand) {
    throw new CliError("OpenCode already has a provider.aiand block that ai& does not manage.", {
      hint: "Remove or rename the foreign block by hand, then run aiand opencode on again.",
    });
  }

  const models = await getApiModels(input.baseUrl);
  const isNative = input.model === "native";
  const built = buildOpencodeConfig({
    apiKey: input.apiKey,
    model: isNative ? "" : input.model,
    models,
    options: { ...OPENCODE_OPTIONS, baseURL: opencodeBaseURL(input.baseUrl) },
  });
  const providerBlock = (built.provider as Record<string, unknown>)[OPENCODE_PROVIDER_ID];

  let text = raw;
  const warnings: string[] = [];
  text = jsoncSet(text, ["provider", OPENCODE_PROVIDER_ID], providerBlock);
  // Migrate a legacy root stamp that OpenCode 1.18.15 refuses to load.
  if (current[OPENCODE_MARKER_KEY] === true) {
    text = jsoncDelete(text, [OPENCODE_MARKER_KEY]);
  }

  const existingModel = typeof current.model === "string" ? current.model : "";
  // The prior on's model record is still live only when the file holds
  // exactly what it wrote; after an `off` or a hand edit the record is stale
  // and must not be carried forward.
  const prior = await getAddedState("opencode");
  const priorModel = prior?.model;
  const priorLive = priorModel !== undefined && existingModel === priorModel;
  // `recorded` is what added.json should carry after this run (a prior
  // model still live stays recorded). `modelWritten` is strictly "we wrote
  // a model ref this run" — the return value reports the model actually
  // in effect, so a re-on without --model names the persisted model, not
  // the requested default.
  let recorded: string | undefined;
  let modelWritten: string | undefined;
  let previousModel: string | undefined;
  if (isNative) {
    // leave the agent's own default
    recorded = priorLive ? priorModel : undefined;
    previousModel = priorLive ? prior?.previousModel : undefined;
  } else if (existingModel && !input.pinModel) {
    if (!existingModel.startsWith(`${OPENCODE_PROVIDER_ID}/`)) {
      warnings.push(`Left your existing model (${existingModel}). Pass --model to switch.`);
    }
    recorded = priorLive ? priorModel : undefined;
    previousModel = priorLive ? prior?.previousModel : undefined;
  } else {
    const nextModel = `${OPENCODE_PROVIDER_ID}/${input.model}`;
    if (existingModel.startsWith(`${OPENCODE_PROVIDER_ID}/`)) {
      // Already our ref: the restore target is what the prior on recorded —
      // never our own ref chained onto itself. A hand-written our-ref with
      // no record restores to nothing.
      previousModel = priorLive ? prior?.previousModel : undefined;
    } else {
      previousModel = existingModel || undefined;
    }
    text = jsoncSet(text, ["model"], nextModel);
    recorded = nextModel;
    modelWritten = nextModel;
  }

  // Write text as-is: jsonc edits preserve the tail, so the seed's
  // trailing-newline convention survives on and off byte-for-byte.
  // A re-on while already routed finds the file at 0600 (our lock). Carry
  // the first-on recorded mode so off still restores the user's original.
  const previousMode = prior?.previousMode ?? (await existingFileMode(path)) ?? 0o644;
  if (text !== raw) {
    await writeFileAtomic(path, text, { mode: 0o600 });
  }
  // A file our prior on created is still ours when it still carries the
  // marker (no `off` has stripped it since).
  const stillOurs = hasOwnershipMarker(current);
  await recordAddedState("opencode", {
    model: recorded,
    previousModel,
    previousMode,
    providerAiand: withoutApiKey(providerBlock),
    created: created || (prior?.created === true && stillOurs),
  });

  // Report the model now in effect: what this run wrote, else what the
  // file already had, else the requested default.
  const reportedModel = modelWritten
    ? modelWritten
    : existingModel
      ? existingModel
      : input.model;
  return {
    model: reportedModel,
    filesWritten: [path],
    warnings,
  };
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
  async disable(): Promise<DisableResult> {
    const path = opencodeConfigPath();
    const raw = await readTextIfExists(path);
    if (!raw.trim()) return { stripped: false };
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = parseJsonc(raw);
      parsed =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
    } catch {
      return { stripped: false };
    }

    const added = await getAddedState("opencode");
    const notes: string[] = [];
    let text = raw;
    let stripped = false;

    const provider = parsed.provider;
    const hasAiand =
      Boolean(provider) &&
      typeof provider === "object" &&
      !Array.isArray(provider) &&
      OPENCODE_PROVIDER_ID in (provider as Record<string, unknown>);
    if (hasAiand) {
      const currentBlock = (provider as Record<string, unknown>)[OPENCODE_PROVIDER_ID];
      const expected = added?.providerAiand;
      const looksOurs = hasOwnershipMarker(parsed);
      if (looksOurs) {
        const edited =
          expected !== undefined
            ? !isDeepStrictEqual(withoutApiKey(currentBlock), withoutApiKey(expected))
            : hasOwnershipMarker(parsed) && !configIsOurs(parsed);
        if (edited) {
          notes.push("left provider.aiand because you edited it");
          // The rest of the block is theirs; the session key and stamp are still ours.
          text = jsoncDelete(text, ["provider", OPENCODE_PROVIDER_ID, "options", "apiKey"]);
          text = jsoncDelete(text, OPENCODE_MARKER_PATH);
          stripped = true;
        } else {
          text = jsoncDelete(text, ["provider", OPENCODE_PROVIDER_ID]);
          const after = parseJsonc(text) as Record<string, unknown>;
          const left = after.provider;
          if (left && typeof left === "object" && !Array.isArray(left) && Object.keys(left).length === 0) {
            text = jsoncDelete(text, ["provider"]);
          }
          stripped = true;
        }
      }
    }

    const live = () => parseJsonc(text) as Record<string, unknown>;
    if (live()[OPENCODE_MARKER_KEY] === true) {
      text = jsoncDelete(text, [OPENCODE_MARKER_KEY]);
      stripped = true;
    }
    if (providerOptions(live())?.[OPENCODE_MARKER_KEY] === true) {
      text = jsoncDelete(text, OPENCODE_MARKER_PATH);
      stripped = true;
    }
    const rootModel = typeof live().model === "string" ? (live().model as string) : "";
    const owned = hasOwnershipMarker(parsed);
    if (added?.model && owned) {
      if (rootModel === added.model) {
        if (added.previousModel) text = jsoncSet(text, ["model"], added.previousModel);
        else text = jsoncDelete(text, ["model"]);
        stripped = true;
      } else if (rootModel) {
        notes.push("left model because you edited it");
      }
    } else if (owned && rootModel.startsWith(`${OPENCODE_PROVIDER_ID}/`)) {
      text = jsoncDelete(text, ["model"]);
      stripped = true;
    }
    // Subtract our lockdown entry without touching the user's own list:
    // legacy files (written by the pre-subtractive on) and hand-merged
    // lists can carry more than just ours, and their survivors must stay.
    const subtractListKey = (key: string, entry: string): void => {
      const value = live()[key];
      if (!Array.isArray(value) || !value.includes(entry)) return;
      const remaining = value.filter((item) => item !== entry);
      if (remaining.length === 0) {
        text = jsoncDelete(text, [key]);
      } else {
        text = jsoncSet(text, [key], remaining);
      }
      stripped = true;
    };
    if (owned) subtractListKey("enabled_providers", OPENCODE_PROVIDER_ID);
    if (owned) subtractListKey("disabled_providers", "opencode");

    if (text !== raw) {
      const next = live();
      const empty = Object.keys(next).length === 0;
      const created = added?.created === true || (await fileCreatedByUs("opencode", path));
      if (empty && created) {
        await unlink(path);
      } else {
        // The key left the file: hand back the mode the user had before on.
        await writeFileAtomic(path, text, { mode: added?.previousMode ?? 0o644 });
      }
    }

    return { stripped, notes };
  },

  async refreshKey(input: { apiKey: string; home: string }): Promise<void> {
    await swapKeyInConfig({
      apiKey: input.apiKey,
      read: async () => {
        // Only patch configs we own: a foreign `aiand`-named provider (no
        // marker, foreign URL) must keep its own key untouched.
        const current = await readOpencodeConfig();
        if (!configIsOurs(current)) return null;
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
      write: async () => {
        const path = opencodeConfigPath();
        const raw = await readTextIfExists(path);
        const next = jsoncSet(raw, ["provider", OPENCODE_PROVIDER_ID, "options", "apiKey"], input.apiKey);
        // Write as-is like enable()/disable(): the seed's trailing-newline
        // convention survives the key swap byte-for-byte.
        await writeFileAtomic(path, next, { mode: 0o600 });
        // Rebake swaps only the key literal; refresh AddedState so disable()
        // does not treat the new key as a user edit.
        const added = await getAddedState("opencode");
        if (added?.providerAiand !== undefined) {
          const provider = (await readOpencodeConfig()).provider as Record<string, unknown>;
          await recordAddedState("opencode", {
            ...added,
            providerAiand: withoutApiKey(provider[OPENCODE_PROVIDER_ID]),
          });
        }
      },
    });
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Session launches must work with NO prior `on`: the whole config rides
    // inline via OPENCODE_CONFIG_CONTENT (highest precedence). The session
    // key must NOT ride in the child env — every process the agent spawns
    // would inherit it — so it goes to a throwaway 0600 file and OpenCode's
    // documented `{file:}` substitution reads it from there. The launcher
    // always runs `cleanup` after the child exits, which unlinks the file.
    const model = input.model ?? resolveDefault(input.catalog);
    const dir = await mkdtemp(join(tmpdir(), "aiand-opencode-"));
    const keyFile = join(dir, "key");
    await writeFile(keyFile, input.apiKey, { mode: 0o600 });
    const config = buildOpencodeConfig({
      apiKey: `{file:${keyFile}}`,
      model,
      models: modelsFromCatalog(input.catalog),
      options: { ...OPENCODE_OPTIONS, baseURL: opencodeBaseURL(input.baseUrl) },
      lockdown: true,
    });
    return {
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      clear: [],
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
};