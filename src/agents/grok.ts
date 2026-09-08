import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Model } from "../api/models.js";
import { CliError } from "../cli/errors.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { resolveDefault } from "./catalog.js";
import type {
  AgentAdapter,
  EnableInput,
  ProbeResult,
  SessionLaunch,
  SessionLaunchInput,
} from "./types.js";

/**
 * Grok Build support.
 *
 * Grok discovers models from an OpenAI-shaped `/v1/models` endpoint, so this
 * serves its own catalog from an ephemeral localhost server and points Grok's
 * inference at ai&. It is launcherOnly: there is no persistent wiring to
 * enable (`on`/`off` are refused by the engine), only a per-session launch.
 *
 * CREDENTIAL SAFETY: Grok requires XAI_API_KEY to accept a custom catalog, and
 * several of its features (image gen/edit, voice) call an xAI-native API
 * directly with whatever key is active. We therefore point every xAI-native
 * surface at the localhost catalog server so the ai& key can never reach an
 * xAI endpoint, and disable those features outright.
 */

const GROK_MAX_COMPLETION_TOKENS = 8192;

type GrokCatalogEntry = {
  id: string;
  model: string;
  name: string;
  description: string;
  base_url: string;
  api_backend: "chat_completions";
  context_window: number;
  max_completion_tokens: number;
  user_selectable: true;
};

type GrokModelCatalog = {
  object: "list";
  data: GrokCatalogEntry[];
};

/**
 * The live ai& catalog, shaped as the OpenAI-style list Grok expects. The one
 * URL surface (https://api.aiand.com/v1) serves both catalog discovery and
 * inference.
 */
export function buildGrokModelCatalog(models: Model[]): GrokModelCatalog {
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      model: model.id,
      name: `ai& · ${model.name}`,
      description: `ai& model: ${model.id}`,
      base_url: "https://api.aiand.com/v1",
      api_backend: "chat_completions" as const,
      context_window: model.context_window,
      // The ai& catalog has no max-output field, so this is a flat constant
      // rather than a per-model value (upstream capped limit.output at 8192).
      max_completion_tokens: GROK_MAX_COMPLETION_TOKENS,
      user_selectable: true as const,
    })),
  };
}

type GrokCatalogServer = {
  modelsListUrl: string;
  origin: string;
  close: () => Promise<void>;
};

/**
 * Serve a pre-serialized catalog on an ephemeral 127.0.0.1 port for this
 * launch only. `origin` is the bare `http://127.0.0.1:<port>` (no trailing
 * slash) that the xAI-native API surface gets routed at.
 */
export async function startGrokCatalogServer(catalogBody: string): Promise<GrokCatalogServer> {
  const server = createServer((request, response) => {
    let pathname = "/";
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      pathname = "/";
    }
    if (request.method === "GET" && pathname === "/v1/models") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(catalogBody),
        "content-type": "application/json; charset=utf-8",
      });
      response.end(catalogBody);
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end('{"error":"not_found"}');
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    modelsListUrl: `${origin}/v1/models`,
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * A blank GROK_HOME override points Grok at the current directory; treat it as
 * unset so Grok resolves its normal home and keeps its built-in resources.
 * Kept as a pure helper so it is testable in isolation.
 */
export function sanitizeGrokEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  if (!out.GROK_HOME?.trim()) {
    delete out.GROK_HOME;
  }
  return out;
}

/**
 * Build the child-process environment for a launched Grok session. GROK_AUTH
 * (inline session auth) outranks GROK_AUTH_PATH, so the ai& key wins even when
 * the user's normal Grok login is active; GROK_DISABLE_API_KEY_AUTH is removed
 * so key auth stays on. The user's auth file itself is never touched.
 */
export function buildGrokLaunchEnvironment({
  apiKey,
  authPath,
  baseUrl,
  modelsListUrl,
  origin,
  selectedModel,
}: {
  apiKey: string;
  authPath: string;
  baseUrl: string;
  modelsListUrl: string;
  origin: string;
  selectedModel: string;
}): Record<string, string> {
  return sanitizeGrokEnv({
    GROK_AUTH_PATH: authPath,
    GROK_MODELS_BASE_URL: baseUrl,
    GROK_MODELS_LIST_URL: modelsListUrl,
    GROK_DEFAULT_MODEL: selectedModel,
    // Grok requires XAI_API_KEY to accept a custom catalog. Keep inference
    // working, but route every xAI-native surface at the localhost catalog
    // server so this ai& credential can never reach an xAI endpoint.
    XAI_API_KEY: apiKey,
    GROK_XAI_API_BASE_URL: origin,
    GROK_SESSION_SUMMARY_MODEL: selectedModel,
    GROK_PROMPT_SUGGESTIONS_MODEL: selectedModel,
    GROK_SUGGESTIONS_AI_MODEL: selectedModel,
    // xAI-native surfaces that ignore the above base-url redirect must be
    // killed so they can never send the active key to api.x.ai.
    GROK_IMAGE_GEN: "0",
    GROK_IMAGE_EDIT: "0",
    GROK_VOICE_MODE: "0",
    GROK_TELEMETRY_ENABLED: "0",
    GROK_FEEDBACK_ENABLED: "0",
  });
}

export const grokAdapter: AgentAdapter = {
  id: "grok",
  label: "Grok Build",
  bin: "grok",
  install: INSTALL_HINTS.grok!,
  launcherOnly: true,

  detect() {
    return detectBinary(this.bin);
  },

  managedFiles() {
    return [];
  },

  async probe(): Promise<ProbeResult> {
    return { active: false, foreignTool: null, model: null };
  },

  async enable(_input: EnableInput) {
    throw new CliError(
      "Grok Build runs on ai& per session only. Use: aiand run-agent grok."
    );
  },

  async disable() {
    // Launcher-only: nothing persistent to remove.
  },

  async sessionLaunch(input: SessionLaunchInput): Promise<SessionLaunch> {
    const model = input.model ?? resolveDefault(input.catalog);
    const catalogBody = JSON.stringify(buildGrokModelCatalog(input.catalog));

    const authDir = mkdtempSync(join(tmpdir(), "aiand-grok-"));
    const authPath = join(authDir, "no-auth.json");
    writeFileSync(authPath, "", { mode: 0o600 });

    const server = await startGrokCatalogServer(catalogBody);

    const env = buildGrokLaunchEnvironment({
      apiKey: input.apiKey,
      authPath,
      baseUrl: "https://api.aiand.com/v1",
      modelsListUrl: server.modelsListUrl,
      origin: server.origin,
      selectedModel: model,
    });

    return {
      env,
      clear: ["GROK_AUTH", "GROK_DISABLE_API_KEY_AUTH"],
      cleanup: async () => {
        await server.close();
        rmSync(authDir, { recursive: true, force: true });
      },
    };
  },
};