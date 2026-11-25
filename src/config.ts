import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { provesAiandConfigDir } from "./auth/config-wipe.js";
import { CliError } from "./cli/errors.js";
import { err } from "./cli/output.js";
import { INVALID_KEY_MESSAGE, isValidKeyShape } from "./cli/redact.js";
import { isConfigId, newConfigId } from "./config-files.js";
import { withFileLock } from "./filelock.js";
import {
  configDir,
  configMarkerId,
  PRIVATE_FILE_MODE,
  syncConfigMarker,
  writeFileAtomic,
} from "./fsutil.js";
import type { DpapiFailure, Tier } from "./secrets.js";
import * as secrets from "./secrets.js";

export { agentHome, configDir, writeFileAtomic } from "./fsutil.js";

export const DEFAULT_BASE_URL = "https://api.aiand.com";

/**
 * The command name written into agent config files: profile names, provider
 * ids, auth commands, and ownership markers. A side-by-side second install
 * must not collide with the production entries in the same files, so the
 * launcher can rename it via AIAND_COMMAND_NAME. Only path-free single
 * tokens are honored — the name becomes file names (codex profile) and
 * markers other installs must match byte-for-byte.
 */
export function commandName(): string {
  const raw = process.env.AIAND_COMMAND_NAME;
  return raw !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw) ? raw : "aiand";
}

/** The console page where a key this CLI cannot revoke is revoked by hand. */
export const CONSOLE_KEYS_URL = "https://console.aiand.com/api-keys";

export type Profile = {
  authUrl?: string;
  apiUrl?: string;
  model?: string;
};

export type Config = {
  profile: string;
  profiles: Record<string, Profile>;
  /**
   * Budgets (ticket #74), stored under the `budget` key of config.json.
   * `monthly` and every `harness.<name>` entry are currency-agnostic numbers
   * in the account's billing currency; `currency` records the currency
   * inferred from the store's cost rows when the budget was set (null when
   * the store had no currency yet). Absent keys simply mean "unset".
   */
  budget?: BudgetConfig;
  /** Names this install; the `.aiand-config` marker in the same dir carries the same id. */
  config_id?: string;
};

/** The `budget` section of config.json (see Config.budget). */
export type BudgetConfig = {
  monthly?: number;
  harness?: Record<string, number>;
  warnPct?: number;
  currency?: string | null;
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

/**
 * The endpoints a stored credential was issued for, normalized by
 * normalizeBaseUrl. Its key is only ever sent to these two, and its refresh
 * token only to auth_url: a later --base-url, AIAND_BASE_URL, AIAND_AUTH_URL
 * or `config set` pointing elsewhere is refused instead of honoured.
 */
export type CredentialBinding = { auth_url: string; api_url: string };

export type Credential = {
  origin?: CredentialOrigin;
  /** Absent only on credentials saved before 0.8; see legacyBinding. */
  bound_to?: CredentialBinding;
  expires_at?: number;
  user?: { id: string; email: string };
  org?: { id: string; name: string };
  /** Filled in by saveCredential with the tier the store actually used. */
  storage?: Tier;
  /** Why a Windows secret sits in the file tier instead of DPAPI, so a read
   * does not start PowerShell to find out again. Constrained Language Mode is
   * policy and is not retried on read; "unavailable" (a PowerShell that hung,
   * timed out or failed) is retried once `dpapi_retry_after` has passed. The
   * next sign-in tries DPAPI again either way. */
  storage_fallback?: DpapiFailure;
  /** Epoch ms before which a read does not try DPAPI again after "unavailable". */
  dpapi_retry_after?: number;
  /** Written as false when the file tier's owner-only ACL could not be applied
   * on Windows, so `status` can say the file is not owner-only. Absent otherwise. */
  owner_only?: false;
};

/** A reassembled credential: the stored metadata plus the decrypted blob. */
export type LoadedCredential = Credential & { access_token: string; refresh_token?: string };

const DEFAULT_PROFILE: Profile = {};

/**
 * #100: the fallback warning fires once per requested profile name per
 * process — some flows (e.g. login passing profile.name back through
 * resolveProfile) resolve an already-resolved name repeatedly.
 */
const warnedProfileFallbacks = new Set<string>();

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

/**
 * The stored `budget` section, sanitized: only finite positive numbers are
 * kept (a hand-edited or legacy malformed value degrades to unset rather
 * than poisoning the forecast math), harness names are non-empty strings,
 * and warnPct is clamped to 1–100.
 */
function sanitizeBudget(raw: unknown): BudgetConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const input = raw as Record<string, unknown>;
  const budget: BudgetConfig = {};
  if (typeof input.monthly === "number" && Number.isFinite(input.monthly) && input.monthly > 0) {
    budget.monthly = input.monthly;
  }
  if (typeof input.harness === "object" && input.harness !== null) {
    const harness: Record<string, number> = {};
    for (const [name, value] of Object.entries(input.harness)) {
      if (name && typeof value === "number" && Number.isFinite(value) && value > 0) {
        harness[name] = value;
      }
    }
    if (Object.keys(harness).length > 0) budget.harness = harness;
  }
  if (typeof input.warnPct === "number" && Number.isFinite(input.warnPct)) {
    budget.warnPct = Math.min(100, Math.max(1, Math.round(input.warnPct)));
  }
  if (typeof input.currency === "string" && input.currency) budget.currency = input.currency;
  else if (input.currency === null) budget.currency = null;
  return Object.keys(budget).length > 0 ? budget : undefined;
}

export function loadConfig(): Config {
  const raw = readJson<Partial<Config>>(configPath());
  const budget = sanitizeBudget(raw?.budget);
  return {
    profile: raw?.profile ?? "default",
    profiles: raw?.profiles ?? { default: { ...DEFAULT_PROFILE } },
    ...(budget ? { budget } : {}),
    ...(isConfigId(raw?.config_id) ? { config_id: raw.config_id } : {}),
  };
}

export async function saveConfig(config: Config): Promise<void> {
  // The id that lets `logout --all` tell this dir is aiand's: the one the
  // marker carries (dropped now if there is none), else a fresh one.
  const config_id = config.config_id ?? (await configMarkerId()) ?? newConfigId();
  await writeJson(configPath(), { ...config, config_id }, PRIVATE_FILE_MODE);
  await syncConfigMarker();
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

/**
 * How long a PowerShell that failed to reach DPAPI is left alone. A hung one
 * costs 20 s a try, and every aiand process (Codex starts one per session)
 * would otherwise pay it on its first key read.
 */
const DPAPI_RETRY_MS = 10 * 60_000;

/**
 * The tier fields credentials.json records for a secret just stored in
 * `storage`. Constrained Language Mode is recorded for good: it is policy and
 * will not pass. A PowerShell that timed out or failed to start may work
 * later, so that one carries a time before which reads do not try it again.
 */
function storedIn(
  storage: Tier,
): Pick<Credential, "storage" | "storage_fallback" | "dpapi_retry_after" | "owner_only"> {
  const failure = storage === "file" ? secrets.dpapiUnavailable() : null;
  return {
    storage,
    ...(failure === "clm" ? { storage_fallback: "clm" as const } : {}),
    ...(failure === "unavailable"
      ? { storage_fallback: "unavailable" as const, dpapi_retry_after: Date.now() + DPAPI_RETRY_MS }
      : {}),
    ...(storage === "file" && secrets.fileTierNotOwnerOnly() ? { owner_only: false as const } : {}),
  };
}

/**
 * Whether a read should leave a file-tier credential where it is instead of
 * trying to move it into DPAPI. A retry time more than one interval away is a
 * clock that was set back, not a long wait.
 */
function dpapiBlocked(entry: Credential): boolean {
  if (entry.storage_fallback === "clm") return true;
  if (entry.storage_fallback !== "unavailable") return false;
  const retryAfter = entry.dpapi_retry_after;
  if (typeof retryAfter !== "number") return false;
  const now = Date.now();
  return retryAfter > now && retryAfter <= now + DPAPI_RETRY_MS;
}

/** Store the credential and return the tier that actually holds the blob.
 * `bound_to` records where it was issued; every sign-in path passes it. */
export async function saveCredential(profile: string, credential: LoadedCredential): Promise<Tier> {
  assertSafeProfileName(profile);
  // Every sign-in path and every rotation lands here: a key that could not
  // ride a header is never stored to fail (and echo itself) later.
  if (!isValidKeyShape(credential.access_token)) throw new CliError(INVALID_KEY_MESSAGE);
  const blob = JSON.stringify({
    access_token: credential.access_token,
    refresh_token: credential.refresh_token,
  });
  // storeSecret decides the tier (env override → keychain probe → file) and
  // returns which one it actually used; metadata records that same tier so a
  // caller can never claim a different store than held the blob.
  const storage = await secrets.storeSecret(profile, blob);

  const {
    access_token: _at,
    refresh_token: _rt,
    storage_fallback: _sf,
    dpapi_retry_after: _dr,
    owner_only: _oo,
    ...meta
  } = credential;
  await updateCredentials((all) => {
    // A caller with no binding gets the one already on record, else the profile as
    // stored: never the profile as resolved now, which carries this run's env and
    // flag overrides (see legacyBinding).
    const bound_to =
      storedBinding(credential) ??
      (all[profile] ? storedBinding(all[profile]) : null) ??
      legacyBinding(profile);
    all[profile] = { ...meta, bound_to, ...storedIn(storage) };
  });
  return storage;
}

/** Record a binding on an already-stored credential without touching its secret. */
export async function bindCredential(profile: string, binding: CredentialBinding): Promise<void> {
  assertSafeProfileName(profile);
  await updateCredentials((all) => {
    const entry = all[profile];
    if (entry) all[profile] = { ...entry, bound_to: binding };
  });
}

/** One spelling per endpoint, so a trailing slash or host case never reads as a different origin. */
export function normalizeBaseUrl(url: string): string {
  try {
    return trimSlash(new URL(url).href);
  } catch {
    return trimSlash(url);
  }
}

/**
 * An endpoint as it may be shown in an error, a hint or a note: no username,
 * password, query or fragment. `normalizeBaseUrl` keeps them (they are part of
 * what a request goes to), so anything printed goes through here.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return trimSlash(parsed.href);
  } catch {
    return trimSlash(url)
      .replace(/\/\/[^/@\s]*@/, "//")
      .replace(/[?#].*$/, "");
  }
}

export function bindingFor(profile: { authUrl: string; apiUrl: string }): CredentialBinding {
  return { auth_url: normalizeBaseUrl(profile.authUrl), api_url: normalizeBaseUrl(profile.apiUrl) };
}

/**
 * The binding a pre-0.8 credential gets on first use. It is read from the
 * profile's stored config (config.json, else the production default), never
 * from --base-url / AIAND_BASE_URL / AIAND_AUTH_URL: every credential is
 * unbound on the day of the upgrade, so trusting this run's overrides would
 * leave the takeover open for everyone until their next login. Normal users
 * keep working (their stored URLs are the ones they signed in against);
 * someone who signed in under an env override is refused with a hint and
 * signs in again. The resolution mirrors resolveProfile minus the env.
 */
export function legacyBinding(name: string): CredentialBinding {
  const stored = loadConfig().profiles[name] ?? {};
  const authUrl = typeof stored.authUrl === "string" ? stored.authUrl : DEFAULT_BASE_URL;
  const apiUrl = typeof stored.apiUrl === "string" ? stored.apiUrl : DEFAULT_BASE_URL;
  return bindingFor({ authUrl, apiUrl });
}

/**
 * Where a credential saved before 0.8 (no `bound_to`) may send its key and
 * refresh token: its profile's endpoints in config.json (see legacyBinding),
 * read only from a config.json this install vouches for. With no config.json,
 * or one whose id is not the marker's (copied from another install), nothing
 * here says where the sign-in was issued, so this is null and nothing is sent
 * or pinned. Every place that fallback becomes a request or a binding asks
 * here, so a later write in the dir cannot turn one refusal into a binding
 * somewhere else.
 */
export async function fallbackBinding(name: string): Promise<CredentialBinding | null> {
  return (await provesAiandConfigDir(configDir())) ? legacyBinding(name) : null;
}

/**
 * Where a credential's key and refresh token may go: the endpoints that issued
 * it, whatever --base-url / AIAND_BASE_URL / AIAND_AUTH_URL this run carries,
 * else fallbackBinding. Null when neither says.
 */
export async function issuerBinding(
  name: string,
  credential: Pick<Credential, "bound_to">,
): Promise<CredentialBinding | null> {
  return storedBinding(credential) ?? (await fallbackBinding(name));
}

/** Why a sign-in fallbackBinding has no answer for was not used, and how to recover. */
export function unprovenIssuer(name: string, outcome: string): { message: string; hint: string } {
  return {
    message: `The sign-in for "${name}" does not record where it was issued, and this directory's config.json can't be trusted to say where, so ${outcome}.`,
    hint: `If it is aiand's, revoke its key at ${CONSOLE_KEYS_URL}, then run \`aiand logout --keep-remote --profile ${name}\` to forget it here, and \`aiand login\` to sign in again.`,
  };
}

/** A well-formed bound_to, or null for a legacy or hand-mangled entry. */
export function storedBinding(credential: Pick<Credential, "bound_to">): CredentialBinding | null {
  const b = credential.bound_to as Partial<CredentialBinding> | undefined;
  if (!b || typeof b !== "object") return null;
  if (typeof b.auth_url !== "string" || typeof b.api_url !== "string") return null;
  return { auth_url: b.auth_url, api_url: b.api_url };
}
export type ResolvedProfile = Profile & { name: string; authUrl: string; apiUrl: string };

export function resolveProfile(override?: string): ResolvedProfile {
  const name = activeProfileName(override);
  const config = loadConfig();
  // #100: a mistyped or missing --profile must not silently serve the default
  // profile's data. The fallback stays (automation depends on it), but it
  // warns on stderr so --json stdout remains parseable. The warning fires
  // only when a profile was explicitly requested, not for the default flow.
  // #103: AIAND_PROFILE must warn too — the env form is as explicit a request
  // as the flag, so it gets the same stderr warning (still once per process).
  const explicit = override ?? (process.env.AIAND_PROFILE?.trim() || undefined);
  if (explicit !== undefined && explicit !== "" && !Object.hasOwn(config.profiles, name)) {
    if (!warnedProfileFallbacks.has(explicit)) {
      warnedProfileFallbacks.add(explicit);
      err(
        `Warning: profile "${explicit}" is not defined in ${configPath()}; ` +
          "falling back to the built-in defaults (empty profile: env vars and global settings only).",
      );
    }
  }
  const stored = config.profiles[name] ?? { ...DEFAULT_PROFILE };
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

/** Pin a credential saved before 0.8 to the profile's endpoints as stored now. */
async function pinLegacyBinding(name: string): Promise<void> {
  const entry = (await loadAllCredentials())[name];
  if (!entry || storedBinding(entry)) return;
  const binding = await fallbackBinding(name);
  if (!binding) {
    const { message, hint } = unprovenIssuer(name, "its endpoints were not changed");
    throw new CliError(message, { hint });
  }
  await bindCredential(name, binding);
}

export async function updateProfile(name: string, patch: Partial<Profile>): Promise<void> {
  assertSafeProfileName(name);
  // Before the write: an unbound credential is judged by the stored URLs, so
  // `config set api-url B` would otherwise move where its key is allowed to go.
  if (patch.apiUrl !== undefined || patch.authUrl !== undefined) await pinLegacyBinding(name);
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
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new CliError(`Base URL must be an origin without a query or fragment (got "${url}").`, {
      hint: "The CLI appends /v1/... itself — pass e.g. https://api.aiand.com, not https://api.aiand.com/?x=1.",
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

const credentialsLockPath = (): string => join(configDir(), "credentials.lock");

/** credentials.json as it stands, validated, with legacy inline secrets left in place. */
function readCredentialsFile(): Record<string, StoredCredential> {
  const all = readJson<Record<string, StoredCredential>>(credentialsPath()) ?? {};
  if (typeof all !== "object" || all === null || Array.isArray(all)) {
    throw new CliError(`${credentialsPath()} does not hold a credentials object.`, {
      hint: "Fix it by hand, or delete it to start over.",
    });
  }
  for (const [profile, entry] of Object.entries(all)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CliError(
        `Credential for profile "${profile}" in ${credentialsPath()} is not valid.`,
        {
          hint: "Fix it by hand, or delete it to start over.",
        },
      );
    }
  }
  return all;
}

/**
 * Read-modify-write credentials.json under a cross-process lock, on a fresh
 * read: a snapshot taken before a slow step (a PowerShell start) would
 * otherwise overwrite whatever another aiand process saved in the meantime.
 * Keep slow work outside `mutate`. The file goes away when the last
 * credential does.
 */
async function updateCredentials(
  mutate: (all: Record<string, StoredCredential>) => void,
): Promise<void> {
  await withFileLock(credentialsLockPath(), async () => {
    const all = readCredentialsFile();
    mutate(all);
    if (Object.keys(all).length > 0) {
      await writeJson(credentialsPath(), all, PRIVATE_FILE_MODE);
      return;
    }
    try {
      unlinkSync(credentialsPath());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  });
}

export async function loadAllCredentials(): Promise<Record<string, StoredCredential>> {
  const all = readCredentialsFile();
  const migrated: Record<string, StoredCredential> = {};
  for (const [profile, entry] of Object.entries(all)) {
    // Legacy shape: the secret lived inline in credentials.json. Move it
    // into the active tier store; every existing credential was device-minted.
    if (entry.access_token !== undefined) {
      const blob = JSON.stringify({
        access_token: entry.access_token,
        refresh_token: entry.refresh_token,
      });
      const storage = await secrets.storeSecret(profile, blob);
      const {
        access_token: _at,
        refresh_token: _rt,
        storage_fallback: _sf,
        dpapi_retry_after: _dr,
        owner_only: _oo,
        ...meta
      } = entry;
      all[profile] = { ...meta, origin: CREDENTIAL_ORIGIN.DEVICE, ...storedIn(storage) };
      migrated[profile] = all[profile];
    }
  }
  if (Object.keys(migrated).length > 0) {
    await updateCredentials((current) => {
      for (const [profile, entry] of Object.entries(migrated)) {
        // Another process may have migrated or replaced it first.
        if (current[profile]?.access_token !== undefined) current[profile] = entry;
      }
    });
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

  if (
    entry.storage === "file" &&
    !dpapiBlocked(entry) &&
    (await secrets.detectTier()) === "dpapi"
  ) {
    // Windows sign-ins from before the DPAPI tier: move them in on first read.
    const result = await secrets.migrateToDpapi(profile, blob);
    // "changed": another process signed in or logged out meanwhile; its
    // record is the truth, not this read. A failure is recorded, so that the
    // next process's read does not start PowerShell to find out again.
    if (result !== "changed") {
      const record = (target: Credential) => {
        if (result === "moved") {
          target.storage = "dpapi";
          delete target.storage_fallback;
          delete target.dpapi_retry_after;
          return;
        }
        target.storage_fallback = result;
        if (result === "unavailable") target.dpapi_retry_after = Date.now() + DPAPI_RETRY_MS;
        else delete target.dpapi_retry_after;
      };
      await updateCredentials((current) => {
        const live = current[profile];
        if (live?.storage === "file") record(live);
      });
      record(entry);
    }
  }

  return {
    ...entry,
    access_token: secret.access_token,
    ...(secret.refresh_token ? { refresh_token: secret.refresh_token } : {}),
  };
}

export async function clearCredential(profile: string): Promise<void> {
  readCredentialsFile();
  await secrets.deleteSecret(profile);
  await updateCredentials((all) => {
    delete all[profile];
  });
}

// Show the `sk-` prefix plus a few characters at each end; a key too short to
// leave anything hidden in the middle is masked whole.
const MASK_HEAD = 7;
const MASK_TAIL = 4;

export function maskKey(key: string): string {
  if (key.length <= MASK_HEAD + MASK_TAIL) return "sk-***";
  return `${key.slice(0, MASK_HEAD)}...${key.slice(-MASK_TAIL)}`;
}
