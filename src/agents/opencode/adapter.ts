import { chmod, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { publicJson } from "../../api/client.js";
import type { Model } from "../../api/models.js";
import { CliError } from "../../cli/errors.js";
import { err } from "../../cli/output.js";
import {
  agentHome,
  configDir,
  isRoutableBaseUrl,
  trimSlash,
  writeFileAtomic,
} from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import { CATALOG_TTL_MS, resolveDefault } from "../catalog.js";
import { detectBinary } from "../detect.js";
import {
  jsoncDelete,
  jsoncSet,
  notValidJsonError,
  parseJsonc,
  readTextIfExists,
} from "../managed-file.js";
import { clearAddedState, fileCreatedByUs, getAddedState, recordAddedState } from "../snapshot.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeResult,
  SessionLaunchInput,
} from "../types.js";

/** What enable() recorded so off can leave hand-edited values alone. */
type OpencodeRecord = {
  model?: string;
  previousModel?: string;
  /** File mode before `on` locked it to 0600; disable() restores it. */
  previousMode?: number;
  providerAiand?: unknown;
  created?: boolean;
};

/** OpenAI-compatible base URL OpenCode dials for every ai& model. */
const OPENCODE_BASE_URL = "https://api.aiand.com/v1";

/** The adapter id (`aiand opencode`), also the key for its snapshot state. */
const OPENCODE_ID = "opencode";
const OPENCODE_BIN = "opencode";
/** OpenCode's own built-in Zen provider, hidden in the launcher overlay. */
const OPENCODE_ZEN_PROVIDER_ID = "opencode";
/** Provider id in the OpenCode config — the "aiand/" model ref prefix too. */
const OPENCODE_PROVIDER_ID = "aiand";
/**
 * Ownership marker aiand stamps so off/logout strip surgically. It lives on
 * provider `options` because OpenCode's config schema is `.strict()` at the
 * root and on each provider: a root `x-aiand` makes 1.18.15 refuse the file
 * (`Unrecognized key: x-aiand`), and options is the one object that allows
 * extra keys.
 */
const OPENCODE_MARKER_KEY = "x-aiand";
const OPENCODE_MARKER_PATH = ["provider", OPENCODE_PROVIDER_ID, "options", OPENCODE_MARKER_KEY];
const OPENCODE_KEY_PATH = ["provider", OPENCODE_PROVIDER_ID, "options", "apiKey"];

/** Recovery hint for an opencode.json that cannot be parsed or edited. */
const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand opencode on again.";

/**
 * One model entry inside `provider.aiand.models`: taken verbatim from
 * `/v1/api.json` for `on` (it carries a real `limit.output`), derived from the
 * Model[] catalog for session launches.
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
 * A response without a models map, or with an empty one, counts as a failed
 * fetch, so it can never replace the last good map with an empty one.
 */
async function getApiModels(baseUrl: string): Promise<Record<string, OpencodeModelEntry>> {
  const cachePath = join(configDir(), OPENCODE_API_CACHE_FILE);
  const trimmedBase = trimSlash(baseUrl);
  try {
    const api = await publicJson<{ opencode?: { models?: unknown } }>(`${trimmedBase}/v1/api.json`);
    const models = api?.opencode?.models;
    if (
      !models ||
      typeof models !== "object" ||
      Array.isArray(models) ||
      Object.keys(models).length === 0
    ) {
      throw new CliError(`${trimmedBase}/v1/api.json carried no OpenCode model map.`);
    }
    await writeFileAtomic(
      cachePath,
      `${JSON.stringify({ fetchedAt: Date.now(), baseUrl: trimmedBase, models }, null, 2)}\n`,
      { mode: PRIVATE_FILE_MODE },
    );
    return models as Record<string, OpencodeModelEntry>;
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

type OpencodeProviderOptions = {
  npm: string;
  name: string;
  baseURL: string;
};

/**
 * The one builder for OpenCode config, used by both enable() and
 * sessionLaunch() so their provider blocks cannot drift. `lockdown` restricts
 * OpenCode to the aiand provider (session launches only).
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
    // Hide every built-in provider from the picker.
    config.enabled_providers = [OPENCODE_PROVIDER_ID];
    // OpenCode's own Zen provider auto-loads its models; disabled_providers
    // wins over enabled_providers, so this holds either way.
    config.disabled_providers = [OPENCODE_ZEN_PROVIDER_ID];
  }
  return config;
}

/**
 * Model has no output-token field, so limit.output mirrors context_window (the
 * cap the gateway enforces). Catalog prices are per 1M tokens, OpenCode's unit.
 * `reasoning_options` is the key `/v1/api.json` already publishes. Session
 * launches do not fetch that map, so the same key carries the catalog levels.
 */
function modelEntryFromCatalog(model: Model): OpencodeModelEntry {
  const caps = model.capabilities;
  const input: string[] = ["text"];
  if (caps.includes("vision")) input.push("image");
  if (caps.includes("video")) input.push("video");
  if (caps.includes("document")) input.push("pdf");
  const price = (value: string | null): number => Number.parseFloat(value ?? "0");
  const levels = model.reasoning_efforts ?? [];
  return {
    name: model.name,
    attachment: caps.includes("vision") || caps.includes("attachment"),
    reasoning: levels.length > 0,
    ...(levels.length > 0 ? { reasoning_options: [{ type: "effort", values: [...levels] }] } : {}),
    temperature: true,
    tool_call: caps.includes("tools") || caps.includes("tool_calling"),
    limit: { context: model.context_window, output: model.context_window },
    modalities: { input, output: ["text"] },
    cost: {
      input: price(model.input_per_1m),
      output: price(model.output_per_1m),
      cache_read: price(model.cached_input_per_1m),
    },
  };
}

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

/** `--base-url` + `/v1`, or the production gateway when none is given. */
function opencodeBaseURL(baseUrl?: string): string {
  const base = trimSlash(baseUrl ?? "");
  return base ? `${base}/v1` : OPENCODE_BASE_URL;
}

function aiandProviderField(
  parsed: Record<string, unknown>,
  field: "options" | "models",
): Record<string, unknown> | undefined {
  const provider = parsed.provider;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return undefined;
  const aiand = (provider as Record<string, unknown>)[OPENCODE_PROVIDER_ID];
  if (!aiand || typeof aiand !== "object" || Array.isArray(aiand)) return undefined;
  const value = (aiand as Record<string, unknown>)[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

const providerOptions = (parsed: Record<string, unknown>) => aiandProviderField(parsed, "options");

/** True when our stamp sits on `provider.aiand.options`. */
function hasOwnershipMarker(parsed: Record<string, unknown>): boolean {
  return providerOptions(parsed)?.[OPENCODE_MARKER_KEY] === true;
}

/**
 * Active routing: our marker plus an https or loopback-http baseURL. A foreign
 * provider merely named `aiand` has no marker, so it never reads active and
 * off/logout never delete it; a marked block with an unusable URL reads
 * inactive instead of throwing.
 */
function configIsOurs(parsed: Record<string, unknown>): boolean {
  if (!hasOwnershipMarker(parsed)) return false;
  return isRoutableBaseUrl(providerOptions(parsed)?.baseURL);
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
 * Tolerant JSONC read of opencode.json (OpenCode accepts comments and trailing
 * commas). A missing, blank, or non-object file reads as {}; a syntax error is
 * a CliError with the recovery hint.
 */
async function readOpencodeConfig(): Promise<Record<string, unknown>> {
  const path = opencodeConfigPath();
  const text = await readTextIfExists(path);
  if (!text.trim()) return {};
  try {
    const parsed: unknown = parseJsonc(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    if (error instanceof SyntaxError) throw notValidJsonError(path, INVALID_CONFIG_HINT);
    throw error;
  }
}

async function probe(): Promise<ProbeResult> {
  let parsed: Record<string, unknown>;
  try {
    parsed = await readOpencodeConfig();
  } catch {
    // A file mid-edit must not wedge `opencode status`.
    return { active: false, model: null };
  }
  const rootModel = typeof parsed.model === "string" ? parsed.model : "";
  const active = configIsOurs(parsed);
  return {
    active,
    model: active && rootModel ? rootModel : null,
  };
}

async function enable(input: EnableInput): Promise<EnableResult> {
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
    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch (error) {
      if (error instanceof SyntaxError) throw notValidJsonError(path, INVALID_CONFIG_HINT);
      throw error;
    }
    // Unlike the tolerant read, a non-object root can't take our edits.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw notValidJsonError(path, INVALID_CONFIG_HINT);
    }
    current = parsed as Record<string, unknown>;
  }

  if (
    current.provider !== undefined &&
    (typeof current.provider !== "object" ||
      current.provider === null ||
      Array.isArray(current.provider))
  ) {
    throw notValidJsonError(path, INVALID_CONFIG_HINT);
  }

  const currentProviders = (current.provider ?? {}) as Record<string, unknown>;
  const existingAiand = currentProviders[OPENCODE_PROVIDER_ID];
  const marked = hasOwnershipMarker(current);
  const foreignAiand = Boolean(existingAiand) && !marked;

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

  const existingModel = typeof current.model === "string" ? current.model : "";
  // The prior on's model record is still live only when the file holds
  // exactly what it wrote; after an `off` or a hand edit the record is stale
  // and must not be carried forward.
  const prior = await getAddedState<OpencodeRecord>(OPENCODE_ID);
  const priorModel = prior?.model;
  const priorLive = priorModel !== undefined && existingModel === priorModel;
  // `recorded` is what added.json carries after this run; `modelWritten` is
  // set only when this run wrote the model ref.
  let recorded: string | undefined;
  let modelWritten: string | undefined;
  let previousModel: string | undefined;
  if (isNative) {
    // leave the agent's own default
    recorded = priorLive ? priorModel : undefined;
    previousModel = priorLive ? prior?.previousModel : undefined;
  } else if (existingModel && !input.pinModel) {
    if (!existingModel.startsWith(`${OPENCODE_PROVIDER_ID}/`)) {
      warnings.push(
        `Left your existing model (${existingModel}). Switch with aiand opencode on --model <id>.`,
      );
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

  // A re-on finds the file at 0600 (our lock); carry the first on's recorded
  // mode so off still restores the user's original.
  const previousMode = prior?.previousMode ?? (await existingFileMode(path)) ?? DEFAULT_FILE_MODE;
  if (text !== raw) {
    await writeFileAtomic(path, text, { mode: PRIVATE_FILE_MODE });
  } else {
    // Unchanged bytes still re-tighten a loosened file: the baked Session
    // key must stay 0600 for as long as it lives here.
    await chmod(path, PRIVATE_FILE_MODE);
  }
  // A file our prior on created is still ours when it still carries the
  // marker (no `off` has stripped it since).
  await recordAddedState(OPENCODE_ID, {
    model: recorded,
    previousModel,
    previousMode,
    providerAiand: withoutApiKey(providerBlock),
    created: created || (prior?.created === true && marked),
  });

  // Report the model now in effect: what this run wrote, else what the
  // file already had, else the requested default.
  const reportedModel = modelWritten ? modelWritten : existingModel ? existingModel : input.model;
  const ourPrefix = `${OPENCODE_PROVIDER_ID}/`;
  return {
    model: reportedModel,
    catalogModel: reportedModel.startsWith(ourPrefix)
      ? reportedModel.slice(ourPrefix.length)
      : undefined,
    filesWritten: [path],
    warnings,
  };
}

/**
 * The OpenCode release CI and the install hint pin (check-dist keeps ci.yml in step).
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const OPENCODE_VERSION = "1.18.32";

const OPENCODE_INSTALL = {
  command: `npm install -g opencode-ai@${OPENCODE_VERSION}`,
  url: "https://opencode.ai",
};

export const opencodeAdapter: AgentAdapter = {
  id: OPENCODE_ID,
  label: "OpenCode",
  bin: OPENCODE_BIN,
  install: OPENCODE_INSTALL,
  aliases: ["code"],
  detect(): DetectResult {
    return detectBinary(OPENCODE_BIN);
  },
  managedFiles(): string[] {
    return [opencodeConfigPath()];
  },
  probe,
  enable,
  async disable(): Promise<DisableResult> {
    const path = opencodeConfigPath();
    const raw = await readTextIfExists(path);
    if (!raw.trim()) {
      await clearAddedState(OPENCODE_ID);
      return { stripped: false };
    }
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = parseJsonc(raw);
      parsed =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
    } catch {
      await clearAddedState(OPENCODE_ID);
      return { stripped: false };
    }

    const added = await getAddedState<OpencodeRecord>(OPENCODE_ID);
    const notes: string[] = [];
    let text = raw;
    let stripped = false;

    // Everything below is gated on our stamp: a foreign `aiand`-named
    // provider (no marker) and an already-stripped file are left alone.
    if (hasOwnershipMarker(parsed)) {
      const provider = parsed.provider;
      const currentBlock =
        provider && typeof provider === "object" && !Array.isArray(provider)
          ? (provider as Record<string, unknown>)[OPENCODE_PROVIDER_ID]
          : undefined;
      if (currentBlock !== undefined) {
        const expected = added?.providerAiand;
        const edited =
          expected !== undefined
            ? !isDeepStrictEqual(withoutApiKey(currentBlock), withoutApiKey(expected))
            : !configIsOurs(parsed);
        if (edited) {
          notes.push("left provider.aiand because you edited it");
          // The rest of the block is theirs; the session key and stamp are still ours.
          text = jsoncDelete(text, OPENCODE_KEY_PATH);
          text = jsoncDelete(text, OPENCODE_MARKER_PATH);
        } else {
          text = jsoncDelete(text, ["provider", OPENCODE_PROVIDER_ID]);
          const left = (parseJsonc(text) as Record<string, unknown>).provider;
          if (
            left &&
            typeof left === "object" &&
            !Array.isArray(left) &&
            Object.keys(left).length === 0
          ) {
            text = jsoncDelete(text, ["provider"]);
          }
        }
      }
      stripped = true;

      // The root model is untouched by the provider edits above.
      const live = parseJsonc(text) as Record<string, unknown>;
      const rootModel = typeof live.model === "string" ? live.model : "";
      // An unpinned pre-existing `aiand/…` root model is the user's — `on`
      // left it (added.model unset) so `off` must leave it too. Do not treat
      // the prefix as ownership.
      if (added?.model) {
        if (rootModel === added.model) {
          if (added.previousModel) text = jsoncSet(text, ["model"], added.previousModel);
          else text = jsoncDelete(text, ["model"]);
        } else if (rootModel) {
          notes.push("left model because you edited it");
        }
      }
    }

    if (text !== raw) {
      const next = parseJsonc(text) as Record<string, unknown>;
      const empty = Object.keys(next).length === 0;
      const created = added?.created === true || (await fileCreatedByUs(OPENCODE_ID, path));
      if (empty && created) {
        await unlink(path);
      } else {
        // The key left the file: hand back the mode the user had before on.
        await writeFileAtomic(path, text, { mode: added?.previousMode ?? DEFAULT_FILE_MODE });
      }
    }

    // Next `on` must record the current dest mode, not the first-on mode.
    await clearAddedState(OPENCODE_ID);
    return { stripped, notes };
  },

  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    // Marker-gated like disable(): a marked config with a garbage or
    // non-loopback baseURL still holds our baked key and must be swapped. A
    // foreign `aiand`-named provider (no marker) keeps its own key untouched.
    const current = await readOpencodeConfig();
    const options = hasOwnershipMarker(current) ? providerOptions(current) : undefined;
    if (!options) return false;
    // A same-key no-op still counts as touched: an idempotent rebake reports refreshed.
    if (options.apiKey === input.apiKey) return true;
    // A rotation swaps only the key it replaced: a config baked from another
    // profile keeps routing to that profile's org.
    if (input.previousKey !== undefined && options.apiKey !== input.previousKey) return false;

    const path = opencodeConfigPath();
    const raw = await readTextIfExists(path);
    await writeFileAtomic(path, jsoncSet(raw, OPENCODE_KEY_PATH, input.apiKey), {
      mode: PRIVATE_FILE_MODE,
    });
    // Rebake swaps only the key literal; refresh AddedState so disable()
    // does not treat the new key as a user edit.
    const added = await getAddedState<OpencodeRecord>(OPENCODE_ID);
    if (added?.providerAiand !== undefined) {
      const provider = (await readOpencodeConfig()).provider as Record<string, unknown>;
      await recordAddedState(OPENCODE_ID, {
        ...added,
        providerAiand: withoutApiKey(provider[OPENCODE_PROVIDER_ID]),
      });
    }
    return true;
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Works with no prior `on`: the whole config rides inline in
    // OPENCODE_CONFIG_CONTENT. The key stays out of the child env (every
    // process the agent spawns would inherit it): it goes to a throwaway 0600
    // file read through OpenCode's `{file:}` substitution, and `cleanup`
    // removes it after the child exits. Inline config needs a concrete model.
    const model = input.model ?? resolveDefault(input.catalog, input.profileModel);
    const dir = await mkdtemp(join(tmpdir(), "aiand-opencode-"));
    const keyFile = join(dir, "key");
    await writeFile(keyFile, input.apiKey, { mode: PRIVATE_FILE_MODE });
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
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
  async openExtras(input) {
    const config = await readOpencodeConfig();
    const model = typeof config.model === "string" ? config.model : "";
    if (!model || model.startsWith(`${OPENCODE_PROVIDER_ID}/`)) return {};
    if (process.env.OPENCODE_CONFIG_CONTENT) return {};
    const wired = Object.keys(aiandProviderField(config, "models") ?? {}).map((id) => ({ id }));
    const ref = `${OPENCODE_PROVIDER_ID}/${resolveDefault(wired, input.profileModel)}`;
    return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: ref }) } };
  },
};
