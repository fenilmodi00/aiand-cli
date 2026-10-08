import { chmod, mkdir, rm, rmdir, unlink } from "node:fs/promises";
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
import { HERMES_PROVIDER_API_KEY_ENV, OWNED_ENV_RE, readEnvValue, replaceEnvValue } from "./env.js";
import { buildHermesOverlay, restoreShims, snapshotShims } from "./overlay.js";
import {
  buildHermesWrites,
  FOREIGN_BLOCK_HINT,
  FOREIGN_LIST_HINT,
  HERMES_PLUGIN_STAMP,
  HERMES_PROVIDER_ID,
  hasHermesMarker,
  hasLegacyAiandEntry,
  hasProviderAiand,
  hermesReasoningLevels,
  modelFieldLine,
  pinHermesModel,
  readModelField,
  readProviderField,
  restoreHermesModelLine,
  setHermesModelProvider,
  stripHermesProvider,
} from "./routing.js";
import { joinYamlLines, splitYamlLines } from "./yaml.js";

/**
 * The Hermes Agent adapter (Nous Research, binary `hermes`, home
 * `~/.hermes`). Persistent wiring rides a dedicated `aiand` model provider
 * shipped as a plugin; sessions without a prior `on` ride the throwaway
 * overlay from overlay.ts, rendered by the same routing.ts builder.
 */
const HERMES_ID = "hermes";
const HERMES_BIN = "hermes";

/**
 * The Hermes Agent commit the live matrix installs and the user-facing
 * install hint pins: the installer is `curl … | bash -s -- --commit <sha>`,
 * so the pin is a commit, not a semver.
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const HERMES_COMMIT = "666f313d1d3abd8077291ba464cf0a10f1a6157f";

const HERMES_INSTALL = {
  command: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --commit ${HERMES_COMMIT}`,
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
  /** Base URL this on wrote into the provider block; refreshKey's repoint proof. */
  wroteBaseUrl?: string;
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

/**
 * The base URL the `aiand` provider dials: `--base-url` + `/v1`, or the
 * production gateway. Hermes's `chat_completions` transport posts to
 * `${base_url}/chat/completions` (OpenAI-compatible: the docs show
 * `https://openrouter.ai/api/v1`, `http://localhost:11434/v1`, and "if a
 * server implements /v1/chat/completions, you can point Hermes at it"), so
 * the stored base_url carries `/v1` like codex/opencode to reach
 * `/v1/chat/completions` (and `/v1/models` for discovery).
 */
function hermesBaseUrl(baseUrl?: string): string {
  return `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;
}
/**
 * The one ownership rule every verb shares: the `providers.aiand` block is
 * ours while our stamp sits on it, or while the prior on's record plus a
 * key_env still naming the dedicated var prove it (a Hermes rewrite may
 * drop the stamp). A repointed block is the user's even with a live record;
 * a foreign block merely named `aiand` never passes.
 */
function hermesBlockIsOurs(configText: string, added: HermesRecord | null): boolean {
  if (hasHermesMarker(configText)) return true;
  return added !== null && readProviderField(configText, "key_env") === HERMES_PROVIDER_API_KEY_ENV;
}
async function probe(): Promise<ProbeResult> {
  try {
    const [configText, envText] = await Promise.all([
      readTextIfExists(hermesConfigPath()),
      readTextIfExists(hermesEnvPath()),
    ]);
    if (!hasProviderAiand(configText)) return { active: false, model: null };
    const marked = hasHermesMarker(configText);
    // Always load the record: wroteBaseUrl is how a stamped block that the
    // user repointed stops counting as on. A missing record falls back to
    // the gateway default, same as refreshKey.
    const added = await getAddedState<HermesRecord>(HERMES_ID);
    if (!hermesBlockIsOurs(configText, marked ? null : added))
      return { active: false, model: null };
    // Same repoint rule as refreshKey and off: a block aimed at the user's
    // origin or env var is not routing through ai&, even with the stamp.
    if (readProviderField(configText, "key_env") !== HERMES_PROVIDER_API_KEY_ENV) {
      return { active: false, model: null };
    }
    if (readProviderField(configText, "base_url") !== (added?.wroteBaseUrl ?? hermesBaseUrl())) {
      return { active: false, model: null };
    }
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
  // The prior on's record is still live while our stamp sits, the block
  // still exists, or the top-level model still routes through aiand (a
  // hand-deleted block with `provider: aiand` still proves the routing ours,
  // so the restore target survives); otherwise it is stale and must not be
  // carried forward.
  const modelRoutesOurs = readModelField(rawConfig, "provider") === HERMES_PROVIDER_ID;
  const prior =
    marked || hasProviderAiand(rawConfig) || modelRoutesOurs
      ? await getAddedState<HermesRecord>(HERMES_ID)
      : null;

  // A legacy `custom_providers:` list entry naming aiand is likewise never
  // ours — aiand only writes the dict — so `on` refuses instead of splicing
  // a duplicate dict block beside it. Checked before the dict block: the
  // entry carries no stamp, so the block check below would misreport it
  // as a foreign block.
  if (hasLegacyAiandEntry(rawConfig)) {
    throw new CliError(
      "Hermes already has a custom_providers entry named aiand that ai& does not manage.",
      { hint: FOREIGN_LIST_HINT },
    );
  }
  // A foreign provider merely named `aiand` is never ours to overwrite — but
  // a block our record still proves ours (stamp dropped by a Hermes rewrite,
  // key_env still the dedicated var, the same proof disable() strips by) is
  // rewritten, not refused: refusing dead-ends re-`on` on a state `off`
  // forgives, leaving only a by-hand fix.
  if (hasProviderAiand(rawConfig) && !hermesBlockIsOurs(rawConfig, prior)) {
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
  const inCatalog = (id: string): boolean => input.catalog.some((m) => m.id === id);
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
  // A kept default that is a prior on's still-live write keeps that record;
  // the user's own needs no undo. Shared by every branch that keeps a line.
  const carryPriorDefault = (): string | undefined =>
    prior?.wroteDefault !== undefined && currentDefault === prior.wroteDefault
      ? prior.wroteDefault
      : undefined;
  if (isNative) {
    // Leave the `model:` section exactly as found: with no model.default the
    // binary sends an empty model and every turn is rejected, so only a
    // left-alone section is a working "use Hermes's own default" (verified
    // against 0.21.5). The provider flips only onto a default the gateway
    // can serve; an unservable one stays on its own provider with a warning.
    if (currentDefault !== undefined && inCatalog(currentDefault)) {
      configText = setHermesModelProvider(configText);
      wroteProvider = true;
      blockModel = currentDefault;
      wroteDefault = carryPriorDefault();
      warnings.push(`Left Hermes's own default (${currentDefault}). Pass --model to switch.`);
    } else {
      wroteDefault = carryPriorDefault();
      wroteProvider = prior?.wroteProvider ?? false;
      if (currentDefault !== undefined) {
        warnings.push(
          `Left your default (${currentDefault}) on its own provider. Pass --model to route through ai&.`,
        );
      } else {
        warnings.push("Hermes has no model default, so none is pinned. Pass --model to pin one.");
      }
    }
  } else if (currentDefault && inCatalog(currentDefault) && !input.pinModel) {
    // The user's pick is servable: keep the line byte-identical, route only
    // the provider through aiand. A kept default that is a prior on's
    // still-live write keeps that record; the user's own needs no undo.
    configText = setHermesModelProvider(configText);
    wroteProvider = true;
    wroteDefault = carryPriorDefault();
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
    reasoningLevels: hermesReasoningLevels(input.catalog),
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
  // The set-aside list carries forward: a re-`on` finds no shadowed lines
  // left to drop (the first run already set them aside), so without the
  // carry-forward it would clobber the first run's list and off could never
  // hand the lines back. New drops merge in, deduplicated.
  const strippedEnvLines = [
    ...(prior?.strippedEnvLines ?? []),
    ...writes.droppedEnvLines.filter((line) => !(prior?.strippedEnvLines ?? []).includes(line)),
  ];
  await recordAddedState(HERMES_ID, {
    previousProviderLine,
    previousDefaultLine: wroteDefault !== undefined ? previousDefaultLine : undefined,
    wroteDefault,
    wroteProvider,
    wroteBaseUrl: baseUrl,
    previousEnvMode,
    previousConfigMode,
    createdEnv: envModeBefore === undefined,
    createdConfig: configModeBefore === undefined,
    createdPlugin: !initExisted && !yamlExisted,
    strippedEnvLines: strippedEnvLines.length > 0 ? strippedEnvLines : undefined,
  } satisfies HermesRecord);

  // The model now in effect: this run's write, else what the file already
  // had, else the requested value. Under --model native the literal is
  // reported (nothing was pinned by this run); catalogModel stays undefined
  // for anything unservable.
  const effective = wroteDefault ?? currentDefault ?? input.model;

  return {
    model: isNative ? input.model : effective,
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

  // The one shared ownership gate (stamp, or record plus the dedicated
  // key_env): a foreign `aiand`-named block and an already-stripped home
  // stay untouched. A live record always proceeds — the strip decision
  // below re-checks the same gate, so a repointed block still gets the
  // "you edited it" note path instead of an early exit.
  if (!marked && !added) return { stripped: false };

  const notes: string[] = [];
  let configText = rawConfig;
  if (hasProviderAiand(configText)) {
    // Stamp-dropped but record-proved: still ours, by the shared gate —
    // unless the user repointed the block at their own origin (refreshKey's
    // rule): then the block is theirs and off leaves it with a note instead
    // of deleting it. A repointed key_env counts the same as a repointed
    // base_url: the block routes to the user's var, so deleting it would
    // discard their edit.
    const repointed =
      readProviderField(configText, "base_url") !== (added?.wroteBaseUrl ?? hermesBaseUrl()) ||
      readProviderField(configText, "key_env") !== HERMES_PROVIDER_API_KEY_ENV;
    if (hermesBlockIsOurs(configText, added) && !repointed) {
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
  const envLines = splitYamlLines(rawEnv);
  let envText = joinYamlLines(
    envLines.lines.filter((line) => !OWNED_ENV_RE.test(line)),
    envLines.trailingNewline && envLines.lines.some((line) => !OWNED_ENV_RE.test(line)),
    envLines.eol,
  );
  for (const line of added?.strippedEnvLines ?? []) {
    if (!splitYamlLines(envText).lines.includes(line)) {
      envText =
        envText === "" || envText.endsWith(envLines.eol)
          ? `${envText}${line}${envLines.eol}`
          : `${envText}${envLines.eol}${line}${envLines.eol}`;
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
  // The launcher routes through a throwaway overlay file, so these names
  // must not leak into the child env where they would shadow that routing.
  // A literal list, never an ANTHROPIC_*/OPENAI_* sweep: each name here is a
  // real env read that can outrank the overlay — the three ANTHROPIC_* names
  // plus CLAUDE_CODE_OAUTH_TOKEN, which the credentials resolver folds into
  // the same ANTHROPIC_TOKEN tuple, are the credential/base-URL routes
  // Hermes consults; OPENAI_API_KEY / OPENAI_BASE_URL feed the auxiliary
  // "main" route when the host env carries them. (HERMES_MODEL and friends
  // need no drop: sessionLaunch pins them itself, so its injection wins.)
  // The wired adapters own their own ANTHROPIC_* rows — claude's settings
  // keep ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL, and ANTHROPIC_AUTH_TOKEN
  // — so a sweep would drop rows a sibling adapter set.
  shadowEnv: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
  ],
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
    // The shared ownership gate (stamp, or record plus the dedicated key_env
    // and the recorded base_url): a foreign `aiand`-named block keeps its
    // own key untouched, as does one the user repointed.
    // Every read sits inside the catch: rebake calls this on every adapter,
    // wired or not, so an unreadable ~/.hermes of a user who never opted in
    // reads false, never a refresh error at each login. The write below
    // stays outside: an opted-in user's failure to swap is worth reporting.
    let raw: string;
    let current: string | undefined;
    try {
      const configText = await readTextIfExists(hermesConfigPath());
      const added = await getAddedState<HermesRecord>(HERMES_ID);
      if (!hermesBlockIsOurs(configText, added)) return false;
      // The dedicated key_env must still name our var even under the stamp:
      // a block the user repointed at their own var keeps routing there, so
      // our orphaned literal must not move. Then the base_url must still be
      // the one this on wrote (the default when the record predates it) — a
      // repointed block is the user's, and the fresh key must not ship to
      // their own origin.
      if (readProviderField(configText, "key_env") !== HERMES_PROVIDER_API_KEY_ENV) return false;
      if (readProviderField(configText, "base_url") !== (added?.wroteBaseUrl ?? hermesBaseUrl()))
        return false;
      raw = await readTextIfExists(hermesEnvPath());
      current = readEnvValue(raw, HERMES_PROVIDER_API_KEY_ENV);
    } catch {
      return false;
    }
    if (current === undefined) return false;
    // A same-key no-op still counts as touched: an idempotent rebake reports
    // refreshed. Like the swap below, it re-tightens a loosened key file:
    // the baked session key stays 0600 for as long as it lives here.
    if (current === input.apiKey) {
      await chmod(hermesEnvPath(), PRIVATE_FILE_MODE);
      return true;
    }
    // A rotation swaps only the key it replaced: a config baked from another
    // profile keeps routing to that profile's org.
    if (input.previousKey !== undefined && current !== input.previousKey) return false;
    // The swap touches only the baked literal; every other byte survives.
    // The key stays 0600 for as long as it lives here.
    await writeFileAtomic(
      hermesEnvPath(),
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
    // key from the overlay .env, never the child env. Every launch names a
    // model: `--model native` never arrives from the CLI (the launcher's
    // catalog validation rejects it), and the guard
    // below backstops direct calls, because a launch without a default sends
    // an empty model and every turn is rejected, and a bare `--provider`
    // exits 2 ("--provider requires --model") — both verified against
    // 0.21.5. Without --model the catalog default is pinned so a routed
    // session never starts on a provider the gateway key cannot reach.
    if (input.model === "native") {
      throw new CliError("Hermes must be told which model to send.", {
        hint: "Pass --model with an ai& model id, or leave it out for the default.",
      });
    }
    const model = input.model ?? resolveDefault(input.catalog, input.profileModel);
    const baseUrl = hermesBaseUrl(input.baseUrl);
    // Snapshot before the child can self-relocate the store shims onto the
    // overlay path that cleanup is about to remove.
    const shims = await snapshotShims(detectBinary(HERMES_BIN).path);
    const overlay = await buildHermesOverlay(hermesHome(), {
      apiKey: input.apiKey,
      baseUrl,
      model,
      reasoningLevels: hermesReasoningLevels(input.catalog),
    });
    if (process.env.AIAND_DEBUG === "1") {
      process.stderr.write("[aiand hermes] mode: pinned\n");
      process.stderr.write(`[aiand hermes] model: ${model}\n`);
      process.stderr.write(`[aiand hermes] base URL: ${baseUrl}\n`);
      process.stderr.write(`[aiand hermes] home overlay: ${overlay}\n`);
    }
    return {
      env: {
        HERMES_HOME: overlay,
        HERMES_INFERENCE_PROVIDER: HERMES_PROVIDER_ID,
        // HERMES_TUI_PROVIDER is deliberately absent — Hermes does not
        // honour it, so setting it would only mislead.
        HERMES_MODEL: model,
        HERMES_INFERENCE_MODEL: model,
      },
      // The overlay pins provider and model; a user flag would override the
      // injected routing, so the launcher drops these from the passthrough
      // (both `--flag value` and `--flag=value`). The set is Hermes's own
      // (`-m, --model MODEL` and `--provider PROVIDER` per `hermes --help`).
      // The model always rides: a bare `--provider` exits 2 ("--provider
      // requires --model") on 0.21.5.
      args: ["--provider", HERMES_PROVIDER_ID, "--model", model],
      // The launcher's generic strip owns the passthrough filtering; the
      // adapter only declares which routing flags it owns.
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
