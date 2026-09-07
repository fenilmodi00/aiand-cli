import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../cli/errors.js";
import { writeFileAtomic } from "../io/atomic.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { detectForeign } from "./foreign.js";
import { resolveDefault } from "./catalog.js";
import { agentHome } from "./paths.js";
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

/**
 * Structural deep-equality that ignores object key order, used to skip a
 * redundant rewrite on an idempotent re-`on`. Arrays and scalars compare
 * positionally/strictly.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const aKey = aKeys[i];
    const bKey = bKeys[i];
    if (aKey === undefined || bKey === undefined || aKey !== bKey) return false;
    if (!deepEqual(aObj[aKey], bObj[aKey])) return false;
  }
  return true;
}

/**
 * Read settings.json with strict semantics for enable(): missing → `{}`;
 * invalid JSON → a CliError pointing the user at the malformed file.
 */
async function readSettings(path: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new CliError(`${path} is not valid JSON.`, {
        hint: "Fix it by hand, or delete it and run aiand claude on again.",
      });
    }
    throw error;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
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
    foreignTool: await detectForeign(managedFiles()),
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
  const current = await readSettings(settingsPath);

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
  nextEnv.ANTHROPIC_MODEL = input.model;
  // Slot vars from input.slots; a missing slot is left unset rather than
  // written as undefined.
  if (input.slots.opus) nextEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = input.slots.opus;
  if (input.slots.sonnet) nextEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = input.slots.sonnet;
  if (input.slots.haiku) {
    nextEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = input.slots.haiku;
    nextEnv.ANTHROPIC_SMALL_FAST_MODEL = input.slots.haiku;
  }

  const next = { ...current, env: nextEnv };

  // Idempotency guard: a re-`on` whose computed settings already match the
  // file skips the rewrite entirely (keeps the first snapshot authoritative).
  if (!deepEqual(current, next)) {
    await writeFileAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }

  await approveStrayAnthropicApiKey(agentHome());

  // Only settings.json counts as written; the ~/.claude.json pre-approval is
  // opportunistic and may legitimately not happen.
  return { model: input.model, filesWritten: [settingsPath] };
}

const CLAUDE_INSTALL = INSTALL_HINTS.claude!;

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
        ANTHROPIC_MODEL: model,
      },
      clear: [...MANAGED_ENV_KEYS],
    };
  },
};