import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./cli/errors.js";
import { configDir, PRIVATE_FILE_MODE, writeFileAtomic } from "./fsutil.js";
import type { Tier } from "./secrets.js";
import * as secrets from "./secrets.js";

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
/** Who minted a stored key: this CLI (device/browser sign-in) or the user (paste). */
export const CREDENTIAL_ORIGIN = { DEVICE: "device", PASTE: "paste" } as const;
export type CredentialOrigin = (typeof CREDENTIAL_ORIGIN)[keyof typeof CREDENTIAL_ORIGIN];

export type Credential = {
  origin?: CredentialOrigin;
  expires_at?: number;
  user?: { id: string; email: string };
  org?: { id: string; name: string };
  /** Filled in by saveCredential with the tier the store actually used. */
  storage?: Tier;
};

/** A reassembled credential: the stored metadata plus the decrypted blob. */
export type LoadedCredential = Credential & { access_token: string; refresh_token?: string };

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

async function writeJson(path: string, value: unknown, mode: number): Promise<void> {
  // writeFileAtomic mkdirs 0700 and preserves/re-tightens the mode, so every
  // metadata write lands whole — readers never see a truncated file.
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

export function loadConfig(): Config {
  const raw = readJson<Partial<Config>>(configPath());
  return {
    profile: raw?.profile ?? "default",
    profiles: raw?.profiles ?? { default: { ...DEFAULT_PROFILE } },
  };
}

export async function saveConfig(config: Config): Promise<void> {
  await writeJson(configPath(), config, PRIVATE_FILE_MODE);
}

export function activeProfileName(override?: string): string {
  const name = override ?? process.env.AIAND_PROFILE ?? loadConfig().profile;
  // Reads guard too: --profile __proto__ must fail here, not route through
  // Object.prototype lookups in resolveProfile / loadCredential.
  assertSafeProfileName(name);
  return name;
}
/**
 * Profile names become keys in credentials.json, file-store accounts, and
 * keychain account strings. `__proto__` (and friends) would route through
 * the Object.prototype setter and silently drop stored metadata, so unsafe
 * names are rejected at the trust boundary: saveCredential / updateProfile.
 */
export function assertSafeProfileName(name: string): void {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name !== name.trim() ||
    name.startsWith(".") ||
    /[/\\:*?"<>|]/.test(name) ||
    Object.hasOwn(Object.prototype, name)
  ) {
    throw new CliError(`Profile name "${name}" is not allowed.`, {
      hint: "Use a plain name: letters, digits, dashes, dots, and underscores.",
    });
  }
}

/** Store the credential and return the tier that actually holds the blob. */
export async function saveCredential(profile: string, credential: LoadedCredential): Promise<Tier> {
  assertSafeProfileName(profile);
  const blob = JSON.stringify({
    access_token: credential.access_token,
    refresh_token: credential.refresh_token,
  });
  // storeSecret decides the tier (env override → keychain probe → file) and
  // returns which one it actually used; metadata records that same tier so a
  // caller can never claim a different store than held the blob.
  const storage = await secrets.storeSecret(profile, blob);

  const { access_token: _at, refresh_token: _rt, ...meta } = credential;
  const all = await loadAllCredentials();
  all[profile] = { ...meta, storage };
  await writeJson(credentialsPath(), all, PRIVATE_FILE_MODE);
  return storage;
}
export type ResolvedProfile = Profile & { name: string; authUrl: string; apiUrl: string };

export function resolveProfile(override?: string): ResolvedProfile {
  const name = activeProfileName(override);
  const stored = loadConfig().profiles[name] ?? { ...DEFAULT_PROFILE };
  const base = process.env.AIAND_BASE_URL;

  // Env and the default are always strings, so a non-string here necessarily
  // came from stored JSON (hand-edited or corrupt). Only the selected value
  // is checked: an env override stays a working escape hatch.
  const rawAuthUrl = process.env.AIAND_AUTH_URL ?? base ?? stored.authUrl ?? DEFAULT_BASE_URL;
  const rawApiUrl = base ?? stored.apiUrl ?? DEFAULT_BASE_URL;
  if (typeof rawAuthUrl !== "string") {
    throw new CliError(`Stored auth-url for profile "${name}" is not a string.`, {
      hint: `Fix it with: aiand config set auth-url <url> --profile "${name}".`,
    });
  }
  if (typeof rawApiUrl !== "string") {
    throw new CliError(`Stored api-url for profile "${name}" is not a string.`, {
      hint: `Fix it with: aiand config set api-url <url> --profile "${name}".`,
    });
  }
  const authUrl = trimSlash(rawAuthUrl);
  const apiUrl = trimSlash(rawApiUrl);
  // Every path funnels through here, so the final URLs are validated here.
  assertHttpsBaseUrl(authUrl);
  assertHttpsBaseUrl(apiUrl);

  return { ...stored, name, authUrl, apiUrl };
}

export async function updateProfile(name: string, patch: Partial<Profile>): Promise<void> {
  assertSafeProfileName(name);
  const config = loadConfig();
  config.profiles[name] = { ...DEFAULT_PROFILE, ...config.profiles[name], ...patch };
  await saveConfig(config);
}

export const trimSlash = (url: string): string => url.replace(/\/+$/, "");
// Read only through Object.hasOwn: a plain `in` or index lookup resolves
// through Object.prototype, so "constructor" would pass as loopback.
const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "::1": true,
};
/** One loopback policy for every http-allowed path; takes `URL.hostname` as-is (IPv6 brackets included). */
export const isLoopbackHost = (host: string): boolean =>
  Object.hasOwn(LOOPBACK_HOSTS, host.replace(/^\[|\]$/g, "").toLowerCase());

/**
 * Base URLs carry API keys, so plain http is rejected except on loopback
 * (local test servers). resolveProfile validates the final URLs; --base-url
 * and `config set` check early through this same helper.
 */
/** https, or http to a loopback host: the base URLs an agent config may route to. */
export function isRoutableBaseUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
    );
  } catch {
    return false;
  }
}

export function assertHttpsBaseUrl(url: string): void {
  // WHATWG URL silently strips surrounding whitespace, so without this check
  // "https://x.example " validates here but later breaks buildUrl's
  // string-concat (new URL(base + path) → TypeError). Reject at set time.
  if (typeof url !== "string" || url !== url.trim()) {
    throw new CliError(`Base URL must not have leading or trailing whitespace (got "${url}").`, {
      hint: "Remove the spaces around the URL and try again.",
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`Base URL must be an absolute https URL (got "${url}").`, {
      hint: "Use https, or http only for loopback (localhost, 127.0.0.1, ::1).",
    });
  }
  // The CLI and every adapter append their own /v1/... paths, so a
  // non-loopback base with a path would double-append and 401 later with
  // no advice. Loopback keeps paths: the mock gateway and other test
  // doubles live under one.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new CliError("Base URL must not embed credentials.", {
      hint: "Pass the key via AIAND_API_KEY or `aiand login` instead of the URL.",
    });
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "" && !isLoopbackHost(parsed.hostname)) {
    throw new CliError(`Base URL must be an origin without a path (got "${url}").`, {
      hint: "The CLI appends /v1/... itself — pass e.g. https://api.aiand.com, not https://api.aiand.com/v1.",
    });
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return;
  throw new CliError(`Base URL must use https (got "${url}").`, {
    hint: "Use https, or http only for loopback (localhost, 127.0.0.1, ::1).",
  });
}

/**
 * Refuse a `/v1`-suffixed base URL at set time: adapters append `/v1`
 * themselves (hermes/codex/opencode reach `/v1/chat/completions` that way),
 * so a suffixed URL doubles to `/v1/v1/...` and the gateway answers with a
 * misdiagnosed 401. Pass the origin instead.
 */
export function assertNoV1Suffix(url: string): void {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return;
  }
  if (pathname.replace(/\/+$/, "").endsWith("/v1")) {
    throw new CliError(`Base URL must not end in "/v1" (got "${url}").`, {
      hint: "Pass the origin instead — ai& appends /v1 where the agent needs it.",
    });
  }
}

/** A credentials.json entry; the secret appears inline only in the legacy shape. */
type StoredCredential = Credential & { access_token?: string; refresh_token?: string };

export async function loadAllCredentials(): Promise<Record<string, StoredCredential>> {
  const all = readJson<Record<string, StoredCredential>>(credentialsPath()) ?? {};
  if (typeof all !== "object" || all === null || Array.isArray(all)) {
    throw new CliError(`${credentialsPath()} does not hold a credentials object.`, {
      hint: "Fix it by hand, or delete it to start over.",
    });
  }
  let migrated = false;
  for (const [profile, entry] of Object.entries(all)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CliError(
        `Credential for profile "${profile}" in ${credentialsPath()} is not valid.`,
        {
          hint: "Fix it by hand, or delete it to start over.",
        },
      );
    }
    // Legacy shape: the secret lived inline in credentials.json. Move it
    // into the active tier store; every existing credential was device-minted.
    if (entry.access_token !== undefined) {
      const blob = JSON.stringify({
        access_token: entry.access_token,
        refresh_token: entry.refresh_token,
      });
      const storage = await secrets.storeSecret(profile, blob);
      migrated = true;
      const { access_token: _at, refresh_token: _rt, ...meta } = entry;
      all[profile] = { ...meta, origin: CREDENTIAL_ORIGIN.DEVICE, storage };
    }
  }
  if (migrated) {
    await writeJson(credentialsPath(), all, PRIVATE_FILE_MODE);
  }
  return all;
}

export async function loadCredential(profile: string): Promise<LoadedCredential | null> {
  const all = await loadAllCredentials();
  const entry = all[profile];
  if (!entry) return null;

  const blob = await secrets.loadSecret(profile, entry.storage);
  let secret: { access_token?: string; refresh_token?: string };
  if (!blob) return null;
  try {
    secret = JSON.parse(blob) as { access_token?: string; refresh_token?: string };
  } catch {
    return null;
  }
  if (!secret.access_token) return null;

  return {
    ...entry,
    access_token: secret.access_token,
    ...(secret.refresh_token ? { refresh_token: secret.refresh_token } : {}),
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
  await writeJson(credentialsPath(), all, PRIVATE_FILE_MODE);
}

// Show the `sk-` prefix plus a few characters at each end; a key too short to
// leave anything hidden in the middle is masked whole.
const MASK_HEAD = 7;
const MASK_TAIL = 4;

export function maskKey(key: string): string {
  if (key.length <= MASK_HEAD + MASK_TAIL) return "sk-***";
  return `${key.slice(0, MASK_HEAD)}...${key.slice(-MASK_TAIL)}`;
}
