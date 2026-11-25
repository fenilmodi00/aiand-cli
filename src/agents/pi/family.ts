import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CliError } from "../../cli/errors.js";
import { commandName, DEFAULT_BASE_URL, isRoutableBaseUrl, writeFileAtomic } from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import {
  asObject,
  jsoncDelete,
  jsoncSet,
  readJsoncObject,
  readTextIfExists,
  writeKeyFile,
  writeStrippedJsonc,
} from "../managed-file.js";
import {
  clearAddedState,
  getAddedState,
  getAddedStateSync,
  recordAddedState,
} from "../snapshot.js";
import type {
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeDetail,
  ProbeResult,
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

/**
 * Ownership marker aiand stamps so off/logout strip surgically. It lives on
 * the auth.json credential because models.json is the one Pi file with a
 * schema behind it (TypeBox): a marker field there rides on schema
 * tolerance, while auth.json's loader only validates type/key and passes
 * unknown keys through.
 */
export const PI_MARKER_KEY = "managedBy";
/**
 * The marker value names the install that wrote it, like `PI_PROVIDER_ID`
 * and every other adapter's marker: a side-by-side second install
 * (`AIAND_COMMAND_NAME=aiand-v2`) must stamp its own name, or it would
 * claim — and strip — config the production install wrote.
 */
export const PI_MARKER = commandName();
/** A name is written into `auth.json`, never read as a pattern. */
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The stamp as it appears in auth.json text, however it is spaced. */
const PI_MARKER_RE = new RegExp(`"${PI_MARKER_KEY}"\\s*:\\s*"${escapeRe(PI_MARKER)}"`);

/** Host of the gateway this CLI dials, for native-key routing checks. */
const GATEWAY_HOST = new URL(DEFAULT_BASE_URL).hostname;

/**
 * One agent that keeps Pi's own config files (models.json, auth.json,
 * settings.json) in an agent dir: Pi itself, and agents built on Pi that
 * point Pi at their own dir (Jouzu). Everything but the dir and the names
 * is shared, so the two cannot drift.
 */
export type PiFamilySpec = {
  id: string; // aiand agent id: "pi", "jouzu"
  label: string; // "Pi", "Jouzu"
  agentDir(): string; // the dir holding models.json, auth.json, settings.json
  dirEnv: string; // the env var that moves the dir, named when `on` refuses a second one
};

/** The on/off/status/rebake core of a Pi-family adapter. */
export type PiFamilyCore = {
  agentDir(): string;
  modelsPath(): string;
  authPath(): string;
  settingsPath(): string;
  managedFiles(): string[];
  carriesWiring(text: string): boolean;
  probe(): Promise<ProbeResult>;
  bakedBaseUrl(): Promise<string | undefined>;
  enableGuard(): Promise<void>;
  enable(input: EnableInput): Promise<EnableResult>;
  disable(): Promise<DisableResult>;
  refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean>;
  /** The ai& key this agent's auth.json carries, or null when the credential is not ours. */
  bakedKey(): Promise<string | null>;
  /** Keys the agent holds in auth.json that reach the ai& gateway without `on` baking them. */
  nativeAiandKeys(): Promise<string[]>;
};

/** The `aiand` credential block in auth.json, when it is an object. */
function aiandCredential(auth: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(auth[PI_PROVIDER_ID]);
}

/** True when our stamp sits on the auth.json `aiand` credential. */
function hasOwnershipMarker(auth: Record<string, unknown>): boolean {
  return aiandCredential(auth)?.[PI_MARKER_KEY] === PI_MARKER;
}

/**
 * True when a provider block no longer has the scalars `on` wrote: the
 * user repointed or reshaped it, so it is theirs. The models array is the
 * live catalog and is not compared.
 */
function blockEdited(block: Record<string, unknown>, wroteBaseUrl: string): boolean {
  return (
    block.baseUrl !== wroteBaseUrl || block.name !== "ai&" || block.api !== "openai-completions"
  );
}

export function createPiFamily(spec: PiFamilySpec): PiFamilyCore {
  const { id, label } = spec;
  /** Recovery hint for a config file that cannot be parsed or edited. */
  const INVALID_CONFIG_HINT = `Fix it by hand, or delete it and run aiand ${id} on again.`;

  const modelsPath = (): string => join(spec.agentDir(), "models.json");
  const authPath = (): string => join(spec.agentDir(), "auth.json");
  const settingsPath = (): string => join(spec.agentDir(), "settings.json");

  async function probeDetail(): Promise<ProbeDetail> {
    let auth: Record<string, unknown>;
    let models: Record<string, unknown>;
    let settings: Record<string, unknown>;
    try {
      auth = await readJsoncObject(authPath(), INVALID_CONFIG_HINT);
      models = await readJsoncObject(modelsPath(), INVALID_CONFIG_HINT);
      settings = await readJsoncObject(settingsPath(), INVALID_CONFIG_HINT);
    } catch {
      // A file mid-edit must not wedge `status`.
      return { active: false, model: null };
    }
    const baseUrl = aiandProvider(models)?.baseUrl;
    const added = await getAddedState<PiRecord>(id);
    if (hasOwnershipMarker(auth)) {
      // The stamp makes the credential ours, but the routing block can
      // still be the user's: a hand-repointed `providers.aiand.baseUrl`
      // must read inactive exactly like `off` reads it, so the
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
      // is the user's.
      if (!routingStillOurs(models, settings, added)) {
        return { active: false, model: null };
      }
    }
    const model = typeof settings.defaultModel === "string" ? settings.defaultModel : null;
    return { active: true, model, baseUrl: typeof baseUrl === "string" ? baseUrl : undefined };
  }

  async function probe(): Promise<ProbeResult> {
    const { active, model } = await probeDetail();
    return { active, model };
  }

  /**
   * Refuse to wire a second agent dir while the recorded one still holds
   * our key: one record cannot hand back two dirs, so the old key would
   * outlive `off`, and the new snapshot would copy it. Runs before the
   * snapshot.
   */
  async function enableGuard(): Promise<void> {
    const wired = (await getAddedState<PiRecord>(id))?.authPath;
    if (!wired || resolve(wired) === resolve(authPath())) return;
    if (!PI_MARKER_RE.test(await readTextIfExists(wired).catch(() => ""))) return;
    throw new CliError(`${label} is already wired through ${dirname(wired)}.`, {
      hint: `Run aiand ${id} off first, then aiand ${id} on for the new ${spec.dirEnv}.`,
    });
  }

  async function enable(input: EnableInput): Promise<EnableResult> {
    const paths = { models: modelsPath(), auth: authPath(), settings: settingsPath() };
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
    // re-`on` may rebake.
    const added = await getAddedState<PiRecord>(id);
    const marked = hasOwnershipMarker(auth);
    if (
      !marked &&
      !routingStillOurs(models, settings, added) &&
      (aiandProvider(models) !== undefined || aiandCredential(auth) !== undefined)
    ) {
      throw new CliError(`${label} already has an aiand config that ai& does not manage.`, {
        hint: `Remove or rename the foreign block by hand, then run aiand ${id} on again.`,
      });
    }

    // The prior on's record is live while our marker sits in auth.json,
    // or while the record still proves the routing ours (a Pi rewrite
    // dropped the stamp); otherwise it is stale and must not carry forward.
    const prior = marked || routingStillOurs(models, settings, added) ? added : null;
    const warnings: string[] = [];
    const catalog = input.catalog;
    const isNative = input.model === "native";
    const inCatalog = (modelId: string): boolean => catalog.some((model) => model.id === modelId);

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
    // stays authoritative (the file holds our provider id by then).
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
      // Leave the model unpinned: the agent's own default resolution wins.
      // on still wires the provider + credential, so the user can pick a
      // model in the agent. After an earlier `on`, native means the same as
      // on a fresh config: the defaults that `on` set are handed back, or
      // the earlier ai& model would still decide (and `aiand jouzu` would
      // still name it).
      warnings.push(`${label}'s own default model is not on ai&; pass --model to pick one.`);
      if (prior?.wroteDefaultModel !== undefined && userDefaultModel === prior.wroteDefaultModel) {
        settingsText =
          prior.previousDefaultModel !== undefined
            ? jsoncSet(settingsText, ["defaultModel"], prior.previousDefaultModel)
            : jsoncDelete(settingsText, ["defaultModel"]);
      }
      if (prior !== null && settings.defaultProvider === PI_PROVIDER_ID) {
        settingsText =
          previousDefaultProvider !== undefined
            ? jsoncSet(settingsText, ["defaultProvider"], previousDefaultProvider)
            : jsoncDelete(settingsText, ["defaultProvider"]);
      }
      wroteDefaultModel = undefined;
      previousDefaultModel = undefined;
    } else if (userDefaultModel && inCatalog(userDefaultModel) && !input.pinModel) {
      // The user's pick is servable: keep it, write only the provider. A
      // kept model that is a prior on's still-live write keeps that record;
      // the user's own model needs no undo.
      settingsText = jsoncSet(settingsText, ["defaultProvider"], PI_PROVIDER_ID);
      wroteDefaultModel =
        prior !== null && prior.wroteDefaultModel === userDefaultModel
          ? userDefaultModel
          : undefined;
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
            `Set aside your defaultModel (${userDefaultModel}); aiand ${id} off puts it back.`,
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

    // auth.json holds the session key: 0600 for as long as it lives there,
    // re-tightened even when the bytes did not change. Written first, so a
    // refusal (a key file inside a git repo) leaves nothing half-wired.
    await writeKeyFile(paths.auth, authText, { mode: PRIVATE_FILE_MODE, agentId: id });
    if (authText === raw.auth) await chmod(paths.auth, PRIVATE_FILE_MODE);
    await writeFileAtomic(paths.models, modelsText, { mode: previousModelsMode });
    await writeFileAtomic(paths.settings, settingsText, { mode: previousSettingsMode });

    // The record tells off what to hand back. The key literal never appears.
    await recordAddedState(id, {
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
    const paths = { models: modelsPath(), auth: authPath(), settings: settingsPath() };
    const added = await getAddedState<PiRecord>(id);
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
          notes: [`${path} is not valid JSON; fix it, then run aiand ${id} off again.`],
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
    // the stamp it takes that proof.
    const modelsFile = parseConfigQuiet(raw.models);
    const block = modelsFile === undefined ? undefined : aiandProvider(modelsFile);
    const ours =
      hasOwnershipMarker(auth) ||
      routingStillOurs(modelsFile, parseConfigQuiet(raw.settings), added);

    if (ours) {
      stripped = true;

      // Removal order keeps a failed `off` retryable: the routing goes
      // first and the auth.json credential, which carries the ownership
      // marker, goes last. A write that fails part-way leaves the marker
      // in place, so the retry still knows the rest is ours.

      // models.json: drop our provider block; unrelated providers survive,
      // and an emptied `providers` map (ours alone) is dropped with it.
      // A marked block the user edited by hand is theirs now: it stays
      // in place with a note while the auth/settings strips still happen.
      // The check compares the scalars `on` wrote (baseUrl, name, api) —
      // the models array is the live catalog, which grows between on and
      // off and must not read as an edit. A block that is already gone
      // (an earlier off that stopped part-way) has nothing left to drop.
      const edited =
        hasOwnershipMarker(auth) &&
        added?.wroteBaseUrl !== undefined &&
        block !== undefined &&
        blockEdited(block, added.wroteBaseUrl);
      if (edited) {
        notes.push("left providers.aiand because you edited it");
      } else {
        const modelsText = dropPiProvider(raw.models);
        await writeStrippedJsonc(
          id,
          paths.models,
          raw.models,
          modelsText,
          added?.previousModelsMode ?? DEFAULT_FILE_MODE,
        );
      }

      // settings.json: hand back the defaultProvider on replaced and the
      // defaultModel on set aside or wrote.
      const handedBack = handBackSettings(raw.settings, added);
      notes.push(...handedBack.notes);
      await writeStrippedJsonc(
        id,
        paths.settings,
        raw.settings,
        handedBack.text,
        added?.previousSettingsMode ?? DEFAULT_FILE_MODE,
      );

      // auth.json last: drop our credential; the user's own credentials
      // survive. A file our on created (the snapshot recorded its absence)
      // and that is now empty is unlinked, never left behind as a stray.
      const authText = jsoncDelete(raw.auth, [PI_PROVIDER_ID]);
      await writeStrippedJsonc(
        id,
        paths.auth,
        raw.auth,
        authText,
        added?.previousAuthMode ?? PRIVATE_FILE_MODE,
      );
    } else if (added !== null && (aiandCredential(auth) !== undefined || block !== undefined)) {
      // Record present but the credential or block was repointed: the
      // user's own values, left in place with a note and nothing
      // written.
      notes.push("left the aiand credential because you edited it");
    }

    // A dir move after `on` (the agent dir retargeted by its env var) leaves
    // our credential in the old files while the current dir shows nothing of
    // ours. The record knows where `on` actually wrote: strip those too, or
    // the baked key stays live forever with nothing pointing at it. auth.json
    // comes first — it carries the ownership marker, so it also decides
    // whether the stale files are ours at all.
    // The moved dir gets the same proof as the current one. auth.json
    // carries the marker, but a Pi rewrite can drop it; the routing the
    // record names (the baseUrl `on` wrote, still the default provider)
    // then proves the stale credential ours too. auth.json goes last, as
    // above, so a failed strip stays retryable.
    const stale: Partial<Record<"auth" | "models" | "settings", string>> = {};
    for (const kind of ["auth", "models", "settings"] as const) {
      const stalePath = added?.[`${kind}Path`];
      if (stalePath && stalePath !== paths[kind] && existsSync(stalePath)) stale[kind] = stalePath;
    }
    const staleText: Partial<Record<"auth" | "models" | "settings", string>> = {};
    const staleParsed: Partial<Record<"auth" | "models" | "settings", Record<string, unknown>>> =
      {};
    for (const kind of ["auth", "models", "settings"] as const) {
      const stalePath = stale[kind];
      if (!stalePath) continue;
      staleText[kind] = await readTextIfExists(stalePath);
      try {
        staleParsed[kind] = await readJsoncObject(stalePath, INVALID_CONFIG_HINT);
      } catch (error) {
        if (error instanceof CliError) {
          // Keep the record: after the fix, off must still find this path.
          // Report the running total, not a hardcoded true: when nothing was
          // stripped yet (moved dir, first stale file unreadable) this is false.
          return {
            stripped,
            notes: [`${stalePath} is not valid JSON; fix it, then run aiand ${id} off again.`],
          };
        }
        throw error;
      }
    }
    const staleRoutingOurs = routingStillOurs(staleParsed.models, staleParsed.settings, added);
    for (const kind of ["models", "settings", "auth"] as const) {
      const stalePath = stale[kind];
      const parsed = staleParsed[kind];
      const rawStale = staleText[kind];
      if (!stalePath || parsed === undefined || rawStale === undefined) continue;
      let next = rawStale;
      if (kind === "auth") {
        // Marker, or the stale routing proof: a foreign credential is left alone.
        if (!hasOwnershipMarker(parsed) && !staleRoutingOurs) continue;
        if (aiandCredential(parsed) === undefined) continue;
        next = jsoncDelete(rawStale, [PI_PROVIDER_ID]);
      } else if (kind === "models") {
        // A repointed or hand-edited block is the user's, as in the current
        // dir: the same baseUrl, name and api checks. The undefined arm is
        // back-compat with records from before wroteBaseUrl.
        const staleBlock = aiandProvider(parsed);
        if (staleBlock === undefined) continue;
        if (added?.wroteBaseUrl !== undefined && blockEdited(staleBlock, added.wroteBaseUrl)) {
          notes.push(`left providers.aiand in ${stalePath} because you edited it`);
          continue;
        }
        next = dropPiProvider(rawStale);
      } else {
        // settings.json: the same hand-back logic as the current dir, same
        // record. Values the user changed in between are theirs and stay.
        const handedBack = handBackSettings(rawStale, added);
        next = handedBack.text;
        notes.push(...handedBack.notes);
      }
      const mode: Record<typeof kind, number | undefined> = {
        auth: added?.previousAuthMode,
        models: added?.previousModelsMode,
        settings: added?.previousSettingsMode,
      };
      await writeStrippedJsonc(
        id,
        stalePath,
        rawStale,
        next,
        mode[kind] ?? (kind === "auth" ? PRIVATE_FILE_MODE : DEFAULT_FILE_MODE),
      );
      if (next !== rawStale) {
        stripped = true;
        notes.push(
          `stripped the aiand config from ${stalePath} because the ${id} config dir moved`,
        );
      }
    }

    await clearAddedState(id);
    return { stripped, notes };
  }

  async function refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    // Gated like disable(): our stamp, or a live record whose
    // routing still proves itself ours. A repointed block (stamp
    // kept or dropped) is the user's — swapping our orphaned key
    // would change nothing routable — and a foreign `aiand`-named
    // credential (no marker, no record) keeps its own key
    // untouched. A malformed auth.json is a plain false, never a
    // throw: refreshKey rides rebake paths where the file may be
    // mid-edit.
    const path = authPath();
    const raw = await readTextIfExists(path);
    let auth: Record<string, unknown>;
    try {
      auth = await readJsoncObject(path, INVALID_CONFIG_HINT);
    } catch {
      return false;
    }
    const added = await getAddedState<PiRecord>(id);
    // A repointed routing block is the user's: the key must not be
    // swapped into a config the tool considers theirs.
    const modelsText = await readTextIfExists(modelsPath());
    const block = aiandProvider(parseConfigQuiet(modelsText) ?? {});
    if (added?.wroteBaseUrl !== undefined && block?.baseUrl !== added.wroteBaseUrl) {
      return false;
    }
    if (!hasOwnershipMarker(auth)) {
      const settingsText = await readTextIfExists(settingsPath());
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
    await writeKeyFile(path, jsoncSet(raw, [PI_PROVIDER_ID, "key"], input.apiKey), {
      mode: PRIVATE_FILE_MODE,
      agentId: id,
    });
    return true;
  }

  /**
   * The key Pi sends is the one in our auth.json credential. A credential
   * without our marker is the user's, and its key is not ours to claim.
   */
  async function bakedKey(): Promise<string | null> {
    let auth: Record<string, unknown>;
    try {
      auth = await readJsoncObject(authPath(), INVALID_CONFIG_HINT);
    } catch {
      return null;
    }
    const credential = aiandCredential(auth);
    if (credential?.[PI_MARKER_KEY] !== PI_MARKER) return null;
    const key = credential.key;
    return typeof key === "string" && key.length > 0 ? key : null;
  }

  /**
   * Raw api keys from auth.json credentials whose models.json baseUrl
   * reaches the ai& gateway (same host the CLI dials). The credential `on`
   * stamped is excluded — bakedKey already records that one. Never throws:
   * a missing, unreadable, or malformed file returns [].
   */
  async function nativeAiandKeys(): Promise<string[]> {
    let auth: Record<string, unknown>;
    let models: Record<string, unknown>;
    try {
      auth = await readJsoncObject(authPath(), INVALID_CONFIG_HINT);
      models = await readJsoncObject(modelsPath(), INVALID_CONFIG_HINT);
    } catch {
      return [];
    }
    const baseUrl = aiandProvider(models)?.baseUrl;
    if (typeof baseUrl !== "string") return [];
    let host: string;
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      return []; // not a URL — not a gateway route
    }
    if (host !== GATEWAY_HOST) return [];
    if (hasOwnershipMarker(auth)) return []; // ours — bakedKey covers it
    const keys: string[] = [];
    for (const value of Object.values(auth)) {
      const entry = asObject(value);
      if (!entry) continue;
      const key = entry.key;
      if (typeof key === "string" && key !== "") keys.push(key);
    }
    return keys;
  }

  return {
    agentDir: spec.agentDir,
    modelsPath,
    authPath,
    settingsPath,
    managedFiles(): string[] {
      // The recorded paths too, so restore works from a shell without the
      // env var that relocated the config dir.
      const added = getAddedStateSync<PiRecord>(id);
      const files = [modelsPath(), authPath(), settingsPath()];
      for (const path of [added?.modelsPath, added?.authPath, added?.settingsPath]) {
        if (path && !files.includes(path)) files.push(path);
      }
      return files;
    },
    carriesWiring: (text) => PI_MARKER_RE.test(text),
    probe,
    bakedBaseUrl: async () => (await probeDetail()).baseUrl,
    enableGuard,
    enable,
    disable,
    refreshKey,
    bakedKey,
    nativeAiandKeys,
  };
}
