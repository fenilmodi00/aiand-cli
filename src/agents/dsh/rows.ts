/**
 * The dsh patch rows aiand owns: the constants that name them and the three
 * builders that render them. One builder module so `on`, `off` and the
 * launcher's overlay can never drift apart, and so scripts/dsh-smoke.mjs can
 * seed a real dsh home from the same code the CLI ships.
 */
import type { Model } from "../../api/models.js";
import { credentialRefSet, renderScalar } from "./patch.js";

/** The provider route aiand declares in dsh's pi-ai adapter. Lowercase
 * hyphenated: dsh refuses credential records outside that grammar. */
export const DSH_ROUTE = "aiand";

/** Ownership marker. It rides inside our route's profile because dsh's config
 * schema passes unknown profile keys through (verified against a real boot),
 * and it lives in the home-level patch layer, which dsh itself never
 * rewrites — the profile layer is where dsh's own settings UI persists. */
export const DSH_MARKER = "x-aiand: true";

/** Banner over every row we own, stripped with the marker when a row the
 * user repointed is handed back to them. */
export const DSH_BANNER = "# Managed by aiand: `aiand dsh off` removes this row.";

/** Credential-ref name in `$DSH_HOME/.credentials.yaml`: the secret stays out
 * of the patch layer, and dsh resolves the ref per request (inherited
 * environment first, then this file, then the `.env` layers). */
export const DSH_KEY_REF = "AIAND_DSH_API_KEY";

/** Plugin ids and names of the two rows aiand owns in the patch layer. */
export const LLM_ROW_ID = "llm-pi-ai";
export const DEFAULT_ROW_ID = "agent-default-model";
const LLM_ROW_NAME = "@deepseek-ai/dsh-llm-pi-ai";
const DEFAULT_ROW_NAME = "@deepseek-ai/dsh-agent-default-model";

/** One catalog model as a dsh `models:` block entry. The output cap mirrors
 * the context window (the gateway enforces the real cap; the catalog carries
 * no output field) — the policy opencode already follows.
 *
 * `reasoningEfforts` is the map dsh turns into pi-ai's `thinkingLevelMap`.
 * A level left out is pinned unsupported, so the client cannot send one the
 * model does not publish. An omitted selection still runs at the engine
 * default, which is max on GLM-5.3. */
function dshModelLines(model: Model): string[] {
  const input = model.capabilities.includes("vision") ? "[text, image]" : "[text]";
  const levels = model.reasoning_efforts ?? [];
  return [
    `          - id: ${renderScalar(model.id)}`,
    `            name: ${renderScalar(model.name)}`,
    `            contextWindow: ${model.context_window}`,
    `            maxTokens: ${model.context_window}`,
    `            input: ${input}`,
    ...(levels.length === 0
      ? []
      : [
          "            reasoningEfforts:",
          ...levels.map((level) => `              ${level}: ${renderScalar(level)}`),
        ]),
  ];
}

/**
 * The llm-pi-ai row routing every catalog model through the gateway. One
 * builder for enable() and sessionLaunch() so the two cannot drift.
 *
 * The route states `supportsReasoningEffort: true` only when a model
 * publishes levels. pi-ai guesses the dialect from the base URL, and a
 * private gateway's URL says nothing. `false` would drop the parameter and
 * leave every reasoning model on the engine default.
 * @public read from dist/ by scripts/dsh-smoke.mjs */
export function buildDshLlmRow(baseUrl: string, catalog: Model[]): string {
  const acceptsEffort = catalog.some((model) => (model.reasoning_efforts?.length ?? 0) > 0);
  return [
    DSH_BANNER,
    `- id: ${LLM_ROW_ID}`,
    `  name: '${LLM_ROW_NAME}'`,
    "  config:",
    "    providers:",
    `      ${DSH_ROUTE}:`,
    `        ${DSH_MARKER}`,
    "        displayName: aiand",
    "        api: openai-completions",
    `        baseURL: ${renderScalar(baseUrl)}`,
    `        apiKeyEnv: ${DSH_KEY_REF}`,
    ...(acceptsEffort ? ["        compat:", "          supportsReasoningEffort: true"] : []),
    "        models:",
    ...catalog.flatMap(dshModelLines),
  ].join("\n");
}

/** The default-model row: the route/model fresh sessions start on. dsh's
 * schema requires both fields. A marked row is aiand's; an unmarked one is
 * the hand-back shape `off` writes when the user had a default before.
 * @public read from dist/ by scripts/dsh-smoke.mjs */
export function buildDshDefaultRow(provider: string, model: string, marked: boolean): string {
  return [
    ...(marked ? [DSH_BANNER] : []),
    `- id: ${DEFAULT_ROW_ID}`,
    `  name: '${DEFAULT_ROW_NAME}'`,
    "  config:",
    ...(marked ? [`    ${DSH_MARKER}`] : []),
    `    provider: ${renderScalar(provider)}`,
    `    model: ${renderScalar(model)}`,
  ].join("\n");
}

/** The credential file's text with our ref set.
 * @public read from dist/ by scripts/dsh-smoke.mjs */
export function buildDshCredentials(text: string, apiKey: string): string {
  return credentialRefSet(text, DSH_KEY_REF, apiKey);
}
