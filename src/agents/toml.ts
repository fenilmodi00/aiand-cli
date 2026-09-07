/**
 * Surgical edits to Codex config.toml — only touches aiand-owned keys/tables
 * so array-of-tables and other non-flat TOML is preserved. String surgery by
 * design: no TOML parser dependency, and unknown tables survive untouched.
 *
 * Ported from the harness toml-patch module, stripped of upstream-only
 * branching (Azure/Foundry providers, http header passthrough, web_search
 * and env-key auth) and renamed to the aiand provider id.
 */

const CODEX_PROVIDER_TABLE_HEADER = "[model_providers.aiand]";
const LEGACY_PROFILE_TABLE_HEADER = "[profiles.aiand]";
const LEGACY_AIAAND_PROFILE_LINE = /^profile\s*=\s*["']aiand["']\s*$/;

const ROOT_MODEL_PROVIDER_LINE = /^model_provider\s*=.+$/;
const ROOT_MODEL_LINE = /^model\s*=.+$/;
const ROOT_MODEL_CATALOG_LINE = /^model_catalog_json\s*=.+$/;

/** Escape a string for use inside a double-quoted TOML literal. */
export function tomlString(value: string): string {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function isAnyTableHeader(trimmed: string): boolean {
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

function isManagedTableHeader(trimmed: string): boolean {
  return trimmed === CODEX_PROVIDER_TABLE_HEADER || trimmed === LEGACY_PROFILE_TABLE_HEADER;
}

function ensureTrailingNewline(text: string): string {
  if (!text) return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Remove exactly the aiand-owned routing: the root `model_provider` /
 * `model` / `model_catalog_json` lines, the `[model_providers.aiand]` table,
 * and any legacy `[profiles.aiand]` table (with its `profile = "aiand"` root
 * line). Every other line — including `[[mcp_servers]]` arrays, unrelated
 * root keys, and other provider tables — is preserved verbatim.
 */
export function stripRouting(raw: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let skippingTable = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (LEGACY_AIAAND_PROFILE_LINE.test(trimmed)) {
      continue;
    }
    if (ROOT_MODEL_PROVIDER_LINE.test(trimmed)
      || ROOT_MODEL_CATALOG_LINE.test(trimmed)
      || ROOT_MODEL_LINE.test(trimmed)) {
      continue;
    }
    if (!skippingTable && isManagedTableHeader(trimmed)) {
      skippingTable = true;
      continue;
    }
    if (skippingTable) {
      if (isAnyTableHeader(trimmed)) {
        skippingTable = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }

  return ensureTrailingNewline(out.join("\n").replace(/\n+$/, "\n"));
}

export type RoutingPatch = {
  providerId: "aiand";
  baseUrl: string;
  modelId: string;
  catalogPath: string;
  apiKey: string;
};

/**
 * Rewrite the root routing keys (`model_provider`, `model`,
 * `model_catalog_json`) and the `[model_providers.aiand]` provider table.
 * Uses strip + rebuild: the owned root lines and table are removed first, then
 * the routing block is prepended and the provider table appended, so anything
 * else in the file (including `[[mcp_servers]]` arrays) is preserved.
 */
export function patchRouting(raw: string, { providerId, baseUrl, modelId, catalogPath, apiKey }: RoutingPatch): string {
  const base = stripRouting(raw);
  const routingBlock = [
    `model_provider = "${providerId}"`,
    `model_catalog_json = "${catalogPath}"`,
    `model = "${modelId}"`,
  ].join("\n");
  const tablesBlock = [
    `[model_providers.${providerId}]`,
    `name = "ai&"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "responses"`,
    `experimental_bearer_token = "${apiKey}"`,
    `requires_openai_auth = false`,
  ].join("\n");

  if (!base.trim()) {
    return `${routingBlock}\n\n${tablesBlock}\n`;
  }

  const separator = base.endsWith("\n") ? "" : "\n";
  return `${routingBlock}\n\n${base}${separator}\n${tablesBlock}\n`;
}

/**
 * First-run defaults for a brand-new Codex config: a blank file gets the
 * interactive-approval and workspace-write sandbox that make stock Codex
 * usable against ai&. A non-empty config is returned untouched.
 */
export function applyFirstRunDefaults(raw: string): string {
  if (raw.trim() !== "") return raw;
  return `approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n`;
}