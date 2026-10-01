import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
  createSessionOverlay,
  jsoncDelete,
  jsoncSet,
  parseWrittenObject,
  readJsoncObject,
  readTextIfExists,
  writeStrippedJsonc,
} from "../managed-file.js";
import { clearAddedState, getAddedState, recordAddedState } from "../snapshot.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeResult,
  SessionLaunchInput,
} from "../types.js";

const COPILOT_ID = "copilot";
const COPILOT_BIN = "copilot";

/** Provider name in providers.json and the qualifier in every model selection. */
const COPILOT_PROVIDER_NAME = "aiand";
/** Model selections the CLI accepts for a BYOK provider are `aiand/<id>`. */
const COPILOT_SELECTION_PREFIX = `${COPILOT_PROVIDER_NAME}/`;

/** Recovery hint for a Copilot config file that cannot be parsed or edited. */
const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand copilot on again.";

/**
 * What enable() recorded so off can tell its values from the user's. The
 * baked key never appears here: only selections, previous values, modes, and
 * the absolute paths we wrote (paths are not secrets; the snapshot manifest
 * already stores them).
 */
type CopilotRecord = {
  /** settings.json's `model` before on overwrote it (undefined = absent). */
  previousModelSelection?: string;
  /** The `aiand/<id>` selection this on wrote; off hands back or removes it. */
  wroteModelSelection?: string;
  /** File mode before `on` wrote it, per file off rewrites. */
  previousProvidersMode?: number;
  previousSettingsMode?: number;
  /** Where `on` actually wrote the files; off strips them if the dir moved. */
  providersPath?: string;
  settingsPath?: string;
};

/** The CLI's config dir: ~/.copilot/, or $COPILOT_HOME when set. */
function copilotHomeDir(): string {
  return process.env.COPILOT_HOME?.trim() || join(agentHome(), ".copilot");
}

/**
 * providers.json: $COPILOT_PROVIDERS_CONFIG points at the file directly and
 * wins over the (relocated) config dir; COPILOT_PROVIDERS_CONFIG relocates
 * providers only, never settings.json.
 */
export function copilotProvidersPath(): string {
  const explicit = process.env.COPILOT_PROVIDERS_CONFIG?.trim();
  if (explicit) return resolve(explicit);
  return join(copilotHomeDir(), "providers.json");
}

export function copilotSettingsPath(): string {
  return join(copilotHomeDir(), "settings.json");
}

/** The `aiand` provider row in providers.json `providers[]`, when shaped like one. */
function aiandRow(providers: Record<string, unknown>): Record<string, unknown> | undefined {
  const rows = Array.isArray(providers.providers) ? providers.providers : [];
  return rows.map(asObject).find((row) => row?.name === COPILOT_PROVIDER_NAME);
}

/**
 * Ownership marker: the provider name itself. The Copilot CLI errors loudly
 * on unrecognized provider fields, so nothing extra rides in the row — a
 * routable `aiand` row is ours, an unroutable one is foreign (opencode's
 * unmarked-aiand refusal, applied to whole-catalog BYOK rows).
 */
function isOurRow(row: Record<string, unknown> | undefined): boolean {
  return row !== undefined && isRoutableBaseUrl(row.baseUrl);
}

const copilotBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

/**
 * The provider row the CLI needs for BYOK: the OpenAI chat-completions
 * dialect over `baseUrl`, authenticating with the literal session key,
 * which (documented) bypasses GitHub sign-in entirely.
 */
export function buildCopilotProvider({
  apiKey,
  baseUrl,
}: {
  apiKey: string;
  baseUrl: string;
}): Record<string, unknown> {
  return {
    name: COPILOT_PROVIDER_NAME,
    type: "openai",
    wireApi: "completions",
    baseUrl,
    apiKey,
  };
}

/**
 * One `models[]` row per catalog model. The CLI addresses BYOK models by
 * provider-qualified id, so `id` is what selection strings name (wireModel
 * is what the request body sends); both keep the catalog id verbatim.
 * `maxPromptTokens`/`maxContextWindowTokens` mirror the context window —
 * the catalog has no separate output field (opencode's policy). The
 * reasoningEffort toggle is on/off here; the CLI derives the effort menu
 * itself, so only the presence of effort levels is published.
 */
export function buildCopilotModelEntries(catalog: Model[]): Record<string, unknown>[] {
  return catalog.map((model) => ({
    id: model.id,
    provider: COPILOT_PROVIDER_NAME,
    wireModel: model.id,
    name: model.name,
    maxPromptTokens: model.context_window,
    maxContextWindowTokens: model.context_window,
    ...(model.reasoning_efforts?.length
      ? { capabilities: { supports: { reasoningEffort: true } } }
      : {}),
  }));
}

async function probe(): Promise<ProbeResult> {
  let providers: Record<string, unknown>;
  let settings: Record<string, unknown>;
  try {
    providers = await readJsoncObject(copilotProvidersPath(), INVALID_CONFIG_HINT);
    settings = await readJsoncObject(copilotSettingsPath(), INVALID_CONFIG_HINT);
  } catch {
    // A file mid-edit must not wedge `copilot status`.
    return { active: false, model: null };
  }
  const row = aiandRow(providers);
  if (!isOurRow(row) || typeof row?.apiKey !== "string") return { active: false, model: null };
  const selection = settings.model;
  const model =
    typeof selection === "string" && selection.startsWith(COPILOT_SELECTION_PREFIX)
      ? selection.slice(COPILOT_SELECTION_PREFIX.length)
      : null;
  return { active: true, model };
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const paths = { providers: copilotProvidersPath(), settings: copilotSettingsPath() };
  const raw = {
    providers: await readTextIfExists(paths.providers),
    settings: await readTextIfExists(paths.settings),
  };
  const providersFile = await readJsoncObject(paths.providers, INVALID_CONFIG_HINT);
  const settingsFile = await readJsoncObject(paths.settings, INVALID_CONFIG_HINT);

  // A foreign provider merely named `aiand` is never ours to overwrite:
  // only rows routing somewhere usable are treated as our own writes.
  const row = aiandRow(providersFile);
  if (row !== undefined && !isOurRow(row)) {
    throw new CliError("Copilot already has a provider named aiand that ai& does not manage.", {
      hint: "Remove it and run aiand copilot on again.",
    });
  }

  // The prior on's record is live only while our row is present and ours;
  // after an `off` or a hand edit it is stale and must not be carried
  // forward.
  const prior = isOurRow(row) ? await getAddedState<CopilotRecord>(COPILOT_ID) : null;
  const warnings: string[] = [];
  const isNative = input.model === "native";

  // providers.json: one `aiand` provider row, and one models[] row per
  // catalog model, appended after the user's foreign rows and replacing
  // every prior row of ours. jsoncSet splices the two arrays whole; every
  // other key and its text survives.
  const foreignProviders = (
    Array.isArray(providersFile.providers) ? providersFile.providers : []
  ).filter((entry) => asObject(entry)?.name !== COPILOT_PROVIDER_NAME);
  const foreignModels = (Array.isArray(providersFile.models) ? providersFile.models : []).filter(
    (entry) => asObject(entry)?.provider !== COPILOT_PROVIDER_NAME,
  );
  let providersText = jsoncSet(
    raw.providers,
    ["providers"],
    [
      ...foreignProviders,
      buildCopilotProvider({ apiKey: input.apiKey, baseUrl: copilotBaseUrl(input.baseUrl) }),
    ],
  );
  providersText = jsoncSet(
    providersText,
    ["models"],
    [...foreignModels, ...buildCopilotModelEntries(input.catalog)],
  );

  // settings.json: the BYOK default selection. Copilot has no built-in
  // BYOK default — a bare `copilot` launch without a routable `model`
  // errors "No supported model available" — so on pins it, and off hands
  // back what the user had.
  const userSelection = typeof settingsFile.model === "string" ? settingsFile.model : undefined;
  const userOwnsSelection =
    userSelection !== undefined && !userSelection.startsWith(COPILOT_SELECTION_PREFIX);
  const priorLive =
    prior?.wroteModelSelection !== undefined && userSelection === prior.wroteModelSelection;

  let settingsText = raw.settings;
  let wroteModelSelection = prior?.wroteModelSelection;
  let previousModelSelection =
    prior?.previousModelSelection ?? (userOwnsSelection ? userSelection : undefined);
  if (isNative) {
    // Leave settings.json untouched: BYOK has no default, so `native`
    // means "whatever its settings already name" — worth saying so.
    warnings.push(
      "Copilot CLI has no built-in BYOK default: it uses whatever model its settings already name.",
    );
    if (wroteModelSelection !== undefined && userSelection !== wroteModelSelection) {
      // A hand edit replaced our write: the record's undo target is stale.
      wroteModelSelection = undefined;
      previousModelSelection = undefined;
    }
  } else {
    wroteModelSelection = `${COPILOT_SELECTION_PREFIX}${input.model}`;
    settingsText = jsoncSet(settingsText, ["model"], wroteModelSelection);
    // Never chain our own previous selection: while a prior on's write is
    // still live, the restore target stays the first pre-aiand value.
    if (userOwnsSelection && !priorLive) previousModelSelection = userSelection;
  }
  // A re-`on` finds each file at its first-on recorded mode; the first
  // capture stays authoritative. providers.json holds the plaintext
  // session key: 0600 for as long as it lives there. A file on created
  // stays private — a stray file must never open 0644.
  const createdProviders = !existsSync(paths.providers);
  const createdSettings = !existsSync(paths.settings);
  const previousProvidersMode =
    prior?.previousProvidersMode ??
    (createdProviders
      ? PRIVATE_FILE_MODE
      : ((await existingFileMode(paths.providers)) ?? DEFAULT_FILE_MODE));
  const previousSettingsMode =
    prior?.previousSettingsMode ??
    (createdSettings
      ? DEFAULT_FILE_MODE
      : ((await existingFileMode(paths.settings)) ?? DEFAULT_FILE_MODE));

  await writeFileAtomic(paths.providers, providersText, { mode: PRIVATE_FILE_MODE });
  // native never edits settingsText; an unchanged file is not rewritten, so
  // a missing settings.json is never created empty (the CLI could not parse
  // it and off's write-equality early-return would strand it).
  const settingsChanged = settingsText !== raw.settings;
  if (settingsChanged) {
    await writeFileAtomic(paths.settings, settingsText, { mode: previousSettingsMode });
  }

  await recordAddedState(COPILOT_ID, {
    previousModelSelection,
    wroteModelSelection,
    previousProvidersMode,
    previousSettingsMode,
    providersPath: paths.providers,
    settingsPath: paths.settings,
  });

  return {
    model: isNative ? "native" : (wroteModelSelection as string),
    catalogModel: isNative ? undefined : input.model,
    filesWritten: settingsChanged ? [paths.providers, paths.settings] : [paths.providers],
    warnings,
  };
}

/**
 * The settings.json selection hand-back off performs on one file, current
 * dir or moved: an `aiand/`-prefixed `model` is ours to undo (off just
 * deleted every row that could serve it, so leaving it dangles a dead
 * model); the user's own value stays, with a note.
 */
function handBackSelection(
  text: string,
  added: CopilotRecord | null,
): { text: string; notes: string[] } {
  const notes: string[] = [];
  const model = text.trim() ? parseWrittenObject(text).model : undefined;
  const isOurSelection = typeof model === "string" && model.startsWith(COPILOT_SELECTION_PREFIX);
  let out = text;
  if (isOurSelection) {
    out =
      added?.previousModelSelection !== undefined
        ? jsoncSet(out, ["model"], added.previousModelSelection)
        : jsoncDelete(out, ["model"]);
  } else if (added?.wroteModelSelection !== undefined && model !== undefined) {
    notes.push("left model because you edited it");
  }
  return { text: out, notes };
}

async function disable(): Promise<DisableResult> {
  const paths = { providers: copilotProvidersPath(), settings: copilotSettingsPath() };
  const added = await getAddedState<CopilotRecord>(COPILOT_ID);
  const raw = {
    providers: await readTextIfExists(paths.providers),
    settings: await readTextIfExists(paths.settings),
  };
  // Both files are parsed before anything is written: a hand edit that broke
  // settings.json must not strand off halfway through a stripped
  // providers.json. Keep the record: once the JSON is fixed, off can still
  // tell our values from the user's.
  let providersFile: Record<string, unknown>;
  try {
    providersFile = await readJsoncObject(paths.providers, INVALID_CONFIG_HINT);
    // Parsed only to gate: a hand edit that broke settings.json must block
    // before anything is written.
    await readJsoncObject(paths.settings, INVALID_CONFIG_HINT);
  } catch (error) {
    if (error instanceof CliError) {
      const what = error.message.trim().replace(/\.$/, "");
      return { stripped: false, notes: [`${what}; fix it, then run aiand copilot off again.`] };
    }
    throw error;
  }

  const notes: string[] = [];
  let stripped = false;

  // Everything below is gated on the provider row itself: a foreign
  // unroutable `aiand` row and an already-stripped file are left alone.
  if (isOurRow(aiandRow(providersFile))) {
    stripped = true;

    // providers.json: drop our provider row and every model row that
    // names our provider. Foreign rows survive; an array we emptied is
    // dropped with its key.
    const leftProviders = (
      Array.isArray(providersFile.providers) ? providersFile.providers : []
    ).filter((entry) => asObject(entry)?.name !== COPILOT_PROVIDER_NAME);
    const leftModels = (Array.isArray(providersFile.models) ? providersFile.models : []).filter(
      (entry) => asObject(entry)?.provider !== COPILOT_PROVIDER_NAME,
    );
    let providersText = raw.providers;
    if (leftProviders.length > 0) {
      providersText = jsoncSet(providersText, ["providers"], leftProviders);
    } else if (providersFile.providers !== undefined) {
      providersText = jsoncDelete(providersText, ["providers"]);
    }
    if (leftModels.length > 0) {
      providersText = jsoncSet(providersText, ["models"], leftModels);
    } else if (providersFile.models !== undefined) {
      providersText = jsoncDelete(providersText, ["models"]);
    }
    await writeStrippedJsonc(
      COPILOT_ID,
      paths.providers,
      raw.providers,
      providersText,
      added?.previousProvidersMode ?? PRIVATE_FILE_MODE,
    );

    // settings.json: the same selection hand-back as the stale path below.
    const handedBack = handBackSelection(raw.settings, added);
    notes.push(...handedBack.notes);
    await writeStrippedJsonc(
      COPILOT_ID,
      paths.settings,
      raw.settings,
      handedBack.text,
      added?.previousSettingsMode ?? DEFAULT_FILE_MODE,
    );
  }

  // A dir move after `on` (COPILOT_HOME / COPILOT_PROVIDERS_CONFIG
  // retargeted) leaves our rows in the old files while the current file
  // shows nothing of ours. The record knows where `on` actually wrote:
  // strip those too, or the baked key stays live forever with nothing
  // pointing at it. Runs outside the current-file gate so a current dir
  // with no providers.json is still honored.
  for (const kind of ["providers", "settings"] as const) {
    const stalePath = kind === "providers" ? added?.providersPath : added?.settingsPath;
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
          notes: [`${stalePath} is not valid JSON; fix it, then run aiand copilot off again.`],
        };
      }
      throw error;
    }
    let staleText = rawStale;
    if (kind === "providers") {
      // Row-gated like the current dir: a foreign unroutable `aiand` row is
      // left alone.
      if (!isOurRow(aiandRow(stale))) continue;
      const leftProviders = (Array.isArray(stale.providers) ? stale.providers : []).filter(
        (entry) => asObject(entry)?.name !== COPILOT_PROVIDER_NAME,
      );
      const leftModels = (Array.isArray(stale.models) ? stale.models : []).filter(
        (entry) => asObject(entry)?.provider !== COPILOT_PROVIDER_NAME,
      );
      if (leftProviders.length > 0) {
        staleText = jsoncSet(staleText, ["providers"], leftProviders);
      } else if (stale.providers !== undefined) {
        staleText = jsoncDelete(staleText, ["providers"]);
      }
      if (leftModels.length > 0) {
        staleText = jsoncSet(staleText, ["models"], leftModels);
      } else if (stale.models !== undefined) {
        staleText = jsoncDelete(staleText, ["models"]);
      }
    } else {
      // settings.json: the same selection hand-back as the current dir,
      // same record. Values the user changed in between are theirs and stay.
      const handedBack = handBackSelection(rawStale, added);
      staleText = handedBack.text;
      notes.push(...handedBack.notes);
    }
    const mode: Record<typeof kind, number | undefined> = {
      providers: added?.previousProvidersMode,
      settings: added?.previousSettingsMode,
    };
    await writeStrippedJsonc(
      COPILOT_ID,
      stalePath,
      rawStale,
      staleText,
      mode[kind] ?? (kind === "providers" ? PRIVATE_FILE_MODE : DEFAULT_FILE_MODE),
    );
    if (staleText !== rawStale) {
      stripped = true;
      notes.push(
        `stripped the aiand config from ${stalePath} because the Copilot config dir moved`,
      );
    }
  }

  await clearAddedState(COPILOT_ID);
  return { stripped, notes };
}

/**
 * The Copilot CLI release the install hint pins (check-dist keeps ci.yml in
 * step).
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const COPILOT_VERSION = "1.0.89";

const COPILOT_INSTALL = {
  command: `npm install -g @github/copilot@${COPILOT_VERSION}`,
  // The features/ai page 404s; the quickstart doc is the canonical install
  // surface for the CLI.
  url: "https://docs.github.com/en/copilot/get-started/cli-quickstart",
};

export const copilotAdapter: AgentAdapter = {
  id: COPILOT_ID,
  label: "GitHub Copilot",
  bin: COPILOT_BIN,
  install: COPILOT_INSTALL,
  detect(): DetectResult {
    return detectBinary(COPILOT_BIN);
  },
  managedFiles(): string[] {
    return [copilotProvidersPath(), copilotSettingsPath()];
  },
  probe,
  enable,
  disable,
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    // Row-gated like disable(): a foreign unroutable `aiand` row keeps its
    // own key untouched.
    const path = copilotProvidersPath();
    const raw = await readTextIfExists(path);
    const providers = await readJsoncObject(path, INVALID_CONFIG_HINT);
    const rows = Array.isArray(providers.providers) ? providers.providers : [];
    const index = rows.findIndex(
      (entry) => asObject(entry)?.name === COPILOT_PROVIDER_NAME && isOurRow(asObject(entry)),
    );
    if (index === -1) return false;
    const row = rows[index] as Record<string, unknown>;
    if (typeof row.apiKey !== "string") return false;
    // A same-key no-op still counts as touched: an idempotent rebake
    // reports refreshed.
    if (row.apiKey === input.apiKey) return true;
    // A rotation swaps only the key it replaced: a config baked from
    // another profile keeps routing to that profile's org.
    if (input.previousKey !== undefined && row.apiKey !== input.previousKey) return false;
    const updated = rows.map((entry, at) =>
      at === index ? { ...(entry as Record<string, unknown>), apiKey: input.apiKey } : entry,
    );
    await writeFileAtomic(path, jsoncSet(raw, ["providers"], updated), {
      mode: PRIVATE_FILE_MODE,
    });
    return true;
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Works with no prior `on`: a throwaway dir becomes COPILOT_HOME
    // holding a generated providers.json (the same rows `on` writes) and a
    // settings.json pinning the session model, both 0600. The key never
    // rides the child env — the overlay file is how the CLI reads it — and
    // cleanup removes the overlay after the child exits.
    // Known ceiling: COPILOT_HOME also relocates the CLI's session history,
    // so launcher sessions die with the throwaway — a session-scoped run
    // keeping its transcript out of the user's ~/.copilot is acceptable,
    // and upstream offers no separate history dir.
    const model = input.model ?? resolveDefault(input.catalog, input.profileModel);
    const overlay = await createSessionOverlay("aiand-copilot-", {
      "providers.json": `${JSON.stringify(
        {
          providers: [
            buildCopilotProvider({
              apiKey: input.apiKey,
              baseUrl: copilotBaseUrl(input.baseUrl),
            }),
          ],
          models: buildCopilotModelEntries(input.catalog),
        },
        null,
        2,
      )}\n`,
      "settings.json": `${JSON.stringify({ model: `${COPILOT_SELECTION_PREFIX}${model}` }, null, 2)}\n`,
    });
    return {
      env: {
        COPILOT_HOME: overlay.dir,
        // COPILOT_PROVIDERS_CONFIG outranks COPILOT_HOME for providers.json
        // (file-direct beats the relocated dir), so an inherited value would
        // make the child read the user's file, not the overlay: pin it at
        // the overlay's own providers.json.
        COPILOT_PROVIDERS_CONFIG: join(overlay.dir, "providers.json"),
        // Model precedence (observed against 1.0.89): --model >
        // COPILOT_MODEL > settings.json. COPILOT_MODEL beats the overlay's
        // own pin and an inherited user env; COPILOT_OFFLINE=true keeps a
        // pure-BYOK session from phoning GitHub (skips auth, telemetry,
        // web tools, GitHub MCP, auto-update).
        COPILOT_MODEL: `${COPILOT_SELECTION_PREFIX}${model}`,
        COPILOT_OFFLINE: "true",
      },
      // --no-auto-update: a mid-session upgrade must not churn the pinned
      // release. --model is stripped because a CLI flag outranks the
      // env pin (see the precedence above), so the injected routing would
      // otherwise be overridable (run-agent's owned-flag filter).
      args: ["--no-auto-update"],
      stripPassthroughFlags: ["--model"],
      cleanup: overlay.cleanup,
    };
  },
};
