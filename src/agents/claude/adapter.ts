import { watch } from "node:fs";
import { chmod, mkdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CliError } from "../../cli/errors.js";
import { printNotes } from "../../cli/output.js";
import { DEFAULT_BASE_URL, writeFileAtomic } from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import { detectBinary } from "../detect.js";
import {
  asObject,
  jsoncDelete,
  jsoncSet,
  notValidJsonError,
  parseJsonc,
  readTextIfExists,
  writeKeyFile,
} from "../managed-file.js";
import { makeOverlayDir } from "../overlays.js";
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
  ProbeDetail,
  ProbeResult,
  SessionLaunchInput,
} from "../types.js";
import { applyModelPicker, buildModelPicker, stripModelPicker } from "./picker.js";
import { launchDefault, putBackUserDefault, type UserDefault } from "./put-back.js";
import {
  CLAUDE_ID,
  type ClaudeRecord,
  claudeSettingsPath,
  modelSlots,
  stickyChoice,
  wiredSettingsPath,
} from "./record.js";
import {
  API_KEY_KEY,
  BASE_URL_KEY,
  buildClaudeSettings,
  CONTEXT_KEY,
  chosenModel,
  claudeBaseUrl,
  claudeDefaultModel,
  contextTokens,
  DENIED_TOOLS,
  ENV_OFF,
  ENV_ON,
  type Env,
  FAST_SIDE,
  FOREIGN_PROVIDER_KEYS,
  fastModel,
  gatewayEnv,
  HEADERS_KEY,
  INVALID_CONFIG_HINT,
  inCatalog,
  isAlias,
  legacyChosen,
  MARKER_KEY,
  MODEL_SETTINGS,
  nonEmpty,
  ownedValues,
  parseSettings,
  routedByUs,
  settingAt,
  slotEnv,
  slotReport,
  startupModel,
  TOKEN_KEY,
  withAgentHeader,
} from "./settings.js";

const CLAUDE_BIN = "claude";

const LIVE_ON_WARNING =
  "If you have Claude Code open in other windows, they now send requests to ai&. One that starts failing needs a restart: type /exit, then run claude --continue. To use ai& in one session only, run aiand claude off, then aiand claude.";
const LIVE_OFF_NOTE =
  "If you have Claude Code open in other windows, they switch back too. If one still uses ai&, restart it: type /exit, then run claude --continue.";
/** Claude Code applies a settings change 1–1.5s after the write (measured on 2.1.311–2.1.319). */
const LIVE_RELOAD_MS = 3000;

const restoreEnv = (text: string, key: string, previous: string | undefined): string =>
  previous !== undefined ? jsoncSet(text, ["env", key], previous) : jsoncDelete(text, ["env", key]);

/** A file carrying our marker; one we cannot parse counts, so its record survives until it is fixed. */
async function markedFile(path: string): Promise<boolean> {
  try {
    const env = asObject(parseSettings(path, await readTextIfExists(path)).env);
    return env?.[MARKER_KEY] === ENV_ON;
  } catch {
    return true;
  }
}

/** Host of the gateway the CLI itself dials, for native-key routing checks. */
const GATEWAY_HOST = new URL(DEFAULT_BASE_URL).hostname;

/**
 * Raw api keys the user set in settings.json whose ANTHROPIC_BASE_URL reaches
 * the ai& gateway, so native Claude Code use attributes to its agent. The row
 * with our marker is excluded — bakedKey/recordAgentKey already record that
 * one. Never throws: a missing, unreadable, or malformed settings.json
 * returns []. Deliberately not consulted: process.env (wrong process and
 * ephemeral), .credentials.json and the keychain (OAuth subscription tokens,
 * not ai& keys). Attribution only; nothing here rewrites the file.
 */
async function claudeNativeAiandKeys(): Promise<string[]> {
  const path = claudeSettingsPath();
  const raw = await readTextIfExists(path);
  if (!raw) return [];
  let settings: Record<string, unknown>;
  try {
    settings = parseSettings(path, raw);
  } catch {
    return [];
  }
  const env = asObject(settings.env);
  if (!env) return [];
  const baseURL = env[BASE_URL_KEY];
  if (typeof baseURL !== "string") return [];
  let host: string;
  try {
    host = new URL(baseURL).hostname;
  } catch {
    return []; // not a URL — not a gateway route
  }
  if (host !== GATEWAY_HOST) return [];
  if (env[MARKER_KEY] === ENV_ON) return []; // ours — bakedKey covers it
  const keys: string[] = [];
  for (const key of [TOKEN_KEY, API_KEY_KEY]) {
    const value = env[key];
    if (typeof value === "string" && value !== "" && !keys.includes(value)) keys.push(value);
  }
  return keys;
}
/** Re-parse text this module just wrote, which is always an object. */
const parseWritten = (text: string): Record<string, unknown> => asObject(parseJsonc(text)) ?? {};

function assertNotForeign(
  path: string,
  settings: Record<string, unknown>,
  env: Record<string, unknown>,
): void {
  const hint = `Remove it from ${path} by hand, then run aiand claude on again. aiand run-agent claude launches Claude Code on ai& without touching the file.`;
  if (nonEmpty(settings.apiKeyHelper)) {
    throw new CliError("Claude Code already has an apiKeyHelper that ai& does not manage.", {
      hint,
    });
  }
  for (const key of [BASE_URL_KEY, TOKEN_KEY, ...FOREIGN_PROVIDER_KEYS]) {
    if (nonEmpty(env[key]) && env[key] !== ENV_OFF) {
      throw new CliError(`Claude Code already sets env.${key}, which ai& does not manage.`, {
        hint,
      });
    }
  }
}

async function probeDetail(): Promise<ProbeDetail> {
  let settings: Record<string, unknown>;
  try {
    const path = await wiredSettingsPath();
    settings = parseSettings(path, await readTextIfExists(path));
  } catch {
    return { active: false, model: null };
  }
  const env = asObject(settings.env);
  const active = routedByUs(env);
  return {
    active,
    model: (active && startupModel(settings).model) || null,
    ...(active ? { baseUrl: String(env?.[BASE_URL_KEY]) } : {}),
  };
}

async function probe(): Promise<ProbeResult> {
  const { active, model } = await probeDetail();
  return { active, model };
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const path = claudeSettingsPath();
  const wired = await getAddedState<ClaudeRecord>(CLAUDE_ID);
  if (wired?.path && wired.path !== path) {
    // Two wired files would share one record, and off would hand one file's
    // values to the other. A record whose file lost our marker is stale.
    if (await markedFile(wired.path)) {
      throw new CliError(`Claude Code is already wired through ${wired.path}.`, {
        hint: "Run aiand claude off first, then aiand claude on for the new CLAUDE_CONFIG_DIR.",
      });
    }
    await clearAddedState(CLAUDE_ID);
  }
  const raw = await readTextIfExists(path);
  let created = false;
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    created = true;
  }
  const settings = parseSettings(path, raw);
  if (settings.env !== undefined && !asObject(settings.env)) {
    throw notValidJsonError(path, INVALID_CONFIG_HINT);
  }
  const permissions = settings.permissions;
  if (permissions !== undefined && !asObject(permissions)) {
    throw notValidJsonError(path, INVALID_CONFIG_HINT);
  }
  const deny = asObject(permissions)?.deny;
  if (deny !== undefined && !Array.isArray(deny)) {
    throw notValidJsonError(path, INVALID_CONFIG_HINT);
  }

  const env = asObject(settings.env) ?? {};
  const marked = env[MARKER_KEY] === ENV_ON;
  if (!marked) assertNotForeign(path, settings, env);

  // The prior on's record only describes this file while our marker is in it.
  // A marked file whose record is gone: the owned keys it holds are ours,
  // never values to hand back on off.
  const prior = marked ? await getAddedState<ClaudeRecord>(CLAUDE_ID) : null;
  const priorEnv: Env = prior?.env ?? (marked ? ownedValues(env) : {});
  const previousEnv: Env = { ...(prior?.previousEnv ?? {}) };
  const createdKeys = new Set(prior?.createdKeys ?? []);
  const warnings: string[] = [];
  const isNative = input.model === "native";
  const catalog = input.catalog;

  const desired: Env = gatewayEnv(input.apiKey, claudeBaseUrl(input.baseUrl));
  // The user's own custom-header pairs ride along; ours replaces only a pair
  // we wrote before (the merge strips and re-adds by header name).
  desired[HEADERS_KEY] = withAgentHeader(
    typeof env[HEADERS_KEY] === "string" ? env[HEADERS_KEY] : undefined,
  );
  const kept: Env = {};
  let chosen: string | undefined;
  let fastChosen: string | undefined;
  let fromProfile = false;
  if (!isNative) {
    // A re-run without --model keeps the model the last `on` was told to use.
    const served = (id: string | undefined): string | undefined =>
      id !== undefined && inCatalog(catalog, id) ? id : undefined;
    // A --model sticks; a profile-sourced choice follows the current profile.
    const sticky = input.pinModel
      ? input.model
      : prior?.choice === undefined
        ? legacyChosen(priorEnv, catalog, input.profileModel)
        : prior.choice.fromProfile
          ? undefined
          : served(prior.choice.model);
    chosen = sticky ?? chosenModel(catalog, undefined, input.profileModel);
    fromProfile = sticky === undefined && chosen !== undefined;
    fastChosen = input.fastModel ?? (input.pinModel ? undefined : served(prior?.choice?.fast));
    const main = chosen ?? claudeDefaultModel(catalog, input.profileModel);
    const fast = fastModel(catalog, main, { chosen, fast: fastChosen });
    for (const [slot, value] of Object.entries(slotEnv(main, fast))) {
      const current = env[slot];
      const pinned = input.pinModel || (input.fastModel !== undefined && FAST_SIDE.has(slot));
      // Only a value the user wrote stays; one a previous `on` wrote is
      // recomputed, so a slot never keeps a model nobody chose.
      const users =
        typeof current === "string" && current !== priorEnv[slot] && inCatalog(catalog, current);
      if (!pinned && users) {
        kept[slot] = current;
      } else {
        desired[slot] = value;
      }
    }
  } else {
    warnings.push("Claude Code's own models are not on ai&; pass --model to pick one.");
  }
  if (!marked) warnings.push(LIVE_ON_WARNING);

  let text = raw;
  if (settings.env === undefined) createdKeys.add("env");
  // A concrete model ai& cannot serve would fail every request: set it aside
  // for off to restore. One ai& serves is the user's choice and stays, even
  // under --model (which pins the slots, not their startup model). Aliases
  // resolve through our slots and stay.
  const removed = { removedModel: prior?.removedModel, removedEnvModel: prior?.removedEnvModel };
  for (const { path: at, label, record } of MODEL_SETTINGS) {
    const value = settingAt(settings, at);
    if (isNative || !nonEmpty(value) || isAlias(value) || inCatalog(catalog, value)) continue;
    text = jsoncDelete(text, [...at]);
    removed[record] = value;
    warnings.push(`Set aside your ${label} (${value}); aiand claude off puts it back.`);
  }

  // The budget follows the model Claude Code starts on, after the set-aside above.
  if (!isNative) {
    const effective = parseSettings(path, text);
    effective.env = { ...asObject(effective.env), ...kept, ...desired };
    desired[CONTEXT_KEY] = contextTokens(catalog, startupModel(effective).model) ?? "";
  }

  for (const [key, value] of Object.entries(desired)) {
    const current = env[key];
    // Keep the user's value to hand back on off. Never the key or the stamp:
    // a foreign token was refused above, so only an empty one is theirs, and
    // a marked file's token and stamp are ours.
    const recordable = marked
      ? key !== TOKEN_KEY && key !== MARKER_KEY
      : key !== TOKEN_KEY || current === "";
    if (
      typeof current === "string" &&
      current !== priorEnv[key] &&
      !(key in previousEnv) &&
      recordable
    ) {
      previousEnv[key] = current;
    }
    text = jsoncSet(text, ["env", key], value);
  }

  const recordedEnv: Env = {};
  for (const [key, value] of Object.entries(desired)) {
    if (key !== TOKEN_KEY) recordedEnv[key] = value;
  }
  for (const [key, value] of Object.entries(priorEnv)) {
    if (!(key in desired) && env[key] === value) recordedEnv[key] = value;
  }

  const addedDeny = [...(prior?.addedDeny ?? [])];
  const denyList: unknown[] = Array.isArray(deny) ? deny : [];
  const missing = DENIED_TOOLS.filter((tool) => !denyList.includes(tool));
  if (missing.length > 0) {
    if (permissions === undefined) createdKeys.add("permissions");
    if (deny === undefined) createdKeys.add("permissions.deny");
    text = jsoncSet(text, ["permissions", "deny"], [...denyList, ...missing]);
    addedDeny.push(...missing);
  }

  const picker = applyModelPicker(
    text,
    settings.modelPicker,
    prior?.modelPicker,
    buildModelPicker(catalog),
  );
  text = picker.text;
  if (picker.warning) warnings.push(picker.warning);

  const previousMode = prior?.previousMode ?? (await existingFileMode(path)) ?? DEFAULT_FILE_MODE;
  if (text !== raw) {
    await writeKeyFile(path, text, { mode: PRIVATE_FILE_MODE, agentId: CLAUDE_ID });
  } else {
    await chmod(path, PRIVATE_FILE_MODE);
  }
  await recordAddedState(CLAUDE_ID, {
    path,
    env: recordedEnv,
    previousEnv,
    ...removed,
    addedDeny,
    createdKeys: [...createdKeys],
    modelPicker: picker.recorded,
    previousMode,
    created: created || prior?.created === true,
    choice: {
      ...(chosen !== undefined ? { model: chosen } : {}),
      ...(fastChosen !== undefined ? { fast: fastChosen } : {}),
      ...(fromProfile ? { fromProfile } : {}),
    },
  });

  // --model pins the slots; a model setting (concrete, or an alias resolving
  // to another slot) can still decide where Claude Code starts.
  const { model: startsOn, setting } = startupModel(parseWritten(text));
  if (chosen !== undefined && setting && startsOn !== chosen) {
    const shown = setting.value === startsOn ? startsOn : `${setting.value} → ${startsOn}`;
    warnings.push(
      `Claude Code still starts on your ${setting.label} setting (${shown}); remove it or use /model to switch to ${chosen}.`,
    );
  }
  if (chosen !== undefined) {
    // A slot the user set by hand still holds another model: say so.
    const report = slotReport(parseWritten(text), { chosen, fast: fastChosen });
    warnings.push(...report.warnings.filter((line) => !line.includes("startup model")));
  }
  return {
    model: startsOn ?? input.model,
    catalogModel: startsOn && inCatalog(catalog, startsOn) ? startsOn : undefined,
    filesWritten: [path],
    warnings,
  };
}

async function disable(): Promise<DisableResult> {
  const added = await getAddedState<ClaudeRecord>(CLAUDE_ID);
  const path = added?.path ?? claudeSettingsPath();
  const raw = await readTextIfExists(path);
  let settings: Record<string, unknown>;
  try {
    settings = parseSettings(path, raw);
  } catch {
    // Keep the record: once the JSON is fixed, off can still tell our
    // values from the user's.
    return {
      stripped: false,
      notes: [`${path} is not valid JSON; fix it, then run aiand claude off again.`],
    };
  }
  const env = asObject(settings.env);
  if (env?.[MARKER_KEY] !== ENV_ON) {
    await clearAddedState(CLAUDE_ID);
    return { stripped: false };
  }

  const previousEnv = added?.previousEnv ?? {};
  const created = new Set(added?.createdKeys ?? []);
  const notes: string[] = [];
  let text = raw;

  for (const key of [TOKEN_KEY, MARKER_KEY]) text = restoreEnv(text, key, previousEnv[key]);
  // Without a record (lost state), every other key we write reads as ours.
  const ours: Env = added?.env ?? ownedValues(env);
  for (const [key, value] of Object.entries(ours)) {
    if (key === MARKER_KEY || env[key] === undefined) continue;
    // "" is an `off` that died in its wait after emptying the key: ours, mid-off.
    if (env[key] !== value && env[key] !== "") {
      notes.push(`left env.${key} because you edited it`);
      continue;
    }
    text = restoreEnv(text, key, previousEnv[key]);
  }
  if (created.has("env") && Object.keys(asObject(parseWritten(text).env) ?? {}).length === 0) {
    text = jsoncDelete(text, ["env"]);
  }

  // Known limit: a pre-existing deny array is re-rendered on removal; keep its
  // raw slice in the record if byte-identical deny arrays ever matter.
  const addedDeny = added?.addedDeny ?? [];
  if (addedDeny.length > 0) {
    const deny = asObject(parseWritten(text).permissions)?.deny;
    if (Array.isArray(deny)) {
      const left = deny.filter((tool) => typeof tool !== "string" || !addedDeny.includes(tool));
      if (left.length === 0 && created.has("permissions.deny")) {
        text = jsoncDelete(text, ["permissions", "deny"]);
      } else if (left.length !== deny.length) {
        text = jsoncSet(text, ["permissions", "deny"], left);
      }
    }
    const permissions = asObject(parseWritten(text).permissions);
    if (permissions && Object.keys(permissions).length === 0 && created.has("permissions")) {
      text = jsoncDelete(text, ["permissions"]);
    }
  }

  for (const { path: at, label, record } of MODEL_SETTINGS) {
    const removedValue = added?.[record];
    if (!removedValue) continue;
    if (settingAt(parseWritten(text), at) === undefined) {
      text = jsoncSet(text, [...at], removedValue);
    } else {
      notes.push(`left ${label} because you set a new one (yours was ${removedValue})`);
    }
  }

  const picker = stripModelPicker(text, parseWritten(text).modelPicker, added?.modelPicker);
  text = picker.text;
  if (picker.note) notes.push(picker.note);

  if (text !== raw) {
    await emptyRemovedKeys(path, text, env);
    const empty = Object.keys(parseWritten(text)).length === 0;
    if (empty && (added?.created === true || (await fileCreatedByUs(CLAUDE_ID, path)))) {
      await unlink(path);
    } else {
      // The key left the file: hand back the mode the user had before on.
      await writeFileAtomic(path, text, { mode: added?.previousMode ?? DEFAULT_FILE_MODE });
    }
  }
  await clearAddedState(CLAUDE_ID);
  return { stripped: true, notes, warnings: [LIVE_OFF_NOTE] };
}

/**
 * Running Claude Code sessions keep an env key that disappears but read "" as unset.
 * The marker stays so a failed second write still reads as ours.
 */
async function emptyRemovedKeys(
  path: string,
  final: string,
  env: Record<string, unknown>,
): Promise<void> {
  const left = asObject(parseWritten(final).env) ?? {};
  const removed = Object.keys(env).filter((key) => !(key in left) && key !== MARKER_KEY);
  if (removed.length === 0) return;
  let text = jsoncSet(final, ["env", MARKER_KEY], ENV_ON);
  for (const key of removed) text = jsoncSet(text, ["env", key], "");
  await writeFileAtomic(path, text, { mode: PRIVATE_FILE_MODE });
  const wait = Number(process.env.AIAND_CLAUDE_RELOAD_MS ?? LIVE_RELOAD_MS);
  await new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * The Claude Code release `open` installs (check-dist requires every npm
 * install hint to pin one). No --ignore-scripts: the package's postinstall
 * (install.cjs) puts the platform's native binary at bin/claude.exe, which
 * is a placeholder until it runs.
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const CLAUDE_CODE_VERSION = "2.1.312";

const CLAUDE_INSTALL = {
  command: `npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`,
  url: "https://code.claude.com/docs",
};

export const claudeAdapter: AgentAdapter = {
  id: CLAUDE_ID,
  label: "Claude Code",
  bin: CLAUDE_BIN,
  install: CLAUDE_INSTALL,
  aliases: ["claude-code"],
  openLaunchesSession: true,
  detect(): DetectResult {
    return detectBinary(CLAUDE_BIN);
  },
  carriesWiring: (text) => text.includes(`"${MARKER_KEY}"`),
  managedFiles(): string[] {
    // The wired file too, so restore works from a shell without its CLAUDE_CONFIG_DIR.
    const wired = getAddedStateSync<ClaudeRecord>(CLAUDE_ID)?.path;
    const current = claudeSettingsPath();
    return wired && wired !== current ? [current, wired] : [current];
  },
  probe,
  modelSlots,
  fastModelFlag: true,
  launchModelFlags: ["--model"],
  // Claude Code's own aliases (opus, sonnet, haiku…) resolve through the slots.
  passesLaunchModel: isAlias,
  bakedBaseUrl: async () => (await probeDetail()).baseUrl,
  enable,
  disable,
  // Claude Code prefers its own OAuth token over any API key, so a shell that
  // has one would silently bill the user's subscription instead of ai&. Both
  // launchers (run-agent, agentSession) delete these before the spawn.
  shadowEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
  nativeAiandKeys: claudeNativeAiandKeys,
  async bakedKey(): Promise<string | null> {
    // The key Claude Code sends is the token in our env block. A config
    // without our marker is the user's, and its token is not ours to claim.
    const path = await wiredSettingsPath();
    const raw = await readTextIfExists(path);
    if (!raw) return null;
    let settings: Record<string, unknown>;
    try {
      settings = parseSettings(path, raw);
    } catch {
      return null;
    }
    const env = asObject(settings.env);
    if (env?.[MARKER_KEY] !== ENV_ON) return null;
    const token = env[TOKEN_KEY];
    return typeof token === "string" && token.length > 0 ? token : null;
  },
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    const path = await wiredSettingsPath();
    const raw = await readTextIfExists(path);
    const env = asObject(parseSettings(path, raw).env);
    if (env?.[MARKER_KEY] !== ENV_ON) return false;
    if (env[TOKEN_KEY] === input.apiKey) return true;
    // A rotation swaps only the key it replaced: a config baked from another
    // profile keeps routing to that profile's org.
    if (input.previousKey !== undefined && env[TOKEN_KEY] !== input.previousKey) return false;
    await writeKeyFile(path, jsoncSet(raw, ["env", TOKEN_KEY], input.apiKey), {
      mode: PRIVATE_FILE_MODE,
      agentId: CLAUDE_ID,
    });
    return true;
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Works with no prior `on`: `--settings` layers a throwaway 0600 file over
    // the user's settings, and Claude Code loads the token from it. It then
    // exports that env block, key included, to every Bash command and hook it
    // runs, as it does after `on`; an apiKeyHelper would keep the key out.
    // Every slot on the chosen model: Claude Code sends titles and other
    // background calls to the fast slot, and safety checks to the Sonnet slot.
    // Without --model, a --model given to `on` still holds.
    const sticky = input.model === undefined ? await stickyChoice(input.catalog) : {};
    const chosen = chosenModel(input.catalog, input.model ?? sticky.model, input.profileModel);
    const main = chosen ?? claudeDefaultModel(input.catalog, input.profileModel);
    // A Claude Code alias (`--model haiku`) stays in the passthrough and
    // outranks the overlay's model, so the budget must follow its slot too.
    let startup: string | undefined;
    const args = input.args ?? [];
    for (let i = 0; i < args.length && args[i] !== "--"; i++) {
      const arg = args[i]!;
      if (arg === "--model") startup = args[++i];
      else if (arg.startsWith("--model=")) startup = arg.slice("--model=".length);
    }
    const settings = buildClaudeSettings({
      apiKey: input.apiKey,
      baseUrl: claudeBaseUrl(input.baseUrl),
      main,
      fast: fastModel(input.catalog, main, { chosen, fast: input.fastModel ?? sticky.fast }),
      startup,
      catalog: input.catalog,
    });
    const dir = await makeOverlayDir("aiand-claude-");
    const file = join(dir, "settings.json");
    try {
      await writeFile(file, JSON.stringify(settings), { mode: PRIVATE_FILE_MODE, flag: "wx" });
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    const userPath = claudeSettingsPath();
    const user: UserDefault | null = await readTextIfExists(userPath)
      .then((raw) => launchDefault(parseSettings(userPath, raw), input.catalog))
      .catch(() => null);
    // One at a time: a watcher-triggered put-back still writing when cleanup
    // runs would leave cleanup's own read nothing to do, and cleanup would
    // check `replaced` before the write set it, dropping the note.
    let putBackQueue: Promise<void> = Promise.resolve();
    const putBack = (): Promise<void> => {
      if (!user) return Promise.resolve();
      putBackQueue = putBackQueue.then(() =>
        putBackUserDefault(userPath, user, input.catalog).catch(() => {}),
      );
      return putBackQueue;
    };
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      if (user) {
        await mkdir(dirname(userPath), { recursive: true });
        // Claude Code writes through a symlinked settings.json.
        const real = await realpath(userPath).catch(() => userPath);
        watcher = watch(dirname(real), (_event, name) => {
          if (name === basename(real)) void putBack();
        });
        watcher.on("error", () => watcher?.close());
      }
    } catch {
      watcher = undefined;
    }
    return {
      env: {},
      args: ["--settings", file],
      cleanup: async () => {
        watcher?.close();
        await rm(dir, { recursive: true, force: true });
        await putBack();
        // Claude Code owns the terminal until it exits. Both ids can carry
        // bytes the user did not type (a catalog id from the server, a model
        // from a settings file another tool wrote), so the note is sanitised.
        if (user?.replaced) {
          const back =
            user.model === undefined
              ? `Cleared ${user.replaced} as your default Claude Code model, so plain claude uses its usual model.`
              : `Your default Claude Code model is ${String(user.model)} again.`;
          printNotes([`${back} ai& models only work inside aiand claude.`]);
        }
      },
    };
  },
};
