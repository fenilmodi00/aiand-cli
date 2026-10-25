import { CliError } from "../cli/errors.js";

/**
 * The vendor list-price snapshot (feature catalog B8, ticket #81).
 *
 * Dual-source discipline (ccusage's): the snapshot is a data file whose
 * entries each cite where the price came from; the CLI never invents one.
 * The bundled snapshot below starts EMPTY of model prices on purpose — the
 * never-guess policy (spec H1) means an entry lands only through a reviewed
 * change citing a vendor pricing page. Until then, models show as
 * `unpriced` (never $0.00) unless the user supplies prices via
 * `aiand config set prices.<model>.input|.output|.cacheRead` or
 * `aiand usage --prices-file <path>` with an updated snapshot.
 *
 * Snapshot schema (format 1):
 *   { format: 1, name, date, sources: [{name,url}],
 *     aliases: [{alias, vendorId, source}],
 *     models: { [vendorId]: { input, output, cacheRead|null, source,
 *                             tiers?: [{minInput, maxInput, input, output, cacheRead}] } } }
 *
 * All rates are USD per 1M tokens. `cacheRead: null` means "no vendor cache
 * discount published" and the input rate applies — documented, not guessed.
 * `tiers` prices by the request's input-token count against `[minInput,
 * maxInput)` bounds; ranges must not overlap (validated on load) so a stored
 * request maps to at most one tier — a request outside every range makes the
 * model row `unpriced` with its reason, never a silent tier pick.
 */

type PriceTier = {
  minInput: number;
  /** Exclusive upper bound; null = unbounded. */
  maxInput: number | null;
  input: number;
  output: number;
  cacheRead: number | null;
};

export type PriceEntry = {
  input: number;
  output: number;
  cacheRead: number | null;
  source: string;
  tiers?: readonly PriceTier[];
};

type PriceAlias = { alias: string; vendorId: string; source: string };

type SnapshotSource = { name: string; url: string };

export type PriceSnapshot = {
  format: 1;
  name: string;
  /** Snapshot date, `YYYY-MM-DD` — always printed in the output header. */
  date: string;
  sources: readonly SnapshotSource[];
  aliases: readonly PriceAlias[];
  models: Record<string, PriceEntry>;
};

/** The gateway's org-prefixed ids and the vendor ids they map to. */
const BUNDLED_ALIASES: readonly PriceAlias[] = [
  {
    alias: "zai-org/glm-5.3",
    vendorId: "glm-5.3",
    source: "Z.ai publishes GLM ids without the gateway's zai-org/ org prefix (docs.z.ai)",
  },
  {
    alias: "moonshotai/kimi-k3",
    vendorId: "kimi-k3",
    source: "Moonshot platform ids (platform.moonshot.ai) carry no moonshotai/ prefix",
  },
  {
    alias: "qwen/qwen3.8-27b",
    vendorId: "qwen3.8-27b",
    source: "Alibaba Model Studio ids carry no qwen/ org prefix",
  },
  {
    alias: "google/gemma-4-31b-it",
    vendorId: "gemma-4-31b-it",
    source: "Google AI Studio ids carry no google/ org prefix",
  },
];

const BUNDLED_SOURCES: readonly SnapshotSource[] = [
  { name: "LiteLLM model prices", url: "https://models.litellm.ai" },
  { name: "models.dev", url: "https://models.dev" },
];

/**
 * The bundled snapshot: schema-complete, price-empty. See the module comment
 * for why empty is the honest default.
 */
export const BUNDLED_SNAPSHOT: PriceSnapshot = {
  format: 1,
  name: "bundled",
  date: "2026-10-25",
  sources: BUNDLED_SOURCES,
  aliases: BUNDLED_ALIASES,
  models: {},
};

// ---------------------------------------------------------------------------
// Parsing + validation (external --prices-file snapshots)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fail(label: string, detail: string): never {
  throw new CliError(`Invalid prices snapshot (${label}): ${detail}`, {
    hint: "Check the snapshot schema in the ai& documentation, or drop --prices-file.",
  });
}

function parseTiers(modelId: string, raw: unknown): PriceTier[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(modelId, "tiers must be an array");
  const tiers: PriceTier[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      fail(modelId, "each tier must be an object");
    }
    const tier = item as Record<string, unknown>;
    if (!isFiniteNumber(tier.minInput) || tier.minInput < 0) {
      fail(modelId, "tier.minInput must be a non-negative number");
    }
    if (tier.maxInput !== null && !isFiniteNumber(tier.maxInput)) {
      fail(modelId, "tier.maxInput must be a number or null");
    }
    if (!isFiniteNumber(tier.input) || !isFiniteNumber(tier.output)) {
      fail(modelId, "tier input/output prices must be numbers");
    }
    if (tier.cacheRead !== null && !isFiniteNumber(tier.cacheRead)) {
      fail(modelId, "tier.cacheRead must be a number or null");
    }
    tiers.push({
      minInput: tier.minInput,
      maxInput: tier.maxInput ?? null,
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cacheRead ?? null,
    });
  }
  // Non-overlapping ranges are what make per-request tier selection exact
  // instead of a guess: two tiers covering one request would mean picking.
  const bounds = tiers.map((tier) => [tier.minInput, tier.maxInput] as const);
  for (let i = 0; i < bounds.length; i++) {
    for (let j = i + 1; j < bounds.length; j++) {
      const [aMin, aMax] = bounds[i]!;
      const [bMin, bMax] = bounds[j]!;
      const overlap =
        aMin < (bMax ?? Number.POSITIVE_INFINITY) && bMin < (aMax ?? Number.POSITIVE_INFINITY);
      if (overlap) fail(modelId, "tier ranges must not overlap");
    }
  }
  return tiers;
}

function parseModels(label: string, raw: unknown): Record<string, PriceEntry> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) fail(label, "models must be an object");
  const models: Record<string, PriceEntry> = {};
  for (const [vendorId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(label, `models.${vendorId} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    if (!isFiniteNumber(entry.input) || !isFiniteNumber(entry.output)) {
      fail(label, `models.${vendorId}.input and .output must be numbers (USD per 1M tokens)`);
    }
    if (
      entry.cacheRead !== null &&
      entry.cacheRead !== undefined &&
      !isFiniteNumber(entry.cacheRead)
    ) {
      fail(label, `models.${vendorId}.cacheRead must be a number or null`);
    }
    const tiers = parseTiers(vendorId, entry.tiers);
    models[vendorId] = {
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead === undefined ? null : (entry.cacheRead as number | null),
      source:
        typeof entry.source === "string" && entry.source.length > 0
          ? entry.source
          : `unattributed entry in ${label}`,
      ...(tiers.length > 0 ? { tiers } : {}),
    };
  }
  return models;
}

function parseAliases(label: string, raw: unknown): PriceAlias[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(label, "aliases must be an array");
  const aliases: PriceAlias[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      fail(label, "each alias must be an object");
    }
    const alias = item as Record<string, unknown>;
    if (typeof alias.alias !== "string" || typeof alias.vendorId !== "string") {
      fail(label, "alias entries need alias + vendorId strings");
    }
    aliases.push({
      alias: alias.alias,
      vendorId: alias.vendorId,
      source: typeof alias.source === "string" ? alias.source : "unattributed alias",
    });
  }
  return aliases;
}

/**
 * Parse + validate a snapshot document. `name` labels it in output metadata
 * (the file's basename for `--prices-file`).
 */
export function parseSnapshot(document: unknown, name: string): PriceSnapshot {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    fail(name, "not a JSON object");
  }
  const raw = document as Record<string, unknown>;
  if (raw.format !== 1) fail(name, "format must be 1");
  if (typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) {
    fail(name, "date must be YYYY-MM-DD");
  }
  return {
    format: 1,
    name,
    date: raw.date,
    sources: parseSources(name, raw.sources),
    aliases: parseAliases(name, raw.aliases),
    models: parseModels(name, raw.models),
  };
}

function parseSources(label: string, raw: unknown): SnapshotSource[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(label, "sources must be an array");
  return raw.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      fail(label, "each source must be an object");
    }
    const source = item as Record<string, unknown>;
    if (typeof source.name !== "string" || typeof source.url !== "string") {
      fail(label, "source entries need name + url strings");
    }
    return { name: source.name, url: source.url };
  });
}

/** The gateway id a vendor price lookup starts from, after the alias map. */
export function resolveAlias(snapshot: PriceSnapshot, model: string): string {
  for (const alias of snapshot.aliases) {
    if (alias.alias === model) return alias.vendorId;
  }
  return model;
}
