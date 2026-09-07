import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Model } from "../api/models.js";
import { writeFileAtomic } from "../io/atomic.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { detectForeign } from "./foreign.js";
import { agentHome } from "./paths.js";
import { applyFirstRunDefaults, patchRouting } from "./toml.js";
import type { AgentAdapter, ProbeResult } from "./types.js";

/** Status note shown when Codex routing is live (shared config + cache). */
export const CODEX_SHARED_NOTE = "Shared by the Codex CLI and ChatGPT Desktop.";

const MANIFEST_BASE_URL = "https://api.aiand.com/v1";

// Safety margin for the Codex ↔ gateway tokenizer mismatch. Codex's own
// tokenizer underestimates the server-side count (~1.8× on text), so it
// would never compact until the gateway rejects with
// context_length_exceeded. Both the truncation limit and the auto-compact
// trigger derive from this ratio so Codex compacts proactively.
const CODEX_TOKENIZER_MISMATCH_RATIO = 1.8;

function codexConfigFile(): string {
  return join(agentHome(), ".codex", "config.toml");
}

function codexCatalogFile(): string {
  return join(agentHome(), ".codex", "aiand-models.json");
}

function codexCacheFile(): string {
  return join(agentHome(), ".codex", "models_cache.json");
}

/**
 * Read a file, treating a missing file as empty content (enable() on a
 * brand-new config, probe() before any write). Anything other than ENOENT
 * propagates — a real read error is not a clean "off".
 */
async function readTextIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function reasoningEfforts(model: Model): Array<{ effort: string; description: string }> {
  if (!model.reasoning_efforts || model.reasoning_efforts.length === 0) return [];
  return model.reasoning_efforts.map((effort) => ({
    effort,
    description: `Reasoning level: ${effort}`,
  }));
}

function toCodexModelCatalogEntry(model: Model, priority: number): Record<string, unknown> {
  const margin = Math.floor(model.context_window / CODEX_TOKENIZER_MISMATCH_RATIO);
  return {
    slug: model.id,
    display_name: model.name,
    description: `ai& model ${model.id}`,
    default_reasoning_level:
      model.reasoning_effort_default ?? (model.reasoning_efforts ? "minimal" : "none"),
    supported_reasoning_levels: reasoningEfforts(model),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    truncation_policy: { mode: "tokens", limit: margin },
    supports_parallel_tool_calls: true,
    context_window: model.context_window,
    max_context_window: model.context_window,
    auto_compact_token_limit: margin,
    input_modalities: model.capabilities.includes("vision") ? ["text", "image"] : ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
  };
}

/**
 * Build the Codex model-file JSON: one entry per live ai& model, shaped the
 * way Codex's model registry expects (slug, reasoning levels, context
 * window, truncation/compaction margins, modalities).
 */
export function codexModelCatalogJson(models: Model[]): string {
  const entries = models.map((model, index) => toCodexModelCatalogEntry(model, index));
  return JSON.stringify({ models: entries });
}

/**
 * Decide whether a config has live ai& routing (a `[model_providers.aiand]`
 * table whose base_url points at api.aiand.com) and read the root-only
 * `model = "…"` line, stopping at the first table header.
 */
function inspectConfig(configText: string): { active: boolean; model: string | null } {
  const hasProviderTable = configText.includes("[model_providers.aiand]");
  const hasOurBase = /base_url\s*=\s*"(https?:\/\/[^"]*api\.aiand\.com[^"]*)"/.test(
    configText
  );
  const active = hasProviderTable && hasOurBase;

  let model: string | null = null;
  for (const line of configText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) break;
    const match = /^model\s*=\s*"([^"]*)"/.exec(trimmed);
    if (match) {
      model = match[1] ?? null;
      break;
    }
  }

  return { active, model };
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  label: "Codex CLI",
  bin: "codex",
  install: INSTALL_HINTS.codex ?? { command: "npm install -g @openai/codex", url: "https://github.com/openai/codex" },
  aliases: ["chatgpt"],

  detect() {
    return detectBinary(this.bin);
  },

  managedFiles() {
    // The cache is deleted on `on`, so it must be snapshotted to be restored.
    return [codexConfigFile(), codexCacheFile()];
  },

  async probe(): Promise<ProbeResult> {
    const configText = await readTextIfExists(codexConfigFile());
    if (configText.trim() === "") {
      return { active: false, foreignTool: null, model: null };
    }
    const { active, model } = inspectConfig(configText);
    const foreignTool = await detectForeign([codexConfigFile()]);
    return { active, foreignTool, model };
  },

  async enable(input) {
    const raw = await readTextIfExists(codexConfigFile());
    const withDefaults = applyFirstRunDefaults(raw);
    const next = patchRouting(withDefaults, {
      providerId: "aiand",
      baseUrl: MANIFEST_BASE_URL,
      modelId: input.model,
      catalogPath: codexCatalogFile(),
      apiKey: input.apiKey,
    });
    await writeFileAtomic(codexConfigFile(), next, { mode: 0o600 });

    await writeFileAtomic(codexCatalogFile(), codexModelCatalogJson(input.catalog), {
      mode: 0o600,
    });
    // A stale OpenAI models cache would shadow our catalog; drop it.
    await rm(codexCacheFile(), { force: true });

    return { model: input.model, filesWritten: [codexConfigFile(), codexCatalogFile()] };
  },

  async disable() {
    // The engine restores the snapshotted config + cache first; the aiand
    // catalog file is ours alone and simply removed.
    await rm(codexCatalogFile(), { force: true });
    await rm(codexCacheFile(), { force: true });
  },

  sessionLaunch(model) {
    // The launcher injects the session key after this call via
    // AIAND_CODEX_AUTH_TOKEN — never baked here so a launched session's env
    // can't linger with the token. Permanent routing bakes the literal into
    // config.toml instead (see enable), which needs no env involvement.
    return {
      env: {},
      clear: [],
      args: ["-c", 'model_provider="aiand"', "-c", `model="${model ?? ""}"`],
    };
  },
};