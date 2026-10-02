import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CliError } from "../../cli/errors.js";
import { agentHome, isRoutableBaseUrl, writeFileAtomic } from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import { resolveDefault } from "../catalog.js";
import { detectBinary } from "../detect.js";
import {
  asObject,
  createSessionOverlay,
  jsoncDelete,
  jsoncSet,
  readJsoncObject,
  readTextIfExists,
  writeStrippedJsonc,
} from "../managed-file.js";
import {
  clearAddedState,
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
import {
  aiandProvider,
  dropPiProvider,
  handBackSettings,
  PI_PROVIDER_ID,
  type PiRecord,
  parseConfigQuiet,
  routingStillOurs,
} from "./ownership.js";
import { buildPiProvider, piBaseUrl } from "./provider.js";

const PI_ID = "pi";
const PI_BIN = "pi";

/**
 * Ownership marker aiand stamps so off/logout strip surgically. It lives on
 * the auth.json credential because models.json is the one Pi file with a
 * schema behind it (TypeBox): a marker field there rides on schema
 * tolerance, while auth.json's loader only validates type/key and passes
 * unknown keys through.
 */
const PI_MARKER_KEY = "managedBy";
const PI_MARKER = "aiand";

/** Recovery hint for a Pi config file that cannot be parsed or edited. */
const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand pi on again.";

/** The agent config dir: ~/.pi/agent/, or $PI_CODING_AGENT_DIR when set. */
function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(agentHome(), ".pi", "agent");
}

function piModelsPath(): string {
  return join(piAgentDir(), "models.json");
}

function piAuthPath(): string {
  return join(piAgentDir(), "auth.json");
}

function piSettingsPath(): string {
  return join(piAgentDir(), "settings.json");
}

const PI_MANAGED_FILES = [piModelsPath, piAuthPath, piSettingsPath] as const;

/** The `aiand` credential block in auth.json, when it is an object. */
function aiandCredential(auth: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(auth[PI_PROVIDER_ID]);
}

/** True when our stamp sits on the auth.json `aiand` credential. */
function hasOwnershipMarker(auth: Record<string, unknown>): boolean {
  return aiandCredential(auth)?.[PI_MARKER_KEY] === PI_MARKER;
}

async function probe(): Promise<ProbeResult> {
  let auth: Record<string, unknown>;
  let models: Record<string, unknown>;
  let settings: Record<string, unknown>;
  try {
    auth = await readJsoncObject(piAuthPath(), INVALID_CONFIG_HINT);
    models = await readJsoncObject(piModelsPath(), INVALID_CONFIG_HINT);
    settings = await readJsoncObject(piSettingsPath(), INVALID_CONFIG_HINT);
  } catch {
    // A file mid-edit must not wedge `pi status`.
    return { active: false, model: null };
  }
  const baseUrl = aiandProvider(models)?.baseUrl;
  const added = await getAddedState<PiRecord>(PI_ID);
  if (hasOwnershipMarker(auth)) {
    // The stamp makes the credential ours, but the routing block can
    // still be the user's: a hand-repointed `providers.aiand.baseUrl`
    // must read inactive exactly like `off` reads it (P18-pi-3), so the
    // block has to match the baseUrl `on` wrote when the record knows
    // it. Records from before wroteBaseUrl keep the bare routability
    // check.
    const block = aiandProvider(models);
    if (added?.wroteBaseUrl !== undefined && block?.baseUrl !== added.wroteBaseUrl) {
      return { active: false, model: null };
    }
    if (!isRoutableBaseUrl(baseUrl)) return { active: false, model: null };
  } else {
    // AddedState backstop: a stamp lost to a Pi rewrite still
    // reads active while the routing it recorded is live. The
    // record alone never reads active — the block must still
    // prove itself ours (the baseUrl `on` wrote, routable,
    // still the default provider); a repointed or foreign block
    // is the user's. (#18 P18-pi-1)
    if (!routingStillOurs(models, settings, added)) {
      return { active: false, model: null };
    }
  }
  const model = typeof settings.defaultModel === "string" ? settings.defaultModel : null;
  return { active: true, model };
}

/**
 * Where plain `pi` keeps this cwd's sessions: a `sessionDir` from settings
 * when set, else Pi's per-cwd default (getDefaultSessionDirPath in 0.87.1's
 * session-manager.js). Pi merges `<cwd>/.pi/settings.json` over the global
 * `~/.pi/agent/settings.json` (settings-manager.js deepMergeSettings), so a
 * project-level `sessionDir` wins here exactly as it does for a plain `pi`
 * launch.
 */
async function piSessionDir(): Promise<string> {
  const globalSettings = await readJsoncObject(piSettingsPath()).catch(
    () => ({}) as Record<string, unknown>,
  );
  const projectSettings = await readJsoncObject(
    join(resolve(process.cwd()), ".pi", "settings.json"),
  ).catch(() => ({}) as Record<string, unknown>);
  const settings = { ...globalSettings, ...projectSettings };
  if (typeof settings.sessionDir === "string" && settings.sessionDir !== "") {
    return resolve(settings.sessionDir.replace(/^~(?=$|[/\\])/, agentHome()));
  }
  const cwd = resolve(process.cwd());
  return join(piAgentDir(), "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const paths = { models: piModelsPath(), auth: piAuthPath(), settings: piSettingsPath() };
  const raw = {
    models: await readTextIfExists(paths.models),
    auth: await readTextIfExists(paths.auth),
    settings: await readTextIfExists(paths.settings),
  };
  const models = await readJsoncObject(paths.models, INVALID_CONFIG_HINT);
  const auth = await readJsoncObject(paths.auth, INVALID_CONFIG_HINT);
  const settings = await readJsoncObject(paths.settings, INVALID_CONFIG_HINT);

  // A foreign provider merely named `aiand` is never ours to
  // overwrite, and neither is an unmarked `aiand` credential
  // in auth.json: `on` would clobber a key the user baked by
  // hand. The one exception is a stamp a Pi rewrite dropped
  // while the record still proves the routing ours — that
  // re-`on` may rebake. (#18 P18-pi-5)
  const added = await getAddedState<PiRecord>(PI_ID);
  const marked = hasOwnershipMarker(auth);
  if (
    !marked &&
    !routingStillOurs(models, settings, added) &&
    (aiandProvider(models) !== undefined || aiandCredential(auth) !== undefined)
  ) {
    throw new CliError("Pi already has an aiand config that ai& does not manage.", {
      hint: "Remove or rename the foreign block by hand, then run aiand pi on again.",
    });
  }

  // The prior on's record is live while our marker sits in auth.json,
  // or while the record still proves the routing ours (a Pi rewrite
  // dropped the stamp); otherwise it is stale and must not carry forward.
  const prior = marked || routingStillOurs(models, settings, added) ? added : null;
  const warnings: string[] = [];
  const catalog = input.catalog;
  const isNative = input.model === "native";
  const inCatalog = (id: string): boolean => catalog.some((model) => model.id === id);

  // models.json: our provider block, replacing any prior one of ours. Every
  // unrelated provider and key survives — jsoncSet splices one property.
  // The baseUrl is what the record keeps for off's ownership proof.
  const baseUrl = piBaseUrl(input.baseUrl);
  const modelsText = jsoncSet(
    raw.models,
    ["providers", PI_PROVIDER_ID],
    buildPiProvider({ baseUrl, catalog }),
  );

  // auth.json: the session key under the aiand credential, marked as ours.
  // Other providers' credentials survive untouched.
  const authText = jsoncSet(raw.auth, [PI_PROVIDER_ID], {
    type: "api_key",
    key: input.apiKey,
    [PI_MARKER_KEY]: PI_MARKER,
  });

  // settings.json: defaultProvider + defaultModel, additive. The prior
  // defaultProvider is what off hands back; on a re-`on` the first capture
  // stays authoritative (the file holds our "aiand" by then).
  const previousDefaultProvider =
    prior?.previousDefaultProvider ??
    (settings.defaultProvider === PI_PROVIDER_ID
      ? undefined
      : typeof settings.defaultProvider === "string"
        ? settings.defaultProvider
        : undefined);
  const userDefaultModel = typeof settings.defaultModel === "string" ? settings.defaultModel : "";

  let settingsText = raw.settings;
  let wroteDefaultModel: string | undefined;
  let previousDefaultModel = prior?.previousDefaultModel;
  if (isNative) {
    // Leave the model unpinned: Pi's own default resolution wins. on still
    // wires the provider + credential, so the user can pick a model in Pi.
    warnings.push("Pi's own default model is not on ai&; pass --model to pick one.");
    wroteDefaultModel = prior?.wroteDefaultModel;
    if (wroteDefaultModel !== undefined && userDefaultModel !== wroteDefaultModel) {
      // A hand edit replaced our write: the record's undo target is stale.
      wroteDefaultModel = undefined;
      previousDefaultModel = undefined;
    }
  } else if (userDefaultModel && inCatalog(userDefaultModel) && !input.pinModel) {
    // The user's pick is servable: keep it, write only the provider. A
    // kept model that is a prior on's still-live write keeps that record;
    // the user's own model needs no undo.
    settingsText = jsoncSet(settingsText, ["defaultProvider"], PI_PROVIDER_ID);
    wroteDefaultModel =
      prior !== null && prior.wroteDefaultModel === userDefaultModel ? userDefaultModel : undefined;
    if (wroteDefaultModel === undefined) previousDefaultModel = undefined;
  } else {
    // Replace with the requested/resolved model. One it cannot serve would
    // fail every request, so it is set aside (and warned) rather than kept.
    // Never chain our own ref onto itself: while a prior on's write is
    // still live, the restore target stays the first pre-aiand value.
    const priorLive = prior?.wroteDefaultModel === userDefaultModel;
    wroteDefaultModel = input.model;
    if (!priorLive) {
      if (userDefaultModel && !inCatalog(userDefaultModel)) {
        warnings.push(
          `Set aside your defaultModel (${userDefaultModel}); aiand pi off puts it back.`,
        );
      }
      previousDefaultModel = userDefaultModel || undefined;
    }
    settingsText = jsoncSet(settingsText, ["defaultProvider"], PI_PROVIDER_ID);
    settingsText = jsoncSet(settingsText, ["defaultModel"], input.model);
  }

  // A re-`on` finds each file at its first-on recorded mode; the first
  // capture stays authoritative. While our key lives in auth.json it is
  // 0600; off restores the recorded mode, so other credentials keep the
  // privacy the file had before on. A file on created has no prior mode:
  // it stays private, since a stray file must never open 0644.
  const previousModelsMode =
    prior?.previousModelsMode ?? (await existingFileMode(paths.models)) ?? DEFAULT_FILE_MODE;
  const previousSettingsMode =
    prior?.previousSettingsMode ?? (await existingFileMode(paths.settings)) ?? DEFAULT_FILE_MODE;
  const previousAuthMode =
    prior?.previousAuthMode ?? (await existingFileMode(paths.auth)) ?? PRIVATE_FILE_MODE;

  await writeFileAtomic(paths.models, modelsText, { mode: previousModelsMode });
  // auth.json holds the session key: 0600 for as long as it lives there,
  // re-tightened even when the bytes did not change.
  await writeFileAtomic(paths.auth, authText, { mode: PRIVATE_FILE_MODE });
  if (authText === raw.auth) await chmod(paths.auth, PRIVATE_FILE_MODE);
  await writeFileAtomic(paths.settings, settingsText, { mode: previousSettingsMode });

  // The record tells off what to hand back. The key literal never appears.
  await recordAddedState(PI_ID, {
    previousDefaultProvider,
    previousDefaultModel,
    wroteDefaultModel,
    wroteBaseUrl: baseUrl,
    previousModelsMode,
    previousSettingsMode,
    previousAuthMode,
    modelsPath: paths.models,
    authPath: paths.auth,
    settingsPath: paths.settings,
  });

  // The model now in effect: this run's write, else what the file already
  // had, else the requested value (the literal "native" under --model
  // native, matching opencode's reporting). Catalog membership decides the
  // text-only warning, so a kept user pick reports too.
  const effective = wroteDefaultModel || userDefaultModel || input.model;
  return {
    model: effective,
    catalogModel: inCatalog(effective) ? effective : undefined,
    filesWritten: [paths.models, paths.auth, paths.settings],
    warnings,
  };
}

async function disable(): Promise<DisableResult> {
  const paths = { models: piModelsPath(), auth: piAuthPath(), settings: piSettingsPath() };
  const added = await getAddedState<PiRecord>(PI_ID);
  const raw = {
    models: await readTextIfExists(paths.models),
    auth: await readTextIfExists(paths.auth),
    settings: await readTextIfExists(paths.settings),
  };
  // Parse all three before any write: stripping auth.json (the marker)
  // and then failing on another file would leave off unfinishable. Keep
  // the record so a retry after the fix can still strip everything.
  let auth: Record<string, unknown> = {};
  for (const path of [paths.auth, paths.models, paths.settings]) {
    try {
      const parsed = await readJsoncObject(path, INVALID_CONFIG_HINT);
      if (path === paths.auth) auth = parsed;
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      return {
        stripped: false,
        notes: [`${path} is not valid JSON; fix it, then run aiand pi off again.`],
      };
    }
  }

  const notes: string[] = [];
  let stripped = false;

  // Everything below is gated on our stamp or record: a foreign
  // `aiand`-named credential (no marker, no record) and an
  // already-stripped file are left alone. The stamp may be gone
  // (a Pi rewrite dropping unknown keys) while the record proves
  // the files are ours — but only while the routing still proves
  // itself ours: the block still names the baseUrl `on` wrote,
  // routable, with settings still defaulting to aiand. A repointed
  // block is the user's. The record alone never strips: without
  // the stamp it takes that proof. (#18 P18-pi-2)
  const modelsFile = parseConfigQuiet(raw.models);
  const block = modelsFile === undefined ? undefined : aiandProvider(modelsFile);
  const ours =
    hasOwnershipMarker(auth) || routingStillOurs(modelsFile, parseConfigQuiet(raw.settings), added);

  if (ours) {
    stripped = true;

    // auth.json: drop our credential; the user's own credentials survive.
    // A file our on created (the snapshot recorded its absence) and that is
    // now empty is unlinked, never left behind as a stray.
    const authText = jsoncDelete(raw.auth, [PI_PROVIDER_ID]);
    await writeStrippedJsonc(
      PI_ID,
      paths.auth,
      raw.auth,
      authText,
      added?.previousAuthMode ?? PRIVATE_FILE_MODE,
    );

    // settings.json: hand back the defaultProvider on replaced and the
    // defaultModel on set aside or wrote.
    const handedBack = handBackSettings(raw.settings, added);
    notes.push(...handedBack.notes);
    await writeStrippedJsonc(
      PI_ID,
      paths.settings,
      raw.settings,
      handedBack.text,
      added?.previousSettingsMode ?? DEFAULT_FILE_MODE,
    );

    // models.json: drop our provider block; unrelated providers survive,
    // and an emptied `providers` map (ours alone) is dropped with it.
    // A marked block the user edited by hand is theirs now: it stays
    // in place with a note while the auth/settings strips above still
    // happen. The check compares the scalars `on` wrote (baseUrl, name,
    // api) — the models array is the live catalog, which grows between
    // on and off and must not read as an edit. A record from before
    // wroteBaseUrl existed is not "edited": it strips as it always did.
    // (#18 P18-pi-3)
    const edited =
      hasOwnershipMarker(auth) &&
      added?.wroteBaseUrl !== undefined &&
      (block === undefined ||
        block.baseUrl !== added.wroteBaseUrl ||
        block.name !== "ai&" ||
        block.api !== "openai-completions");
    if (edited) {
      notes.push("left providers.aiand because you edited it");
    } else {
      const modelsText = dropPiProvider(raw.models);
      await writeStrippedJsonc(
        PI_ID,
        paths.models,
        raw.models,
        modelsText,
        added?.previousModelsMode ?? DEFAULT_FILE_MODE,
      );
    }
  } else if (added !== null && (aiandCredential(auth) !== undefined || block !== undefined)) {
    // Record present but the credential or block was repointed: the
    // user's own values, left in place with a note and nothing
    // written. (#18 P18-pi-2)
    notes.push("left the aiand credential because you edited it");
  }

  // A dir move after `on` (PI_CODING_AGENT_DIR retargeted) leaves our
  // credential in the old files while the current dir shows nothing of
  // ours. The record knows where `on` actually wrote: strip those too, or
  // the baked key stays live forever with nothing pointing at it. auth.json
  // comes first — it carries the ownership marker, so it also decides
  // whether the stale files are ours at all.
  for (const kind of ["auth", "models", "settings"] as const) {
    const stalePath = added?.[`${kind}Path`];
    if (!stalePath || stalePath === paths[kind] || !existsSync(stalePath)) continue;
    const rawStale = await readTextIfExists(stalePath);
    let stale: Record<string, unknown>;
    try {
      stale = await readJsoncObject(stalePath, INVALID_CONFIG_HINT);
    } catch (error) {
      if (error instanceof CliError) {
        // Keep the record: after the fix, off must still find this path.
        // Report the running total, not a hardcoded true: when nothing was
        // stripped yet (moved dir, first stale file unreadable) this is false.
        return {
          stripped,
          notes: [`${stalePath} is not valid JSON; fix it, then run aiand pi off again.`],
        };
      }
      throw error;
    }
    let staleText = rawStale;
    if (kind === "auth") {
      // Marker-gated like the current dir: a foreign credential is left alone.
      if (!hasOwnershipMarker(stale)) continue;
      staleText = jsoncDelete(rawStale, [PI_PROVIDER_ID]);
    } else if (kind === "models") {
      // models.json: drop our provider block; unrelated providers
      // survive, and an emptied `providers` map (ours alone) is
      // dropped with it. The moved dir gets the same proof as the
      // current dir: a repointed block is the user's. models.json
      // carries no stamp (it lives on the auth.json credential), so
      // the baseUrl-vs-record proof is the only one; the undefined
      // arm is back-compat with records from before wroteBaseUrl.
      // (#18 P18-pi-3)
      const staleBlock = aiandProvider(stale);
      if (staleBlock === undefined) continue;
      if (added?.wroteBaseUrl !== undefined && staleBlock.baseUrl !== added.wroteBaseUrl) {
        notes.push(`left providers.aiand in ${stalePath} because you edited it`);
        continue;
      }
      staleText = dropPiProvider(rawStale);
    } else {
      // settings.json: the same hand-back logic as the current dir, same
      // record. Values the user changed in between are theirs and stay.
      const handedBack = handBackSettings(rawStale, added);
      staleText = handedBack.text;
      notes.push(...handedBack.notes);
    }
    const mode: Record<typeof kind, number | undefined> = {
      auth: added?.previousAuthMode,
      models: added?.previousModelsMode,
      settings: added?.previousSettingsMode,
    };
    await writeStrippedJsonc(
      PI_ID,
      stalePath,
      rawStale,
      staleText,
      mode[kind] ?? (kind === "auth" ? PRIVATE_FILE_MODE : DEFAULT_FILE_MODE),
    );
    if (staleText !== rawStale) {
      stripped = true;
      notes.push(`stripped the aiand config from ${stalePath} because the pi config dir moved`);
    }
  }

  await clearAddedState(PI_ID);
  return { stripped, notes };
}

/**
 * The Pi release the install hint pins (check-dist keeps ci.yml in step).
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const PI_VERSION = "0.87.1";

const PI_INSTALL = {
  command: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION}`,
  url: "https://pi.dev",
};

export const piAdapter: AgentAdapter = {
  id: PI_ID,
  label: "Pi",
  bin: PI_BIN,
  install: PI_INSTALL,
  // No shadowEnv: the only PI_* names Pi consults are
  // PI_CODING_AGENT_DIR — which sessionLaunch sets, so the
  // overlay always wins over an inherited value — and
  // PI_CODING_AGENT_SESSION_DIR, which points at session
  // history, not routing. No inherited name overrides the
  // overlay's models.json/auth.json, so there is nothing to
  // delete: an evidence-based empty, not a guessed sweep. (#18)
  // "--model native" leaves the model unpinned instead of
  // catalog-validated (README: `--model native`); the launcher
  // passes the literal through only for adapters that opt in.
  allowUnpinnedModel: true,
  detect(): DetectResult {
    return detectBinary(PI_BIN);
  },
  managedFiles(): string[] {
    // The recorded paths too, so restore works from a shell
    // without the PI_CODING_AGENT_DIR that relocated the config
    // dir (#18).
    const added = getAddedStateSync<PiRecord>(PI_ID);
    const files = PI_MANAGED_FILES.map((path) => path());
    for (const path of [added?.modelsPath, added?.authPath, added?.settingsPath]) {
      if (path && !files.includes(path)) files.push(path);
    }
    return files;
  },
  probe,
  enable,
  disable,
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    // Gated like disable(): our stamp, or a live record whose
    // routing still proves itself ours. A repointed block (stamp
    // kept or dropped) is the user's — swapping our orphaned key
    // would change nothing routable — and a foreign `aiand`-named
    // credential (no marker, no record) keeps its own key
    // untouched. A malformed auth.json is a plain false, never a
    // throw: refreshKey rides rebake paths where the file may be
    // mid-edit. (#18 P18-pi-4)
    const path = piAuthPath();
    const raw = await readTextIfExists(path);
    let auth: Record<string, unknown>;
    try {
      auth = await readJsoncObject(path, INVALID_CONFIG_HINT);
    } catch {
      return false;
    }
    const added = await getAddedState<PiRecord>(PI_ID);
    // A repointed routing block is the user's: the key must not be
    // swapped into a config the tool considers theirs (P18-pi-3).
    const modelsText = await readTextIfExists(piModelsPath());
    const block = aiandProvider(parseConfigQuiet(modelsText) ?? {});
    if (added?.wroteBaseUrl !== undefined && block?.baseUrl !== added.wroteBaseUrl) {
      return false;
    }
    if (!hasOwnershipMarker(auth)) {
      const settingsText = await readTextIfExists(piSettingsPath());
      if (!routingStillOurs(parseConfigQuiet(modelsText), parseConfigQuiet(settingsText), added)) {
        return false;
      }
    }
    const credential = aiandCredential(auth);
    // The stamp may be gone while the block survives; with no
    // credential block at all there is no key of ours to swap.
    if (!credential) return false;
    // A same-key no-op still counts as touched: an idempotent rebake reports
    // refreshed.
    if (credential.key === input.apiKey) return true;
    // A rotation swaps only the key it replaced: a config baked from another
    // profile keeps routing to that profile's org.
    if (input.previousKey !== undefined && credential.key !== input.previousKey) return false;
    await writeFileAtomic(path, jsoncSet(raw, [PI_PROVIDER_ID, "key"], input.apiKey), {
      mode: PRIVATE_FILE_MODE,
    });
    return true;
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Works with no prior `on`: a throwaway overlay becomes
    // PI_CODING_AGENT_DIR holding only a generated models.json (the same
    // provider block `on` writes) and auth.json with the session key at
    // 0600. The key never rides the child env — the overlay file is how Pi
    // reads it — and cleanup removes the overlay after the child exits.
    // Real session history survives in the user's own session dir, pointed
    // at through PI_CODING_AGENT_SESSION_DIR (Pi treats an empty value as
    // unset): else settings.json `sessionDir`, else Pi's per-cwd default
    // <agent dir>/sessions/--<encoded cwd>--. The overlay would otherwise
    // be the agent dir — its history must not vanish with the throwaway.
    // No Pi config files are written under ~/.pi; history still lands in
    // the user's dir.
    // "--model native" leaves the model unpinned (README: `--model
    // native`): the model stays undefined so Pi starts on its own
    // default within the aiand provider, and --model is dropped from
    // the launch args. Any other undefined model resolves through the
    // catalog as before. (#18)
    let model = input.model;
    if (model === "native") {
      model = undefined;
    } else if (model === undefined) {
      model = resolveDefault(input.catalog, input.profileModel);
    }
    const overlay = await createSessionOverlay("aiand-pi-", {
      "models.json": `${JSON.stringify(
        {
          providers: {
            [PI_PROVIDER_ID]: buildPiProvider({
              baseUrl: piBaseUrl(input.baseUrl),
              catalog: input.catalog,
            }),
          },
        },
        null,
        2,
      )}\n`,
      "auth.json": `${JSON.stringify({
        [PI_PROVIDER_ID]: { type: "api_key", key: input.apiKey, [PI_MARKER_KEY]: PI_MARKER },
      })}\n`,
    });
    // Pi reads --provider only alongside --model; for native, --models
    // scopes its own default pick to the aiand provider. `**`, not `*`:
    // Pi matches with minimatch, where `*` does not cross `/`, and catalog
    // ids contain one (`zai-org/glm-5.3`) — `aiand/*` matches nothing and
    // Pi silently falls back to its own default provider.
    const args = [
      "--provider",
      PI_PROVIDER_ID,
      ...(model === undefined ? ["--models", `${PI_PROVIDER_ID}/**`] : ["--model", model]),
    ];
    // Non-TTY stdin: ask for an explicit one-shot mode. Upstream Pi has had
    // hang bugs with redirected stdin when no mode is set; a piped prompt
    // must process and exit, not sit on an interactive session.
    if (!process.stdin.isTTY) args.push("--print");
    return {
      env: {
        PI_CODING_AGENT_DIR: overlay.dir,
        PI_CODING_AGENT_SESSION_DIR:
          process.env.PI_CODING_AGENT_SESSION_DIR || (await piSessionDir()),
      },
      // --provider/--model pin the routing; a user-supplied --api-key would
      // override the overlay's credential, so it is stripped with the rest
      // of the routing flags (both `--flag value` and `--flag=value`).
      args,
      stripPassthroughFlags: ["--provider", "--model", "--models", "--api-key"],
      cleanup: overlay.cleanup,
    };
  },
};
