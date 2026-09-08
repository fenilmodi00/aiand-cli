import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { Model } from "../api/models.js";
import { agentHome, writeFileAtomic } from "../config.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { detectForeign } from "./foreign.js";
import { assertIdeStopped, CHATGPT_DESKTOP_SPEC } from "./quit-guard.js";
import { resolveDefault } from "./catalog.js";
import { readTextIfExists } from "./managed-file.js";
import { applyFirstRunDefaults, patchRouting, tomlString } from "./toml.js";
import type { AgentAdapter, EnableInput, ProbeResult, SessionLaunchInput } from "./types.js";


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
  install: INSTALL_HINTS.codex!,
  aliases: ["chatgpt"],

  detect() {
    return detectBinary(this.bin);
  },

  /**
   * Refuse to write ~/.codex/config.toml while ChatGPT Desktop is running:
   * it shares that config and rewrites it on exit, silently clobbering the
   * write. Linux has no ChatGPT Desktop build, so the guard is a no-op
   * there.
   */
  async enableGuard(opts: { force: boolean }): Promise<void> {
    if (process.platform !== "darwin" && process.platform !== "win32") return;
    await assertIdeStopped(CHATGPT_DESKTOP_SPEC, "ChatGPT Desktop", {
      force: opts.force,
    });
  },

  /**
   * `off` restores the shared config.toml byte-for-byte; a running ChatGPT
   * Desktop would rewrite it from memory on exit and undo the restore.
   */
  async offGuard(opts: { force: boolean }): Promise<void> {
    if (process.platform !== "darwin" && process.platform !== "win32") return;
    await assertIdeStopped(CHATGPT_DESKTOP_SPEC, "ChatGPT Desktop", {
      force: opts.force,
    });
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

  async sessionLaunch(input: SessionLaunchInput) {
    // Session launches must work with NO prior `on`: the -c overlay defines
    // the whole provider (name/base_url/wire_api) inline, and the key rides
    // in env via env_key — nothing secret is written to disk. Codex's own
    // default model (gpt-5-codex family) is not in the gateway catalog, so
    // a concrete model is always baked from the live catalog.
    const model = input.model ?? resolveDefault(input.catalog);
    return {
      env: { AIAND_CODEX_AUTH_TOKEN: input.apiKey },
      clear: [],
      args: [
        "-c",
        'model_provider="aiand"',
        "-c",
        `model="${model}"`,
        "-c",
        'model_providers.aiand.name="ai&"',
        "-c",
        'model_providers.aiand.base_url="https://api.aiand.com/v1"',
        "-c",
        'model_providers.aiand.wire_api="responses"',
        "-c",
        'model_providers.aiand.env_key="AIAND_CODEX_AUTH_TOKEN"',
      ],
    };
  },

  async enable(input: EnableInput) {
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

  /**
   * Swap ONLY the baked `experimental_bearer_token` literal inside the
   * `[model_providers.aiand]` table, preserving the model id, catalog path,
   * and every other line/table byte-for-byte. Idempotent: a key that already
   * matches does not rewrite the file.
   */
  async refreshKey(input: { apiKey: string; home: string }): Promise<void> {
    const file = codexConfigFile();
    const raw = await readTextIfExists(file);
    if (!raw.trim()) return;
    const lines = raw.split("\n");
    let insideAiand = false;
    let changed = false;
    const keyLine = /^(\s*)experimental_bearer_token\s*=(.*)$/;
    const next = lines.map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        insideAiand = trimmed === "[model_providers.aiand]";
        return line;
      }
      if (!insideAiand) return line;
      const match = keyLine.exec(line);
      if (!match) return line;
      const newValue = tomlString(input.apiKey);
      if (line.trimEnd() === `${match[1]}experimental_bearer_token = ${newValue}`) return line;
      changed = true;
      return `${match[1]}experimental_bearer_token = ${newValue}`;
    });
    if (!changed) return;
    await writeFileAtomic(file, `${next.join("\n")}\n`, { mode: 0o600 });
  },
};