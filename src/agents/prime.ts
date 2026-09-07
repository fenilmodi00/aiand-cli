import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { configDir } from "../config.js";
import { writeFileAtomic } from "../io/atomic.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { detectForeign } from "./foreign.js";
import { agentHome } from "./paths.js";
import type { AgentAdapter, DetectResult, EnableInput, ProbeResult, SessionLaunchInput } from "./types.js";
import type { Model } from "../api/models.js";

/**
 * The base origin this adapter's provider entries point at. The client appends
 * `/v1` itself, so models.json carries the versioned path directly.
 */
const PRIME_BASE_URL = "https://api.aiand.com/v1";

/** The sidecar directory under <configDir>/agents/ is entirely aiand-owned. */
function primeDir(): string {
  return join(configDir(), "agents", "prime");
}

/** The single file this adapter writes; everything else lives in the dir. */
function modelsPath(): string {
  return join(primeDir(), "models.json");
}

/** Managed file list, matched by the engine's snapshot + foreign scan. */
function managedFiles(): string[] {
  return [modelsPath()];
}

/**
 * Cost conversion shared with pi/deepseek: the catalog prices are USD strings
 * per 1M tokens; upstream cost fields are USD per 1M tokens as numbers. The
 * gateway's cached price is already per-1M, so `Number(...)` reads it straight.
 */
function costOf(model: Model): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  return {
    input: Number(model.input_per_1m),
    output: Number(model.output_per_1m),
    cacheRead: Number(model.cached_input_per_1m ?? model.input_per_1m),
    cacheWrite: 0,
  };
}

/**
 * A pi-shape provider model entry built from a live catalog Model. `maxTokens`
 * is the upstream default constant (the catalog carries no max-output field).
 */
function modelEntry(model: Model): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning_efforts?.length ? true : false,
    input: model.capabilities.includes("vision") ? ["text", "image"] : ["text"],
    contextWindow: model.context_window,
    maxTokens: 16384,
    cost: costOf(model),
  };
}

/** The full models.json body: a single gateway provider with catalog models. */
function buildModelsJson(catalog: Model[]): Record<string, unknown> {
  return {
    providers: {
      aiand: {
        baseUrl: PRIME_BASE_URL,
        api: "openai-completions",
        models: catalog.map(modelEntry),
      },
    },
  };
}

async function ensurePrimeDir(): Promise<string> {
  const dir = primeDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

async function enable(input: EnableInput): Promise<{ model: string; filesWritten: string[] }> {
  const dir = await ensurePrimeDir();
  await writeFileAtomic(modelsPath(), `${JSON.stringify(buildModelsJson(input.catalog), null, 2)}\n`, {
    mode: 0o600,
  });
  return { model: input.model, filesWritten: [modelsPath()] };
}

async function probe(): Promise<ProbeResult> {
  let active = false;
  try {
    const parsed = JSON.parse(await readFile(modelsPath(), "utf8")) as {
      providers?: { aiand?: { baseUrl?: unknown } };
    };
    const baseUrl = parsed.providers?.aiand?.baseUrl;
    active = typeof baseUrl === "string" && baseUrl.startsWith("https://api.aiand.com");
  } catch {
    // Missing or invalid models.json → inactive, never a crash (a file
    // mid-edit shouldn't wedge `prime status`).
    active = false;
  }
  return {
    active,
    // No persistent model pin: sessionLaunch receives the resolved model.
    model: null,
    foreignTool: await detectForeign(managedFiles()),
  };
}

async function disable(): Promise<void> {
  await rm(primeDir(), { recursive: true, force: true });
}

async function sessionLaunch(input: SessionLaunchInput) {
  // Prime reads its provider wiring from PRIME_AGENT_CODING_AGENT_DIR at
  // startup; the dir already holds models.json from `on`, but write it again
  // reusing the enable builder so a run-agent without a prior `on` still gets
  // a working provider map from the live catalog. Nothing ephemeral is
  // created here, so there is no cleanup to run after the child exits.
  await ensurePrimeDir();
  await writeFileAtomic(modelsPath(), `${JSON.stringify(buildModelsJson(input.catalog), null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    env: {
      PRIME_AGENT_CODING_AGENT_DIR: primeDir(),
      AIAND_API_KEY: input.apiKey,
    },
    clear: [],
  };
}

const PRIME_INSTALL = INSTALL_HINTS.prime!;

export const primeAdapter: AgentAdapter = {
  id: "prime",
  label: "Prime Agent",
  bin: "prime",
  install: PRIME_INSTALL,
  detect(): DetectResult {
    return detectBinary("prime");
  },
  managedFiles,
  probe,
  enable,
  disable,
  sessionLaunch,
};