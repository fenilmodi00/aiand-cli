import type { Model } from "../../api/models.js";
import { commandName, DEFAULT_BASE_URL, trimSlash } from "../../config.js";

// Read at module load: the name is written into providers.json once, per
// process, and must stay consistent across build/read/delete.
/** Provider name in providers.json and the qualifier in every model selection. */
export const COPILOT_PROVIDER_NAME = commandName();
/** Model selections the CLI accepts for a BYOK provider are `aiand/<id>`. */
export const COPILOT_SELECTION_PREFIX = `${COPILOT_PROVIDER_NAME}/`;

/** The gateway base URL the provider row speaks to. */
export const copilotBaseUrl = (baseUrl?: string): string =>
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
    // Attribution: the gateway logs this per request to identify the agent.
    // Documented providers[].headers field. Not an ownership marker — the
    // row shape plus the recorded baseUrl stay the proof — but any CLI
    // rewrite of the row rebuilds it via this builder, so the pair lives
    // as long as the row `off` strips.
    headers: { "x-aiand-agent": "copilot" },
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
