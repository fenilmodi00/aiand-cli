import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { publicJson } from "../../api/client.js";
import type { Model } from "../../api/models.js";
import { CliError } from "../../cli/errors.js";
import { err } from "../../cli/output.js";
import { configDir, trimSlash, writeFileAtomic } from "../../config.js";
import { PRIVATE_FILE_MODE } from "../../fsutil.js";
import { CATALOG_TTL_MS } from "../catalog.js";
import { asObject } from "../managed-file.js";

// The model map OpenCode's `provider.aiand.models` holds: fetched from the
// gateway's /v1/api.json (and cut down to what is safe) for `on`, derived
// from the catalog for session launches.

/**
 * One model entry inside `provider.aiand.models`: taken verbatim from
 * `/v1/api.json` for `on` (it carries a real `limit.output`), derived from the
 * Model[] catalog for session launches.
 */
export type OpencodeModelEntry = Record<string, unknown>;

/** Last-good `/v1/api.json` model map, so `on` survives an unreachable gateway. */
const OPENCODE_API_CACHE_FILE = "opencode-api.json";

type ApiJsonCache = {
  fetchedAt: number;
  baseUrl: string;
  models: Record<string, OpencodeModelEntry>;
};

/**
 * OpenCode substitutes `{env:NAME}` and `{file:path}` anywhere in its config
 * text, so a served string carrying one would read the user's environment or
 * files into a request. No model field needs either.
 */
const SUBSTITUTION = /\{(?:env|file):/;

const cleanString = (value: unknown): string | undefined =>
  typeof value === "string" && !SUBSTITUTION.test(value) ? value : undefined;

/** The numeric fields of `value` named in `keys`, or undefined when none are. */
function numberFields(value: unknown, keys: readonly string[]): Record<string, number> | undefined {
  const source = asObject(value);
  if (!source) return undefined;
  const out: Record<string, number> = {};
  for (const key of keys) {
    const field = source[key];
    if (typeof field === "number" && Number.isFinite(field)) out[key] = field;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const cleanStrings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => cleanString(item) !== undefined)
    ? (value as string[])
    : undefined;

const MODEL_STRING_FIELDS = ["id", "name", "family", "release_date", "last_updated", "knowledge"];
const MODEL_BOOLEAN_FIELDS = [
  "attachment",
  "reasoning",
  "temperature",
  "tool_call",
  "open_weights",
  "experimental",
];
const COST_FIELDS = ["input", "output", "cache_read", "cache_write"];
const MODEL_STATUSES = new Set(["alpha", "beta", "deprecated"]);

/**
 * One served model entry, cut down to the descriptive fields of OpenCode's
 * model schema (models.dev's shape) plus the `reasoning_options` ai&
 * publishes. Everything that changes what OpenCode loads or sends (`npm`,
 * `provider`, `options`, `headers`, `variants`, `api`, `env`) is dropped, as
 * is any field of the wrong type or carrying a substitution.
 */
function cleanModelEntry(raw: unknown): OpencodeModelEntry | undefined {
  const source = asObject(raw);
  if (!source) return undefined;
  const entry: OpencodeModelEntry = {};
  for (const key of MODEL_STRING_FIELDS) {
    const value = cleanString(source[key]);
    if (value !== undefined) entry[key] = value;
  }
  for (const key of MODEL_BOOLEAN_FIELDS) {
    if (typeof source[key] === "boolean") entry[key] = source[key];
  }
  if (typeof source.status === "string" && MODEL_STATUSES.has(source.status)) {
    entry.status = source.status;
  }
  const cost = numberFields(source.cost, COST_FIELDS);
  const over = numberFields(asObject(source.cost)?.context_over_200k, COST_FIELDS);
  if (cost || over) entry.cost = { ...cost, ...(over ? { context_over_200k: over } : {}) };
  const limit = numberFields(source.limit, ["context", "input", "output"]);
  if (limit) entry.limit = limit;
  const modalities = asObject(source.modalities);
  const input = cleanStrings(modalities?.input);
  const output = cleanStrings(modalities?.output);
  if (input || output) {
    entry.modalities = { ...(input ? { input } : {}), ...(output ? { output } : {}) };
  }
  const interleaved = source.interleaved;
  if (interleaved === true || interleaved === false) {
    entry.interleaved = interleaved;
  } else if (cleanString(asObject(interleaved)?.field) !== undefined) {
    entry.interleaved = { field: asObject(interleaved)?.field };
  }
  if (Array.isArray(source.reasoning_options)) {
    const options = source.reasoning_options.flatMap((option: unknown) => {
      const type = cleanString(asObject(option)?.type);
      const values = cleanStrings(asObject(option)?.values);
      return type !== undefined && values !== undefined ? [{ type, values: [...values] }] : [];
    });
    if (options.length > 0) entry.reasoning_options = options;
  }
  return entry;
}

/** A served model map with every entry cleaned and unsafe ids dropped. */
function cleanModelMap(models: Record<string, unknown>): Record<string, OpencodeModelEntry> {
  const out: Record<string, OpencodeModelEntry> = {};
  for (const [id, raw] of Object.entries(models)) {
    if (cleanString(id) === undefined || Object.hasOwn(Object.prototype, id)) continue;
    const entry = cleanModelEntry(raw);
    if (entry) out[id] = entry;
  }
  return out;
}

/**
 * Live api.json carries the canonical OpenCode model map (with real
 * limit.output). Its descriptive fields are taken as served, so the picker
 * matches the gateway; nothing else is (see cleanModelEntry). The
 * fetched map is cached per base URL; a failed fetch falls back to the last
 * good map instead of failing `on` outright (offline machine, fixture env).
 * A response without a models map, or with an empty one, counts as a failed
 * fetch, so it can never replace the last good map with an empty one.
 */
export async function getApiModels(baseUrl: string): Promise<Record<string, OpencodeModelEntry>> {
  const cachePath = join(configDir(), OPENCODE_API_CACHE_FILE);
  const trimmedBase = trimSlash(baseUrl);
  try {
    const api = await publicJson<{ opencode?: { models?: unknown } }>(`${trimmedBase}/v1/api.json`);
    const served = asObject(api?.opencode?.models);
    const models = served ? cleanModelMap(served) : {};
    if (Object.keys(models).length === 0) {
      throw new CliError(`${trimmedBase}/v1/api.json carried no OpenCode model map.`);
    }
    await writeFileAtomic(
      cachePath,
      `${JSON.stringify({ fetchedAt: Date.now(), baseUrl: trimmedBase, models }, null, 2)}\n`,
      { mode: PRIVATE_FILE_MODE },
    );
    return models;
  } catch (error) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as Partial<ApiJsonCache>;
      if (
        cached?.baseUrl === trimmedBase &&
        cached.models &&
        typeof cached.models === "object" &&
        typeof cached.fetchedAt === "number" &&
        Date.now() - cached.fetchedAt < CATALOG_TTL_MS
      ) {
        err("OpenCode model map unreachable; using the last cached map.");
        return cleanModelMap(cached.models);
      }
    } catch {
      // No usable cache — fall through to the original fetch error.
    }
    throw error;
  }
}

/**
 * limit.output mirrors context_window rather than the catalog's
 * max_output_tokens. Catalog prices are per 1M tokens, OpenCode's unit.
 * `reasoning_options` is the key `/v1/api.json` already publishes. Session
 * launches do not fetch that map, so the same key carries the catalog levels.
 */
function modelEntryFromCatalog(model: Model): OpencodeModelEntry {
  const caps = model.capabilities;
  const input: string[] = ["text"];
  if (caps.includes("vision")) input.push("image");
  if (caps.includes("video")) input.push("video");
  if (caps.includes("document")) input.push("pdf");
  const price = (value: string | null): number => Number.parseFloat(value ?? "0");
  const levels = model.reasoning_efforts ?? [];
  return {
    name: model.name,
    attachment: caps.includes("vision") || caps.includes("attachment"),
    reasoning: levels.length > 0,
    ...(levels.length > 0 ? { reasoning_options: [{ type: "effort", values: [...levels] }] } : {}),
    temperature: true,
    tool_call: caps.includes("tools") || caps.includes("tool_calling"),
    limit: { context: model.context_window, output: model.context_window },
    modalities: { input, output: ["text"] },
    cost: {
      input: price(model.input_per_1m),
      output: price(model.output_per_1m),
      cache_read: price(model.cached_input_per_1m),
    },
  };
}

/**
 * The session launch's model map, held to the same field allowlist as the
 * one `on` writes: the catalog is served data too, and OpenCode substitutes
 * `{file:}` and `{env:}` anywhere in its config text. A model whose id carries
 * one is left out, and so is any string field that does.
 */
export function modelsFromCatalog(catalog: Model[]): Record<string, OpencodeModelEntry> {
  const out: Record<string, OpencodeModelEntry> = {};
  for (const model of catalog) {
    if (cleanString(model.id) === undefined || Object.hasOwn(Object.prototype, model.id)) continue;
    const entry = cleanModelEntry(modelEntryFromCatalog(model));
    if (entry) out[model.id] = entry;
  }
  return out;
}
