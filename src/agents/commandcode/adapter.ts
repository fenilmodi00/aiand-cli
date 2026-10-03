import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { CliError } from "../../cli/errors.js";
import { isRoutableBaseUrl, writeFileAtomic } from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import { detectBinary } from "../detect.js";
import {
  asObject,
  jsoncDelete,
  jsoncSet,
  parseWrittenObject,
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
} from "../types.js";
import { COMMANDCODE_INSTALL } from "./install.js";
import { commandcodeSessionLaunch } from "./launch.js";
import {
  aiandCredential,
  aiandRow,
  buildCommandCodeProvider,
  COMMANDCODE_MANAGED_FILES,
  COMMANDCODE_PROVIDER_ID,
  COMMANDCODE_SELECTION_PREFIX,
  commandCodeBaseUrl,
  commandcodeAuthPath,
  commandcodeConfigPath,
  commandcodeProvidersPath,
  INVALID_CONFIG_HINT,
  isOurRow,
} from "./shared.js";

const COMMANDCODE_ID = "commandcode";
/**
 * Windows ships the binary as `cmdc`: `cmd` there is the
 * Windows shell, so a plain `detectBinary("cmd")` would find
 * cmd.exe (live-proven: the package's bin map ships both).
 */
const COMMANDCODE_BIN = process.platform === "win32" ? "cmdc" : "cmd";

/**
 * What enable() recorded so off can tell its values from the
 * user's. The baked key never appears here: only ids, previous
 * values, file modes, and the absolute paths we wrote (paths
 * are not secrets; the snapshot manifest already stores them).
 */
type CommandCodeRecord = {
  /** What config.json's model was before on (undefined = absent). */
  previousModel?: string;
  /** The model this on wrote (`aiand/<id>`); off hands back or removes it. */
  wroteModel?: string;
  /** File mode before `on` wrote it, per file off rewrites. */
  previousProvidersMode?: number;
  previousConfigMode?: number;
  /** auth.json's mode before `on` wrote it; a new file stays private. */
  previousAuthMode?: number;
  /** Where `on` actually wrote the files; off strips them if the dir moved. */
  providersPath?: string;
  authPath?: string;
  configPath?: string;
  /** The baseURL on wrote into the row; a repointed row is the user's. */
  wroteBaseUrl?: string;
};

async function probe(): Promise<ProbeResult> {
  let providers: Record<string, unknown>;
  let config: Record<string, unknown>;
  try {
    providers = await readJsoncObject(commandcodeProvidersPath(), INVALID_CONFIG_HINT);
    config = await readJsoncObject(commandcodeConfigPath(), INVALID_CONFIG_HINT);
    // A corrupt auth.json would break the real binary's key lookup, so
    // status must not report on over it (pi reads all three the same way).
    await readJsoncObject(commandcodeAuthPath(), INVALID_CONFIG_HINT);
  } catch {
    // A file mid-edit must not wedge `commandcode status`.
    return { active: false, model: null };
  }
  const row = aiandRow(providers);
  if (!isOurRow(row) || !isRoutableBaseUrl(row?.baseURL)) {
    return { active: false, model: null };
  }
  // A row the user repointed (marker kept, baseURL changed) routes to
  // their gateway now: status reads off over it and off leaves it with
  // a note (pi's round-2 wroteBaseUrl rule).
  const recorded = await getAddedState<CommandCodeRecord>(COMMANDCODE_ID);
  if (recorded?.wroteBaseUrl !== undefined && row?.baseURL !== recorded.wroteBaseUrl) {
    return { active: false, model: null };
  }
  // Only an `aiand/`-prefixed model routes to our row; an
  // unprefixed one pins Command Code's own gateway instead.
  const model = typeof config.model === "string" ? config.model : null;
  return {
    active: true,
    model: model?.startsWith(COMMANDCODE_SELECTION_PREFIX)
      ? model.slice(COMMANDCODE_SELECTION_PREFIX.length)
      : null,
  };
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const paths = {
    providers: commandcodeProvidersPath(),
    auth: commandcodeAuthPath(),
    config: commandcodeConfigPath(),
  };
  const raw = {
    providers: await readTextIfExists(paths.providers),
    auth: await readTextIfExists(paths.auth),
    config: await readTextIfExists(paths.config),
  };
  const providers = await readJsoncObject(paths.providers, INVALID_CONFIG_HINT);
  // auth.json is parsed for the failure, not the value: a corrupt
  // file must fail `on` with the shared error before anything is
  // written, and the credential block is spliced into raw text.
  await readJsoncObject(paths.auth, INVALID_CONFIG_HINT);
  const config = await readJsoncObject(paths.config, INVALID_CONFIG_HINT);

  // A foreign provider merely named `aiand` is never ours to overwrite.
  const row = aiandRow(providers);
  if (row !== undefined && !isOurRow(row)) {
    throw new CliError("Command Code already has a provider.aiand row that ai& does not manage.", {
      hint: "Remove or rename the foreign row by hand, then run aiand commandcode on again.",
    });
  }

  // Command Code's own models route to its gateway, not ai&'s,
  // so there is nothing `native` could serve (Codex precedent).
  if (input.model === "native") {
    throw new CliError("Command Code's own models are not on ai&.", {
      hint: "Pass --model with an ai& model id, or leave it out for the default.",
    });
  }

  // The prior on's record is still live only while our marker
  // sits on the row; after an `off` or a hand edit it is stale
  // and must not be carried forward.
  const prior = isOurRow(row) ? await getAddedState<CommandCodeRecord>(COMMANDCODE_ID) : null;
  const warnings: string[] = [];
  const catalog = input.catalog;
  const inCatalog = (id: string): boolean => catalog.some((model) => model.id === id);
  // A config.json model routes to our row exactly when it is
  // `aiand/<catalog id>`; anything else fails every request.
  const servable = (value: string): boolean =>
    value.startsWith(COMMANDCODE_SELECTION_PREFIX) &&
    inCatalog(value.slice(COMMANDCODE_SELECTION_PREFIX.length));

  // providers.json: our provider row, replacing any prior one of
  // ours. Every unrelated row and key survives — jsoncSet
  // splices one property.
  const providersText = jsoncSet(
    raw.providers,
    ["provider", COMMANDCODE_PROVIDER_ID],
    buildCommandCodeProvider({
      baseUrl: commandCodeBaseUrl(input.baseUrl),
      catalog,
    }),
  );

  // auth.json: the session key under the aiand credential —
  // exactly the block `/connect` writes ({type, key}). Command
  // Code's own login fields (apiKey, userName, ...) and other
  // credentials survive untouched.
  const authText = jsoncSet(raw.auth, [COMMANDCODE_PROVIDER_ID], {
    type: "api",
    key: input.apiKey,
  });

  // config.json: the model pin. The user's own pick is kept when
  // it already routes to our row and the gateway serves it; any
  // other value is set aside so off can put it back.
  const userModel = typeof config.model === "string" ? config.model : "";
  let configText = raw.config;
  let wroteModel: string | undefined;
  let previousModel = prior?.previousModel;
  if (servable(userModel) && !input.pinModel) {
    // A kept model that is a prior on's still-live write keeps
    // that record; the user's own model needs no undo.
    wroteModel = prior !== null && prior.wroteModel === userModel ? userModel : undefined;
    if (wroteModel === undefined) previousModel = undefined;
  } else {
    // Replace with the requested/resolved model. Never chain our
    // own ref onto itself: while a prior on's write is still
    // live, the restore target stays the first pre-aiand value.
    const priorLive = prior?.wroteModel === userModel;
    wroteModel = `${COMMANDCODE_SELECTION_PREFIX}${input.model}`;
    if (!priorLive) {
      if (userModel && !servable(userModel)) {
        warnings.push(`Set aside your model (${userModel}); aiand commandcode off puts it back.`);
      }
      previousModel = userModel || undefined;
    }
    configText = jsoncSet(configText, ["model"], wroteModel);
  }

  // A re-`on` finds each file at its first-on recorded mode; the
  // first capture stays authoritative. While our key lives in
  // auth.json it is 0600; off restores the recorded mode, so
  // other credentials keep the privacy the file had before on. A
  // file on created has no prior mode: it stays private, since a
  // stray file must never open 0644.
  const previousProvidersMode =
    prior?.previousProvidersMode ?? (await existingFileMode(paths.providers)) ?? DEFAULT_FILE_MODE;
  const previousConfigMode =
    prior?.previousConfigMode ?? (await existingFileMode(paths.config)) ?? DEFAULT_FILE_MODE;
  const previousAuthMode =
    prior?.previousAuthMode ?? (await existingFileMode(paths.auth)) ?? PRIVATE_FILE_MODE;

  await writeFileAtomic(paths.providers, providersText, { mode: previousProvidersMode });
  // auth.json holds the session key: 0600 for as long as it
  // lives there, re-tightened even when the bytes did not change.
  await writeFileAtomic(paths.auth, authText, { mode: PRIVATE_FILE_MODE });
  if (authText === raw.auth) await chmod(paths.auth, PRIVATE_FILE_MODE);
  await writeFileAtomic(paths.config, configText, { mode: previousConfigMode });

  // The record tells off what to hand back. The key literal never
  // appears.
  await recordAddedState(COMMANDCODE_ID, {
    previousModel,
    wroteModel,
    previousProvidersMode,
    previousConfigMode,
    previousAuthMode,
    providersPath: paths.providers,
    authPath: paths.auth,
    configPath: paths.config,
    wroteBaseUrl: commandCodeBaseUrl(input.baseUrl),
  });

  // The model now in effect: this run's write, else what the file
  // already had, else the requested value.
  const effective =
    wroteModel ??
    (servable(userModel) ? userModel : `${COMMANDCODE_SELECTION_PREFIX}${input.model}`);
  const bareModel = effective.slice(COMMANDCODE_SELECTION_PREFIX.length);
  return {
    model: effective,
    catalogModel: inCatalog(bareModel) ? bareModel : undefined,
    filesWritten: [paths.providers, paths.auth, paths.config],
    warnings,
  };
}

/**
 * The config.json hand-back off performs on one file, current dir
 * or moved: a model we wrote is restored (or removed) only while
 * it is still ours, and a value the user changed in between is
 * theirs.
 */
function handBackConfig(
  text: string,
  added: CommandCodeRecord | null,
): { text: string; notes: string[] } {
  const notes: string[] = [];
  const config = text.trim() ? parseWrittenObject(text) : {};
  let out = text;
  if (added?.wroteModel !== undefined) {
    if (config.model === added.wroteModel) {
      out =
        added.previousModel !== undefined
          ? jsoncSet(out, ["model"], added.previousModel)
          : jsoncDelete(out, ["model"]);
    } else if (config.model !== undefined) {
      notes.push("left model because you edited it");
    }
  }
  return { text: out, notes };
}

/**
 * Parse one managed file for off. A parse failure is reported
 * with the file's own path so the user can fix exactly that
 * file; the record is kept so a later off (after the fix) can
 * still tell our values from the user's.
 */
async function parseManagedFile(
  path: string,
): Promise<{ value: Record<string, unknown>; note?: string }> {
  try {
    return { value: await readJsoncObject(path, INVALID_CONFIG_HINT) };
  } catch (error) {
    if (error instanceof CliError) {
      return {
        value: {},
        note: `${path} is not valid JSON; fix it, then run aiand commandcode off again.`,
      };
    }
    throw error;
  }
}

async function disable(): Promise<DisableResult> {
  const paths = {
    providers: commandcodeProvidersPath(),
    auth: commandcodeAuthPath(),
    config: commandcodeConfigPath(),
  };
  const added = await getAddedState<CommandCodeRecord>(COMMANDCODE_ID);
  const raw = {
    providers: await readTextIfExists(paths.providers),
    auth: await readTextIfExists(paths.auth),
    config: await readTextIfExists(paths.config),
  };
  // Transactional: every managed file parses before anything is
  // written, so a half-strip can never happen. The first failure
  // is reported with its own path and keeps the record.
  const parsed = {
    providers: await parseManagedFile(paths.providers),
    auth: await parseManagedFile(paths.auth),
    config: await parseManagedFile(paths.config),
  };
  const parseNote = parsed.providers.note ?? parsed.auth.note ?? parsed.config.note;
  if (parseNote) return { stripped: false, notes: [parseNote] };
  const providers = parsed.providers.value;

  const notes: string[] = [];
  let stripped = false;

  // Everything below is gated on our marker in providers.json: a
  // foreign `aiand`-named row (no marker) and an already-stripped
  // file are left alone.
  const row = aiandRow(providers);
  if (isOurRow(row)) {
    // A row the user repointed to their own gateway is theirs now:
    // the row stays, but our key, model pin, and any stale files
    // must not survive a repoint (pi's round-2 rule).
    const repointed = added?.wroteBaseUrl !== undefined && row?.baseURL !== added.wroteBaseUrl;
    if (repointed) {
      notes.push(
        `providers.aiand routes at ${row?.baseURL}, not ai&; left the row as your own config.`,
      );
    } else {
      stripped = true;
    }

    // auth.json: drop our credential; the user's own login and
    // other credentials survive. A file our on created (the
    // snapshot recorded its absence) and that is now empty is
    // unlinked, never left behind as a stray.
    const authText = jsoncDelete(raw.auth, [COMMANDCODE_PROVIDER_ID]);
    await writeStrippedJsonc(
      COMMANDCODE_ID,
      paths.auth,
      raw.auth,
      authText,
      added?.previousAuthMode ?? PRIVATE_FILE_MODE,
    );

    // config.json: hand the model back.
    const handedBack = handBackConfig(raw.config, added);
    notes.push(...handedBack.notes);
    await writeStrippedJsonc(
      COMMANDCODE_ID,
      paths.config,
      raw.config,
      handedBack.text,
      added?.previousConfigMode ?? DEFAULT_FILE_MODE,
    );

    // providers.json: drop our row — unless the user repointed it,
    // in which case it is theirs and stays. Unrelated rows
    // survive, and an emptied `provider` map (ours alone) is
    // dropped with it.
    if (!repointed) {
      let providersText = jsoncDelete(raw.providers, ["provider", COMMANDCODE_PROVIDER_ID]);
      const left = asObject(parseWrittenObject(providersText).provider);
      if (left && Object.keys(left).length === 0) {
        providersText = jsoncDelete(providersText, ["provider"]);
      }
      await writeStrippedJsonc(
        COMMANDCODE_ID,
        paths.providers,
        raw.providers,
        providersText,
        added?.previousProvidersMode ?? DEFAULT_FILE_MODE,
      );
    }
  }

  // A HOME move after `on` leaves our writes in the old files while
  // the current dir shows nothing of ours. The record knows where
  // `on` actually wrote: strip those too, or the baked key stays
  // live forever with nothing pointing at it. providers.json comes
  // first — it carries the ownership marker, so it also decides
  // whether the stale files are ours at all.
  for (const kind of ["providers", "auth", "config"] as const) {
    const stalePath = added?.[`${kind}Path`];
    if (!stalePath || stalePath === paths[kind] || !existsSync(stalePath)) continue;
    const rawStale = await readTextIfExists(stalePath);
    const parsedStale = await parseManagedFile(stalePath);
    if (parsedStale.note) {
      // Keep the record: after the fix, off must still find this
      // path. Report the running total, not a hardcoded true:
      // when nothing was stripped yet (moved dir, first stale file
      // unreadable) this is false.
      return { stripped, notes: [parsedStale.note] };
    }
    let staleText = rawStale;
    if (kind === "providers") {
      // Marker-gated like the current dir: a foreign row is left
      // alone. Unrelated rows survive; an emptied `provider` map
      // is dropped with our row.
      if (!isOurRow(aiandRow(parsedStale.value))) continue;
      // A repointed stale row is the user's now: left in place
      // with a note, the same rule as the current dir.
      const staleRow = aiandRow(parsedStale.value);
      if (added?.wroteBaseUrl !== undefined && staleRow?.baseURL !== added.wroteBaseUrl) {
        notes.push(
          `left ${stalePath} because you repointed providers.aiand at ${staleRow?.baseURL}`,
        );
        continue;
      }
      staleText = jsoncDelete(rawStale, ["provider", COMMANDCODE_PROVIDER_ID]);
      const left = asObject(parseWrittenObject(staleText).provider);
      if (left && Object.keys(left).length === 0) {
        staleText = jsoncDelete(staleText, ["provider"]);
      }
    } else if (kind === "auth") {
      // auth.json: drop our credential; the user's own login and
      // other credentials survive.
      staleText = jsoncDelete(rawStale, [COMMANDCODE_PROVIDER_ID]);
    } else {
      // config.json: the same hand-back logic as the current dir,
      // same record. Values the user changed in between are theirs
      // and stay.
      const handedBack = handBackConfig(rawStale, added);
      staleText = handedBack.text;
      notes.push(...handedBack.notes);
    }
    const mode: Record<typeof kind, number | undefined> = {
      providers: added?.previousProvidersMode,
      auth: added?.previousAuthMode,
      config: added?.previousConfigMode,
    };
    await writeStrippedJsonc(
      COMMANDCODE_ID,
      stalePath,
      rawStale,
      staleText,
      mode[kind] ?? (kind === "auth" ? PRIVATE_FILE_MODE : DEFAULT_FILE_MODE),
    );
    if (staleText !== rawStale) {
      stripped = true;
      notes.push(
        `stripped the aiand config from ${stalePath} because the commandcode config dir moved`,
      );
    }
  }

  await clearAddedState(COMMANDCODE_ID);
  return { stripped, notes };
}

export const commandcodeAdapter: AgentAdapter = {
  id: COMMANDCODE_ID,
  label: "Command Code",
  bin: COMMANDCODE_BIN,
  install: COMMANDCODE_INSTALL,
  detect(): DetectResult {
    return detectBinary(COMMANDCODE_BIN);
  },
  managedFiles(): string[] {
    // The recorded paths too, so `restore --force` works from a
    // shell whose HOME moved since `on` (claude precedent).
    const current = COMMANDCODE_MANAGED_FILES.map((path) => path());
    const recorded = getAddedStateSync<CommandCodeRecord>(COMMANDCODE_ID);
    const wired = [recorded?.providersPath, recorded?.authPath, recorded?.configPath].filter(
      (path): path is string => typeof path === "string" && !current.includes(path),
    );
    return [...current, ...wired];
  },
  probe,
  enable,
  disable,
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    // Marker-gated like disable(): a foreign `aiand`-named row
    // keeps its own credential untouched.
    const path = commandcodeAuthPath();
    const raw = await readTextIfExists(path);
    // A mid-edit config is never worth a crash: pi and omp return
    // false here, and a rebake must not throw past rebakeAgentKeys.
    let row: Record<string, unknown> | undefined;
    let credential: Record<string, unknown> | undefined;
    try {
      row = aiandRow(await readJsoncObject(commandcodeProvidersPath(), INVALID_CONFIG_HINT));
      credential = aiandCredential(await readJsoncObject(path, INVALID_CONFIG_HINT));
    } catch (error) {
      // The shared invalid-JSON CliError means mid-edit; a real
      // I/O error must still surface (the landed copilot shape).
      if (error instanceof CliError) return false;
      throw error;
    }
    if (!isOurRow(row) || credential === undefined) return false;
    // A row the user repointed to their own gateway reads that
    // credential now: swapping our key into it would ship the
    // session key to their endpoint (pi's round-2 rule).
    const recorded = await getAddedState<CommandCodeRecord>(COMMANDCODE_ID);
    if (recorded?.wroteBaseUrl !== undefined && row?.baseURL !== recorded.wroteBaseUrl) {
      return false;
    }
    // A same-key no-op still counts as touched: an idempotent
    // rebake reports refreshed.
    if (credential.key === input.apiKey) return true;
    // A rotation swaps only the key it replaced: a config wired
    // from another profile keeps routing to that profile's org.
    if (input.previousKey !== undefined && credential.key !== input.previousKey) return false;
    await writeFileAtomic(path, jsoncSet(raw, [COMMANDCODE_PROVIDER_ID, "key"], input.apiKey), {
      mode: PRIVATE_FILE_MODE,
    });
    return true;
  },
  sessionLaunch: commandcodeSessionLaunch,
};
