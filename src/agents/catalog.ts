import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../cli/errors.js";
import { configDir, writeFileAtomic } from "../config.js";
import { listModels, type Model } from "../api/models.js";

const CATALOG_CACHE_FILE = "model-catalog.json";
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Whether a catalog model accepts image input. A model is vision-capable when
 * its capability list contains "vision"; everything else is text-only.
 */
export function visionLabel(model: Model): "vision" | "text-only" {
  return model.capabilities.includes("vision") ? "vision" : "text-only";
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

function parseCache(value: unknown): CatalogCache | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.fetchedAt !== "number" || !Number.isFinite(record.fetchedAt)) return null;
  if (typeof record.baseUrl !== "string" || record.baseUrl.length === 0) return null;
  if (!Array.isArray(record.models)) return null;
  const models: Model[] = [];
  for (const entry of record.models) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const model = entry as Record<string, unknown>;
    if (typeof model.id !== "string" || model.id.length === 0) return null;
    if (!Array.isArray(model.capabilities)) return null;
    if (!model.capabilities.every((cap) => typeof cap === "string")) return null;
    models.push(entry as Model);
  }
  return { fetchedAt: record.fetchedAt, baseUrl: record.baseUrl, models };
}

async function readCache(): Promise<CatalogCache | null> {
  try {
    const raw = await readFile(catalogCachePath(), "utf8");
    return parseCache(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
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
 * A fresh cache short-circuits the network entirely; a failed fetch does not
 * serve an expired cache.
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
    if (error instanceof CliError) throw error;
    throw new CliError("Could not reach the model catalog.", {
      hint: "Check your network and retry.",
      exitCode: 1,
    });
  }
}

/**
 * Refuse a model id that is not in the live catalog. `flag` is the CLI flag
 * named in the error (`--model`). Callers that accept the
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
 * Effective model for one-shot inference: an explicit --model flag wins
 * as-is, otherwise resolve through the live catalog (profile model when
 * still listed, else the curated default).
 */
export async function resolveEffectiveModel(
  flag: string | undefined,
  baseUrl: string,
  profileModel?: string
): Promise<string> {
  if (flag !== undefined) return flag;
  return resolveDefault(await getCatalog(baseUrl), profileModel);
}


