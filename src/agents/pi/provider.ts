import type { Model } from "../../api/models.js";
import { DEFAULT_BASE_URL, trimSlash } from "../../config.js";

/** The gateway base URL Pi's provider block speaks to. */
export const piBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

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
