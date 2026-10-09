import type { Model } from "../../api/models.js";
import { DEFAULT_BASE_URL, trimSlash } from "../../config.js";
import { inCatalog, resolveDefault } from "../catalog.js";
import { asObject } from "../managed-file.js";
import { buildModelPicker } from "./picker.js";

/** Claude Code reads its boolean env switches as "1" and "0". */
export const ENV_ON = "1";
export const ENV_OFF = "0";
export const MARKER_KEY = "AIAND_MANAGED";
export const BASE_URL_KEY = "ANTHROPIC_BASE_URL";
export const TOKEN_KEY = "ANTHROPIC_AUTH_TOKEN";
/** Blanked so a key exported in the shell cannot win over ours. */
const API_KEY_KEY = "ANTHROPIC_API_KEY";
/**
 * The gateway flattens `system` into one string, so Claude Code's attribution
 * block would reach the model as prompt text; its docs name this variable as
 * the client-side fix for a gateway that reshapes `system`.
 */
const ATTRIBUTION_KEY = "CLAUDE_CODE_ATTRIBUTION_HEADER";
/** A `[1m]`-tagged id would make Claude Code assume a 1M window and ignore the cap below. */
const DISABLE_1M_KEY = "CLAUDE_CODE_DISABLE_1M_CONTEXT";
const OPUS_SLOT = "ANTHROPIC_DEFAULT_OPUS_MODEL";
const SONNET_SLOT = "ANTHROPIC_DEFAULT_SONNET_MODEL";
const FABLE_SLOT = "ANTHROPIC_DEFAULT_FABLE_MODEL";
export const MAIN_SLOTS = [OPUS_SLOT, SONNET_SLOT, FABLE_SLOT, "CLAUDE_CODE_SUBAGENT_MODEL"];
export const FAST_SLOT = "ANTHROPIC_DEFAULT_HAIKU_MODEL";
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
// One cap for every model: open models get unreliable at tool calling well
// before their advertised 1M window (a glm-5.3 session looped at ~270k), so
// Claude Code should compact long sessions first. A per-model catalog field
// (an "effective context") would retire it.
const CONTEXT_CAP_TOKENS = 200_000;
export const DENIED_TOOLS = ["WebSearch"];
export const FOREIGN_PROVIDER_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

// Curated orders filtered through the live catalog, until a catalog field can
// say which model suits which slot. Vision first for the main slots, since
// pasting screenshots is routine in Claude Code.
const MAIN_PREFERRED = ["moonshotai/kimi-k3", "qwen/qwen3.8-27b", "moonshotai/kimi-k2.7-code"];
const FAST_PREFERRED = ["deepseek-ai/deepseek-v4-flash", "google/gemma-4-31b-it"];

export type Env = Record<string, string>;

/** The two settings that can name the model Claude Code starts on, strongest first. */
export const MODEL_SETTINGS = [
  { path: ["env", ENV_MODEL_KEY], label: `env.${ENV_MODEL_KEY}`, record: "removedEnvModel" },
  { path: ["model"], label: "model", record: "removedModel" },
] as const;

/** `--base-url` origin, or the production gateway. Claude Code appends `/v1/messages` itself. */
export function claudeBaseUrl(baseUrl?: string): string {
  return trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL;
}

/** Shared across adapters; re-exported for this module's consumers. */
export { inCatalog };

const aliasName = (model: string): string => model.replace(/\[1m\]$/i, "").toLowerCase();

export const isAlias = (model: string): boolean => Object.hasOwn(ALIAS_SLOTS, aliasName(model));

export const claudeDefaultModel = (catalog: Model[], profileModel?: string): string =>
  resolveDefault(catalog, profileModel, MAIN_PREFERRED);

export function fastModel(catalog: Model[], main: string): string {
  return FAST_PREFERRED.find((id) => inCatalog(catalog, id)) ?? main;
}

export function gatewayEnv(apiKey: string, baseUrl: string): Env {
  return {
    [BASE_URL_KEY]: baseUrl,
    [TOKEN_KEY]: apiKey,
    [API_KEY_KEY]: "",
    [MARKER_KEY]: ENV_ON,
    [ATTRIBUTION_KEY]: ENV_OFF,
    [DISABLE_1M_KEY]: ENV_ON,
    // A switch left on in the shell or a lower settings file would route
    // Claude Code to that cloud whatever ANTHROPIC_BASE_URL says.
    ...Object.fromEntries(FOREIGN_PROVIDER_KEYS.map((key) => [key, ENV_OFF])),
  };
}

export function slotEnv(main: string, fast: string): Env {
  const env: Env = {};
  for (const slot of MAIN_SLOTS) env[slot] = main;
  env[FAST_SLOT] = fast;
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

export function contextTokens(catalog: Model[], ids: string[]): string | undefined {
  const windows = ids
    .map((id) => catalog.find((model) => model.id === id)?.context_window)
    .filter((window): window is number => typeof window === "number" && window > 0);
  return windows.length > 0 ? String(Math.min(CONTEXT_CAP_TOKENS, ...windows)) : undefined;
}

export function buildClaudeSettings({
  apiKey,
  baseUrl,
  main,
  catalog,
}: {
  apiKey: string;
  baseUrl: string;
  main: string;
  catalog: Model[];
}): Record<string, unknown> {
  const fast = fastModel(catalog, main);
  // ANTHROPIC_MODEL too: a shell export of it would beat the `model` below.
  const env: Env = {
    ...gatewayEnv(apiKey, baseUrl),
    ...slotEnv(main, fast),
    [ENV_MODEL_KEY]: main,
  };
  const tokens = contextTokens(catalog, [main, fast]);
  if (tokens) env[CONTEXT_KEY] = tokens;
  return {
    model: main,
    env,
    permissions: { deny: DENIED_TOOLS },
    modelPicker: buildModelPicker(catalog),
  };
}

export const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value !== "";
