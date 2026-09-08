import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Model } from "../api/models.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { agentHome, writeFileAtomic } from "../config.js";
import { readJsonOrEmpty, swapKeyInConfig } from "./managed-file.js";
import type { AgentAdapter, DetectResult, EnableInput, ProbeResult, SessionLaunchInput } from "./types.js";

/**
 * The Pi coding agent reads three config files under `~/.pi/agent/` at
 * startup: settings.json (routing + picker scope), auth.json (a map of named
 * credentials, one per provider), and models.json (custom model providers
 * added to Pi's built-in catalog). The `on` wiring is persistent — a later
 * stock-binary launch rides these files with no launcher env, so
 * `sessionLaunch` is a no-op. Everything is snapshotted by the engine.
 */
const PI_PROVIDER = "aiand";
const PI_MANAGED_BY = "aiand";
const PI_BASE_URL = "https://api.aiand.com/v1";

/**
 * Pi's picker is scoped to exactly this provider: the glob matches
 * `provider/modelId` resolution in Pi's model-registry, hiding every other
 * provider's models from the picker while routing through `aiand`.
 */
const PI_ENABLED_MODELS: readonly string[] = ["aiand/*"];

/** Max output tokens pi uses for a registered custom model. */
const PI_MAX_TOKENS = 16384;

function settingsPath(): string {
  return join(agentHome(), ".pi", "agent", "settings.json");
}

function authPath(): string {
  return join(agentHome(), ".pi", "agent", "auth.json");
}

function modelsPath(): string {
  return join(agentHome(), ".pi", "agent", "models.json");
}

/**
 * One Pi models.json entry built from a live aiand catalog model. Prices are
 * USD-per-1M-token strings in the gateway catalog; pi's `cost` object wants
…
 * cached price is a per-1M string too; when the model has no cached price we
 * fall back to its input price (cacheRead always costs ≤ input in aiand's
 * catalog, so this never overstates).
 */
function piModelEntry(model: Model): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    reasoning:
      (model.reasoning_efforts?.length ?? 0) > 0,
    input: ["text"],
    contextWindow: model.context_window,
    maxTokens: PI_MAX_TOKENS,
    cost: {
      input: Number(model.input_per_1m),
      output: Number(model.output_per_1m),
      cacheRead: Number(model.cached_input_per_1m ?? model.input_per_1m),
      cacheWrite: 0,
    },
  };
}

function managedFiles(): string[] {
  return [settingsPath(), authPath(), modelsPath()];
}

async function probe(): Promise<ProbeResult> {
  let active = false;
  let model: string | null = null;
  // Ground truth from the real files: routing is live only when settings names
  // `aiand` and models.json actually carries the `aiand` provider. A file
  // mid-edit shouldn't wedge `pi status`, so any read/parse failure → inactive.
  try {
    const settings = JSON.parse(await readFile(settingsPath(), "utf8"));
    const settingsObj =
      settings && typeof settings === "object" && !Array.isArray(settings)
        ? (settings as Record<string, unknown>)
        : {};
    if (settingsObj.defaultProvider === PI_PROVIDER && typeof settingsObj.defaultModel === "string") {
      const modelsConfig = JSON.parse(await readFile(modelsPath(), "utf8")) as {
        providers?: Record<string, unknown>;
      };
      if (modelsConfig?.providers?.[PI_PROVIDER]) {
        active = true;
        model = settingsObj.defaultModel;
      }
    }
  } catch {
    active = false;
  }
  return {
    active,
    model,
  };
}

async function enable(input: EnableInput): Promise<{ model: string; filesWritten: string[] }> {
  const sPath = settingsPath();
  const aPath = authPath();
  const mPath = modelsPath();

  // Merge-preserve: each file keeps every unrelated key the user planted.
  const settings = await readJsonOrEmpty(sPath, "pi", "settings.json");
  const auth = await readJsonOrEmpty(aPath, "pi", "auth.json");
  const modelsConfig = await readJsonOrEmpty(mPath, "pi", "models.json");

  const nextSettings = {
    ...settings,
    defaultProvider: PI_PROVIDER,
    defaultModel: input.model,
    enabledModels: [...PI_ENABLED_MODELS],
  };

  const nextAuth = {
    ...auth,
    [PI_PROVIDER]: { type: "api_key", key: input.apiKey, managedBy: PI_MANAGED_BY },
  };

  // Replace only the `aiand` provider, preserving any non-aiand providers.
  const providers =
    modelsConfig.providers &&
    typeof modelsConfig.providers === "object" &&
    !Array.isArray(modelsConfig.providers)
      ? (modelsConfig.providers as Record<string, unknown>)
      : {};
  const nextModels = {
    ...modelsConfig,
    providers: {
      ...providers,
      [PI_PROVIDER]: {
        baseUrl: PI_BASE_URL,
        api: "openai-completions",
        models: input.catalog.map(piModelEntry),
      },
    },
  };

  await writeFileAtomic(sPath, `${JSON.stringify(nextSettings, null, 2)}\n`, { mode: 0o600 });
  await writeFileAtomic(aPath, `${JSON.stringify(nextAuth, null, 2)}\n`, { mode: 0o600 });
  await writeFileAtomic(mPath, `${JSON.stringify(nextModels, null, 2)}\n`, { mode: 0o600 });

  return { model: input.model, filesWritten: [sPath, aPath, mPath] };
}

const PI_INSTALL = INSTALL_HINTS.pi!;

export const piAdapter: AgentAdapter = {
  id: "pi",
  label: "Pi",
  bin: "pi",
  install: PI_INSTALL,

  detect(): DetectResult {
    return detectBinary("pi");
  },

  managedFiles,

  probe,

  enable,

  async disable(): Promise<void> {
    // Nothing beyond manifest restore: all three files are snapshotted by the
    // engine, which restores each byte-for-byte (or deletes files it did not
    // exist before `on`). There is no aiand-owned side file to clean up.
    return Promise.resolve();
  },

  /**
   * Swap ONLY the baked key under `auth.aiand.key` in auth.json, preserving
   * settings.json and models.json and every unrelated key. Uses the same
   * readJsonObject/writeFileAtomic helpers enable() does (mode 0600).
   * Idempotent: a key that already matches leaves the file untouched.
   */
  async refreshKey(input: { apiKey: string; home: string }): Promise<void> {
    await swapKeyInConfig({
      apiKey: input.apiKey,
      read: () => readJsonOrEmpty(authPath(), "pi", "auth.json"),
      currentKey: (auth) => {
        const entry = auth[PI_PROVIDER];
        return entry && typeof entry === "object"
          ? (entry as Record<string, unknown>).key
          : undefined;
      },
      apply: (auth, apiKey) => {
        const entry = auth[PI_PROVIDER];
        return {
          ...auth,
          [PI_PROVIDER]: { ...(entry && typeof entry === "object" ? entry : {}), key: apiKey },
        };
      },
      write: async (next) => {
        await writeFileAtomic(authPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      },
    });
  },

  async sessionLaunch(_input: SessionLaunchInput) {
    // Pi reads auth.json/models.json/settings.json at startup, so a launched
    // session rides the persistent wiring `on` already wrote. The launcher
    // supports an adapter whose session is purely persistent: no env, nothing
    // to unset.
    return { env: {}, clear: [] };
  },
};