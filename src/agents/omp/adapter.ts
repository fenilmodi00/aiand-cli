import { existsSync } from "node:fs";
import { chmod, unlink } from "node:fs/promises";
import { CliError } from "../../cli/errors.js";
import { isRoutableBaseUrl, writeFileAtomic } from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import { detectBinary } from "../detect.js";
import { asObject, readTextIfExists } from "../managed-file.js";
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
} from "../types.js";
import { OMP_INSTALL } from "./install.js";
import { ompConfigPath, ompModelsPath, ompRefreshKey, ompSessionLaunch } from "./launch.js";
import {
  buildOmpProviderBlock,
  OMP_MARKER,
  OMP_MARKER_KEY,
  OMP_PROVIDER_ID,
  ompBaseUrl,
} from "./provider.js";
import { readYamlMapping, yamlDelete, yamlSet } from "./yaml.js";

const OMP_MANAGED_FILES = [ompModelsPath, ompConfigPath] as const;
const OMP_ID = "omp";
const OMP_BIN = "omp";

/** Recovery hint for an omp config file that cannot be parsed or edited. */
const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand omp on again.";

/**
 * What enable() recorded so off can tell its values from the user's. The
 * baked key never appears here: only ids, previous values, file modes, and
 * the absolute paths we wrote (paths are not secrets; the snapshot manifest
 * already stores them).
 */
type OmpRecord = {
  /** What config.yml's modelRoles.default was before on (undefined = absent). */
  previousDefaultModel?: string;
  /** The modelRoles.default this on wrote; off hands back or removes it. */
  wroteDefaultModel?: string;
  /** The providers.aiand.baseUrl this on wrote; off's ownership proof. */
  wroteBaseUrl?: string;
  /** File mode before `on` wrote it, per file off rewrites. */
  previousModelsMode?: number;
  previousConfigMode?: number;
  /** Where `on` actually wrote the files; off strips them if the dir moved. */
  modelsPath?: string;
  configPath?: string;
};

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
/**
 * Run a surgical yaml edit, mapping a SyntaxError to the recovery
 * hint: the parser accepts shapes the line editors cannot splice
 * (a sequence where a mapping is needed), and that must fail loud
 * like readOmpFile, never write a corrupted file.
 */
function editOmpYaml(path: string, edit: () => string): string {
  try {
    return edit();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError(`${path} is not valid YAML.`, { hint: INVALID_CONFIG_HINT });
    }
    throw error;
  }
}

/** The `aiand` provider block in models.yml, when it is a mapping. */
function aiandProvider(models: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(aiandProviderParent(models)?.[OMP_PROVIDER_ID]);
}

function aiandProviderParent(models: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(models.providers);
}

/** True when our stamp sits on the models.yml `aiand` provider block. */
function hasOwnershipMarker(models: Record<string, unknown>): boolean {
  return aiandProvider(models)?.[OMP_MARKER_KEY] === OMP_MARKER;
}
/**
 * Ownership of an `aiand` provider block: with a live record, the
 * baseUrl `on` wrote still in place — a repointed block is the
 * user's even when the stamp survived, and a stamp-dropped block
 * the record still proves is ours. Without a record the stamp alone
 * is the authority (there is nothing to compare against). Mirrors
 * hermes's disable gating (#18 P18-omp-2, P18-omp-4).
 */
function ownsProviderBlock(models: Record<string, unknown>, added: OmpRecord | null): boolean {
  const provider = aiandProvider(models);
  if (provider === undefined) return false;
  if (added === null) {
    // No record: the stamp alone is the authority, but only while the
    // block still names where ai& lives — a stamped block repointed at
    // the user's own origin is theirs, and status must not claim it
    // (#18 P18-omp-2).
    const baseUrl = provider.baseUrl;
    return (
      hasOwnershipMarker(models) &&
      typeof baseUrl === "string" &&
      baseUrl === ompBaseUrl() &&
      isRoutableBaseUrl(baseUrl)
    );
  }
  const baseUrl = provider.baseUrl;
  return typeof baseUrl === "string" && baseUrl === added.wroteBaseUrl;
}

async function probe(): Promise<ProbeResult> {
  let models: Record<string, unknown>;
  let config: Record<string, unknown>;
  let added: OmpRecord | null;
  try {
    models = await readOmpFile(ompModelsPath());
    config = await readOmpFile(ompConfigPath());
    added = await getAddedState<OmpRecord>(OMP_ID);
  } catch {
    // A file mid-edit (or an unreadable record) must not wedge
    // `omp status`.
    return { active: false, model: null };
  }
  // Ownership answered the way `off` answers it — the stamp, or
  // a live record plus the baseUrl `on` wrote still in place —
  // so status never claims routing `off` refuses to undo: a
  // repointed block is the user's, a stamp-dropped one the
  // record still proves is ours (#18 P18-omp-2, P18-omp-4).
  if (!ownsProviderBlock(models, added)) return { active: false, model: null };
  const baseUrl = aiandProvider(models)?.baseUrl;
  if (!isRoutableBaseUrl(typeof baseUrl === "string" ? baseUrl : undefined)) {
    return { active: false, model: null };
  }
  const defaultModel = asObject(config.modelRoles)?.default;
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

  // A foreign provider merely named `aiand` is never ours to overwrite —
  // except a stamp a rewrite dropped while the record still proves the
  // routing ours: that block is one `off` would strip, so a re-`on` may
  // rebake it. Mirrors pi's guard (#18 P18-pi-5).
  const added = await getAddedState<OmpRecord>(OMP_ID);
  if (
    aiandProvider(models) !== undefined &&
    !hasOwnershipMarker(models) &&
    !ownsProviderBlock(models, added)
  ) {
    throw new CliError("Oh My Pi already has a providers.aiand block that ai& does not manage.", {
      hint: "Remove or rename the foreign block by hand, then run aiand omp on again.",
    });
  }

  // The prior on's record is still live only while the block proves ours —
  // the marker, or a live record plus the baseUrl `on` wrote still in
  // place; after an `off` or a hand edit it is stale and must not be
  // carried forward.
  const prior = ownsProviderBlock(models, added) ? added : null;
  const warnings: string[] = [];
  const catalog = input.catalog;
  const isNative = input.model === "native";
  const inCatalog = (id: string): boolean => catalog.some((model) => model.id === id);

  // models.yml: our override-only provider block, replacing any prior one of
  // ours. Every unrelated provider and key survives — yamlSet splices one
  // property.
  const modelsText = editOmpYaml(paths.models, () =>
    yamlSet(
      raw.models,
      ["providers", OMP_PROVIDER_ID],
      buildOmpProviderBlock({ baseUrl: input.baseUrl, apiKey: input.apiKey }),
    ),
  );

  // config.yml: modelRoles.default, additive. The prior value is what off
  // hands back; on a re-`on` the first capture stays authoritative.
  const modelRoles = asObject(config.modelRoles);
  const userDefaultModel = typeof modelRoles?.default === "string" ? modelRoles.default : "";

  let configText = raw.config;
  let wroteDefaultModel: string | undefined;
  let previousDefaultModel = prior?.previousDefaultModel;
  if (isNative) {
    // Leave the model unpinned: omp's own default resolution wins (with our
    // provider block, that is the bundled aiand default). on still wires
    // routing, so the user can pick a model in omp.
    warnings.push(
      "Oh My Pi's own default model resolution is in effect; pass --model to pick one.",
    );
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
    configText = editOmpYaml(paths.config, () =>
      yamlSet(configText, ["modelRoles", "default"], `${OMP_PROVIDER_ID}/${input.model}`),
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
    modelsPath: paths.models,
    configPath: paths.config,
    wroteBaseUrl: ompBaseUrl(input.baseUrl),
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
  const marked = hasOwnershipMarker(models);

  // Ownership of the `aiand` provider block: our stamp, or —
  // when a rewrite dropped it — a live record plus the
  // baseUrl `on` wrote still in place. A repointed block (a
  // baseUrl we did not write) or a foreign `aiand`-named
  // block is the user's: left in place with a note, never
  // stripped. Without a record the stamp alone is the
  // authority.
  const ours = ownsProviderBlock(models, added);

  // Everything below runs for a stamped block or a live
  // record: a stamp-dropped block the record still owns must
  // hand config.yml back too.
  if (marked || added) {
    // Parse config.yml before any write: when it cannot be parsed, off writes
    // nothing — the record and the models.yml marker stay, so a retry after
    // the fix can still strip our block and restore the previous default.
    let configText = raw.config;
    let config: Record<string, unknown>;
    try {
      config = readYamlMapping(configText);
    } catch {
      return {
        stripped: false,
        notes: [`${paths.config} is not valid YAML; fix it, then run aiand omp off again.`],
      };
    }

    if (ours) {
      stripped = true;

      // models.yml: drop our provider block; unrelated providers survive, and
      // an emptied `providers` map (ours alone) is dropped with it.
      let modelsText = editOmpYaml(paths.models, () =>
        yamlDelete(raw.models, ["providers", OMP_PROVIDER_ID]),
      );
      const left = aiandProviderParent(readYamlMapping(modelsText));
      if (left && Object.keys(left).length === 0) {
        modelsText = editOmpYaml(paths.models, () => yamlDelete(modelsText, ["providers"]));
      }
      await writeStripped(
        paths.models,
        raw.models,
        modelsText,
        added?.previousModelsMode ?? DEFAULT_FILE_MODE,
      );
    } else if (aiandProvider(models) !== undefined) {
      // Repointed or foreign: the block is the user's, so it
      // stays exactly as they left it.
      notes.push("left providers.aiand because you edited it");
    }

    // config.yml: hand back modelRoles.default on set aside or wrote.
    // Values the user changed in between are theirs and stay, with a note.
    const modelRoles = asObject(config.modelRoles);
    if (added?.wroteDefaultModel !== undefined) {
      if (modelRoles?.default === added.wroteDefaultModel) {
        if (added.previousDefaultModel !== undefined) {
          configText = editOmpYaml(paths.config, () =>
            yamlSet(configText, ["modelRoles", "default"], added.previousDefaultModel!),
          );
        } else {
          configText = editOmpYaml(paths.config, () =>
            yamlDelete(configText, ["modelRoles", "default"]),
          );
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
    if (configText !== raw.config) stripped = true;
  }

  // A dir move after `on` (PI_CODING_AGENT_DIR / PI_CONFIG_DIR retargeted)
  // leaves our block in the old files while the current dir shows nothing
  // of ours. The record knows where `on` actually wrote: strip those too,
  // or the baked key stays live forever with nothing pointing at it.
  for (const kind of ["models", "config"] as const) {
    const stalePath = kind === "models" ? added?.modelsPath : added?.configPath;
    if (!stalePath || stalePath === paths[kind] || !existsSync(stalePath)) continue;
    const rawStale = await readTextIfExists(stalePath);
    let stale: Record<string, unknown>;
    try {
      stale = kind === "models" ? await readOmpFile(stalePath) : readYamlMapping(rawStale);
    } catch (error) {
      if (error instanceof CliError || error instanceof SyntaxError) {
        // Keep the record: after the fix, off must still find this path.
        // Report the running total, not a hardcoded true: when nothing was
        // stripped yet (moved dir, first stale file unreadable) this is false.
        return {
          stripped,
          notes: [`${stalePath} is not valid YAML; fix it, then run aiand omp off again.`],
        };
      }
      throw error;
    }
    let staleText = rawStale;
    if (kind === "models") {
      // The same ownership rule as the current dir: a foreign
      // block is left alone, and so is one the user repointed.
      if (!ownsProviderBlock(stale, added)) {
        if (aiandProvider(stale) !== undefined) {
          notes.push(`left providers.aiand in ${stalePath} because you edited it`);
        }
        continue;
      }
      staleText = editOmpYaml(stalePath, () =>
        yamlDelete(rawStale, ["providers", OMP_PROVIDER_ID]),
      );
      const left = aiandProviderParent(readYamlMapping(staleText));
      if (left && Object.keys(left).length === 0) {
        staleText = editOmpYaml(stalePath, () => yamlDelete(staleText, ["providers"]));
      }
    } else if (added?.wroteDefaultModel !== undefined) {
      // config.yml: the same hand-back logic as the current dir, same
      // record. Values the user changed in between are theirs and stay.
      const modelRoles = asObject(stale.modelRoles);
      if (modelRoles?.default === added.wroteDefaultModel) {
        staleText = editOmpYaml(stalePath, () =>
          added.previousDefaultModel !== undefined
            ? yamlSet(staleText, ["modelRoles", "default"], added.previousDefaultModel)
            : yamlDelete(staleText, ["modelRoles", "default"]),
        );
      } else if (modelRoles?.default !== undefined) {
        notes.push("left modelRoles.default because you edited it");
      }
    }
    await writeStripped(
      stalePath,
      rawStale,
      staleText,
      (kind === "models" ? added?.previousModelsMode : added?.previousConfigMode) ??
        DEFAULT_FILE_MODE,
    );
    if (staleText !== rawStale) {
      stripped = true;
      notes.push(`stripped the aiand block from ${stalePath} because the omp config dir moved`);
    }
  }

  await clearAddedState(OMP_ID);
  return { stripped, notes };
}

export const ompAdapter: AgentAdapter = {
  id: OMP_ID,
  label: "Oh My Pi",
  bin: OMP_BIN,
  aliases: ["oh-my-pi"],
  install: OMP_INSTALL,
  // The launcher routes through a throwaway overlay dir (a
  // generated models.yml + config.yml), so these inherited
  // names would shadow or bypass that file routing. Literal
  // list, never a sweep — each name is proven against the omp
  // v18.4.4 binary this host runs (`~/.local/bin/omp`, via
  // `omp --help` and strings probing of the embedded source):
  // - OMP_PROFILE: with the overlay's baseUrl dead and its key
  //   fake, `OMP_PROFILE=probe` still completed a real request —
  //   a named profile's auth/config replaces the overlay files
  //   entirely ("Named profile for isolated agent state").
  // - AIAND_BASE_URL: the bundled aiand provider's resolver
  //   reads `block.baseUrl ?? Bun.env.AIAND_BASE_URL` (embedded
  //   source); the populated overlay block wins, but this is
  //   the live fallback name on the aiand routing path and
  //   sessionLaunch never sets it.
  // - PI_SMOL_MODEL / PI_SLOW_MODEL / PI_PLAN_MODEL: `omp
  //   --help` and the binary's env reference document these as
  //   role-model overrides; a value naming another provider's
  //   model routes that role off-provider, outside the gateway
  //   (hermes lists HERMES_MODEL et al. for the same reason).
  // NOT listed: AIAND_API_KEY (the aiand provider's declared
  // envVars key) — run-agent.ts deletes it unconditionally
  // before shadowEnv runs, and the overlay's models.yml carries
  // the key anyway; ANTHROPIC_* — omp consults those only for
  // its anthropic provider, unreachable under the overlay (the
  // default is pinned to aiand, role overrides deleted, and
  // --model/--provider stripped from the passthrough).
  shadowEnv: ["OMP_PROFILE", "AIAND_BASE_URL", "PI_SMOL_MODEL", "PI_SLOW_MODEL", "PI_PLAN_MODEL"],
  // "--model native" leaves the default unpinned instead of
  // catalog-validated: sessionLaunch drops the model pin and
  // lets omp's own default resolution pick.
  allowUnpinnedModel: true,
  detect(): DetectResult {
    return detectBinary(OMP_BIN);
  },
  managedFiles(): string[] {
    // The recorded paths too, so restore works from a shell
    // without the PI_CODING_AGENT_DIR that relocated the agent
    // dir (#18).
    const added = getAddedStateSync<OmpRecord>(OMP_ID);
    const files = OMP_MANAGED_FILES.map((path) => path());
    for (const path of [added?.modelsPath, added?.configPath]) {
      if (path && !files.includes(path)) files.push(path);
    }
    return files;
  },
  probe,
  enable,
  disable,
  refreshKey: (input) => ompRefreshKey(input),
  sessionLaunch: (input) => ompSessionLaunch(input),
};
