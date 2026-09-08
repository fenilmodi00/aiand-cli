import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { CliError } from "./cli/errors.js";
import { agentHome, configDir, writeFileAtomic } from "./fsutil.js";
import * as secrets from "./secrets.js";
import type { Tier } from "./secrets.js";

export { agentHome, configDir, writeFileAtomic } from "./fsutil.js";

export const DEFAULT_BASE_URL = "https://api.aiand.com";

export type Profile = {
  authUrl?: string;
  apiUrl?: string;

  model?: string;
};

export type Config = {
  profile: string;
  profiles: Record<string, Profile>;
};

/**
 * What credentials.json holds: metadata only. The secret blob itself (JSON
 * `{access_token, refresh_token}`) lives in the tier store — keychain, AES-256
 * encrypted file, or plaintext (explicit opt-in). `origin` tracks who minted
 * the key so logout knows whether a server-side revoke is ours to do.
 */
export type Credential = {
  origin?: "device" | "paste";

  refresh_token?: string;

  expires_at?: number;
  user?: { id: string; email: string };
  org?: { id: string; name: string };
  /** Filled in by saveCredential with the tier the store actually used. */
  storage?: Tier;
};

/** A reassembled credential: the stored metadata plus the decrypted blob. */
export type LoadedCredential = Credential & { access_token: string };

const DEFAULT_PROFILE: Profile = {};

export const configPath = (): string => join(configDir(), "config.json");
export const credentialsPath = (): string => join(configDir(), "credentials.json");

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (e instanceof SyntaxError) {
      throw new CliError(`${path} is not valid JSON.`, {
        hint: "Fix it by hand, or delete it to start over.",
      });
    }
    throw e;
  }
}

function writeJson(path: string, value: unknown, mode: number): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode });

  chmodSync(path, mode);
}

export function loadConfig(): Config {
  const raw = readJson<Partial<Config>>(configPath());
  return {
    profile: raw?.profile ?? "default",
    profiles: raw?.profiles ?? { default: { ...DEFAULT_PROFILE } },
  };
}

export function saveConfig(config: Config): void {
  writeJson(configPath(), config, 0o600);
}

export function activeProfileName(override?: string): string {
  return override ?? process.env.AIAND_PROFILE ?? loadConfig().profile;
}
export async function saveCredential(
  profile: string,
  credential: LoadedCredential
): Promise<void> {
  const blob = JSON.stringify({ access_token: credential.access_token, refresh_token: credential.refresh_token });
  // storeSecret decides the tier (env override → keychain probe → file) and
  // returns which one it actually used; metadata records that same tier so a
  // caller can never claim a different store than held the blob.
  const storage = await secrets.storeSecret(profile, blob);

  const { access_token: _at, refresh_token: _rt, ...meta } = credential;
  const all = await loadAllCredentials();
  all[profile] = { ...meta, storage };
  writeJson(credentialsPath(), all, 0o600);
}
export type ResolvedProfile = Profile & { name: string; authUrl: string; apiUrl: string };

export function resolveProfile(override?: string): ResolvedProfile {
  const name = activeProfileName(override);
  const stored = loadConfig().profiles[name] ?? { ...DEFAULT_PROFILE };
  const base = process.env.AIAND_BASE_URL;

  return {
    ...stored,
    name,
    authUrl: trimSlash(
      process.env.AIAND_AUTH_URL ?? base ?? stored.authUrl ?? DEFAULT_BASE_URL
    ),
    apiUrl: trimSlash(base ?? stored.apiUrl ?? DEFAULT_BASE_URL),
  };
}

export function updateProfile(name: string, patch: Partial<Profile>): void {
  const config = loadConfig();
  config.profiles[name] = { ...DEFAULT_PROFILE, ...config.profiles[name], ...patch };
  saveConfig(config);
}

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

type StoredCredential = Credential & Partial<LoadedCredential>;

export async function loadAllCredentials(): Promise<Record<string, StoredCredential>> {
  const all = readJson<Record<string, StoredCredential>>(credentialsPath()) ?? {};
  let migrated = false;
  for (const [profile, entry] of Object.entries(all)) {
    // Legacy shape: the token pair lived inline in credentials.json. Move it
    // into the active tier store; every existing credential was device-minted.
    if (entry.access_token !== undefined) {
      const blob = JSON.stringify({ access_token: entry.access_token, refresh_token: entry.refresh_token });
      const storage = await secrets.storeSecret(profile, blob);
      migrated = true;
      const { access_token: _at, refresh_token: _rt, ...meta } = entry;
      all[profile] = { ...meta, origin: "device", storage };
    }
  }
  if (migrated) {
    writeJson(credentialsPath(), all, 0o600);
  }
  return all;
}

export async function loadCredential(profile: string): Promise<LoadedCredential | null> {
  const all = await loadAllCredentials();
  const entry = all[profile];
  if (!entry) return null;

  const blob = await secrets.loadSecret(profile);
  let pair: { access_token?: string; refresh_token?: string };
  if (!blob) return null;
  try {
    pair = JSON.parse(blob) as { access_token?: string; refresh_token?: string };
  } catch {
    return null;
  }
  if (!pair.access_token) return null;

  return {
    ...entry,
    access_token: pair.access_token,
    ...(pair.refresh_token ? { refresh_token: pair.refresh_token } : {}),
  };
}

export async function clearCredential(profile: string): Promise<void> {
  const all = await loadAllCredentials();
  delete all[profile];
  await secrets.deleteSecret(profile);
  if (Object.keys(all).length === 0) {
    try {
      unlinkSync(credentialsPath());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return;
  }
  writeJson(credentialsPath(), all, 0o600);
}

export function maskKey(key: string): string {
  if (key.length <= 11) return "sk-***";
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}
