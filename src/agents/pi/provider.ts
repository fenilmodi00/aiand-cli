import type { Model } from "../../api/models.js";
import { DEFAULT_BASE_URL, trimSlash } from "../../config.js";

/** The gateway base URL Pi's provider block speaks to. */
export const piBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

/** Pi `thinkingLevelMap` keys. An omitted key is not hidden, so unsupported levels are null. */
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function thinkingLevelMap(levels: readonly string[]): Record<string, string | null> {
  const published = new Set(levels);
  return Object.fromEntries(
    PI_THINKING_LEVELS.map((level) => [level, published.has(level) ? level : null]),
  );
}

/**
 * One model entry in Pi's `providers.aiand.models` array, rendered from the
 * live catalog. Prices are per-1M floats (the catalog's unit); Pi's cost
 * unit is per Mtok, the same order opencode writes, so the numbers pass
 * through. `contextWindow` is `context_window`. `maxTokens` is
 * `max_output_tokens`: Pi treats it as the output cap and sends no more
 * than the smaller of that cap and the window minus its prompt estimate
 * and a 4096-token margin. A null cap omits `maxTokens`, since Pi's schema
 * rejects null and drops the whole provider; Pi then defaults to 16384.
 */
export function piModelEntry(model: Model): Record<string, unknown> {
  const input: string[] = ["text"];
  if (model.capabilities.includes("vision")) input.push("image");
  const price = (value: string | null): number => Number.parseFloat(value ?? "0");
  const levels = model.reasoning_efforts ?? [];
  return {
    id: model.id,
    name: model.name,
    reasoning: levels.length > 0,
    ...(levels.length > 0
      ? {
          thinkingLevelMap: thinkingLevelMap(levels),
          compat: { supportsReasoningEffort: true },
        }
      : {}),
    input,
    contextWindow: model.context_window,
    ...(model.max_output_tokens != null ? { maxTokens: model.max_output_tokens } : {}),
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
 * Pi's default thinking level is medium. An unsupported level moves up to
 * the next published one, so an omitted level is not the engine default.
 * The OpenAI "developer" role Pi sends for reasoning models is accepted by
 * the gateway.
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
    models: catalog.map(piModelEntry),
  };
}
