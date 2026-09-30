import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Model } from "../../api/models.js";
import { CliError } from "../../cli/errors.js";
import { agentHome, isRoutableBaseUrl, trimSlash, writeFileAtomic } from "../../config.js";
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

const COPILOT_ID = "copilot";
const COPILOT_BIN = "copilot";

/** Provider name in providers.json and the qualifier in every model selection. */
const COPILOT_PROVIDER_NAME = "aiand";
/** Model selections the CLI accepts for a BYOK provider are `aiand/<id>`. */
const COPILOT_SELECTION_PREFIX = `${COPILOT_PROVIDER_NAME}/`;

/** OpenAI-compatible base URL the CLI dials for every ai& model. */
const COPILOT_BASE_URL = "https://api.aiand.com/v1";

/** Recovery hint for a Copilot config file that cannot be parsed or edited. */
const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand copilot on again.";

/**
 * What enable() recorded so off can tell its values from the user's. The
 * baked key never appears here: only selections, previous values, modes,
 * and created flags.
 */
type CopilotRecord = {
  /** settings.json's `model` before on overwrote it (undefined = absent). */
  previousModelSelection?: string;
  /** The `aiand/<id>` selection this on wrote; off hands back or removes it. */
  wroteModelSelection?: string;
  /** File mode before `on` wrote it, per file off rewrites. */
  previousProvidersMode?: number;
  previousSettingsMode?: number;
  /** Whether `on` created the file (a created file is unlinked when emptied). */
  createdProviders?: boolean;
  createdSettings?: boolean;
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

/**
 * Tolerant JSONC read of a Copilot config file (settings.json is documented
 * JSONC): missing/blank reads as {}, a parse error or a non-object root is
 * the shared invalid-JSON CliError with the recovery hint.
 */
async function readCopilotFile(path: string): Promise<Record<string, unknown>> {
  const text = await readTextIfExists(path);
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw notValidJsonError(path, INVALID_CONFIG_HINT);
    throw error;
  }
  return asObject(parsed) ?? {};
}

/** Re-parse text this module just wrote, which is always an object or empty. */
function parseWritten(text: string): Record<string, unknown> {
  return asObject(parseJsonc(text)) ?? {};
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

/** `--base-url` + `/v1`, or the production gateway when none is given. */
function copilotBaseUrl(baseUrl?: string): string {
  const base = trimSlash(baseUrl ?? "");
  return base ? `${base}/v1` : COPILOT_BASE_URL;
}

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
    providers = await readCopilotFile(copilotProvidersPath());
    settings = await readCopilotFile(copilotSettingsPath());
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
  const providersFile = await readCopilotFile(paths.providers);
  const settingsFile = await readCopilotFile(paths.settings);

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
  const createdProviders = prior?.createdProviders ?? !existsSync(paths.providers);
  const createdSettings = prior?.createdSettings ?? !existsSync(paths.settings);
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
    createdProviders,
    createdSettings,
  });

  return {
    model: isNative ? "native" : (wroteModelSelection as string),
    catalogModel: isNative ? undefined : input.model,
    filesWritten: settingsChanged ? [paths.providers, paths.settings] : [paths.providers],
    warnings,
  };
}

/** Write a stripped file back, or unlink it when our `on` created it and nothing is left. */
async function writeStripped(
  path: string,
  before: string,
  after: string,
  mode: number,
  created: boolean,
): Promise<void> {
  if (after === before) return;
  if (Object.keys(parseWritten(after)).length === 0 && created) {
    await rm(path, { force: true });
  } else {
    await writeFileAtomic(path, after, { mode });
  }
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
  let settingsFile: Record<string, unknown>;
  try {
    providersFile = await readCopilotFile(paths.providers);
    settingsFile = await readCopilotFile(paths.settings);
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
    await writeStripped(
      paths.providers,
      raw.providers,
      providersText,
      added?.previousProvidersMode ?? PRIVATE_FILE_MODE,
      added?.createdProviders === true || (await fileCreatedByUs(COPILOT_ID, paths.providers)),
    );

    // settings.json: hand back the `model` selection on replaced, or drop
    // the key when on added it to a file that had none. A `aiand/`-prefixed
    // value — ours, or a later pick of another ai& model from the app's
    // menu — is always undone: off just deleted every row that could serve
    // it, so leaving it dangles a dead model. Only the user's own value
    // stays, with a note.
    let settingsText = raw.settings;
    const model = settingsFile.model;
    const isOurSelection = typeof model === "string" && model.startsWith(COPILOT_SELECTION_PREFIX);
    if (isOurSelection) {
      if (added?.previousModelSelection !== undefined) {
        settingsText = jsoncSet(settingsText, ["model"], added.previousModelSelection);
      } else {
        settingsText = jsoncDelete(settingsText, ["model"]);
      }
    } else if (added?.wroteModelSelection !== undefined && model !== undefined) {
      notes.push("left model because you edited it");
    }
    await writeStripped(
      paths.settings,
      raw.settings,
      settingsText,
      added?.previousSettingsMode ?? DEFAULT_FILE_MODE,
      added?.createdSettings === true || (await fileCreatedByUs(COPILOT_ID, paths.settings)),
    );
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
    const providers = await readCopilotFile(path);
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
    const overlay = await mkdtemp(join(tmpdir(), "aiand-copilot-"));
    // A failed setup would otherwise leak the overlay (and a half-written
    // key file) after an error: run-agent never sees cleanup it didn't get.
    try {
      await writeFile(
        join(overlay, "providers.json"),
        `${JSON.stringify(
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
        { mode: PRIVATE_FILE_MODE },
      );
      await writeFile(
        join(overlay, "settings.json"),
        `${JSON.stringify({ model: `${COPILOT_SELECTION_PREFIX}${model}` }, null, 2)}\n`,
        { mode: PRIVATE_FILE_MODE },
      );
    } catch (error) {
      await rm(overlay, { recursive: true, force: true });
      throw error;
    }
    return {
      env: {
        COPILOT_HOME: overlay,
        // COPILOT_PROVIDERS_CONFIG outranks COPILOT_HOME for providers.json
        // (file-direct beats the relocated dir), so an inherited value would
        // make the child read the user's file, not the overlay: pin it at
        // the overlay's own providers.json.
        COPILOT_PROVIDERS_CONFIG: join(overlay, "providers.json"),
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
      cleanup: async () => {
        await rm(overlay, { recursive: true, force: true });
      },
    };
  },
};
