import type { Model } from "../../api/models.js";
import { DEFAULT_BASE_URL, isRoutableBaseUrl, trimSlash } from "../../config.js";
import { resolveDefault } from "../catalog.js";
import { asObject, notValidJsonError, parseJsonc } from "../managed-file.js";
import { buildModelPicker } from "./picker.js";

/** Claude Code reads its boolean env switches as "1" and "0". */
export const ENV_ON = "1";
export const ENV_OFF = "0";
export const MARKER_KEY = "AIAND_MANAGED";
export const BASE_URL_KEY = "ANTHROPIC_BASE_URL";
export const TOKEN_KEY = "ANTHROPIC_AUTH_TOKEN";
/** Blanked so a key exported in the shell cannot win over ours. */
export const API_KEY_KEY = "ANTHROPIC_API_KEY";
/**
 * The gateway flattens `system` into one string, so Claude Code's attribution
 * block would reach the model as prompt text; its docs name this variable as
 * the client-side fix for a gateway that reshapes `system`.
 */
const ATTRIBUTION_KEY = "CLAUDE_CODE_ATTRIBUTION_HEADER";
/**
 * Let the numeric hint size unrecognized `[1m]` ids too; otherwise Claude Code
 * ignores it and assumes exactly 1M, even when the catalog says otherwise.
 * https://code.claude.com/docs/en/model-config#which-ids-claude_code_max_context_tokens-applies-to
 */
const DISABLE_1M_KEY = "CLAUDE_CODE_DISABLE_1M_CONTEXT";
const OPUS_SLOT = "ANTHROPIC_DEFAULT_OPUS_MODEL";
const SONNET_SLOT = "ANTHROPIC_DEFAULT_SONNET_MODEL";
const FABLE_SLOT = "ANTHROPIC_DEFAULT_FABLE_MODEL";
const MAIN_SLOTS = [OPUS_SLOT, SONNET_SLOT, FABLE_SLOT, "CLAUDE_CODE_SUBAGENT_MODEL"];
const FAST_SLOT = "ANTHROPIC_DEFAULT_HAIKU_MODEL";
/**
 * The model auto mode's safety checks run on (Claude Code v2.1.302+; older
 * versions ignore it). Unset, they run on the Sonnet slot: each check sends
 * ~30k input tokens, so on the main model they cost more than the coding
 * work. They get the fast model instead.
 */
const AUTO_MODE_MODEL_KEY = "CLAUDE_CODE_AUTO_MODE_MODEL";
/**
 * `0` keeps auto mode on Claude Code's own safety-check requests. The server
 * checks Claude Code otherwise asks for need Anthropic's `safeguard_results`,
 * which the gateway cannot produce for its models; Claude Code falls back to
 * its own requests today and says an upcoming release removes that fallback,
 * after which every checked action would be asked about or denied. See
 * docs/adr/0002-claude-auto-mode-safety-checks.md.
 */
const AUTO_MODE_SERVER_KEY = "CLAUDE_CODE_AUTO_MODE_SERVER";
const ENV_MODEL_KEY = "ANTHROPIC_MODEL";
/** The slot `default`, and an alias this adapter does not know, start on. */
const DEFAULT_SLOT = SONNET_SLOT;
/** Claude Code's model aliases and the slot each starts on; `opusplan` uses opus only in plan mode. */
const ALIAS_SLOTS: Record<string, string> = {
  default: DEFAULT_SLOT,
  sonnet: SONNET_SLOT,
  opusplan: SONNET_SLOT,
  opus: OPUS_SLOT,
  best: OPUS_SLOT,
  fable: FABLE_SLOT,
  haiku: FAST_SLOT,
};
export const CONTEXT_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
export const DENIED_TOOLS = ["WebSearch"];
export const FOREIGN_PROVIDER_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

// Curated orders filtered through the live catalog, until a catalog field can
// say which model suits which slot. Vision first for the main slots, since
// pasting screenshots is routine in Claude Code.
const MAIN_PREFERRED = ["moonshotai/kimi-k3", "qwen/qwen3.8-27b"];
const FAST_PREFERRED = ["deepseek-ai/deepseek-v4.1-flash-1017", "google/gemma-4-31b-it"];

export type Env = Record<string, string>;

/**
 * Newline/comma-separated `Name: value` pairs Claude Code sends on every
 * request; ours names the agent for the gateway's per-request log. The
 * user's own pairs ride along through on (withAgentHeader) and come back
 * whole on off, like every owned env value.
 */
export const HEADERS_KEY = "ANTHROPIC_CUSTOM_HEADERS";
const AGENT_HEADER_NAME = "x-aiand-agent";

/** The two settings that can name the model Claude Code starts on, strongest first. */
export const MODEL_SETTINGS = [
  { path: ["env", ENV_MODEL_KEY], label: `env.${ENV_MODEL_KEY}`, record: "removedEnvModel" },
  { path: ["model"], label: "model", record: "removedModel" },
] as const;

/** `--base-url` origin, or the production gateway. Claude Code appends `/v1/messages` itself. */
export function claudeBaseUrl(baseUrl?: string): string {
  return trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL;
}

export const inCatalog = (catalog: Model[], id: string): boolean =>
  catalog.some((model) => model.id === id);

const aliasName = (model: string): string => model.replace(/\[1m\]$/i, "").toLowerCase();

export const isAlias = (model: string): boolean => Object.hasOwn(ALIAS_SLOTS, aliasName(model));

export const claudeDefaultModel = (catalog: Model[], profileModel?: string): string =>
  resolveDefault(catalog, profileModel, MAIN_PREFERRED);

/**
 * The model the user chose for Claude Code: `--model`, else the profile's
 * model (`aiand config set model`) while the catalog still serves it. Unset
 * means the user left the pick to us.
 */
export function chosenModel(
  catalog: Model[],
  model: string | undefined,
  profileModel: string | undefined,
): string | undefined {
  if (model !== undefined) return model;
  return profileModel && inCatalog(catalog, profileModel) ? profileModel : undefined;
}

/**
 * The fast slot's model (`haiku`: session titles and other background calls).
 * `--fast-model` when given; else the chosen model, so a user who picked one
 * model gets only that model; only with no choice at all does the
 * curated fast order apply.
 */
export function fastModel(
  catalog: Model[],
  main: string,
  choice: { chosen?: string; fast?: string } = {},
): string {
  if (choice.fast !== undefined) return choice.fast;
  if (choice.chosen !== undefined) return choice.chosen;
  return FAST_PREFERRED.find((id) => inCatalog(catalog, id)) ?? main;
}

/**
 * Merge our attribution pair into an `ANTHROPIC_CUSTOM_HEADERS` value,
 * replacing only a pair we wrote before: the user's own pairs survive both
 * the merge and off byte-identically, whichever separator Claude Code
 * accepts (`Name: value` pairs on newlines or commas).
 */
export function withAgentHeader(current: string | undefined): string {
  const pair = `${AGENT_HEADER_NAME}: claude`;
  const kept = (current ?? "")
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !entry.toLowerCase().startsWith(`${AGENT_HEADER_NAME}:`));
  return kept.length > 0 ? `${kept.join("\n")}\n${pair}` : pair;
}

export function gatewayEnv(apiKey: string, baseUrl: string): Env {
  return {
    [BASE_URL_KEY]: baseUrl,
    [TOKEN_KEY]: apiKey,
    [API_KEY_KEY]: "",
    [MARKER_KEY]: ENV_ON,
    [ATTRIBUTION_KEY]: ENV_OFF,
    [HEADERS_KEY]: withAgentHeader(""),
    [DISABLE_1M_KEY]: ENV_ON,
    [AUTO_MODE_SERVER_KEY]: ENV_OFF,
    // A switch left on in the shell or a lower settings file would route
    // Claude Code to that cloud whatever ANTHROPIC_BASE_URL says.
    ...Object.fromEntries(FOREIGN_PROVIDER_KEYS.map((key) => [key, ENV_OFF])),
  };
}

export function slotEnv(main: string, fast: string): Env {
  const env: Env = {};
  for (const slot of MAIN_SLOTS) env[slot] = main;
  env[FAST_SLOT] = fast;
  // Auto mode's safety checks (Claude Code 2.1.302+): written, so a value
  // exported in the shell cannot send them to a model nobody chose here.
  env[AUTO_MODE_MODEL_KEY] = fast;
  return env;
}

/**
 * Every `env` key `on` owns apart from the token and the marker (which `off`
 * always removes), taken from the helpers that write them so the lists
 * cannot drift.
 */
const OWNED_ENV_KEYS = [
  ...Object.keys(gatewayEnv("", "")),
  ...Object.keys(slotEnv("", "")),
  CONTEXT_KEY,
].filter((key) => key !== TOKEN_KEY && key !== MARKER_KEY);

export function ownedValues(env: Record<string, unknown>): Env {
  const owned: Env = {};
  for (const key of OWNED_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string") owned[key] = value;
  }
  return owned;
}

export const settingAt = (settings: Record<string, unknown>, path: readonly string[]): unknown =>
  path.length === 1 ? settings[path[0]!] : asObject(settings.env)?.[path[1]!];

/** The setting that decides the startup model, and the model it resolves to. */
export function startupModel(settings: Record<string, unknown>): {
  model: string | undefined;
  setting?: { label: string; value: string };
} {
  const env = asObject(settings.env) ?? {};
  for (const { path, label } of MODEL_SETTINGS) {
    const value = settingAt(settings, path);
    if (!nonEmpty(value)) continue;
    if (!isAlias(value)) return { model: value, setting: { label, value } };
    const slot = env[ALIAS_SLOTS[aliasName(value)]!];
    return { model: nonEmpty(slot) ? slot : undefined, setting: { label, value } };
  }
  const slot = env[DEFAULT_SLOT];
  return { model: nonEmpty(slot) ? slot : undefined };
}

const SLOT_LABELS: [key: string, label: string][] = [
  [OPUS_SLOT, "opus"],
  [SONNET_SLOT, "sonnet"],
  [FABLE_SLOT, "fable"],
  ["CLAUDE_CODE_SUBAGENT_MODEL", "subagent"],
  [FAST_SLOT, "fast (haiku)"],
];

export type SlotEntry = { key: string; label: string; model: string | null };

/**
 * Every model Claude Code can send a request to under these settings, and a
 * warning for each that is not the chosen one. `chosen` is what the user
 * picked (`--model`; `--fast-model` for the fast slot and safety checks);
 * with no pick, the model Claude Code starts on.
 */
export function slotReport(
  settings: Record<string, unknown>,
  choice: { chosen?: string; fast?: string } = {},
): { slots: SlotEntry[]; warnings: string[] } {
  const env = asObject(settings.env) ?? {};
  const read = (key: string): string | null => (nonEmpty(env[key]) ? env[key] : null);
  const startup = startupModel(settings);
  const slots: SlotEntry[] = [
    { key: startup.setting?.label ?? "model", label: "startup", model: startup.model ?? null },
    ...SLOT_LABELS.map(([key, label]) => ({ key, label, model: read(key) })),
  ];
  const auto = read(AUTO_MODE_MODEL_KEY);
  const checks: SlotEntry =
    auto !== null
      ? { key: AUTO_MODE_MODEL_KEY, label: "auto-mode checks", model: auto }
      : { key: SONNET_SLOT, label: "auto-mode checks", model: read(SONNET_SLOT) };
  slots.push(checks);
  const main = choice.chosen ?? startup.model;
  // The checks follow --fast-model even when the Sonnet slot supplies their model.
  const fastSide = (slot: SlotEntry) => slot === checks || slot.key === FAST_SLOT;
  const warnings: string[] = [];
  for (const slot of slots) {
    const want = fastSide(slot) && choice.fast !== undefined ? choice.fast : main;
    if (want === undefined || slot.model === null || slot.model === want) continue;
    warnings.push(
      `Claude Code's ${slot.label} model (${slot.key}) is ${slot.model}, not ${want}: it sends requests there too.`,
    );
  }
  if (warnings.length > 0) {
    warnings.push(
      choice.chosen !== undefined
        ? `To put every slot on ${choice.chosen}, run aiand claude on --model ${choice.chosen}.`
        : "To put every slot on one model, run aiand claude on --model <id>.",
    );
  }
  return { slots, warnings };
}

/** Claude Code exposes one process-wide hint, so size it for the startup model. */
export function contextTokens(catalog: Model[], id: string | undefined): string | undefined {
  const window = catalog.find((model) => model.id === id)?.context_window;
  return typeof window === "number" && Number.isSafeInteger(window) && window > 0
    ? String(window)
    : undefined;
}

export function buildClaudeSettings({
  apiKey,
  baseUrl,
  main,
  fast,
  catalog,
  startup,
}: {
  apiKey: string;
  baseUrl: string;
  main: string;
  fast: string;
  catalog: Model[];
  startup?: string;
}): Record<string, unknown> {
  // ANTHROPIC_MODEL too: a shell export of it would beat the `model` below.
  const env: Env = {
    ...gatewayEnv(apiKey, baseUrl),
    ...slotEnv(main, fast),
    [ENV_MODEL_KEY]: main,
  };
  // Claude Code's own --model (an alias it resolves through the slots) outranks `model`.
  const selected = startupModel({ env: { ...env, [ENV_MODEL_KEY]: startup ?? main } }).model;
  // Empty also clears an inherited hint when the catalog has no usable window.
  env[CONTEXT_KEY] = contextTokens(catalog, selected) ?? "";
  return {
    model: main,
    env,
    permissions: { deny: DENIED_TOOLS },
    modelPicker: buildModelPicker(catalog),
  };
}

export const INVALID_CONFIG_HINT = "Fix it by hand, then run aiand claude on again.";

export const routedByUs = (env: Record<string, unknown> | undefined): boolean =>
  env?.[MARKER_KEY] === ENV_ON && isRoutableBaseUrl(env[BASE_URL_KEY]);

export function parseSettings(path: string, raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw notValidJsonError(path, INVALID_CONFIG_HINT);
    throw error;
  }
  const object = asObject(parsed);
  if (!object) throw notValidJsonError(path, INVALID_CONFIG_HINT);
  return object;
}

/** Slots that follow `--fast-model` rather than `--model`. */
export const FAST_SIDE = new Set([FAST_SLOT, AUTO_MODE_MODEL_KEY]);

/**
 * A record from before `chosen` was recorded (0.8.0): main slots that all
 * hold one served model other than the default were a `--model` choice.
 */
export function legacyChosen(
  priorEnv: Env,
  catalog: Model[],
  profileModel: string | undefined,
): string | undefined {
  // A served profile model is a current choice, and outranks one inferred from old slots.
  if (profileModel !== undefined && inCatalog(catalog, profileModel)) return undefined;
  const values = new Set(MAIN_SLOTS.map((slot) => priorEnv[slot]));
  if (values.size !== 1) return undefined;
  const [model] = values;
  if (model === undefined || !inCatalog(catalog, model)) return undefined;
  // Our default, or the profile's model, was no --model choice.
  if (model === claudeDefaultModel(catalog) || model === profileModel) return undefined;
  return model;
}

export const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value !== "";
