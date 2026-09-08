import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../cli/errors.js";
import { configDir, writeFileAtomic } from "../config.js";
import { listModels, type Model } from "../api/models.js";

const CATALOG_CACHE_FILE = "model-catalog.json";
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Whether a catalog model accepts image input. A model is vision-capable when
 * its capability list contains "vision"; everything else is text-only.
 */
export function visionLabel(model: Model): "vision" | "text-only" {
  return model.capabilities.includes("vision") ? "vision" : "text-only";
}

/**
 * One stderr warning line naming the text-only models just wired. Empty list →
 * empty string (callers skip the line entirely).
 */
export function formatTextOnlyWarning(ids: string[]): string {
  if (ids.length === 0) return "";
  return `Text-only: ${ids.join(", ")} · Avoid images; recover with /rewind.`;
}

// Curated fallback order, filtered through the live catalog so retired ids
// are never written into an agent's config.
const PREFERRED_DEFAULTS = [
  "zai-org/glm-5.3",
  "moonshotai/kimi-k3",
  "qwen/qwen3.8-27b",
  "google/gemma-4-31b-it",
];

type CatalogCache = {
  fetchedAt: number;
  baseUrl: string;
  models: Model[];
};

function catalogCachePath(): string {
  return join(configDir(), CATALOG_CACHE_FILE);
}

async function readCache(): Promise<CatalogCache | null> {
  try {
    const raw = await readFile(catalogCachePath(), "utf8");
    return JSON.parse(raw) as CatalogCache;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isFresh(cache: CatalogCache, baseUrl: string): boolean {
  return (
    cache.baseUrl === baseUrl && Date.now() - cache.fetchedAt < CATALOG_TTL_MS
  );
}

/**
 * The live /v1/models list, cached for 6h at <configDir>/model-catalog.json.
 * A fresh cache short-circuits the network entirely; a failed fetch falls
 * back to a stale cache before giving up.
 */
export async function getCatalog(baseUrl: string): Promise<Model[]> {
  const cached = await readCache();
  if (cached && isFresh(cached, baseUrl)) return cached.models;

  try {
    const models = await listModels(null, baseUrl);
    const next: CatalogCache = { fetchedAt: Date.now(), baseUrl, models };
    await writeFileAtomic(catalogCachePath(), `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    return models;
  } catch (error) {
    if (cached) return cached.models;
    throw new CliError("Could not reach the model catalog.", {
      hint: "Check your network and retry.",
      // Preserve the underlying detail (401, rate limit, DNS) for the CLI
      // error chain while keeping the catalog-specific message.
      exitCode: error instanceof CliError ? error.exitCode : 1,
    });
  }
}

/**
 * Refuse a model id that is not in the live catalog. `flag` is the CLI flag
 * named in the error (`--model`, `--opus`, …). Callers that accept the
 * literal `"native"` escape hatch must skip this check themselves.
 */
export function validateCatalogModel(
  catalog: Model[],
  id: string,
  flag = "--model"
): void {
  if (catalog.some((entry) => entry.id === id)) return;
  throw new CliError(`${flag} "${id}" is not in the catalog.`, {
    hint: `Valid ids: ${catalog.map((entry) => entry.id).join(", ")}`,
  });
}

/**
 * Pick the model written into agent configs: an explicit profile model wins
 * when it still exists in the catalog, then the curated default order, then
 * whatever the gateway lists first.
 */
export function resolveDefault(models: Model[], profileModel?: string): string {
  if (profileModel && models.some((model) => model.id === profileModel)) {
    return profileModel;
  }
  for (const candidate of PREFERRED_DEFAULTS) {
    if (models.some((model) => model.id === candidate)) return candidate;
  }
  const first = models[0];
  if (!first) {
    throw new CliError("The model catalog is empty.", {
      hint: "Check your network and retry.",
    });
  }
  return first.id;
}

/**
 * Claude Code reads a trailing `[1m]` tag on a model id to size its context
 * window; without it, the binary assumes 200K and auto-compacts, starving
 * subagents on 1M-context models. Return `${modelId}[1m]` when the catalog
 * entry exists and its context window is at least one million tokens,
 * otherwise the id unchanged (unknown ids pass through untouched).
 */
export function withContextTag(modelId: string, catalog: Model[]): string {
  const entry = catalog.find((model) => model.id === modelId);
  return entry && entry.context_window >= 1_000_000 ? `${modelId}[1m]` : modelId;
}

function toolCapable(model: Model): boolean {
  if (!Array.isArray(model.capabilities) || model.capabilities.length === 0) {
    // No capability metadata: assume the model can call tools.
    return true;
  }
  // The gateway publishes "tool_calling"; older catalogs used "tools" /
  // "tool-calling". Match every spelling so a catalog refresh never empties
  // the slot resolution.
  return model.capabilities.some((capability) =>
    ["tools", "tool-calling", "tool_calling"].includes(capability)
  );
}

function price(value: string | null): number {
  return Number.parseFloat(value ?? "0");
}

/**
 * Claude Code's three model slots resolved from the live catalog: opus takes
 * the priciest tool-capable output, sonnet mirrors the default, and haiku
 * takes the cheapest tool-capable input.
 */
export function resolveSlots(models: Model[]): Record<string, string> {
  const capable = models.filter(toolCapable);
  if (capable.length === 0) return {};

  const opus = capable.reduce((best, model) =>
    price(model.output_per_1m) > price(best.output_per_1m) ? model : best
  );
  const haiku = capable.reduce((best, model) =>
    price(model.input_per_1m) < price(best.input_per_1m) ? model : best
  );
  const sonnet = resolveDefault(models);

  return { opus: opus.id, sonnet, haiku: haiku.id };
}
