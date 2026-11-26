import { chmod, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CliError } from "../../cli/errors.js";
import {
  agentHome,
  commandName,
  DEFAULT_BASE_URL,
  isRoutableBaseUrl,
  trimSlash,
  writeFileAtomic,
} from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import { resolveDefault } from "../catalog.js";
import { detectBinary } from "../detect.js";
import { takeFlagValues } from "../launch.js";
import {
  asObject,
  jsoncDelete,
  jsoncGet,
  jsoncSet,
  notValidJsonError,
  parseJsonc,
  readTextIfExists,
  writeKeyFile,
} from "../managed-file.js";
import { makeOverlayDir } from "../overlays.js";
import { clearAddedState, fileCreatedByUs, getAddedState, recordAddedState } from "../snapshot.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeDetail,
  ProbeResult,
  SessionLaunchInput,
} from "../types.js";
import { getApiModels, modelsFromCatalog, type OpencodeModelEntry } from "./models.js";

/** What enable() recorded so off can leave hand-edited values alone. */
type OpencodeRecord = {
  model?: string;
  previousModel?: string;
  /** `small_model` (titles, summaries), written beside `model` and handed back alike. */
  smallModel?: string;
  previousSmallModel?: string;
  /** File mode before `on` locked it to 0600; disable() restores it. */
  previousMode?: number;
  providerAiand?: unknown;
  created?: boolean;
};

/** OpenAI-compatible base URL OpenCode dials for every ai& model. */
const OPENCODE_BASE_URL = "https://api.aiand.com/v1";

/** Host of the gateway the CLI itself dials, for native-key routing checks. */
const GATEWAY_HOST = new URL(DEFAULT_BASE_URL).hostname;

/** The adapter id (`aiand opencode`), also the key for its snapshot state. */
const OPENCODE_ID = "opencode";
const OPENCODE_BIN = "opencode";
/** OpenCode's own built-in Zen provider, hidden in the launcher overlay. */
const OPENCODE_ZEN_PROVIDER_ID = "opencode";
/** Provider id in the OpenCode config — the "<commandName>/" model ref prefix too. */
const OPENCODE_PROVIDER_ID = commandName();
/**
 * Ownership marker aiand stamps so off/logout strip surgically. It lives on
 * provider `options` because OpenCode's config schema is `.strict()` at the
 * root and on each provider: a root `x-aiand` makes 1.18.15 refuse the file
 * (`Unrecognized key: x-aiand`), and options is the one object that allows
 * extra keys.
 */
const OPENCODE_MARKER_KEY = `x-${OPENCODE_PROVIDER_ID}`;
const OPENCODE_MARKER_PATH = ["provider", OPENCODE_PROVIDER_ID, "options", OPENCODE_MARKER_KEY];
const OPENCODE_KEY_PATH = ["provider", OPENCODE_PROVIDER_ID, "options", "apiKey"];

/** Recovery hint for an opencode.json that cannot be parsed or edited. */
const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand opencode on again.";

function opencodeConfigPath(): string {
  return join(agentHome(), ".config", "opencode", "opencode.json");
}

type OpencodeProviderOptions = {
  npm: string;
  name: string;
  baseURL: string;
  /** Attribution: the gateway logs this per request to identify the agent. */
  headers: { "x-aiand-agent": string };
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
          // Attribution: the gateway logs this per request to identify
          // the agent. options is the extra-keys-tolerant object, and
          // the pair rides inside the block `off` strips.
          headers: options.headers,
          // Nested: OpenCode's root/provider objects reject unknown keys.
          [OPENCODE_MARKER_KEY]: true,
        },
        models,
      },
    },
    model: `${OPENCODE_PROVIDER_ID}/${model}`,
  };
  if (lockdown) {
    // Titles and summaries on the same model: left unset, OpenCode picks its
    // own small model, which may be one the user did not choose.
    config.small_model = config.model;
    // Hide every built-in provider from the picker.
    config.enabled_providers = [OPENCODE_PROVIDER_ID];
    // OpenCode's own Zen provider auto-loads its models; disabled_providers
    // wins over enabled_providers, so this holds either way.
    config.disabled_providers = [OPENCODE_ZEN_PROVIDER_ID];
  }
  return config;
}

const OPENCODE_OPTIONS: OpencodeProviderOptions = {
  npm: "@ai-sdk/openai-compatible",
  name: "ai&",
  baseURL: OPENCODE_BASE_URL,
  headers: { "x-aiand-agent": "opencode" },
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
 * Raw api keys of every provider in opencode.json whose baseURL reaches
 * the ai& gateway (same host the CLI dials), skipping the provider row
 * with no apiKey. The CLI-baked row (marker present) is excluded —
 * bakedKey/recordAgentKey already record that one. Never throws: a
 * missing, unreadable, or malformed config returns [].
 */
async function opencodeNativeAiandKeys(): Promise<string[]> {
  let parsed: Record<string, unknown>;
  try {
    parsed = await readOpencodeConfig();
  } catch {
    return [];
  }
  const provider = parsed.provider;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return [];
  const providers = provider as Record<string, unknown>;
  const ours = hasOwnershipMarker(parsed);
  const keys: string[] = [];
  for (const id of Object.keys(providers)) {
    const block = providers[id];
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const options = (block as Record<string, unknown>).options;
    if (!options || typeof options !== "object" || Array.isArray(options)) continue;
    const baseURL = (options as Record<string, unknown>).baseURL;
    if (typeof baseURL !== "string") continue;
    let host: string;
    try {
      host = new URL(baseURL).hostname;
    } catch {
      continue; // not a URL — not a gateway route
    }
    if (host !== GATEWAY_HOST) continue;
    if (ours && id === OPENCODE_PROVIDER_ID) continue;
    const key = (options as Record<string, unknown>).apiKey;
    if (typeof key === "string" && key !== "") keys.push(key);
  }
  return keys;
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

async function probeDetail(): Promise<ProbeDetail> {
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
    ...(active ? { baseUrl: String(providerOptions(parsed)?.baseURL) } : {}),
  };
}

async function probe(): Promise<ProbeResult> {
  const { active, model } = await probeDetail();
  return { active, model };
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
  const existingSmall = typeof current.small_model === "string" ? current.small_model : "";
  const smallLive = prior?.smallModel !== undefined && existingSmall === prior.smallModel;
  // Untouched by this run: the prior record stands only while the file holds it.
  let recordedSmall = smallLive ? prior?.smallModel : undefined;
  let previousSmall = smallLive ? prior?.previousSmallModel : undefined;
  if (isNative) {
    // leave the agent's own default
    recorded = priorLive ? priorModel : undefined;
    previousModel = priorLive ? prior?.previousModel : undefined;
  } else if (existingModel && !input.pinModel) {
    if (!existingModel.startsWith(`${OPENCODE_PROVIDER_ID}/`)) {
      warnings.push(
        `Left your existing model (${existingModel}). Switch with aiand opencode on --model <id>.`,
      );
    } else if (existingSmall === "" || smallLive) {
      // An ai& model kept: titles and summaries follow it (an `on` from
      // before small_model was written left it to OpenCode's own pick).
      text = jsoncSet(text, ["small_model"], existingModel);
      recordedSmall = existingModel;
    }
    recorded = priorLive ? priorModel : undefined;
    previousModel = priorLive ? prior?.previousModel : undefined;
  } else {
    // The root model is read through OpenCode's own `{env:}`/`{file:}`
    // substitution, so only an id the cleaned map carries may be written.
    if (!Object.hasOwn(models, input.model)) {
      throw new CliError(`OpenCode cannot be pointed at ${input.model}.`, {
        hint: "Pass --model with an id from `aiand models`.",
      });
    }
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
    // Titles and summaries on the same model: left unset, OpenCode picks its
    // own small model, which may be one the user did not choose.
    previousSmall = smallLive ? prior?.previousSmallModel : existingSmall || undefined;
    text = jsoncSet(text, ["small_model"], nextModel);
    recordedSmall = nextModel;
  }

  // A re-on finds the file at 0600 (our lock); carry the first on's recorded
  // mode so off still restores the user's original.
  const previousMode = prior?.previousMode ?? (await existingFileMode(path)) ?? DEFAULT_FILE_MODE;
  if (text !== raw) {
    await writeKeyFile(path, text, { mode: PRIVATE_FILE_MODE, agentId: OPENCODE_ID });
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
    smallModel: recordedSmall,
    previousSmallModel: previousSmall,
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
  launchModelFlags: ["--model", "-m"],
  aliases: ["code"],
  nativeAiandKeys: opencodeNativeAiandKeys,
  detect(): DetectResult {
    return detectBinary(OPENCODE_BIN);
  },
  carriesWiring: (text) => text.includes(`"${OPENCODE_MARKER_KEY}"`),
  managedFiles(): string[] {
    return [opencodeConfigPath()];
  },
  probe,
  bakedBaseUrl: async () => (await probeDetail()).baseUrl,
  enable,
  async bakedKey(): Promise<string | null> {
    // The key OpenCode sends is the one in our provider block. A block
    // without our marker is the user's, and its key is not ours to claim.
    const raw = await readTextIfExists(opencodeConfigPath());
    if (!raw) return null;
    const marker = jsoncGet(raw, OPENCODE_MARKER_PATH);
    if (marker !== true) return null;
    const key = jsoncGet(raw, OPENCODE_KEY_PATH);
    return typeof key === "string" && key.length > 0 ? key : null;
  },
  async disable(): Promise<DisableResult> {
    const path = opencodeConfigPath();
    const raw = await readTextIfExists(path);
    if (!raw.trim()) {
      await clearAddedState(OPENCODE_ID);
      return { stripped: false };
    }
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = asObject(parseJsonc(raw));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      // Unreadable is not "nothing to turn off": the key may still be in
      // there. Keep the record so off can tell our values from the user's
      // once the file is fixed (Claude Code's rule).
      return {
        stripped: false,
        notes: [
          `${path} is not valid JSON and may still hold your ai& key; fix it, then run aiand opencode off again.`,
        ],
      };
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
      const small = typeof live.small_model === "string" ? live.small_model : "";
      if (added?.smallModel) {
        if (small === added.smallModel) {
          if (added.previousSmallModel) {
            text = jsoncSet(text, ["small_model"], added.previousSmallModel);
          } else text = jsoncDelete(text, ["small_model"]);
        } else if (small) {
          notes.push("left small_model because you edited it");
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
    await writeKeyFile(path, jsoncSet(raw, OPENCODE_KEY_PATH, input.apiKey), {
      mode: PRIVATE_FILE_MODE,
      agentId: OPENCODE_ID,
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
    const models = modelsFromCatalog(input.catalog);
    const servable = input.catalog.filter((entry) => Object.hasOwn(models, entry.id));
    const model = input.model ?? resolveDefault(servable, input.profileModel);
    if (!Object.hasOwn(models, model)) {
      throw new CliError(`OpenCode cannot be pointed at ${model}.`, {
        hint: "Pass --model with an id from `aiand models`.",
      });
    }
    const dir = await makeOverlayDir("aiand-opencode-");
    const keyFile = join(dir, "key");
    try {
      await writeFile(keyFile, input.apiKey, { mode: PRIVATE_FILE_MODE, flag: "wx" });
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    const config = buildOpencodeConfig({
      apiKey: `{file:${keyFile}}`,
      model,
      models,
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
    // The user named a model in OpenCode's own args: theirs stands, and an
    // ai& one takes titles and summaries too.
    const [named] = takeFlagValues(input.args, ["--model", "-m"]).values.slice(-1);
    if (named !== undefined) {
      if (!named.startsWith(`${OPENCODE_PROVIDER_ID}/`) || process.env.OPENCODE_CONFIG_CONTENT) {
        return {};
      }
      return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ small_model: named }) } };
    }
    const config = await readOpencodeConfig();
    const model = typeof config.model === "string" ? config.model : "";
    if (!model || model.startsWith(`${OPENCODE_PROVIDER_ID}/`)) return {};
    if (process.env.OPENCODE_CONFIG_CONTENT) return {};
    const wired = Object.keys(aiandProviderField(config, "models") ?? {}).map((id) => ({ id }));
    const ref = `${OPENCODE_PROVIDER_ID}/${resolveDefault(wired, input.profileModel)}`;
    return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: ref, small_model: ref }) } };
  },
};
