import { DEFAULT_BASE_URL, trimSlash } from "../../config.js";
import { asObject } from "../managed-file.js";
import type { YamlValue } from "./yaml.js";
import { readYamlMapping, yamlSet } from "./yaml.js";

/** The provider id in models.yml; omp already bundles an `aiand` provider. */
export const OMP_PROVIDER_ID = "aiand";

/**
 * Ownership marker stamped inside the models.yml provider block. omp has no
 * auth.json (credentials live in agent.db or the provider block), and its
 * provider schema tolerates unknown keys — the block is the right carrier.
 */
export const OMP_MARKER_KEY = "managedBy";
export const OMP_MARKER = "aiand";

/** The gateway base URL omp's provider block speaks to. */
export const ompBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

/**
 * The one builder for the override-only aiand provider block omp reads:
 * baseUrl + apiKey + marker. omp reads effort levels from the catalog
 * bundled in its binary. Those aiand rows are low, medium, and high,
 * with default medium, and they lag the live catalog. The override
 * only redirects route and key.
 */
export function buildOmpProviderBlock({ baseUrl, apiKey }: { baseUrl?: string; apiKey: string }): {
  [key: string]: YamlValue;
} {
  return {
    baseUrl: ompBaseUrl(baseUrl),
    apiKey,
    [OMP_MARKER_KEY]: OMP_MARKER,
  };
}

/**
 * Who owns the `aiand` provider block in a models.yml text. `unknown`
 * covers everything `off` must refuse: a missing block, a foreign one,
 * and a file that does not parse at all — the caller reports untouched
 * and a mid-edit file never throws.
 */
export type OmpProviderOwnership =
  | { kind: "ours"; block: Record<string, unknown> }
  | { kind: "unknown" };

export function readOmpProviderBlock(raw: string): OmpProviderOwnership {
  let models: unknown;
  try {
    models = raw.trim() ? readYamlMapping(raw) : {};
  } catch {
    return { kind: "unknown" };
  }
  const block = asObject((models as Record<string, unknown>).providers);
  const provider = block === undefined ? undefined : asObject(block[OMP_PROVIDER_ID]);
  if (provider?.[OMP_MARKER_KEY] !== OMP_MARKER) return { kind: "unknown" };
  return { kind: "ours", block: provider };
}

export function editOmpProviderBlock(raw: string, key: string, value: string): string {
  return yamlSet(raw, ["providers", OMP_PROVIDER_ID, key], value);
}
