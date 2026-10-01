import { chmod, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  HERMES_KEY_ENV,
  HERMES_PROVIDER_ID,
  hasHermesMarker,
  hasProviderAiand,
  pinHermesModel,
  pinHermesProvider,
  readEnvValue,
  readModelField,
  readProviderField,
  removeEnvPair,
  restoreHermesModelProvider,
  setHermesModelProvider,
  stripHermesProvider,
  upsertEnvPair,
} from "./routing.js";

/** What enable() recorded so off can tell its own values from the user's. */
type HermesRecord = {
  /** Effective default this on pinned (top-level and block); undefined when native. */
  wroteDefault?: string;
  /** model.default before this on, when this on changed or removed it. */
  previousDefault?: string;
  /** This on deleted model.default (native). */
  removedDefault?: boolean;
  /** Dict-block scalars this on wrote, for hand-edit detection (names only, never the key). */
  wroteProvider?: { baseUrl: string; keyEnv: string; defaultModel?: string };
  /** model.provider before this on (undefined = absent); off restores it. */
  previousProvider?: string;
  /** File modes before `on`; disable() hands them back once the key leaves. */
  previousModes?: { config?: number; env?: number };
  created?: { config?: boolean; env?: boolean };
};

/** The adapter id (`aiand hermes`), also the key for its snapshot state. */
const HERMES_ID = "hermes";
const HERMES_BIN = "hermes";

// No commit pin: upstream ships an unversioned install script (no SHA to name
// in the hint, no CI pin to keep in step), unlike OPENCODE_VERSION's
// `npm install -g opencode-ai@<version>` + check-dist pair. If Hermes ever
// ships versioned installs, pin here and check it the same way.
const HERMES_INSTALL = {
  command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
  url: "https://hermes-agent.nousresearch.com/docs/",
};

/** Provider base_url for Hermes: the gateway origin plus its /v1 route root. */
const hermesWireBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

/** Hermes home: the override is first-class upstream, default is `~/.hermes`. */
function hermesHome(): string {
  return process.env.HERMES_HOME || join(agentHome(), ".hermes");
}

function hermesConfigPath(): string {
  return join(hermesHome(), "config.yaml");
}

function hermesEnvPath(): string {
  return join(hermesHome(), ".env");
}

/**
 * Dict-or-legacy presence that never throws: disable() already survived the
 * marker read, so a malformed section stays a cleanup path, never a throw.
 */
function hasProviderAiandQuiet(text: string): boolean {
  try {
    return hasProviderAiand(text);
  } catch {
    return false;
  }
}

async function probe(): Promise<ProbeResult> {
  try {
    const configText = await readTextIfExists(hermesConfigPath());
    const envText = await readTextIfExists(hermesEnvPath());
    const marked = hasHermesMarker(configText);
    // AddedState backstop: a stamp lost to hand-editing still reads active
    // while the routing it recorded is live. Skipped when marked so a corrupt
    // record can never wedge `hermes status`.
    if (!marked && !(await getAddedState<HermesRecord>(HERMES_ID))) {
      return { active: false, model: null };
    }
    // The record alone never reads active: without the stamp, the dedicated
    // key_env must still prove the block is ours — a block the user repointed
    // at their own var is theirs even with a live record. (#17 P17-5)
    if (!marked && readProviderField(configText, "key_env") !== HERMES_KEY_ENV) {
      return { active: false, model: null };
    }
    if (!isRoutableBaseUrl(readProviderField(configText, "base_url"))) {
      return { active: false, model: null };
    }
    if (!readEnvValue(envText, HERMES_KEY_ENV)) {
      return { active: false, model: null };
    }
    return { active: true, model: readModelField(configText, "default") ?? null };
  } catch {
    // A file mid-edit must not wedge `hermes status`.
    return { active: false, model: null };
  }
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const configPath = hermesConfigPath();
  const envPath = hermesEnvPath();
  const rawConfig = await readTextIfExists(configPath);
  const rawEnv = await readTextIfExists(envPath);
  // Only a missing file counts as created by us: a pre-existing empty file
  // belongs to the user, and `off` must never unlink it.
  let createdConfig = false;
  let createdEnv = false;
  for (const [path, set] of [
    [configPath, (value: boolean) => (createdConfig = value)],
    [envPath, (value: boolean) => (createdEnv = value)],
  ] as const) {
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      set(true);
    }
  }

  // Reads throw CliError with a by-hand hint on shapes aiand cannot edit
  // (tabs, inline sections) — like a non-object JSON root, enable fails loud.
  const currentDefault = readModelField(rawConfig, "default");
  const currentProvider = readModelField(rawConfig, "provider");
  const marked = hasHermesMarker(rawConfig);
  const inCatalog = (id: string): boolean => input.catalog.some((model) => model.id === id);
  // The prior on's record is still live only when the file holds exactly what
  // it wrote; after an `off` or a hand edit the record is stale and must not
  // be carried forward.
  const prior = await getAddedState<HermesRecord>(HERMES_ID);
  const priorLive =
    prior?.wroteDefault !== undefined
      ? currentDefault === prior.wroteDefault
      : prior?.removedDefault === true
        ? currentDefault === undefined
        : false;
  // A re-on finds provider already ours: carry the first on's restore target
  // so off still hands back the user's original, never our own flip.
  const previousProvider =
    currentProvider === HERMES_PROVIDER_ID ? prior?.previousProvider : currentProvider;

  // Hermes joins base_url + "/chat/completions" for its OpenAI-wire routes
  // (verified against 0.21.5 on host: the bare origin 404s with the gateway's
  // own "Use /v1/chat/completions" hint). base_url therefore carries the /v1
  // route root, same as Pi's provider and Codex's profile.
  const baseUrl = hermesWireBaseUrl(input.baseUrl);
  const isNative = input.model === "native";
  const warnings: string[] = [];
  // `effective` is the default live after this run; undefined leaves it unpinned.
  let effective: string | undefined;
  let wroteDefault: string | undefined;
  let previousDefault: string | undefined;
  let removedDefault = false;
  // Keep-vs-pin, copied from the OpenCode adapter and kept per-agent on
  // purpose: sharing it would touch foundation files against the minimal-touch
  // goal. An explicit --model pins, a servable current default is kept with a
  // provider flip, `native` leaves the default unpinned, and an unservable
  // default is set aside for off.
  if (isNative) {
    if (currentDefault !== undefined) {
      previousDefault = priorLive ? prior?.previousDefault : currentDefault;
      removedDefault = true;
    } else {
      previousDefault = prior?.previousDefault;
      removedDefault = prior?.removedDefault ?? false;
    }
    warnings.push("Left the model unpinned (native). Pass --model to pin a gateway model.");
  } else if (!input.pinModel && currentDefault !== undefined && inCatalog(currentDefault)) {
    effective = currentDefault;
    if (priorLive && prior?.wroteDefault !== undefined) {
      // Still our live pin from the prior on: keep its restore target.
      wroteDefault = prior.wroteDefault;
      previousDefault = prior.previousDefault;
    }
    // Else the servable default is the user's own — kept, and off leaves it.
    if (currentProvider !== HERMES_PROVIDER_ID) {
      warnings.push(`Left your existing model (${currentDefault}). Pass --model to switch.`);
    }
  } else if (!input.pinModel && currentDefault !== undefined) {
    effective = input.model;
    wroteDefault = input.model;
    previousDefault = priorLive ? prior?.previousDefault : currentDefault;
    warnings.push(`Set aside your model (${currentDefault}); aiand hermes off puts it back.`);
  } else if (currentDefault !== input.model) {
    effective = input.model;
    wroteDefault = input.model;
    previousDefault = priorLive ? prior?.previousDefault : currentDefault;
  } else if (priorLive) {
    // Already pinned to the requested id by the prior on: keep its target,
    // never chain our own ref onto itself.
    effective = input.model;
    wroteDefault = prior?.wroteDefault;
    previousDefault = prior?.previousDefault;
  }
  // Else a hand-set match with no live record: theirs, and off leaves it.

  // The provider upsert refuses a foreign `aiand` block or legacy list entry
  // with a by-hand hint and never overwrites either.
  let text = pinHermesProvider(
    rawConfig,
    effective === undefined ? { baseUrl } : { baseUrl, model: effective },
  );
  if (isNative) {
    text = pinHermesModel(text, undefined);
  } else if (!input.pinModel && currentDefault !== undefined && inCatalog(currentDefault)) {
    text = setHermesModelProvider(text);
  } else {
    text = pinHermesModel(text, input.model);
  }
  const nextEnv = upsertEnvPair(rawEnv, HERMES_KEY_ENV, input.apiKey);

  // A re-on carries the first on's recorded modes so off still restores the
  // user's originals. The key file locks to 0600; the yaml holds no secret.
  const previousModes = {
    config:
      prior?.previousModes?.config ?? (await existingFileMode(configPath)) ?? DEFAULT_FILE_MODE,
    env: prior?.previousModes?.env ?? (await existingFileMode(envPath)) ?? DEFAULT_FILE_MODE,
  };
  if (text !== rawConfig) {
    await writeFileAtomic(configPath, text, { mode: previousModes.config });
  }
  if (nextEnv !== rawEnv) {
    await writeFileAtomic(envPath, nextEnv, { mode: PRIVATE_FILE_MODE });
  } else {
    // Unchanged bytes still re-tighten a loosened file: the baked session
    // key must stay 0600 for as long as it lives here.
    await chmod(envPath, PRIVATE_FILE_MODE);
  }
  // A file our prior on created is still ours while it still carries the
  // marker (no `off` has stripped it since). No secret bytes: the record
  // holds names and model ids only, the key lives in `.env` alone.
  await recordAddedState(HERMES_ID, {
    wroteDefault,
    previousDefault,
    removedDefault,
    wroteProvider: {
      baseUrl,
      keyEnv: HERMES_KEY_ENV,
      ...(effective === undefined ? {} : { defaultModel: effective }),
    },
    previousProvider,
    previousModes,
    created: {
      config: createdConfig || (prior?.created?.config === true && marked),
      env: createdEnv || (prior?.created?.env === true && marked),
    },
  } satisfies HermesRecord);

  return {
    model: effective ?? input.model,
    catalogModel: effective !== undefined && inCatalog(effective) ? effective : undefined,
    filesWritten: [configPath, envPath],
    warnings,
  };
}

async function disable(): Promise<DisableResult> {
  const configPath = hermesConfigPath();
  const envPath = hermesEnvPath();
  const rawConfig = await readTextIfExists(configPath);
  const rawEnv = await readTextIfExists(envPath);
  if (!rawConfig.trim() && !rawEnv.trim()) {
    await clearAddedState(HERMES_ID);
    return { stripped: false };
  }
  let marked: boolean;
  try {
    marked = hasHermesMarker(rawConfig);
  } catch {
    // Keep the record: once config.yaml is fixed, off can still tell our
    // values from the user's.
    return {
      stripped: false,
      notes: [`${configPath} needs a by-hand fix; fix it, then run aiand hermes off again.`],
    };
  }
  const added = await getAddedState<HermesRecord>(HERMES_ID);
  if (!marked && !added) {
    await clearAddedState(HERMES_ID);
    return { stripped: false };
  }

  const notes: string[] = [];
  let text = rawConfig;
  let stripped = false;

  // Everything below is gated on our stamp or record: a foreign `aiand`
  // block (no marker, no record) and an already-stripped file stay untouched.
  // The stamp may be gone (a Hermes rewrite dropping unknown keys) while the
  // record proves the block is ours — but only while its key_env is still
  // the dedicated var we wrote; a repointed block is the user's. The record
  // alone never strips: without the stamp it takes the dedicated key_env to
  // prove the block is still ours. (#17 P17-5)
  const looksOurs = readProviderField(text, "key_env") === HERMES_KEY_ENV;
  if (marked) {
    const expected = added?.wroteProvider;
    const edited =
      expected !== undefined &&
      (readProviderField(text, "base_url") !== expected.baseUrl ||
        readProviderField(text, "key_env") !== expected.keyEnv ||
        readProviderField(text, "default_model") !== expected.defaultModel);
    if (edited) {
      notes.push("left providers.aiand because you edited it");
    } else {
      text = stripHermesProvider(text);
    }
    stripped = true;
  } else if (added && looksOurs) {
    // Stamp-dropped but still ours: the record plus the dedicated key_env.
    text = stripHermesProvider(text, { allowUnmarked: true });
    stripped = true;
  } else if (added && hasProviderAiandQuiet(text)) {
    notes.push("left providers.aiand because you edited it");
  }

  if (marked || added) {
    let modelReadable = true;
    let currentProvider: string | undefined;
    let currentDefault: string | undefined;
    try {
      currentProvider = readModelField(text, "provider");
      currentDefault = readModelField(text, "default");
    } catch {
      modelReadable = false;
      notes.push(`${configPath} has a model section ai& does not edit; left it as is.`);
    }
    if (modelReadable) {
      if (currentProvider !== undefined && currentProvider !== HERMES_PROVIDER_ID) {
        if (added) notes.push("left model because you edited it");
      } else {
        if (added?.wroteDefault !== undefined && currentDefault === added.wroteDefault) {
          text =
            added.previousDefault !== undefined
              ? pinHermesModel(text, added.previousDefault)
              : pinHermesModel(text, undefined);
        } else if (added?.wroteDefault !== undefined && currentDefault !== undefined) {
          notes.push("left model.default because you edited it");
        } else if (
          added?.removedDefault === true &&
          currentDefault === undefined &&
          added.previousDefault !== undefined
        ) {
          text = pinHermesModel(text, added.previousDefault);
        }
        // Our flip rides back: restore the provider line `on` found (or drop
        // it when there was none). A provider naming anything else is the
        // user's hand edit and stays with a note (handled above).
        if (currentProvider === HERMES_PROVIDER_ID) {
          text = restoreHermesModelProvider(text, added?.previousProvider);
        }
      }
    }
  }

  const env = removeEnvPair(rawEnv, HERMES_KEY_ENV);

  if (text !== rawConfig) {
    const empty = text.trim() === "";
    const created =
      added?.created?.config === true || (await fileCreatedByUs(HERMES_ID, configPath));
    if (empty && created) {
      await unlink(configPath);
    } else {
      // No secret lives in the yaml: hand back the mode from before on.
      await writeFileAtomic(configPath, text, {
        mode: added?.previousModes?.config ?? DEFAULT_FILE_MODE,
      });
    }
  }
  if (env !== rawEnv) {
    const created = added?.created?.env === true || (await fileCreatedByUs(HERMES_ID, envPath));
    if (env === "" && created) {
      await unlink(envPath);
    } else {
      // The key left the file: hand back the mode from before on.
      await writeFileAtomic(envPath, env, { mode: added?.previousModes?.env ?? DEFAULT_FILE_MODE });
    }
  }

  stripped = stripped || text !== rawConfig || env !== rawEnv;
  // Next `on` must record the current modes, not the first-on ones.
  await clearAddedState(HERMES_ID);
  return { stripped, notes };
}

async function sessionLaunch(input: SessionLaunchInput) {
  // One-shot state-fresh: the overlay starts from "" (routing-only) — no
  // sessions, skills, or memory ride along, and the child can never write
  // through to the real home. Copies only, never symlinks; no shim
  // snapshot/restore touches anything outside the overlay.
  let model = input.model;
  if (model === "native") model = undefined;
  else if (model === undefined) model = resolveDefault(input.catalog, input.profileModel);
  const baseUrl = hermesWireBaseUrl(input.baseUrl);
  const overlay = await mkdtemp(join(tmpdir(), "aiand-hermes-"));
  const configText = pinHermesModel(
    pinHermesProvider("", model === undefined ? { baseUrl } : { baseUrl, model }),
    model,
  );
  await writeFileAtomic(join(overlay, "config.yaml"), configText, { mode: DEFAULT_FILE_MODE });
  // The key alone: nothing reads any other var from the overlay .env (probe
  // reads the provider block), and the key file locks to 0600 like T3's.
  await writeFileAtomic(join(overlay, ".env"), upsertEnvPair("", HERMES_KEY_ENV, input.apiKey), {
    mode: PRIVATE_FILE_MODE,
  });
  return {
    env: { HERMES_HOME: overlay },
    // Belt-and-braces per SPEC §7.4: the overlay config already pins provider
    // + model (the fallback routing), so these flags only restate it for
    // Hermes CLIs that honor per-invocation --provider/--model.
    args: ["--provider", HERMES_PROVIDER_ID, ...(model === undefined ? [] : ["--model", model])],
    // The set is Hermes's own per-invocation routing flags (--provider,
    // --model, and the -m short form). Kept on review (#17 P17-6): the hermes
    // binary was unavailable to re-check `hermes --help`, so the
    // user-visible surface stays and the strip is covered by test instead of
    // trimmed on a guess.
    stripPassthroughFlags: ["--provider", "--model", "-m"],
    cleanup: async () => {
      await rm(overlay, { recursive: true, force: true });
    },
  };
}

export const hermesAdapter: AgentAdapter = {
  id: HERMES_ID,
  label: "Hermes Agent",
  bin: HERMES_BIN,
  install: HERMES_INSTALL,
  // The product's full name (install domain, docs): `aiand hermes-agent on`
  // and `aiand run-agent hermes-agent` resolve like `hermes`, the way
  // `claude-code` resolves to `claude`. Verified against the installed
  // binary (#17 P17-6): the installer publishes a `hermes-agent` convenience
  // launcher next to `hermes`, and `aiand` only uses the alias for name
  // resolution — sessionLaunch always execs `hermes`, whose per-invocation
  // surface really has --provider, --model, and the -m short form.
  aliases: ["hermes-agent"],
  // The launcher (T4) routes through a throwaway overlay file, so these names
  // must not leak into the child env where they would shadow that routing.
  // A literal list, never an ANTHROPIC_*/OPENAI_* sweep: each name here is a
  // real env read in the installed binary (0.21.5) that can outrank the
  // overlay — the three ANTHROPIC_* names plus CLAUDE_CODE_OAUTH_TOKEN, which
  // the credentials resolver folds into the same ANTHROPIC_TOKEN tuple, are
  // the credential/base-URL routes Hermes consults; HERMES_MODEL /
  // HERMES_INFERENCE_MODEL / HERMES_INFERENCE_PROVIDER override model and
  // provider; OPENAI_API_KEY / OPENAI_BASE_URL feed the auxiliary "main"
  // route when the host env carries them. The wired adapters own their own
  // ANTHROPIC_* rows (claude's settings keep ANTHROPIC_MODEL,
  // ANTHROPIC_DEFAULT_*_MODEL, and ANTHROPIC_AUTH_TOKEN) — a sweep would drop
  // rows a sibling adapter set. (#17 P17-8, #18 review)
  shadowEnv: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "HERMES_MODEL",
    "HERMES_INFERENCE_MODEL",
    "HERMES_INFERENCE_PROVIDER",
  ],
  // "--model native" leaves the default unpinned instead of catalog-validated.
  allowUnpinnedModel: true,
  detect(): DetectResult {
    return detectBinary(HERMES_BIN);
  },
  managedFiles(): string[] {
    return [hermesConfigPath(), hermesEnvPath()];
  },
  probe,
  enable,
  disable,
  sessionLaunch,
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    // Gated like disable()'s block strip: our stamp or record, plus a
    // key_env still naming the dedicated var. A marked config with a garbage
    // or non-loopback baseURL still holds our baked key and must be swapped,
    // but a block the user repointed at their own var (stamp kept or dropped)
    // is theirs — swapping our orphaned literal would change nothing
    // routable. A foreign `aiand`-named block (no marker, no record) keeps
    // its own key untouched. (#17 P17-4)
    const rawEnv = await readTextIfExists(hermesEnvPath());
    const rawConfig = await readTextIfExists(hermesConfigPath());
    let marked = false;
    let keyEnv: string | undefined;
    try {
      marked = hasHermesMarker(rawConfig);
      keyEnv = readProviderField(rawConfig, "key_env");
    } catch {
      marked = false;
    }
    const added = await getAddedState<HermesRecord>(HERMES_ID);
    if (!marked && !added) return false;
    if (keyEnv !== HERMES_KEY_ENV) return false;
    const current = readEnvValue(rawEnv, HERMES_KEY_ENV);
    // A same-key no-op still counts as touched: an idempotent rebake reports
    // refreshed. Like enable()'s else-branch, it re-tightens a loosened key
    // file: the baked session key must stay 0600 for as long as it lives here.
    if (current === input.apiKey) {
      await chmod(hermesEnvPath(), PRIVATE_FILE_MODE);
      return true;
    }
    // A rotation swaps only the key it replaced: a config baked from another
    // profile keeps routing to that profile's org.
    if (input.previousKey !== undefined && current !== input.previousKey) return false;
    await writeFileAtomic(hermesEnvPath(), upsertEnvPair(rawEnv, HERMES_KEY_ENV, input.apiKey), {
      mode: PRIVATE_FILE_MODE,
    });
    // The record holds no key bytes, so nothing in AddedState needs refreshing.
    return true;
  },
};
