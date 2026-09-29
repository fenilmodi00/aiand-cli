import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../../cli/errors.js";
import { agentHome, isRoutableBaseUrl, trimSlash, writeFileAtomic } from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import { resolveDefault } from "../catalog.js";
import { detectBinary } from "../detect.js";
import { readTextIfExists } from "../managed-file.js";
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
import { readYamlMapping, type YamlValue, yamlDelete, yamlRender, yamlSet } from "./yaml.js";

const OMP_ID = "omp";
const OMP_BIN = "omp";

/** Provider id in models.yml; omp already bundles an `aiand` provider. */
const OMP_PROVIDER_ID = "aiand";
/**
 * Ownership marker stamped inside the models.yml provider block. omp has no
 * auth.json (credentials live in agent.db or the provider block), and its
 * provider schema tolerates unknown keys — the block is the right carrier.
 */
const OMP_MARKER_KEY = "managedBy";
const OMP_MARKER = "aiand";

/** OpenAI-compatible base URL omp dials for every ai& model. */
const OMP_BASE_URL = "https://api.aiand.com/v1";

/** Recovery hint for an omp config file that cannot be parsed or edited. */
const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand omp on again.";

/**
 * What enable() recorded so off can tell its values from the user's. The
 * baked key never appears here: only ids, previous values, and file modes.
 */
type OmpRecord = {
  /** What config.yml's modelRoles.default was before on (undefined = absent). */
  previousDefaultModel?: string;
  /** The modelRoles.default this on wrote; off hands back or removes it. */
  wroteDefaultModel?: string;
  /** File mode before `on` wrote it, per file off rewrites. */
  previousModelsMode?: number;
  previousConfigMode?: number;
};

/** The agent config dir: ~/.omp/agent/, or $PI_CODING_AGENT_DIR when set. */
function ompAgentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  return join(agentHome(), process.env.PI_CONFIG_DIR || ".omp", "agent");
}

function ompModelsPath(): string {
  return join(ompAgentDir(), "models.yml");
}
function ompConfigPath(): string {
  return join(ompAgentDir(), "config.yml");
}

const OMP_MANAGED_FILES = [ompModelsPath, ompConfigPath] as const;

/**
 * Read an omp YAML file as a mapping: missing/blank reads as {}, a parse
 * error becomes a CliError naming the file.
 */
async function readOmpFile(path: string): Promise<Record<string, unknown>> {
  const text = await readTextIfExists(path);
  if (!text.trim()) return {};
  try {
    return readYamlMapping(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError(`${path} is not valid YAML.`, { hint: INVALID_CONFIG_HINT });
    }
    throw error;
  }
}

/** The `aiand` provider block in models.yml, when it is a mapping. */
function aiandProvider(models: Record<string, unknown>): Record<string, unknown> | undefined {
  const providers = aiandProviderParent(models);
  if (providers === undefined) return undefined;
  const provider = providers[OMP_PROVIDER_ID];
  return provider && typeof provider === "object" && !Array.isArray(provider)
    ? (provider as Record<string, unknown>)
    : undefined;
}

function aiandProviderParent(models: Record<string, unknown>): Record<string, unknown> | undefined {
  const providers = models.providers;
  return providers && typeof providers === "object" && !Array.isArray(providers)
    ? (providers as Record<string, unknown>)
    : undefined;
}

/** True when our stamp sits on the models.yml `aiand` provider block. */
function hasOwnershipMarker(models: Record<string, unknown>): boolean {
  return aiandProvider(models)?.[OMP_MARKER_KEY] === OMP_MARKER;
}

/** `--base-url` + `/v1`, or the production gateway when none is given. */
function ompBaseUrl(baseUrl?: string): string {
  const base = trimSlash(baseUrl ?? "");
  return base ? `${base}/v1` : OMP_BASE_URL;
}

/**
 * The one builder for the override-only aiand provider block omp reads:
 * baseUrl + apiKey + marker. omp's bundled aiand catalog entry already fixes
 * the wire dialect (`api: openai-completions`) and the effort ladders, so
 * the override only redirects route + key.
 */
export function buildOmpProviderBlock({ baseUrl, apiKey }: { baseUrl?: string; apiKey: string }): {
  [key: string]: YamlValue;
} {
  return {
    baseUrl: ompBaseUrl(baseUrl),
    apiKey,
    [OMP_MARKER_KEY]: OMP_MARKER,
  };
}

async function probe(): Promise<ProbeResult> {
  let models: Record<string, unknown>;
  let config: Record<string, unknown>;
  try {
    models = await readOmpFile(ompModelsPath());
    config = await readOmpFile(ompConfigPath());
  } catch {
    // A file mid-edit must not wedge `omp status`.
    return { active: false, model: null };
  }
  if (!hasOwnershipMarker(models)) return { active: false, model: null };
  const baseUrl = aiandProvider(models)?.baseUrl;
  if (!isRoutableBaseUrl(typeof baseUrl === "string" ? baseUrl : undefined)) {
    return { active: false, model: null };
  }
  const modelRoles = config.modelRoles;
  const defaultModel =
    modelRoles && typeof modelRoles === "object" && !Array.isArray(modelRoles)
      ? (modelRoles as Record<string, unknown>).default
      : undefined;
  const model =
    typeof defaultModel === "string" && defaultModel.startsWith(`${OMP_PROVIDER_ID}/`)
      ? defaultModel.slice(OMP_PROVIDER_ID.length + 1)
      : null;
  return { active: true, model };
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const paths = { models: ompModelsPath(), config: ompConfigPath() };
  const raw = {
    models: await readTextIfExists(paths.models),
    config: await readTextIfExists(paths.config),
  };
  const models = await readOmpFile(paths.models);
  const config = await readOmpFile(paths.config);

  // A foreign provider merely named `aiand` is never ours to overwrite.
  if (aiandProvider(models) !== undefined && !hasOwnershipMarker(models)) {
    throw new CliError("OMP already has a providers.aiand block that ai& does not manage.", {
      hint: "Remove or rename the foreign block by hand, then run aiand omp on again.",
    });
  }

  // The prior on's record is still live only while our marker sits in
  // models.yml; after an `off` or a hand edit it is stale and must not be
  // carried forward.
  const prior = hasOwnershipMarker(models) ? await getAddedState<OmpRecord>(OMP_ID) : null;
  const warnings: string[] = [];
  const catalog = input.catalog;
  const isNative = input.model === "native";
  const inCatalog = (id: string): boolean => catalog.some((model) => model.id === id);

  // models.yml: our override-only provider block, replacing any prior one of
  // ours. Every unrelated provider and key survives — yamlSet splices one
  // property.
  const modelsText = yamlSet(
    raw.models,
    ["providers", OMP_PROVIDER_ID],
    buildOmpProviderBlock({ baseUrl: input.baseUrl, apiKey: input.apiKey }),
  );

  // config.yml: modelRoles.default, additive. The prior value is what off
  // hands back; on a re-`on` the first capture stays authoritative.
  const modelRoles =
    config.modelRoles && typeof config.modelRoles === "object" && !Array.isArray(config.modelRoles)
      ? (config.modelRoles as Record<string, unknown>)
      : undefined;
  const userDefaultModel =
    typeof modelRoles?.default === "string" ? (modelRoles.default as string) : "";

  let configText = raw.config;
  let wroteDefaultModel: string | undefined;
  let previousDefaultModel = prior?.previousDefaultModel;
  if (isNative) {
    // Leave the model unpinned: omp's own default resolution wins (with our
    // provider block, that is the bundled aiand default). on still wires
    // routing, so the user can pick a model in omp.
    warnings.push("OMP's own default model resolution is in effect; pass --model to pick one.");
    wroteDefaultModel = prior?.wroteDefaultModel;
    if (wroteDefaultModel !== undefined && userDefaultModel !== wroteDefaultModel) {
      // A hand edit replaced our write: the record's undo target is stale.
      wroteDefaultModel = undefined;
      previousDefaultModel = undefined;
    }
  } else if (userDefaultModel && inCatalog(stripSelector(userDefaultModel)) && !input.pinModel) {
    // The user's pick is servable: keep it, write only the provider. A
    // kept model that is a prior on's still-live write keeps that record;
    // the user's own model needs no undo.
    wroteDefaultModel =
      prior !== null && prior.wroteDefaultModel === userDefaultModel ? userDefaultModel : undefined;
    if (wroteDefaultModel === undefined) previousDefaultModel = undefined;
  } else {
    // Replace with the requested/resolved model. One it cannot serve would
    // fail every request, so it is set aside (and warned) rather than kept.
    // Never chain our own ref onto itself: while a prior on's write is
    // still live, the restore target stays the first pre-aiand value.
    const priorLive = prior?.wroteDefaultModel === userDefaultModel;
    wroteDefaultModel = `${OMP_PROVIDER_ID}/${input.model}`;
    if (!priorLive) {
      if (userDefaultModel && !inCatalog(stripSelector(userDefaultModel))) {
        warnings.push(
          `Set aside your modelRoles.default (${userDefaultModel}); aiand omp off puts it back.`,
        );
      }
      previousDefaultModel = userDefaultModel || undefined;
    }
    configText = yamlSet(
      configText,
      ["modelRoles", "default"],
      `${OMP_PROVIDER_ID}/${input.model}`,
    );
  }

  // A re-`on` finds each file at its first-on recorded mode; the first
  // capture stays authoritative. models.yml holds the session key: 0600 for
  // as long as it lives there, re-tightened even when the bytes did not
  // change. A file on created stays private: a stray file must never open
  // 0644.
  const previousModelsMode =
    prior?.previousModelsMode ?? (await existingFileMode(paths.models)) ?? DEFAULT_FILE_MODE;
  const previousConfigMode =
    prior?.previousConfigMode ?? (await existingFileMode(paths.config)) ?? DEFAULT_FILE_MODE;

  await writeFileAtomic(paths.models, modelsText, { mode: PRIVATE_FILE_MODE });
  if (modelsText === raw.models) await chmod(paths.models, PRIVATE_FILE_MODE);
  await writeFileAtomic(paths.config, configText, { mode: previousConfigMode });

  // The record tells off what to hand back. The key literal never appears.
  await recordAddedState(OMP_ID, {
    previousDefaultModel,
    wroteDefaultModel,
    previousModelsMode,
    previousConfigMode,
  });

  // The model now in effect, as the catalog id: this run's write, else what
  // the file already had, else the requested value.
  const effective = wroteDefaultModel || userDefaultModel || input.model;
  const effectiveId = stripSelector(effective);
  return {
    model: effectiveId,
    catalogModel: inCatalog(effectiveId) ? effectiveId : undefined,
    filesWritten: [paths.models, paths.config],
    warnings,
  };
}

function stripSelector(ref: string): string {
  return ref.startsWith(`${OMP_PROVIDER_ID}/`) ? ref.slice(OMP_PROVIDER_ID.length + 1) : ref;
}

/** Write a stripped file back, or unlink it when our `on` created it and nothing is left. */
async function writeStripped(
  path: string,
  before: string,
  after: string,
  mode: number,
): Promise<void> {
  if (after === before) return;
  if (Object.keys(readYamlMapping(after)).length === 0 && (await fileCreatedByUs(OMP_ID, path))) {
    await unlink(path).catch(() => {});
  } else {
    await writeFileAtomic(path, after, { mode });
  }
}

async function disable(): Promise<DisableResult> {
  const paths = { models: ompModelsPath(), config: ompConfigPath() };
  const added = await getAddedState<OmpRecord>(OMP_ID);
  const raw = {
    models: await readTextIfExists(paths.models),
    config: await readTextIfExists(paths.config),
  };
  let models: Record<string, unknown>;
  try {
    models = await readOmpFile(paths.models);
  } catch (error) {
    if (error instanceof CliError) {
      // Keep the record: once the YAML is fixed, off can still tell our
      // values from the user's.
      return {
        stripped: false,
        notes: [`${paths.models} is not valid YAML; fix it, then run aiand omp off again.`],
      };
    }
    throw error;
  }

  const notes: string[] = [];
  let stripped = false;

  // Everything below is gated on our stamp: a foreign `aiand`-named
  // provider (no marker) and an already-stripped file are left alone.
  if (hasOwnershipMarker(models)) {
    stripped = true;

    // models.yml: drop our provider block; unrelated providers survive, and
    // an emptied `providers` map (ours alone) is dropped with it.
    let modelsText = yamlDelete(raw.models, ["providers", OMP_PROVIDER_ID]);
    const left = aiandProviderParent(readYamlMapping(modelsText));
    if (left && Object.keys(left).length === 0) {
      modelsText = yamlDelete(modelsText, ["providers"]);
    }
    await writeStripped(
      paths.models,
      raw.models,
      modelsText,
      added?.previousModelsMode ?? DEFAULT_FILE_MODE,
    );

    // config.yml: hand back modelRoles.default on set aside or wrote.
    // Values the user changed in between are theirs and stay, with a note.
    // An unparseable config.yml keeps the record like models.yml above:
    // off still ran, and the user fixes their file before a retry.
    let configText = raw.config;
    let config: Record<string, unknown>;
    try {
      config = readYamlMapping(configText);
    } catch {
      notes.push(`${paths.config} is not valid YAML; fix it, then run aiand omp off again.`);
      config = {};
    }
    const modelRoles =
      config.modelRoles &&
      typeof config.modelRoles === "object" &&
      !Array.isArray(config.modelRoles)
        ? (config.modelRoles as Record<string, unknown>)
        : undefined;
    if (added?.wroteDefaultModel !== undefined) {
      if (modelRoles?.default === added.wroteDefaultModel) {
        if (added.previousDefaultModel !== undefined) {
          configText = yamlSet(configText, ["modelRoles", "default"], added.previousDefaultModel);
        } else {
          configText = yamlDelete(configText, ["modelRoles", "default"]);
        }
      } else if (modelRoles?.default !== undefined) {
        notes.push("left modelRoles.default because you edited it");
      }
    }
    await writeStripped(
      paths.config,
      raw.config,
      configText,
      added?.previousConfigMode ?? DEFAULT_FILE_MODE,
    );
  }

  await clearAddedState(OMP_ID);
  return { stripped, notes };
}

/**
 * The OMP release the install hint pins (check-dist keeps ci.yml in step).
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const OMP_VERSION = "18.4.3";

const OMP_INSTALL = {
  command: `curl -fsSL https://omp.sh/install | sh -s -- --binary --ref v${OMP_VERSION}`,
  url: "https://omp.sh",
};

export const ompAdapter: AgentAdapter = {
  id: OMP_ID,
  label: "Oh My Pi",
  bin: OMP_BIN,
  aliases: ["oh-my-pi"],
  install: OMP_INSTALL,
  detect(): DetectResult {
    return detectBinary(OMP_BIN);
  },
  managedFiles(): string[] {
    return OMP_MANAGED_FILES.map((path) => path());
  },
  probe,
  enable,
  disable,
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    // Marker-gated like disable(): a foreign `aiand`-named provider keeps
    // its own key untouched.
    const path = ompModelsPath();
    const raw = await readTextIfExists(path);
    const provider = aiandProvider(await readOmpFile(path));
    if (!provider || provider[OMP_MARKER_KEY] !== OMP_MARKER) return false;
    // A same-key no-op still counts as touched: an idempotent rebake reports
    // refreshed.
    const bakedKey = provider.apiKey;
    if (bakedKey === input.apiKey) return true;
    // A rotation swaps only the key it replaced: a config baked from another
    // profile keeps routing to that profile's org.
    if (input.previousKey !== undefined && bakedKey !== input.previousKey) return false;
    await writeFileAtomic(
      path,
      yamlSet(raw, ["providers", OMP_PROVIDER_ID, "apiKey"], input.apiKey),
      { mode: PRIVATE_FILE_MODE },
    );
    return true;
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Works with no prior `on`: a throwaway overlay becomes
    // PI_CODING_AGENT_DIR holding only a generated models.yml (the same
    // override block `on` writes) and config.yml pinning modelRoles.default
    // at 0600. The key never rides the child env — the overlay file is how
    // omp reads it — and cleanup removes the overlay after the child exits.
    // Real session history survives in the user's own session dir, pointed
    // at through PI_CODING_AGENT_SESSION_DIR.
    const model = input.model ?? resolveDefault(input.catalog, input.profileModel);
    const overlay = await mkdtemp(join(tmpdir(), "aiand-omp-"));
    // A failed setup would otherwise leak the overlay (and a half-written
    // key file) after an error: run-agent never sees cleanup it didn't get.
    try {
      await writeFile(
        join(overlay, "models.yml"),
        yamlRender({
          providers: {
            [OMP_PROVIDER_ID]: buildOmpProviderBlock({
              baseUrl: input.baseUrl,
              apiKey: input.apiKey,
            }),
          },
        }),
        { mode: PRIVATE_FILE_MODE },
      );
      await writeFile(
        join(overlay, "config.yml"),
        yamlRender({ modelRoles: { default: `${OMP_PROVIDER_ID}/${model}` } }),
        { mode: PRIVATE_FILE_MODE },
      );
    } catch (error) {
      await rm(overlay, { recursive: true, force: true });
      throw error;
    }
    const args = ["--model", `${OMP_PROVIDER_ID}/${model}`];
    // Non-TTY stdin: ask for an explicit one-shot mode. A piped prompt must
    // process and exit, not sit on an interactive session.
    if (!process.stdin.isTTY) args.push("--print");
    return {
      env: {
        PI_CODING_AGENT_DIR: overlay,
        PI_CODING_AGENT_SESSION_DIR:
          process.env.PI_CODING_AGENT_SESSION_DIR ?? join(ompAgentDir(), "sessions"),
      },
      // --model pins the routing; a user-supplied --provider/--api-key/
      // --models would override the overlay, so they are stripped with the
      // rest of the routing flags (both `--flag value` and `--flag=value`).
      args,
      stripPassthroughFlags: ["--model", "--provider", "--api-key", "--models"],
      cleanup: async () => {
        await rm(overlay, { recursive: true, force: true });
      },
    };
  },
};
