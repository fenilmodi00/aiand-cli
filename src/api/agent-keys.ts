import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, writeFileAtomic } from "../config.js";
import { PRIVATE_FILE_MODE } from "../fsutil.js";

/**
 * Which agent owns which API key.
 *
 * The Gateway's /logs rows carry `api_key` but no harness or client field, so
 * the only way to attribute a request to an agent is to remember which key we
 * baked into that agent's config. This file is that memory: the CLI writes it
 * when it wires an agent, and the observability commands read it back.
 * Keys are stored masked (the same shape /logs returns) plus a fingerprint of
 * the full key, so two keys that share a mask are still told apart and the
 * secret never lands on disk.
 *
 * Two kinds of mapping share this file. A CLI-baked key is recorded at `on`
 * time (and on rebake, so rotation never strands history). A native key —
 * one the agent holds in its own credential store, e.g. omp's own `aiand`
 * provider login — is swept on every store sync: the agent may rotate or
 * delete it at any time, so the sweep re-adds whatever is currently present;
 * mappings are never dropped by the sweep, because history under a
 * rotated-away key must stay attributed.
 */
export type AgentKeyRecord = {
  /** Agent id as the registry spells it: "claude", "codex", "opencode", … */
  agent: string;
  /** The masked key, e.g. "sk-abcd...1234" — the same shape /logs returns. */
  masked: string;
  /** SHA-256 of the full key, hex. Identifies the key without storing it. */
  fingerprint: string;
  /** Epoch ms when this mapping was written. */
  at: number;
};

type AgentKeyFile = {
  version: 1;
  keys: AgentKeyRecord[];
};

const AGENT_KEYS_FILE = "agent-keys.json";

export function agentKeysPath(): string {
  return join(configDir(), AGENT_KEYS_FILE);
}

export function maskKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

/**
 * A stable id for the key that does not reveal it. SHA-256 of the full key,
 * first 16 hex chars — enough to tell two keys apart, useless as a secret.
 */
async function keyFingerprint(key: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function readFile(path: string): AgentKeyFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentKeyFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.keys)) return { version: 1, keys: [] };
    return {
      version: 1,
      keys: parsed.keys.filter(
        (entry): entry is AgentKeyRecord =>
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.agent === "string" &&
          typeof entry.masked === "string" &&
          typeof entry.fingerprint === "string",
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, keys: [] };
    // A corrupt map must not break the CLI: observability degrades, the agent
    // keeps working.
    return { version: 1, keys: [] };
  }
}

/**
 * Remember that `agent` is wired with `key`. Idempotent per (agent, key):
 * re-wiring the same agent with the same key updates only the timestamp.
 */
export async function recordAgentKey(agent: string, key: string): Promise<AgentKeyRecord> {
  const fingerprint = await keyFingerprint(key);
  const record: AgentKeyRecord = {
    agent,
    masked: maskKey(key),
    fingerprint,
    at: Date.now(),
  };
  const file = readFile(agentKeysPath());
  const keys = file.keys.filter(
    (entry) => !(entry.agent === agent && entry.fingerprint === fingerprint),
  );
  keys.push(record);
  await writeFileAtomic(agentKeysPath(), `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  return record;
}

/**
 * First-class harness label for the CLI's own traffic: the key `aiand run` /
 * `aiand chat` authenticates with, recorded at store-sync time so a fresh
 * install (empty agent map) stops attributing all of its traffic to
 * "unknown". Never-guess rule untouched: only the key this CLI itself
 * presented gets this label; anything else stays unknown.
 */
export const SELF_AGENT = "aiand-cli";

/**
 * Remember the CLI's own active session key as {@link SELF_AGENT}. Additive
 * and idempotent (same semantics as recordNativeAgentKeys). At read time
 * (`agentsForMaskedKey`) a self entry loses to any agent wired with the same
 * key, so `aiand init`'s labels still win.
 */
export async function recordSelfAgentKey(key: string): Promise<void> {
  if (!key) return;
  await recordNativeAgentKeys(SELF_AGENT, [key]);
}

/** Every remembered key→agent mapping. */
export function listAgentKeys(): AgentKeyRecord[] {
  return readFile(agentKeysPath()).keys;
}

/**
 * Read the key every wired agent currently carries, straight from its own
 * config, and remember the mapping.
 *
 * This is what makes attribution work for agents wired before the map
 * existed: the key is in the agent's config, and the CLI knows how to read
 * each one. An adapter that bakes no key of its own (Codex asks
 * `aiand key export`) returns null and is skipped.
 */
export async function collectBakedKeys(
  adapters: readonly { id: string; bakedKey?: () => Promise<string | null> }[],
): Promise<AgentKeyRecord[]> {
  const records: AgentKeyRecord[] = [];
  for (const adapter of adapters) {
    if (!adapter.bakedKey) continue;
    let key: string | null = null;
    try {
      key = await adapter.bakedKey();
    } catch {
      // A config mid-edit must not break the whole sweep.
      continue;
    }
    if (!key) continue;
    records.push({
      agent: adapter.id,
      masked: maskKey(key),
      fingerprint: await keyFingerprint(key),
      at: Date.now(),
    });
  }
  return records;
}

/**
 * Every agent sharing a masked key, in recording order. A key the CLI baked
 * into several agents (one sign-in, `aiand init` wiring many) is genuinely
 * ambiguous per request — the gateway identifies only the key — so
 * consumers either label such traffic distinctly or keep first-recording
 * order stable for deterministic output.
 */
export function agentsForMaskedKey(masked: string): string[] {
  const agents = readFile(agentKeysPath())
    .keys.filter((entry) => entry.masked === masked)
    .map((entry) => entry.agent);
  // The CLI's own self-entry is the fallback, not a claim: when an agent is
  // wired with the same key, the agent's label wins. Without this, `aiand
  // init` on a key the CLI also uses would re-label every past CLI request.
  const nonSelf = agents.filter((agent) => agent !== SELF_AGENT);
  return nonSelf.length > 0 ? nonSelf : agents;
}

/**
 * The agent that owns a masked key, or undefined when the key was never
 * wired by this CLI (an agent wired by hand, or a key from another machine).
 * When several agents share the key, the first in recording order wins —
 * deterministic, and honest consumers surface the sharing via
 * agentsForMaskedKey.
 */
export function agentForMaskedKey(masked: string): string | undefined {
  return agentsForMaskedKey(masked)[0];
}

/** Drop a mapping — used when an agent is unwired. */
export async function forgetAgentKeys(agent: string): Promise<number> {
  const path = agentKeysPath();
  const file = readFile(path);
  const keys = file.keys.filter((entry) => entry.agent !== agent);
  if (keys.length === file.keys.length) return 0;
  await writeFileAtomic(path, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  return file.keys.length - keys.length;
}

/**
 * Remember an agent's NATIVE key mappings — keys it holds in its own
 * credential store (see AgentAdapter.nativeAiandKeys), which the CLI never
 * baked. Additive and idempotent per (agent, fingerprint): history under a
 * key the agent has since rotated or deleted must STAY attributed, so the
 * sweep never removes entries; `forgetAgentKeys` (`off`) is the only removal
 * path, and a later sync re-adds whatever is still present. Never throws:
 * an unreadable caller state leaves the file as it was.
 */
export async function recordNativeAgentKeys(agent: string, keys: readonly string[]): Promise<void> {
  const path = agentKeysPath();
  const file = readFile(path);
  const existing = new Set(file.keys.map((entry) => `${entry.agent}:${entry.fingerprint}`));
  const additions: AgentKeyRecord[] = [];
  for (const key of keys) {
    if (!key) continue;
    const fingerprint = await keyFingerprint(key);
    if (existing.has(`${agent}:${fingerprint}`)) continue;
    existing.add(`${agent}:${fingerprint}`);
    additions.push({ agent, masked: maskKey(key), fingerprint, at: Date.now() });
  }
  if (additions.length === 0) return;
  await writeFileAtomic(
    path,
    `${JSON.stringify({ version: 1, keys: [...file.keys, ...additions] }, null, 2)}\n`,
    { mode: PRIVATE_FILE_MODE },
  );
}
