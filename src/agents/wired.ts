import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { configDir } from "../config.js";
import { PRIVATE_FILE_MODE, writeFileAtomic } from "../fsutil.js";

/**
 * Where each agent was last wired, recorded by `on` so a later profile switch
 * can tell whether the profile's key belongs in that config. It is a second
 * witness beside the base URL an adapter reads back from its own config
 * (`bakedBaseUrl`), which wins when it answers. Agents wired before this file
 * existed have no entry, and a file that is missing or mangled reads the same
 * way: see rebakeForBinding, where "no entry" never means "safe to rebake".
 */
type Wired = Record<string, { profile: string; api_url: string }>;

const wiredPath = (): string => join(configDir(), "wired.json");

async function load(): Promise<Wired> {
  try {
    const parsed: unknown = JSON.parse(await readFile(wiredPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Wired) : {};
  } catch {
    // Missing or mangled: every agent reads as unrecorded, which
    // rebakeForBinding judges by the config itself or leaves alone.
    return {};
  }
}

async function save(wired: Wired): Promise<void> {
  await writeFileAtomic(wiredPath(), `${JSON.stringify(wired, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
}

export async function recordWired(agentId: string, profile: string, apiUrl: string): Promise<void> {
  await save({ ...(await load()), [agentId]: { profile, api_url: apiUrl } });
}

export async function forgetWired(agentId: string): Promise<void> {
  const wired = await load();
  if (!Object.hasOwn(wired, agentId)) return;
  delete wired[agentId];
  await save(wired);
}

export async function wiredApiUrl(agentId: string): Promise<string | null> {
  const entry = (await load())[agentId];
  return typeof entry?.api_url === "string" ? entry.api_url : null;
}

/** Agents recorded as wired for `profile`, with the API origin each was wired to. */
export async function wiredFor(profile: string): Promise<{ agent: string; apiUrl: string }[]> {
  return Object.entries(await load()).flatMap(([agent, entry]) =>
    entry?.profile === profile && typeof entry.api_url === "string"
      ? [{ agent, apiUrl: entry.api_url }]
      : [],
  );
}
