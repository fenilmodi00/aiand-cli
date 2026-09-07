import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDefault } from "./catalog.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { agentHome } from "./paths.js";
import type { AgentAdapter, ProbeResult, SessionLaunchInput } from "./types.js";

/**
 * Hermes Agent support.
 *
 * Hermes prefers its own saved `.env` and credential pool over process env
 * vars, so simply exporting a key does not redirect it. Each launch gets an
 * isolated HERMES_HOME overlay: ordinary state (sessions, skills, memories,
 * preferences) is symlinked back to the user's real home so it stays native
 * and resumable, while credentials, config, and an ephemeral provider plugin
 * exist only inside the overlay. The user's real Hermes home is never
 * modified.
 */

const HERMES_BASE_URL = "https://api.aiand.com/v1";
const PROVIDER_ID = "aiand";

const VALUE_OVERRIDES: Record<string, true> = {
  "--provider": true,
  "--model": true,
  "-m": true,
};
const ISOLATED_HOME_ENTRIES: Record<string, true> = {
  ".env": true,
  active_profile: true,
};

function containsCredentialState(name: string): boolean {
  return name in ISOLATED_HOME_ENTRIES || /auth|credential|token/i.test(name);
}

function linkDirectoryEntries(
  source: string,
  destination: string,
  excludedNames: Record<string, true> = {}
): void {
  if (!existsSync(source)) {
    return;
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name in excludedNames) {
      continue;
    }
    symlinkSync(
      join(source, entry.name),
      join(destination, entry.name),
      entry.isDirectory() ? "dir" : "file"
    );
  }
}

/**
 * Render the aiand provider stanza written under the `providers:` mapping of
 * config.yaml — 2-space indented children, block-list models.
 */
function aiandProviderStanza(model: string, modelIds: readonly string[]): string {
  const models = modelIds.map((id) => `      - ${id}`).join("\n");
  return (
    `  ${PROVIDER_ID}:\n` +
    `    name: "ai&"\n` +
    `    base_url: ${HERMES_BASE_URL}\n` +
    `    key_env: AIAND_HERMES_API_KEY\n` +
    `    transport: chat_completions\n` +
    `    default_model: ${model}\n` +
    `    models:\n${models}\n` +
    `    discover_models: false`
  );
}

/**
 * String surgery on the top-level `providers:` mapping of Hermes's config.yaml.
 * When `providers:` is absent the block is appended as a new top-level
 * section; when an `aiand` child already exists it is replaced in place;
 * otherwise the stanza is inserted right after the `providers:` line.
 */
function patchProvidersSection(text: string, stanza: string): string {
  const lines = text.split("\n");
  const providersIdx = lines.findIndex((line) => /^providers:\s*$/.test(line));
  const stanzaLines = stanza.split("\n");

  if (providersIdx === -1) {
    const base = text.endsWith("\n") ? text : `${text}\n`;
    return `${base}providers:\n${stanza}\n`;
  }

  // Scan the children of providers: for an existing aiand stanza.
  let aiandIdx = -1;
  for (let i = providersIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line === "") continue;
    if (/^\S/.test(line)) break; // providers block ended before any aiand
    if (/^  aiand:\s*$/.test(line)) {
      aiandIdx = i;
      break;
    }
    if (/^  \S/.test(line)) continue; // sibling provider, keep scanning
  }

  if (aiandIdx === -1) {
    lines.splice(providersIdx + 1, 0, ...stanzaLines);
  } else {
    let end = aiandIdx + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line === undefined || line === "") {
        end++;
        continue;
      }
      if (/^\S/.test(line) || /^  \S+:\s*$/.test(line)) break;
      end++;
    }
    lines.splice(aiandIdx, end - aiandIdx, ...stanzaLines);
  }

  let out = lines.join("\n");
  if (text.endsWith("\n") && !out.endsWith("\n")) out += "\n";
  return out;
}

function writeProviderConfig(overlay: string, model: string, modelIds: readonly string[]): void {
  const configPath = join(overlay, "config.yaml");
  const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  writeFileSync(
    configPath,
    patchProvidersSection(source, aiandProviderStanza(model, modelIds)),
    "utf8"
  );
}

function writeEphemeralEnv(overlay: string, apiKey: string): void {
  writeFileSync(
    join(overlay, ".env"),
    `AIAND_HERMES_API_KEY=${JSON.stringify(apiKey)}\n` +
      `AIAND_HERMES_BASE_URL=${JSON.stringify(HERMES_BASE_URL)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

function writeAiandProviderPlugin(overlay: string, modelIds: readonly string[]): void {
  const pluginDir = join(overlay, "plugins", "model-providers", PROVIDER_ID);
  mkdirSync(pluginDir, { recursive: true });
  const modelValues = modelIds.map((id) => JSON.stringify(id)).join(", ");
  // A 1-tuple needs a trailing comma in Python.
  const pythonTuple = modelIds.length === 1 ? `${modelValues},` : modelValues;
  writeFileSync(
    join(pluginDir, "__init__.py"),
    `"""Ephemeral ai& provider generated by aiand-cli."""

from providers import register_provider
from providers.base import ProviderProfile


class AiandProfile(ProviderProfile):
    def prepare_messages(self, messages):
        prepared = []
        for message in messages:
            item = dict(message)
            if item.get("role") == "tool":
                item.pop("name", None)
            prepared.append(item)
        return prepared


aiand = AiandProfile(
    name="aiand",
    display_name="ai&",
    description="ai& through aiand-cli",
    api_mode="chat_completions",
    env_vars=("AIAND_HERMES_API_KEY", "AIAND_HERMES_BASE_URL"),
    base_url=${JSON.stringify(HERMES_BASE_URL)},
    fallback_models=(${pythonTuple}),
    supports_vision=True,
)

register_provider(aiand)
`,
    "utf8"
  );
  writeFileSync(
    join(pluginDir, "plugin.yaml"),
    `name: aiand
kind: model-provider
version: 1.0.0
description: Ephemeral ai& provider generated by aiand-cli
`,
    "utf8"
  );
}

/**
 * Build the isolated Hermes home for one launch. Returns the overlay path; the
 * caller must remove it when the session ends.
 */
function createHermesHomeOverlay(
  nativeHome: string,
  apiKey: string,
  model: string,
  modelIds: readonly string[]
): string {
  const overlay = mkdtempSync(join(tmpdir(), "aiand-hermes-"));
  try {
    if (existsSync(nativeHome)) {
      for (const entry of readdirSync(nativeHome, { withFileTypes: true })) {
        // Credentials and plugins are overlay-only; everything else is linked
        // back so normal Hermes state stays shared and resumable.
        if (containsCredentialState(entry.name) || entry.name === "plugins") {
          continue;
        }
        if (entry.name === "config.yaml" && entry.isFile()) {
          // Copied, not linked: we edit it, and must not touch the real one.
          copyFileSync(join(nativeHome, entry.name), join(overlay, entry.name));
          continue;
        }
        symlinkSync(
          join(nativeHome, entry.name),
          join(overlay, entry.name),
          entry.isDirectory() ? "dir" : "file"
        );
      }

      const nativePlugins = join(nativeHome, "plugins");
      const overlayPlugins = join(overlay, "plugins");
      if (existsSync(nativePlugins)) {
        mkdirSync(overlayPlugins, { recursive: true });
        for (const entry of readdirSync(nativePlugins, { withFileTypes: true })) {
          if (entry.name === "model-providers") {
            continue;
          }
          symlinkSync(
            join(nativePlugins, entry.name),
            join(overlayPlugins, entry.name),
            entry.isDirectory() ? "dir" : "file"
          );
        }
        linkDirectoryEntries(
          join(nativePlugins, "model-providers"),
          join(overlayPlugins, "model-providers"),
          { [PROVIDER_ID]: true }
        );
      }
    }
    writeProviderConfig(overlay, model, modelIds);
    writeEphemeralEnv(overlay, apiKey);
    writeAiandProviderPlugin(overlay, modelIds);
    return overlay;
  } catch (error) {
    rmSync(overlay, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Strip user-specified runtime overrides so ours win on the CLI. Exported as a
 * pure helper (grok adapter uses the same shape) — the launcher applies it to
 * passthrough args; the adapter's own built args carry no overrides.
 */
export function argsWithoutRuntimeOverrides(args: string[]): string[] {
  const sanitized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg in VALUE_OVERRIDES) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--provider=") || arg.startsWith("--model=")) {
      continue;
    }
    sanitized.push(arg);
  }
  return sanitized;
}

export const hermesAdapter: AgentAdapter = {
  id: "hermes",
  label: "Hermes Agent",
  bin: "hermes",
  install: INSTALL_HINTS.hermes ?? {
    command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    url: "https://hermes-agent.nousresearch.com/docs/",
  },
  launcherOnly: true,

  detect() {
    return detectBinary(this.bin);
  },

  managedFiles() {
    return [];
  },

  async probe(): Promise<ProbeResult> {
    // Launcher-only: owns no persistent files, reads nothing.
    return { active: false, foreignTool: null, model: null };
  },

  async sessionLaunch(input: SessionLaunchInput) {
    const model = input.model ?? resolveDefault(input.catalog);
    const modelIds = input.catalog.map((m) => m.id);
    const nativeHome = process.env.HERMES_HOME || join(agentHome(), ".hermes");
    const overlay = createHermesHomeOverlay(nativeHome, input.apiKey, model, modelIds);

    const env: Record<string, string> = {
      HERMES_HOME: overlay,
      AIAND_HERMES_API_KEY: input.apiKey,
      AIAND_HERMES_BASE_URL: HERMES_BASE_URL,
      HERMES_MODEL: model,
      HERMES_INFERENCE_MODEL: model,
      HERMES_INFERENCE_PROVIDER: PROVIDER_ID,
      HERMES_TUI_PROVIDER: PROVIDER_ID,
      AIAND_API_KEY: input.apiKey,
    };

    return {
      env,
      clear: [],
      args: ["--provider", PROVIDER_ID, "--model", model],
      async cleanup() {
        try {
          rmSync(overlay, { recursive: true, force: true });
        } catch {
          // never throw from cleanup
        }
      },
    };
  },

  async enable() {
    throw new Error("hermes is launcher-only; use `aiand run-agent hermes`.");
  },

  async disable() {
    // Nothing persisted, nothing to strip.
  },
};