import { mkdir, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
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
import { buildHermesOverlay, restoreShims, snapshotShims } from "./overlay.js";
import {
  buildHermesWrites,
  FOREIGN_BLOCK_HINT,
  HERMES_PLUGIN_STAMP,
  HERMES_PROVIDER_API_KEY_ENV,
  HERMES_PROVIDER_ID,
  hasHermesMarker,
  hasProviderAiand,
  modelFieldLine,
  OWNED_ENV_RE,
  pinHermesModel,
  readEnvValue,
  readModelField,
  readProviderField,
  replaceEnvValue,
  restoreHermesModelLine,
  setHermesModelProvider,
  stripHermesProvider,
} from "./routing.js";

/**
 * The Hermes Agent adapter (Nous Research, binary `hermes`, home
 * `~/.hermes`). Persistent wiring rides a dedicated `aiand` model provider
 * shipped as a plugin; sessions without a prior `on` ride the throwaway
 * overlay from overlay.ts, rendered by the same routing.ts builder.
 */
const HERMES_ID = "hermes";
const HERMES_BIN = "hermes";

/**
 * The Hermes Agent commit the live matrix installs: the installer is
 * `curl ... | bash --commit <sha>`, so the pin is a commit, not a semver.
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const HERMES_COMMIT = "666f313d1d3abd8077291ba464cf0a10f1a6157f";

const HERMES_INSTALL = {
  command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
  url: "https://hermes-agent.nousresearch.com/docs/",
};

/** Hermes's home: the real one persistent wiring writes, the launcher overlays. */
const hermesHome = () => process.env.HERMES_HOME || join(agentHome(), ".hermes");
const hermesEnvPath = () => join(hermesHome(), ".env");
const hermesConfigPath = () => join(hermesHome(), "config.yaml");
const hermesProviderDir = () =>
  join(hermesHome(), "plugins", "model-providers", HERMES_PROVIDER_ID);
const hermesInitPyPath = () => join(hermesProviderDir(), "__init__.py");
const hermesPluginYamlPath = () => join(hermesProviderDir(), "plugin.yaml");
/**
 * What enable() recorded so off can tell its values from the user's. The
 * baked key never appears here: only raw `model:` lines (ids, no secrets),
 * file modes, created flags, and the shadowed env lines off hands back.
 */
type HermesRecord = {
  /** Raw `provider:` line before on (undefined = absent, or already ours). */
  previousProviderLine?: string;
  /** Raw `default:` line before on (undefined = absent). */
  previousDefaultLine?: string;
  /** The default this on wrote; off hands back or removes it. */
  wroteDefault?: string;
  /** Whether this on routed the top-level provider through aiand. */
  wroteProvider?: boolean;
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

/** The base URL every Hermes launch dials: `--base-url`, or the production gateway. */
function hermesBaseUrl(baseUrl?: string): string {
  return trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL;
}
async function probe(): Promise<ProbeResult> {
  try {
    const [configText, envText] = await Promise.all([
      readTextIfExists(hermesConfigPath()),
      readTextIfExists(hermesEnvPath()),
    ]);
    if (!hasProviderAiand(configText)) return { active: false, model: null };
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
async function enable(input: EnableInput): Promise<EnableResult> {
  const envPath = hermesEnvPath();
  const configPath = hermesConfigPath();
  const providerDir = hermesProviderDir();
  const initPyPath = hermesInitPyPath();
  const pluginYamlPath = hermesPluginYamlPath();

  const [rawEnv, rawConfig] = await Promise.all([
    readTextIfExists(envPath),
    readTextIfExists(configPath),
  ]);
  const marked = hasHermesMarker(rawConfig);
  // The prior on's record is still live only while our stamp (or the record
  // itself, when a Hermes rewrite dropped the stamp) says the files are
  // ours; otherwise it is stale and must not be carried forward.
  const prior =
    marked || hasProviderAiand(rawConfig) ? await getAddedState<HermesRecord>(HERMES_ID) : null;

  // A foreign provider merely named `aiand` is never ours to overwrite.
  if (hasProviderAiand(rawConfig) && !marked && !prior) {
    throw new CliError("Hermes already has a providers.aiand block that ai& does not manage.", {
      hint: FOREIGN_BLOCK_HINT,
    });
  }
  // Same for same-named plugin files without our stamp: overwriting them
  // would destroy the user's own provider, and off could never hand it back.
  for (const path of [initPyPath, pluginYamlPath]) {
    const existing = await readTextIfExists(path);
    if (existing !== "" && !existing.includes(HERMES_PLUGIN_STAMP) && !prior) {
      throw new CliError(
        "Hermes already has an aiand model-provider plugin that ai& does not manage.",
        { hint: FOREIGN_BLOCK_HINT },
      );
    }
  }

  const baseUrl = hermesBaseUrl(input.baseUrl);
  const isNative = input.model === "native";
  const inCatalog = (id: string): boolean => input.catalog.some((model) => model.id === id);
  const currentProvider = readModelField(rawConfig, "provider");
  const currentDefault = readModelField(rawConfig, "default");
  const currentProviderLine = modelFieldLine(rawConfig, "provider");
  const currentDefaultLine = modelFieldLine(rawConfig, "default");
  const warnings: string[] = [];

  // A re-`on` keeps the first capture authoritative (the file holds our
  // values by then); a provider already routing through aiand records no
  // restore target, like Pi's already-ours defaultProvider.
  const previousProviderLine =
    prior?.previousProviderLine ??
    (currentProvider === HERMES_PROVIDER_ID ? undefined : currentProviderLine);
  let previousDefaultLine = prior?.previousDefaultLine ?? currentDefaultLine;

  let configText = rawConfig;
  let wroteDefault: string | undefined;
  let wroteProvider = false;
  // The provider block names the model actually in effect, so block and
  // top-level default stay aligned the way the overlay aligns them.
  let blockModel: string | undefined;
  if (isNative) {
    // Leave the model unpinned: Hermes's own default wins. On still wires
    // the provider block + credential, so the user can pick a model in Hermes.
    warnings.push("Hermes's own default model is not on ai&; pass --model to pick one.");
    if (prior?.wroteDefault !== undefined && currentDefault === prior.wroteDefault) {
      wroteDefault = prior.wroteDefault;
    }
    wroteProvider = prior?.wroteProvider ?? false;
    blockModel = undefined;
  } else if (currentDefault && inCatalog(currentDefault) && !input.pinModel) {
    // The user's pick is servable: keep the line byte-identical, route only
    // the provider through aiand. A kept default that is a prior on's
    // still-live write keeps that record; the user's own needs no undo.
    configText = setHermesModelProvider(configText);
    wroteProvider = true;
    if (prior?.wroteDefault !== undefined && currentDefault === prior.wroteDefault) {
      wroteDefault = prior.wroteDefault;
    }
    blockModel = currentDefault;
  } else {
    // Replace with the requested/resolved model. One it cannot serve would
    // fail every request, so it is set aside (and warned) rather than kept.
    // Never chain our own write onto itself: while a prior on's write is
    // still live, the restore target stays the first pre-aiand line —
    // otherwise the restore target is whatever this run replaces.
    wroteDefault = input.model;
    wroteProvider = true;
    if (prior?.wroteDefault === currentDefault) {
      previousDefaultLine = prior?.previousDefaultLine;
    } else {
      if (currentDefault && !inCatalog(currentDefault)) {
        warnings.push(`Set aside your default (${currentDefault}); aiand hermes off puts it back.`);
      }
      previousDefaultLine = currentDefaultLine;
    }
    configText = pinHermesModel(configText, input.model);
    blockModel = input.model;
  }

  // The shared builder writes provider block, plugin, and env from the same
  // bytes the overlay builds, so the two routings cannot drift; only the
  // top-level model section above carries enable()'s keep/set-aside policy.
  const writes = buildHermesWrites({
    apiKey: input.apiKey,
    baseUrl,
    model: blockModel,
    envText: rawEnv,
    configText,
  });
  if (writes.droppedEnvLines.length > 0) {
    const one = writes.droppedEnvLines.length === 1;
    warnings.push(
      `Set aside your ANTHROPIC ${one ? "entry" : "entries"} from ${envPath} so ${one ? "it cannot" : "they cannot"} shadow ai& routing; aiand hermes off puts ${one ? "it" : "them"} back.`,
    );
  }

  // A re-`on` finds each file at its first-on recorded mode; the first
  // capture stays authoritative. A file on created has no prior mode: the
  // key-bearing .env stays private, the key-free config takes the default.
  const envModeBefore = await existingFileMode(envPath);
  const configModeBefore = await existingFileMode(configPath);
  const initExisted = (await existingFileMode(initPyPath)) !== undefined;
  const yamlExisted = (await existingFileMode(pluginYamlPath)) !== undefined;
  const previousEnvMode = prior?.previousEnvMode ?? envModeBefore ?? PRIVATE_FILE_MODE;
  const previousConfigMode = prior?.previousConfigMode ?? configModeBefore ?? DEFAULT_FILE_MODE;

  await writeFileAtomic(envPath, writes.env, { mode: PRIVATE_FILE_MODE });
  await writeFileAtomic(configPath, writes.config, { mode: previousConfigMode });
  await mkdir(providerDir, { recursive: true });
  await writeFileAtomic(initPyPath, writes.initPy, { mode: DEFAULT_FILE_MODE });
  await writeFileAtomic(pluginYamlPath, writes.pluginYaml, { mode: DEFAULT_FILE_MODE });

  // The record tells off what to hand back. The key literal never appears.
  await recordAddedState(HERMES_ID, {
    previousProviderLine,
    previousDefaultLine: wroteDefault !== undefined ? previousDefaultLine : undefined,
    wroteDefault,
    wroteProvider,
    previousEnvMode,
    previousConfigMode,
    createdEnv: envModeBefore === undefined,
    createdConfig: configModeBefore === undefined,
    createdPlugin: !initExisted && !yamlExisted,
    strippedEnvLines: writes.droppedEnvLines.length > 0 ? writes.droppedEnvLines : undefined,
  } satisfies HermesRecord);

  // The model now in effect: this run's write, else what the file already
  // had, else the requested value (the literal "native" under --model
  // native, matching Pi's reporting).
  const effective = wroteDefault ?? currentDefault ?? input.model;
  return {
    model: effective,
    catalogModel: inCatalog(effective) ? effective : undefined,
    filesWritten: [envPath, configPath, initPyPath, pluginYamlPath],
    warnings,
  };
}
async function disable(): Promise<DisableResult> {
  const envPath = hermesEnvPath();
  const configPath = hermesConfigPath();
  const providerDir = hermesProviderDir();
  const added = await getAddedState<HermesRecord>(HERMES_ID);
  const rawConfig = await readTextIfExists(configPath);
  const rawEnv = await readTextIfExists(envPath);
  const marked = hasHermesMarker(rawConfig);

  // Everything below is gated on our stamp or our record: a foreign
  // `aiand`-named block (no marker, no record) and an already-stripped home
  // are left alone.
  if (!marked && !added) return { stripped: false };

  const notes: string[] = [];
  let configText = rawConfig;
  if (hasProviderAiand(configText)) {
    // The stamp may be gone (a Hermes rewrite dropping unknown keys) while
    // the record proves the block is ours — but only while its key_env is
    // still the dedicated var we wrote; a repointed block is the user's. The
    // record alone never strips: without the stamp it takes the dedicated
    // key_env to prove the block is still ours.
    const looksOurs = readProviderField(configText, "key_env") === HERMES_PROVIDER_API_KEY_ENV;
    if (marked || looksOurs) {
      configText = stripHermesProvider(configText);
    } else {
      notes.push("left providers.aiand because you edited it");
    }
  }

  // The top-level default: hand back the set-aside line, or drop our pinned
  // line when nothing was there. A line the user changed in between is
  // theirs and stays, with a note.
  if (added?.wroteDefault !== undefined) {
    const current = readModelField(configText, "default");
    if (current === added.wroteDefault) {
      configText = restoreHermesModelLine(configText, "default", added.previousDefaultLine);
    } else if (current !== undefined) {
      notes.push("left model.default because you edited it");
    }
  }
  if (added?.wroteProvider === true) {
    const current = readModelField(configText, "provider");
    if (current === HERMES_PROVIDER_ID) {
      configText = restoreHermesModelLine(configText, "provider", added.previousProviderLine);
    } else if (current !== undefined) {
      notes.push("left model.provider because you edited it");
    }
  }
  // A file our on created that is now empty is unlinked, never left as a
  // stray; otherwise the key-free config goes back to its pre-on mode.
  if (configText !== rawConfig) {
    const created = added?.createdConfig === true || (await fileCreatedByUs(HERMES_ID, configPath));
    if (configText.trim() === "" && created) {
      await unlink(configPath).catch(() => {});
    } else {
      await writeFileAtomic(configPath, configText, {
        mode: added?.previousConfigMode ?? DEFAULT_FILE_MODE,
      });
    }
  }

  // The dedicated vars leave the .env; the user's own lines survive. A file
  // our on created that is now empty is unlinked, never left as a stray.
  // Set-aside ANTHROPIC_* lines come back, deduplicated against lines the
  // user added back themselves mid-wire.
  let envText = rawEnv
    .split("\n")
    .filter((line) => !OWNED_ENV_RE.test(line))
    .join("\n");
  for (const line of added?.strippedEnvLines ?? []) {
    if (!envText.split("\n").includes(line)) {
      envText =
        envText === "" || envText.endsWith("\n") ? `${envText}${line}\n` : `${envText}\n${line}\n`;
    }
  }
  if (envText !== rawEnv) {
    const created = added?.createdEnv === true || (await fileCreatedByUs(HERMES_ID, envPath));
    if (envText.trim() === "" && created) {
      await unlink(envPath).catch(() => {});
    } else {
      // The key left the file: hand back the mode the user had before on.
      await writeFileAtomic(envPath, envText, {
        mode: added?.previousEnvMode ?? PRIVATE_FILE_MODE,
      });
    }
  }

  // Our plugin files leave; a file the user edited in between (stamp gone)
  // stays, with a note. The provider dir goes when empty — other provider
  // ids are never touched.
  for (const path of [hermesInitPyPath(), hermesPluginYamlPath()]) {
    const existing = await readTextIfExists(path);
    if (existing === "") continue;
    if (existing.includes(HERMES_PLUGIN_STAMP)) {
      await unlink(path).catch(() => {});
    } else {
      notes.push(`left ${path} because you edited it`);
    }
  }
  await rmdir(providerDir).catch(() => {});

  await clearAddedState(HERMES_ID);
  return { stripped: true, notes };
}
export const hermesAdapter: AgentAdapter = {
  id: HERMES_ID,
  label: "Hermes Agent",
  bin: HERMES_BIN,
  install: HERMES_INSTALL,
  // The product's full name (install domain, docs): `aiand hermes-agent
  // on` and `aiand run-agent hermes-agent` resolve like `hermes`, the way
  // `claude-code` resolves to `claude`.
  aliases: ["hermes-agent"],
  detect(): DetectResult {
    return detectBinary(HERMES_BIN);
  },
  managedFiles(): string[] {
    return [hermesEnvPath(), hermesConfigPath(), hermesInitPyPath(), hermesPluginYamlPath()];
  },
  probe,
  enable,
  disable,
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    // Gated like disable()'s block strip: our stamp or record, plus a
    // key_env still naming the dedicated var. A marked config with a garbage
    // or non-loopback baseURL still holds our baked key and must be swapped,
    // but a record-only block the user repointed at their own var (stamp
    // gone, key_env renamed) is theirs — swapping our orphaned literal would
    // change nothing routable. A foreign `aiand`-named block (no marker, no
    // record) keeps its own key untouched.
    const configText = await readTextIfExists(hermesConfigPath());
    const marked =
      hasHermesMarker(configText) || (await getAddedState<HermesRecord>(HERMES_ID)) !== null;
    if (!marked) return false;
    if (readProviderField(configText, "key_env") !== HERMES_PROVIDER_API_KEY_ENV) return false;
    const envPath = hermesEnvPath();
    const raw = await readTextIfExists(envPath);
    const current = readEnvValue(raw, HERMES_PROVIDER_API_KEY_ENV);
    if (current === undefined) return false;
    // A same-key no-op still counts as touched: an idempotent rebake reports refreshed.
    if (current === input.apiKey) return true;
    // A rotation swaps only the key it replaced: a config baked from another
    // profile keeps routing to that profile's org.
    if (input.previousKey !== undefined && current !== input.previousKey) return false;
    // The swap touches only the baked literal; every other byte survives.
    // The key stays 0600 for as long as it lives here.
    await writeFileAtomic(
      envPath,
      replaceEnvValue(raw, HERMES_PROVIDER_API_KEY_ENV, input.apiKey),
      {
        mode: PRIVATE_FILE_MODE,
      },
    );
    return true;
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Works with no prior `on`: the routing lives in a throwaway HERMES_HOME
    // overlay, removed by cleanup when the child exits. Hermes reads its
    // key from the overlay .env, never the child env. `--model native`
    // arrives as the literal and leaves the model unpinned so Hermes's own
    // default wins; an explicit --model is pinned as-is; without one the
    // catalog default is pinned so a routed session never starts on a
    // provider the gateway key cannot reach.
    let model = input.model;
    if (model === "native") model = undefined;
    else if (model === undefined) model = resolveDefault(input.catalog, input.profileModel);
    const baseUrl = trimSlash(input.baseUrl ?? "") || DEFAULT_BASE_URL;
    // Snapshot before the child can self-relocate the store shims onto the
    // overlay path that cleanup is about to remove.
    const shims = await snapshotShims(detectBinary(HERMES_BIN).path);
    const overlay = await buildHermesOverlay(hermesHome(), {
      apiKey: input.apiKey,
      baseUrl,
      model,
    });
    // Mode is how the model was chosen: pinned (explicit or catalog
    // default) or native (Hermes's own default decides).
    if (process.env.AIAND_DEBUG === "1") {
      process.stderr.write(`[aiand hermes] mode: ${model === undefined ? "native" : "pinned"}\n`);
      process.stderr.write(`[aiand hermes] model: ${model ?? "(Hermes default)"}\n`);
      process.stderr.write(`[aiand hermes] base URL: ${baseUrl}\n`);
      process.stderr.write(`[aiand hermes] home overlay: ${overlay}\n`);
    }
    return {
      env: {
        HERMES_HOME: overlay,
        HERMES_INFERENCE_PROVIDER: HERMES_PROVIDER_ID,
        // Native names no model of ours: only the pinned launch sets the
        // model ids. HERMES_TUI_PROVIDER is deliberately absent — Hermes
        // does not honour it, so setting it would only mislead.
        ...(model === undefined ? {} : { HERMES_MODEL: model, HERMES_INFERENCE_MODEL: model }),
      },
      // The overlay pins provider and model; a user flag would override the
      // injected routing, so the launcher drops these from the passthrough
      // (both `--flag value` and `--flag=value`). The set is Hermes's own
      // (`-m, --model MODEL` and `--provider PROVIDER` per `hermes --help`).
      args: ["--provider", HERMES_PROVIDER_ID, ...(model === undefined ? [] : ["--model", model])],
      stripPassthroughFlags: ["--provider", "--model", "-m"],
      cleanup: async () => {
        // Shims first: the user's `hermes` binary must never point at a
        // path cleanup is about to delete.
        await restoreShims(shims, overlay);
        await rm(overlay, { recursive: true, force: true });
      },
    };
  },
};
