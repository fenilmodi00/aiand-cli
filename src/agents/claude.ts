import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { agentHome, writeFileAtomic } from "../config.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { resolveDefault, withContextTag } from "./catalog.js";
import { readJsonOrEmpty, swapKeyInConfig } from "./managed-file.js";
import type { AgentAdapter, DetectResult, EnableInput, ProbeResult, SessionLaunchInput } from "./types.js";

/**
 * Claude Code routes to the gateway through ANTHROPIC_BASE_URL plus the
 * session key baked as ANTHROPIC_AUTH_TOKEN (PRD-locked Q4). The client
 * appends `/v1/messages` itself, so this is the origin without a versioned
 * path. Latest recent-confirming wiring, so drop me if this surprises.
 */
export const CLAUDE_BASE_URL = "https://api.aiand.com";

/**
 * Every env key this adapter owns inside the Claude Code `env` block, and the
 * exact set stripped from a child process before a session launch. This is the
 * union of the two upstream conflict lists — the model-mapping keys and the
 * auth keys — kept verbatim so a stale sibling installation's keys never fight
 * the gateway routing (ours win because we write after clearing).
 */
const MANAGED_ENV_KEYS: readonly string[] = [
  // auth — a stray key would bypass the gateway session
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // main slot
  "ANTHROPIC_MODEL",
  // opus slot
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  // sonnet slot
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  // haiku slot
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_SMALL_FAST_MODEL",
  // fallback tier
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
  // subagent + custom picker
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
];

/** Both config files, resolved from agentHome(); both are snapshotted. */
function managedFiles(): string[] {
  const home = agentHome();
  return [join(home, ".claude", "settings.json"), join(home, ".claude.json")];
}

async function probe(): Promise<ProbeResult> {
  let env: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(
      await readFile(join(agentHome(), ".claude", "settings.json"), "utf8")
    ) as { env?: Record<string, unknown> };
    env = parsed.env;
  } catch {
    // Missing or invalid settings.json → inactive, never a crash (a file
    // mid-edit shouldn't wedge `claude status`).
    env = undefined;
  }
  return {
    active: env?.ANTHROPIC_BASE_URL === CLAUDE_BASE_URL,
    // Truth from the real file: Claude Code can still route even with an empty
    // or legacy model var, so the model is whatever the env block says.
    model: typeof env?.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL : null,
  };
}

/**
 * If the user exported ANTHROPIC_API_KEY, pre-approve it in ~/.claude.json so
 * Claude Code doesn't show its one-time "Detected a custom API key in your
 * environment" prompt on first launch. Claude Code identifies an approved key
 * by `key.trim().slice(-20)` stored in customApiKeyResponses.approved. No-op
 * when no key is in the env. Opportunistic: an unreadable/invalid ~/.claude.json
 * skips the approval rather than aborting the enable.
 */
async function approveStrayAnthropicApiKey(home: string): Promise<boolean> {
  const key = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (!home || !key) return false;
  const identifier = key.slice(-20);
  const filePath = join(home, ".claude.json");

  let current: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    current = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") current = {};
    else return false; // invalid JSON → skip approval, never block enable
  }

  const responses =
    current.customApiKeyResponses && typeof current.customApiKeyResponses === "object"
      ? (current.customApiKeyResponses as Record<string, unknown>)
      : {};
  const approved = Array.isArray(responses.approved) ? (responses.approved as string[]) : [];
  if (approved.includes(identifier)) return false;

  await writeFileAtomic(
    filePath,
    `${JSON.stringify(
      {
        ...current,
        customApiKeyResponses: {
          ...responses,
          approved: [...approved, identifier],
          rejected: Array.isArray(responses.rejected) ? (responses.rejected as string[]) : [],
        },
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return true;
}

async function enable(input: EnableInput): Promise<{ model: string; filesWritten: string[] }> {
  const settingsPath = join(agentHome(), ".claude", "settings.json");
  const current = await readJsonOrEmpty(settingsPath, "claude");

  // Build the env block: copy the existing env minus every managed key FIRST
  // (so stale sibling keys never survive), then write ours.
  const existingEnv =
    current.env && typeof current.env === "object" && !Array.isArray(current.env)
      ? (current.env as Record<string, unknown>)
      : {};
  const nextEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(existingEnv)) {
    if (!MANAGED_ENV_KEYS.includes(name)) nextEnv[name] = String(value);
  }
  nextEnv.ANTHROPIC_BASE_URL = CLAUDE_BASE_URL;
  nextEnv.ANTHROPIC_AUTH_TOKEN = input.apiKey;
  // Claude Code reads a trailing [1m] tag to size its context window and
  // strips it before the request; without it the binary assumes 200K and
  // auto-compacts, starving subagents on 1M-context models.
  // The literal "native" unpins a slot so Claude Code's own default wins: the
  // managed var was already swept out of nextEnv above, and we deliberately
  // write nothing back, leaving the binary to fall back to its built-in model.
  if (input.model !== "native") {
    nextEnv.ANTHROPIC_MODEL = withContextTag(input.model, input.catalog);
  }
  if (input.slots.opus && input.slots.opus !== "native") {
    nextEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = withContextTag(input.slots.opus, input.catalog);
  }
  if (input.slots.sonnet && input.slots.sonnet !== "native") {
    nextEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = withContextTag(input.slots.sonnet, input.catalog);
  }
  if (input.slots.haiku && input.slots.haiku !== "native") {
    // ANTHROPIC_SMALL_FAST_MODEL mirrors the haiku slot, so when haiku is
    // unpinned (native) neither var is written.
    const haiku = withContextTag(input.slots.haiku, input.catalog);
    nextEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
    nextEnv.ANTHROPIC_SMALL_FAST_MODEL = haiku;
  }

  const next = { ...current, env: nextEnv };

  // Idempotency guard: a re-`on` whose computed settings already match the
  // file skips the rewrite entirely (keeps the first snapshot authoritative).
  if (!isDeepStrictEqual(current, next)) {
    await writeFileAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }

  await approveStrayAnthropicApiKey(agentHome());

  // Only settings.json counts as written; the ~/.claude.json pre-approval is
  // opportunistic and may legitimately not happen.
  return { model: input.model, filesWritten: [settingsPath] };
}

const CLAUDE_INSTALL = INSTALL_HINTS.claude!;

/**
 * Swap ONLY the baked ANTHROPIC_AUTH_TOKEN literal in an already-active
 * settings.json, preserving every model id, slot, and unrelated key. Reads,
 * patches, and rewrites through the same readSettings/writeFileAtomic pair
 * enable() uses, so the file mode (0600) and structure stay stable. A key
 * that already matches the file is a no-op (idempotent refresh).
 */
async function refreshKey(input: { apiKey: string; home: string }): Promise<void> {
  const settingsPath = join(input.home, ".claude", "settings.json");
  await swapKeyInConfig({
    apiKey: input.apiKey,
    read: () => readJsonOrEmpty(settingsPath, "claude"),
    currentKey: (current) => {
      const env =
        current.env && typeof current.env === "object" && !Array.isArray(current.env)
          ? (current.env as Record<string, unknown>)
          : {};
      return env.ANTHROPIC_AUTH_TOKEN;
    },
    apply: (current, apiKey) => {
      const env =
        current.env && typeof current.env === "object" && !Array.isArray(current.env)
          ? (current.env as Record<string, unknown>)
          : {};
      return {
        ...current,
        env: { ...env, ANTHROPIC_BASE_URL: CLAUDE_BASE_URL, ANTHROPIC_AUTH_TOKEN: apiKey },
      };
    },
    write: async (next) => {
      await writeFileAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    },
  });
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  label: "Claude Code",
  bin: "claude",
  install: CLAUDE_INSTALL,
  detect(): DetectResult {
    return detectBinary("claude");
  },
  managedFiles,
  probe,
  enable,
  refreshKey,
  async disable(): Promise<void> {
    // Nothing beyond manifest restore: the engine restores both snapshotted
    // files byte-for-byte, and unlike the codex adapter there is no aiand-owned
    // file to clean up. A no-op is the whole contract.
    return Promise.resolve();
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Claude Code's built-in model default (claude-opus-5) is not in the
    // gateway catalog, so a session launch must always bake a catalog-valid
    // model into ANTHROPIC_MODEL — never rely on the binary's own default.
    const model = input.model ?? resolveDefault(input.catalog);
    return {
      env: {
        ANTHROPIC_BASE_URL: CLAUDE_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: input.apiKey,
        // Same [1m] tag as enable(): sizes Claude Code's context window.
        ANTHROPIC_MODEL: withContextTag(model, input.catalog),
      },
      clear: [...MANAGED_ENV_KEYS],
    };
  },
};