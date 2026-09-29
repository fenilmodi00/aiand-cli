import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const PI_ID = "pi";
const PI_BIN = "pi";

/** Provider id in Pi's models.json and the key of its auth.json credential. */
const PI_PROVIDER_ID = "aiand";
/**
 * Ownership marker aiand stamps so off/logout strip surgically. It lives on
 * the auth.json credential because models.json is the one Pi file with a
 * schema behind it (TypeBox): a marker field there rides on schema
 * tolerance, while auth.json's loader only validates type/key and passes
 * unknown keys through.
 */
const PI_MARKER_KEY = "managedBy";
const PI_MARKER = "aiand";

/** OpenAI-compatible base URL Pi dials for every ai& model. */
const PI_BASE_URL = "https://api.aiand.com/v1";

/** Recovery hint for a Pi config file that cannot be parsed or edited. */
const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand pi on again.";

/**
 * What enable() recorded so off can tell its values from the user's. The
 * baked key never appears here: only ids, previous values, and file modes.
 */
type PiRecord = {
  /** What settings.json's defaultProvider was before on (undefined = absent). */
  previousDefaultProvider?: string;
  /** What settings.json's defaultModel was before the write off must undo. */
  previousDefaultModel?: string;
  /** The defaultModel this on wrote (a catalog id); off hands back or removes it. */
  wroteDefaultModel?: string;
  /** File mode before `on` wrote it, per file off rewrites. */
  previousModelsMode?: number;
  previousSettingsMode?: number;
  /** auth.json's mode before `on` wrote it; a new file stays private. */
  previousAuthMode?: number;
};

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

/**
 * Read a Pi config file as an object: missing/blank reads as {}, a parse
 * error is the shared invalid-JSON CliError. Pi parses all three files with
 * plain JSON.parse (only models.json tolerates comments), but the surgical
 * editors keep whatever text the user had, so its round trip is safe.
 */
async function readPiFile(path: string): Promise<Record<string, unknown>> {
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

/** The `aiand` credential block in auth.json, when it is an object. */
function aiandCredential(auth: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(auth[PI_PROVIDER_ID]);
}

/** True when our stamp sits on the auth.json `aiand` credential. */
function hasOwnershipMarker(auth: Record<string, unknown>): boolean {
  return aiandCredential(auth)?.[PI_MARKER_KEY] === PI_MARKER;
}

/** The provider block Pi's model runtime composes from models.json. */
function aiandProvider(models: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(asObject(models.providers)?.[PI_PROVIDER_ID]);
}

/** `--base-url` + `/v1`, or the production gateway when none is given. */
function piBaseUrl(baseUrl?: string): string {
  const base = trimSlash(baseUrl ?? "");
  return base ? `${base}/v1` : PI_BASE_URL;
}

/**
 * One model entry in Pi's `providers.aiand.models` array, rendered from the
 * live catalog. Prices are per-1M floats (the catalog's unit); Pi's cost
 * unit is per Mtok, the same order opencode writes, so the numbers pass
 * through. The catalog carries no output-token field, so maxTokens mirrors
 * the context window — the cap the gateway enforces (opencode's policy).
 */
export function piModelEntry(model: Model): Record<string, unknown> {
  const input: string[] = ["text"];
  if (model.capabilities.includes("vision")) input.push("image");
  const price = (value: string | null): number => Number.parseFloat(value ?? "0");
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning_efforts != null && model.reasoning_efforts.length > 0,
    input,
    contextWindow: model.context_window,
    maxTokens: model.context_window,
    cost: {
      input: price(model.input_per_1m),
      output: price(model.output_per_1m),
      cacheRead: price(model.cached_input_per_1m),
      cacheWrite: 0,
    },
  };
}

/**
 * The one builder for the aiand provider block in models.json, used by
 * enable() and sessionLaunch() so the two cannot drift.
 *
 * `supportsReasoningEffort: false` is a live-gateway finding, not a guess:
 * Pi sends `reasoning_effort: "medium"` for reasoning models by default and
 * the catalog advertises per-model effort sets (glm-5.3 takes low/high/max
 * only), so the gateway answers 400 on the first prompt. Suppressing the
 * param lets the gateway apply each model's own default. The OpenAI
 * "developer" role pi sends for reasoning models is accepted by the
 * gateway, so no other compat flag is set.
 */
export function buildPiProvider({
  baseUrl,
  catalog,
}: {
  baseUrl: string;
  catalog: Model[];
}): Record<string, unknown> {
  return {
    name: "ai&",
    baseUrl,
    api: "openai-completions",
    compat: { supportsReasoningEffort: false },
    models: catalog.map(piModelEntry),
  };
}

async function probe(): Promise<ProbeResult> {
  let auth: Record<string, unknown>;
  let models: Record<string, unknown>;
  let settings: Record<string, unknown>;
  try {
    auth = await readPiFile(piAuthPath());
    models = await readPiFile(piModelsPath());
    settings = await readPiFile(piSettingsPath());
  } catch {
    // A file mid-edit must not wedge `pi status`.
    return { active: false, model: null };
  }
  if (!hasOwnershipMarker(auth)) return { active: false, model: null };
  const baseUrl = aiandProvider(models)?.baseUrl;
  if (!isRoutableBaseUrl(baseUrl)) return { active: false, model: null };
  const model = typeof settings.defaultModel === "string" ? settings.defaultModel : null;
  return { active: true, model };
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const paths = { models: piModelsPath(), auth: piAuthPath(), settings: piSettingsPath() };
  const raw = {
    models: await readTextIfExists(paths.models),
    auth: await readTextIfExists(paths.auth),
    settings: await readTextIfExists(paths.settings),
  };
  const models = await readPiFile(paths.models);
  const auth = await readPiFile(paths.auth);
  const settings = await readPiFile(paths.settings);

  // A foreign provider merely named `aiand` is never ours to overwrite.
  if (aiandProvider(models) !== undefined && !hasOwnershipMarker(auth)) {
    throw new CliError("Pi already has a providers.aiand block that ai& does not manage.", {
      hint: "Remove or rename the foreign block by hand, then run aiand pi on again.",
    });
  }

  // The prior on's record is still live only while our marker sits in
  // auth.json; after an `off` or a hand edit it is stale and must not be
  // carried forward.
  const prior = hasOwnershipMarker(auth) ? await getAddedState<PiRecord>(PI_ID) : null;
  const warnings: string[] = [];
  const catalog = input.catalog;
  const isNative = input.model === "native";
  const inCatalog = (id: string): boolean => catalog.some((model) => model.id === id);

  // models.json: our provider block, replacing any prior one of ours. Every
  // unrelated provider and key survives — jsoncSet splices one property.
  const modelsText = jsoncSet(
    raw.models,
    ["providers", PI_PROVIDER_ID],
    buildPiProvider({ baseUrl: piBaseUrl(input.baseUrl), catalog }),
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
    previousModelsMode,
    previousSettingsMode,
    previousAuthMode,
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

/** Write a stripped file back, or unlink it when our `on` created it and nothing is left. */
async function writeStripped(
  path: string,
  before: string,
  after: string,
  mode: number,
): Promise<void> {
  if (after === before) return;
  if (Object.keys(parseWritten(after)).length === 0 && (await fileCreatedByUs(PI_ID, path))) {
    await unlink(path).catch(() => {});
  } else {
    await writeFileAtomic(path, after, { mode });
  }
}

async function disable(): Promise<DisableResult> {
  const paths = { models: piModelsPath(), auth: piAuthPath(), settings: piSettingsPath() };
  const added = await getAddedState<PiRecord>(PI_ID);
  const raw = {
    models: await readTextIfExists(paths.models),
    auth: await readTextIfExists(paths.auth),
    settings: await readTextIfExists(paths.settings),
  };
  let auth: Record<string, unknown>;
  try {
    auth = await readPiFile(paths.auth);
  } catch (error) {
    if (error instanceof CliError) {
      // Keep the record: once the JSON is fixed, off can still tell our
      // values from the user's.
      return {
        stripped: false,
        notes: [`${paths.auth} is not valid JSON; fix it, then run aiand pi off again.`],
      };
    }
    throw error;
  }

  const notes: string[] = [];
  let stripped = false;

  // Everything below is gated on our stamp: a foreign `aiand`-named
  // credential (no marker) and an already-stripped file are left alone.
  if (hasOwnershipMarker(auth)) {
    stripped = true;

    // auth.json: drop our credential; the user's own credentials survive.
    // A file our on created (the snapshot recorded its absence) and that is
    // now empty is unlinked, never left behind as a stray.
    const authText = jsoncDelete(raw.auth, [PI_PROVIDER_ID]);
    await writeStripped(
      paths.auth,
      raw.auth,
      authText,
      added?.previousAuthMode ?? PRIVATE_FILE_MODE,
    );

    // settings.json: hand back the defaultProvider on replaced and the
    // defaultModel on set aside or wrote. Values the user changed in
    // between are theirs and stay, with a note.
    let settingsText = raw.settings;
    const settings = parseWritten(settingsText);
    if (added?.wroteDefaultModel !== undefined) {
      if (settings.defaultModel === added.wroteDefaultModel) {
        if (added.previousDefaultModel !== undefined) {
          settingsText = jsoncSet(settingsText, ["defaultModel"], added.previousDefaultModel);
        } else {
          settingsText = jsoncDelete(settingsText, ["defaultModel"]);
        }
      } else if (settings.defaultModel !== undefined) {
        notes.push("left defaultModel because you edited it");
      }
    }
    if (settings.defaultProvider === PI_PROVIDER_ID) {
      if (added?.previousDefaultProvider !== undefined) {
        settingsText = jsoncSet(settingsText, ["defaultProvider"], added.previousDefaultProvider);
      } else {
        settingsText = jsoncDelete(settingsText, ["defaultProvider"]);
      }
    } else if (settings.defaultProvider !== undefined) {
      notes.push("left defaultProvider because you edited it");
    }
    await writeStripped(
      paths.settings,
      raw.settings,
      settingsText,
      added?.previousSettingsMode ?? DEFAULT_FILE_MODE,
    );

    // models.json: drop our provider block; unrelated providers survive,
    // and an emptied `providers` map (ours alone) is dropped with it.
    let modelsText = jsoncDelete(raw.models, ["providers", PI_PROVIDER_ID]);
    const left = asObject(parseWritten(modelsText).providers);
    if (left && Object.keys(left).length === 0) {
      modelsText = jsoncDelete(modelsText, ["providers"]);
    }
    await writeStripped(
      paths.models,
      raw.models,
      modelsText,
      added?.previousModelsMode ?? DEFAULT_FILE_MODE,
    );
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
  detect(): DetectResult {
    return detectBinary(PI_BIN);
  },
  managedFiles(): string[] {
    return PI_MANAGED_FILES.map((path) => path());
  },
  probe,
  enable,
  disable,
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    // Marker-gated like disable(): a foreign `aiand`-named credential keeps
    // its own key untouched.
    const path = piAuthPath();
    const raw = await readTextIfExists(path);
    const credential = aiandCredential(await readPiFile(path));
    if (!credential || credential[PI_MARKER_KEY] !== PI_MARKER) return false;
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
    // at through PI_CODING_AGENT_SESSION_DIR: Pi resolves that env, else
    // <agent dir>/sessions, and the overlay would otherwise be the agent
    // dir — its history must not vanish with the throwaway. No Pi config
    // files are written under ~/.pi; history still lands in the user's dir.
    const model = input.model ?? resolveDefault(input.catalog, input.profileModel);
    const overlay = await mkdtemp(join(tmpdir(), "aiand-pi-"));
    // A failed setup would otherwise leak the overlay (and a half-written
    // key file) after an error: run-agent never sees cleanup it didn't get.
    try {
      await writeFile(
        join(overlay, "models.json"),
        `${JSON.stringify(
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
        { mode: PRIVATE_FILE_MODE },
      );
      await writeFile(
        join(overlay, "auth.json"),
        `${JSON.stringify({
          [PI_PROVIDER_ID]: { type: "api_key", key: input.apiKey, [PI_MARKER_KEY]: PI_MARKER },
        })}\n`,
        { mode: PRIVATE_FILE_MODE },
      );
    } catch (error) {
      await rm(overlay, { recursive: true, force: true });
      throw error;
    }
    const args = ["--provider", PI_PROVIDER_ID, "--model", model];
    // Non-TTY stdin: ask for an explicit one-shot mode. Upstream Pi has had
    // hang bugs with redirected stdin when no mode is set; a piped prompt
    // must process and exit, not sit on an interactive session.
    if (!process.stdin.isTTY) args.push("--print");
    return {
      env: {
        PI_CODING_AGENT_DIR: overlay,
        PI_CODING_AGENT_SESSION_DIR:
          process.env.PI_CODING_AGENT_SESSION_DIR ?? join(piAgentDir(), "sessions"),
      },
      // --provider/--model pin the routing; a user-supplied --api-key would
      // override the overlay's credential, so it is stripped with the rest
      // of the routing flags (both `--flag value` and `--flag=value`).
      args,
      stripPassthroughFlags: ["--provider", "--model", "--models", "--api-key"],
      cleanup: async () => {
        await rm(overlay, { recursive: true, force: true });
      },
    };
  },
};
