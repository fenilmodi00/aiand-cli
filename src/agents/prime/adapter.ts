import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Model } from "../../api/models.js";
import { CliError } from "../../cli/errors.js";
import {
  agentHome,
  DEFAULT_BASE_URL,
  isRoutableBaseUrl,
  trimSlash,
  writeFileAtomic,
} from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import { resolveDefault } from "../catalog.js";
import { detectBinary } from "../detect.js";
import {
  asObject,
  jsoncDelete,
  jsoncSet,
  notValidJsonError,
  parseJsonc,
  readTextIfExists,
} from "../managed-file.js";
import {
  clearAddedState,
  fileCreatedByUs,
  getAddedState,
  getAddedStateSync,
  recordAddedState,
} from "../snapshot.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeResult,
  SessionLaunchInput,
} from "../types.js";
import { PRIME_INSTALL } from "./install.js";

const PRIME_ID = "prime";
const PRIME_BIN = "prime-agent";
/** Provider id in models.json — also the `provider` half of a model ref. */
const PRIME_PROVIDER_ID = "aiand";
/** Ownership marker: serde ignores unknown keys on read and the app never rewrites models.json. */
const PRIME_MARKER_KEY = "x-aiand";
const PRIME_MARKER_PATH = ["providers", PRIME_PROVIDER_ID, PRIME_MARKER_KEY];
const PRIME_KEY_PATH = ["providers", PRIME_PROVIDER_ID, "apiKey"];
const PRIME_PROVIDER_PATH = ["providers", PRIME_PROVIDER_ID];
const PROVIDER_ID_PATH = ["defaultProvider"];
const MODEL_ID_PATH = ["defaultModel"];
/** The dialect: the binary dials `baseUrl + "/chat/completions"`, so baseUrl carries /v1. */
const PRIME_API = "openai-completions";
const PRIME_BASE_URL = `${DEFAULT_BASE_URL}/v1`;

const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand prime on again.";

/** enable() recorded so off can tell its bytes from later user edits. */
type PrimeRecord = {
  /** The models.json this record describes (env can move it between on and off). */
  path: string;
  settingsPath: string;
  /** The provider block as written, session key removed. */
  providerAiand?: unknown;
  /** The "provider"/"model" halves on wrote into settings.json, when it wrote a pair. */
  pair?: string;
  /** A defaultProvider/defaultModel of the user's that on set aside to put back. */
  previousProvider?: string;
  previousModel?: string;
  /** File modes before `on` locked models.json to 0600. */
  previousMode?: number;
  settingsPreviousMode?: number;
  created?: boolean;
  settingsCreated?: boolean;
};

function primeAgentDir(): string {
  const override = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  return override
    ? override.replace(/^~(?=\/|$)/, agentHome())
    : join(agentHome(), ".prime", "agent");
}

function modelsPath(): string {
  return join(primeAgentDir(), "models.json");
}

function settingsPath(): string {
  return join(primeAgentDir(), "settings.json");
}

/** `--base-url` + `/v1`, or the production gateway when none is given. */
function primeBaseUrl(baseUrl?: string): string {
  const base = trimSlash(baseUrl ?? "");
  return base ? `${base}/v1` : PRIME_BASE_URL;
}

/** One catalog model in the `models.json` shape (camelCase; validate_config demands a non-zero window). */
function modelEntry(model: Model): Record<string, unknown> {
  const input = ["text"];
  if (model.capabilities.includes("vision")) input.push("image");
  const price = (value: string | null): number => Number.parseFloat(value ?? "0");
  return {
    id: model.id,
    name: model.name,
    input,
    reasoning: (model.reasoning_efforts?.length ?? 0) > 0,
    cost: {
      input: price(model.input_per_1m),
      output: price(model.output_per_1m),
      // The real 0.9.8 schema requires all four cost fields.
      cacheRead: price(model.cached_input_per_1m),
      cacheWrite: 0,
    },
    // Model has no output-token field, so maxTokens mirrors context_window (the
    // cap the gateway enforces), like the OpenCode model map.
    contextWindow: model.context_window,
    maxTokens: model.context_window,
  };
}

/**
 * The one provider builder for enable() and sessionLaunch() so their blocks
 * cannot drift. `apiKey` may be a literal; models ride from the live catalog.
 */
function buildProvider(apiKey: string, baseUrl: string, catalog: Model[]): Record<string, unknown> {
  return {
    name: "ai&",
    baseUrl,
    apiKey,
    api: PRIME_API,
    models: catalog.map(modelEntry),
    [PRIME_MARKER_KEY]: true,
  };
}

/** Tolerant read of a models.json/settings.json candidate: missing or blank is {}. */
async function readJsonDoc(path: string): Promise<Record<string, unknown>> {
  const raw = await readTextIfExists(path);
  if (raw.trim().length === 0) return {};
  try {
    return asObject(parseJsonc(raw)) ?? {};
  } catch {
    // Probe reads must not wedge `prime status` on a file mid-edit.
    return {};
  }
}

/** Strict read for edits: a non-object root can't take our surgical writes. */
async function readJsonDocForWrite(
  path: string,
): Promise<{ raw: string; doc: Record<string, unknown> }> {
  const raw = await readTextIfExists(path);
  if (raw.trim().length === 0) return { raw, doc: {} };
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw notValidJsonError(path, INVALID_CONFIG_HINT);
    throw error;
  }
  const doc = asObject(parsed);
  if (!doc) throw notValidJsonError(path, INVALID_CONFIG_HINT);
  return { raw, doc };
}

function hasMarker(doc: Record<string, unknown>): boolean {
  return asObject(asObject(doc.providers)?.[PRIME_PROVIDER_ID])?.[PRIME_MARKER_KEY] === true;
}

function pairOf(doc: Record<string, unknown>): string {
  const provider = typeof doc.defaultProvider === "string" ? doc.defaultProvider : "";
  const model = typeof doc.defaultModel === "string" ? doc.defaultModel : "";
  return provider && model ? `${provider}/${model}` : "";
}

/** Deep clone of a provider block with the session key removed. */
function withoutApiKey(block: unknown): unknown {
  const clone = structuredClone(block);
  if (asObject(clone)) delete (clone as Record<string, unknown>).apiKey;
  return clone;
}

/** Our marker plus an https or loopback-http baseUrl: the file routes to ai&. */
function routesToGateway(doc: Record<string, unknown>): boolean {
  const baseUrl = asObject(asObject(doc.providers)?.[PRIME_PROVIDER_ID])?.baseUrl;
  return hasMarker(doc) && typeof baseUrl === "string" && isRoutableBaseUrl(baseUrl);
}

async function probe(): Promise<ProbeResult> {
  const models = await readJsonDoc(modelsPath());
  if (!routesToGateway(models)) return { active: false, model: null };
  const settings = await readJsonDoc(settingsPath());
  const pair = pairOf(settings);
  return { active: true, model: pair.startsWith(`${PRIME_PROVIDER_ID}/`) ? pair : null };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const path = modelsPath();
  const settings = settingsPath();
  const { raw, doc } = await readJsonDocForWrite(path);

  const providers = asObject(doc.providers);
  if (doc.providers !== undefined && !providers) {
    throw notValidJsonError(path, INVALID_CONFIG_HINT);
  }
  const existing = providers?.[PRIME_PROVIDER_ID];
  if (existing !== undefined && !hasMarker(doc)) {
    throw new CliError("Prime already has an aiand provider that ai& does not manage.", {
      hint: "Remove or rename the foreign block by hand, then run aiand prime on again.",
    });
  }

  const marked = hasMarker(doc);
  const prior = marked ? await getAddedState<PrimeRecord>(PRIME_ID) : null;
  const built = buildProvider(input.apiKey, primeBaseUrl(input.baseUrl), input.catalog);
  const isNative = input.model === "native";

  let text = raw;
  text = jsoncSet(text, PRIME_PROVIDER_PATH, built);

  // The model pair rides in settings.json as defaultProvider/defaultModel:
  // the app's own lookup matches provider+id exactly, which survives ids
  // that contain slashes (--model patterns do not).
  const settingsDoc = await readJsonDocForWrite(settings);
  const currentPair = pairOf(settingsDoc.doc);
  const warnings: string[] = [];
  let settingsText = settingsDoc.raw;
  let settingsWritten = false;
  let recorded: string | undefined;
  let previousProvider: string | undefined;
  let previousModel: string | undefined;
  const priorLive = prior?.pair !== undefined && currentPair === prior.pair;

  if (isNative) {
    // leave the agent's own default alone
    recorded = priorLive ? prior?.pair : undefined;
    if (priorLive) {
      previousProvider = prior?.previousProvider;
      previousModel = prior?.previousModel;
    }
  } else if (currentPair && !input.pinModel) {
    // Keep whatever model the user has, ours or their own: the settings pair
    // only picks which model starts, and a foreign route still works with
    // the user's own credentials.
    if (!currentPair.startsWith(`${PRIME_PROVIDER_ID}/`)) {
      warnings.push(`Left your existing model (${currentPair}). Pass --model to switch.`);
    }
    recorded = priorLive ? prior?.pair : undefined;
    if (priorLive) {
      previousProvider = prior?.previousProvider;
      previousModel = prior?.previousModel;
    }
  } else {
    const nextPair = `${PRIME_PROVIDER_ID}/${input.model}`;
    if (currentPair.startsWith(`${PRIME_PROVIDER_ID}/`)) {
      // Already ours: the restore target is what the prior on recorded —
      // never our own pair chained onto itself. A hand-written ours with
      // no record restores to nothing.
      if (priorLive) {
        previousProvider = prior?.previousProvider;
        previousModel = prior?.previousModel;
      }
    } else if (currentPair) {
      // The pair is the only model knob in the config: --model takes it
      // over, and off puts the old one back.
      const slash = currentPair.indexOf("/");
      previousProvider = currentPair.slice(0, slash === -1 ? undefined : slash);
      previousModel = slash === -1 ? undefined : currentPair.slice(slash + 1);
      warnings.push(`Set aside your model (${currentPair}); aiand prime off puts it back.`);
    }
    settingsText = jsoncSet(settingsText, PROVIDER_ID_PATH, PRIME_PROVIDER_ID);
    settingsText = jsoncSet(settingsText, MODEL_ID_PATH, input.model);
    recorded = nextPair;
    settingsWritten = settingsText !== settingsDoc.raw;
  }

  const created = marked ? prior?.created === true : !(await exists(path));
  const previousMode = prior?.previousMode ?? (await existingFileMode(path)) ?? DEFAULT_FILE_MODE;
  if (text !== raw) {
    // models.json carries the baked session key: it is written and kept at 0600.
    await writeFileAtomic(path, text, { mode: PRIVATE_FILE_MODE });
  } else {
    await chmod(path, PRIVATE_FILE_MODE);
  }

  const settingsCreated =
    marked && prior?.settingsPath === settings
      ? prior.settingsCreated === true
      : !(await exists(settings));
  const settingsPreviousMode =
    prior?.settingsPreviousMode ?? (await existingFileMode(settings)) ?? DEFAULT_FILE_MODE;
  if (settingsWritten) {
    // No key in settings.json; it keeps the mode the user had.
    await writeFileAtomic(settings, settingsText, { mode: settingsPreviousMode });
  }

  await recordAddedState(PRIME_ID, {
    path,
    settingsPath: settings,
    providerAiand: withoutApiKey(built),
    pair: recorded,
    previousProvider,
    previousModel,
    previousMode,
    settingsPreviousMode,
    created: created || (prior?.created === true && marked),
    settingsCreated,
  } satisfies PrimeRecord);

  const effectivePair =
    recorded ?? currentPair ?? (isNative ? "" : `${PRIME_PROVIDER_ID}/${input.model}`);
  return {
    model: effectivePair || input.model,
    catalogModel: effectivePair.startsWith(`${PRIME_PROVIDER_ID}/`)
      ? effectivePair.slice(PRIME_PROVIDER_ID.length + 1)
      : undefined,
    filesWritten: settingsWritten ? [path, settings] : [path],
    warnings,
  };
}

async function disable(): Promise<DisableResult> {
  const path = modelsPath();
  const settings = settingsPath();
  const added =
    (await getAddedState<PrimeRecord>(PRIME_ID)) ?? getAddedStateSync<PrimeRecord>(PRIME_ID);
  // off can run from a shell that no longer sets PRIME_AGENT_CODING_AGENT_DIR:
  // strip the paths `on` recorded, plus the ones resolved here.
  const modelsTargets = new Set([path]);
  if (added?.path) modelsTargets.add(added.path);
  const settingsTargets = new Set([settings]);
  if (added?.settingsPath) settingsTargets.add(added.settingsPath);

  const notes: string[] = [];
  let stripped = false;
  // A file off could not finish stops the record from being cleared, so a
  // retry (after the file is fixed) can still strip the rest.
  let incomplete = false;
  // Set when a models file Prime left mid-write cannot be read: the settings
  // pair stays put until a later off actually removes the routing.
  let modelsStillRouted = false;

  for (const file of modelsTargets) {
    let parsed: { raw: string; doc: Record<string, unknown> };
    try {
      parsed = await readJsonDocForWrite(file);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      // A models.json Prime left mid-write will not parse. Never strip what we
      // cannot read: keep the record so a retry after the file is fixed (or
      // Prime finishes) still removes the block, and say so.
      incomplete = true;
      modelsStillRouted = true;
      notes.push(`${file} is not valid JSON; fix it, then run aiand prime off again.`);
      continue;
    }
    const { raw, doc } = parsed;
    if (!hasMarker(doc)) continue;
    stripped = true;

    let text = raw;
    const provider = asObject(doc.providers)?.[PRIME_PROVIDER_ID];
    const expected = added?.providerAiand;
    const edited =
      expected !== undefined
        ? !isDeepStrictEqual(withoutApiKey(provider), withoutApiKey(expected))
        : !routesToGateway(doc);
    if (edited) {
      notes.push("left providers.aiand because you edited it");
      // The block is theirs; the session key and stamp are still ours.
      text = jsoncDelete(text, PRIME_KEY_PATH);
      text = jsoncDelete(text, PRIME_MARKER_PATH);
    } else {
      text = jsoncDelete(text, PRIME_PROVIDER_PATH);
      const left = asObject(parseJsonc(text))?.providers;
      if (left && Object.keys(left).length === 0) text = jsoncDelete(text, ["providers"]);
    }

    if (text !== raw) {
      const rest = asObject(parseJsonc(text));
      if (
        Object.keys(rest ?? {}).length === 0 &&
        (added?.created === true || (await fileCreatedByUs(PRIME_ID, file)))
      ) {
        await rm(file, { force: true });
      } else {
        // The key left the file: hand back the mode the user had before on.
        await writeFileAtomic(file, text, { mode: added?.previousMode ?? DEFAULT_FILE_MODE });
      }
    }
  }

  // The settings pair: only ours to remove when the file still holds exactly
  // what on wrote. A pair the user changed while routed is theirs; the note
  // says so and off leaves it. Each key restores independently so a lone
  // defaultModel of the user's, which on set aside, comes back whole.
  for (const file of settingsTargets) {
    if (!added?.pair || modelsStillRouted) continue;
    let parsed: { raw: string; doc: Record<string, unknown> };
    try {
      parsed = await readJsonDocForWrite(file);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      // A broken settings.json (a hand edit mid-write) must not turn off into
      // an error that aborts before the models strip can be recorded; keep the
      // record so a retry after the fix still restores the pair.
      incomplete = true;
      notes.push(`${file} is not valid JSON; fix it, then run aiand prime off again.`);
      continue;
    }
    const { raw, doc } = parsed;
    const current = pairOf(doc);
    if (current !== added.pair) {
      if (current) notes.push("left the default model because you edited it");
      continue;
    }
    let text = raw;
    for (const [keyPath, value] of [
      [PROVIDER_ID_PATH, added.previousProvider],
      [MODEL_ID_PATH, added.previousModel],
    ] as const) {
      text =
        value === undefined ? jsoncDelete(text, [...keyPath]) : jsoncSet(text, [...keyPath], value);
    }
    if (text !== raw) {
      const rest = asObject(parseJsonc(text));
      if (
        Object.keys(rest ?? {}).length === 0 &&
        (added.settingsCreated === true || (await fileCreatedByUs(PRIME_ID, file)))
      ) {
        await rm(file, { force: true });
      } else {
        await writeFileAtomic(file, text, {
          mode: added.settingsPreviousMode ?? DEFAULT_FILE_MODE,
        });
      }
    }
  }

  // Keep the record while a file is still unfinishable: clearing it now would
  // strand the pair and make the next off report nothing to turn off.
  if (!incomplete) await clearAddedState(PRIME_ID);
  return { stripped, notes };
}

async function overlayModelsJson(
  dir: string,
  apiKey: string,
  baseUrl: string,
  catalog: Model[],
): Promise<void> {
  const doc = { providers: { [PRIME_PROVIDER_ID]: buildProvider(apiKey, baseUrl, catalog) } };
  await writeFile(join(dir, "models.json"), `${JSON.stringify(doc, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
}

async function overlaySettingsJson(dir: string, model: string): Promise<void> {
  const doc = { defaultProvider: PRIME_PROVIDER_ID, defaultModel: model };
  await writeFile(join(dir, "settings.json"), `${JSON.stringify(doc, null, 2)}\n`);
}

async function launchOverlay(input: SessionLaunchInput, model: string) {
  // A throwaway agent dir: models.json + settings.json only. The Python
  // kernel venv hangs off HOME (`layout.rs`), not the agent dir, so a
  // session never rebuilds it. The daemon socket and sessions pin inside
  // the overlay: cleanup removes them and a session daemon can never
  // shadow or outlive the user's state.
  const dir = await mkdtemp(join(tmpdir(), "aiand-prime-"));
  await overlayModelsJson(dir, input.apiKey, primeBaseUrl(input.baseUrl), input.catalog);
  await overlaySettingsJson(dir, model);
  return {
    env: {
      PRIME_AGENT_CODING_AGENT_DIR: dir,
      PRIME_AGENT_SESSION_DIR: join(dir, "sessions"),
      PRIME_AGENT_DAEMON_SOCKET: join(dir, "daemon.sock"),
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const primeAdapter: AgentAdapter = {
  id: PRIME_ID,
  label: "Prime",
  bin: PRIME_BIN,
  install: PRIME_INSTALL,
  aliases: ["prime-agent"],
  detect(): DetectResult {
    return detectBinary(PRIME_BIN);
  },
  managedFiles(): string[] {
    // The wired files too, so restore works from a shell without the env override.
    const wired = getAddedStateSync<PrimeRecord>(PRIME_ID);
    const out = new Set([modelsPath(), settingsPath()]);
    if (wired?.path) out.add(wired.path);
    if (wired?.settingsPath) out.add(wired.settingsPath);
    return [...out];
  },
  probe,
  enable,
  disable,
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    const wired =
      (await getAddedState<PrimeRecord>(PRIME_ID)) ?? getAddedStateSync<PrimeRecord>(PRIME_ID);
    const candidates = new Set([modelsPath(), wired?.path].filter(Boolean) as string[]);
    let found = false;
    for (const file of candidates) {
      // Tolerant read: a file mid-write reports no marked block rather than
      // throwing, so a rebake never crashes on a broken models.json.
      const doc = await readJsonDoc(file);
      const provider = asObject(asObject(doc.providers)?.[PRIME_PROVIDER_ID]);
      if (provider === undefined) continue;
      if (provider[PRIME_MARKER_KEY] !== true) continue;
      found = true;
      // The file holds our key, so it must not stay world-readable. A same-key
      // rebake re-tightens a loosened mode; a rotation rewrites at 0600.
      if (provider.apiKey === input.apiKey) {
        await chmod(file, PRIVATE_FILE_MODE);
        continue;
      }
      // A rotation swaps only the key it replaced; a config baked from
      // another profile keeps routing to that profile's org.
      if (input.previousKey !== undefined && provider.apiKey !== input.previousKey) continue;
      const raw = await readTextIfExists(file);
      await writeFileAtomic(file, jsoncSet(raw, PRIME_KEY_PATH, input.apiKey), {
        mode: PRIVATE_FILE_MODE,
      });
      const added = await getAddedState<PrimeRecord>(PRIME_ID);
      if (added?.providerAiand !== undefined) {
        const after = asObject((await readJsonDoc(file)).providers)?.[PRIME_PROVIDER_ID];
        await recordAddedState(PRIME_ID, { ...added, providerAiand: withoutApiKey(after) });
      }
    }
    return found;
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // A throwaway agent dir: user files untouched, key in the overlay's
    // 0600 models.json, never the child env. --provider/--model/--api-key
    // still outrank the overlay (the user's own flags, the user's choice).
    const model = input.model ?? resolveDefault(input.catalog, input.profileModel);
    const launch = await launchOverlay(input, model);
    return launch;
  },
};
