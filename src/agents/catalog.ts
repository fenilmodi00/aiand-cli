import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listModels, type Model } from "../api/models.js";
import { CliError, EXIT } from "../cli/errors.js";
import { configDir, writeFileAtomic } from "../config.js";
import { PRIVATE_FILE_MODE } from "../fsutil.js";
import { HOUR_MS } from "../time.js";

const CATALOG_CACHE_FILE = "model-catalog.json";
export const CATALOG_TTL_MS = 6 * HOUR_MS;

/** Vision-capable means the capability list contains "vision". */
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
  return cache.baseUrl === baseUrl && Date.now() - cache.fetchedAt < CATALOG_TTL_MS;
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
      mode: PRIVATE_FILE_MODE,
    });
    return models;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Could not reach the model catalog.", {
      hint: "Check your network and retry.",
      exitCode: EXIT.ERROR,
    });
  }
}

/**
 * Refuse a model id that is not in the live catalog. `flag` is the CLI flag
 * named in the error (`--model`). Callers that accept the
 * literal `"native"` escape hatch must skip this check themselves.
 */
export function validateCatalogModel(catalog: Model[], id: string, flag = "--model"): void {
  if (catalog.some((entry) => entry.id === id)) return;
  throw new CliError(`${flag} "${id}" is not in the catalog.`, {
    hint: `Valid ids: ${catalog.map((entry) => entry.id).join(", ")}`,
  });
}

/** Whether `id` names a catalog model. Adapters keep a user's model only
 * while the gateway still serves it; this is that test. */
export const inCatalog = (catalog: Model[], id: unknown): id is string =>
  typeof id === "string" && catalog.some((model) => model.id === id);

/**
 * Pick the model written into agent configs: an explicit profile model wins
 * when it still exists in the catalog, then the curated default order, then
 * whatever the gateway lists first.
 */
/** `preferred` is an adapter's own order, tried ahead of the global one. */
export function resolveDefault(
  models: readonly Pick<Model, "id">[],
  profileModel?: string,
  preferred: readonly string[] = [],
): string {
  if (profileModel && models.some((model) => model.id === profileModel)) {
    return profileModel;
  }
  for (const candidate of [...preferred, ...PREFERRED_DEFAULTS]) {
    if (models.some((model) => model.id === candidate)) return candidate;
  }
  const first = models[0];
  if (!first) {
    throw new CliError("The model catalog is empty.", {
      hint: "The gateway listed no models; retry later or check the base URL.",
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
  profileModel?: string,
): Promise<string> {
  if (flag !== undefined) return flag;
  return resolveDefault(await getCatalog(baseUrl), profileModel);
}
