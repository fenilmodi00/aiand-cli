import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * Electron `safeStorage`-compatible secret encryption.
 *
 * Cursor's BYOK API key is not stored as a per-secret OS keychain entry but as
 * an **encrypted blob in the application-scoped `state.vscdb`** (`ItemTable`,
 * key `secret://cursorAuth/openAIKey`), decrypted with Electron `safeStorage`
 * (see Cursor's `BaseSecretStorageService` + `EncryptionMainService`).
 *
 * The value stored is exactly `JSON.stringify(safeStorage.encryptString(plaintext))`,
 * i.e. the JSON form of a Node Buffer — `{"type":"Buffer","data":[...]}` — whose
 * bytes are the platform `safeStorage` ciphertext. This module reproduces that
 * ciphertext so the harness can write a key Cursor can actually read.
 *
 * Platform schemes (matching Chromium's OSCrypt, which Electron `safeStorage`
 * wraps — verified against Chromium's `os_crypt/async/common/algorithm.mojom`
 * and `encryptor.cc`):
 * - macOS:   `v10` + AES-128-CBC. Key = PBKDF2-HMAC-SHA1(masterPw, "saltysalt",
 *            1003, 16). IV = 16×0x20. The master password is a random value in
 *            the login keychain under service "<AppName> Safe Storage".
 * - Windows: `v10` + AES-256-GCM. Layout: `v10(3) + nonce(12) + ciphertext +
 *            tag(16)`. The 32-byte key is DPAPI-protected
 *            (`CryptProtectData`, CurrentUser) and stored base64-encoded under
 *            `os_crypt.encrypted_key` in the `Local State` JSON file (with a
 *            5-byte `"DPAPI"` prefix before the protected blob).
 * - Linux:   `v11` + AES-128-CBC with **1** PBKDF2 iteration when a keyring
 *            (libsecret) holds the master password, else `v10` with the
 *            hardcoded "peanuts" password (the "basic_text" backend) — also
 *            1 iteration. Same KDF/cipher as macOS but with 1 iteration, not
 *            1003 (which is macOS-only).
 *
 * Test seam: when AIAND_IDE_SECRET_PLAINTEXT is set, encrypt/decrypt are the
 * identity (the raw key is stored verbatim). Cursor does NOT read such a
 * value — this is only for exercising the harness's logic headlessly/in CI.
 */

const SALT = "saltysalt";
const MAC_ITERATIONS = 1003;
const LINUX_ITERATIONS = 1;
const KEY_LEN = 16;
const IV = Buffer.alloc(16, 0x20);
const LINUX_BASIC_PASSWORD = "peanuts";

/**
 * The JSON form of an empty Node Buffer — `JSON.stringify(Buffer.alloc(0))`.
 * This is what `safeStorage.encryptString("")` serializes to, and what Cursor
 * leaves in a `secret://` cell when the user clears a key in the IDE. Treated
 * as "no secret" by {@link decryptSecret}.
 */
const EMPTY_BUFFER_JSON = JSON.stringify({ type: "Buffer", data: [] });

/* Windows (Chromium OSCrypt async — AES-256-GCM with a DPAPI-protected key). */
const WIN_VERSION = "v10";
const WIN_NONCE_LEN = 12;
const WIN_TAG_LEN = 16;
const WIN_KEY_LEN = 32;
const DPAPI_PREFIX = "DPAPI";

/**
 * @returns whether the plaintext test seam is active.
 * Strictly `=== "1"` so that `AIAND_IDE_SECRET_PLAINTEXT=0` (or any other
 * value) does NOT enable plaintext — a common footgun with truthy-string
 * env checks. Exported for unit tests.
 */
export function plaintextMode(): boolean {
  return process.env.AIAND_IDE_SECRET_PLAINTEXT === "1";
}

/** Memoized result of {@link linuxSecretServiceReachable} (process-constant). */
let secretServiceReachableMemo: boolean | undefined;

/**
 * Reset memoized Linux Secret Service probes (tests only).
 */
export function resetLinuxSafeStorageDetectionForTests(): void {
  secretServiceReachableMemo = undefined;
}

/**
 * Whether `secret-tool` (libsecret-tools) is on PATH.
 * Ubuntu's `libsecret-tools` does not implement `--version`; a missing binary
 * sets `error` on spawn, while a present binary exits non-zero without args.
 */
export function linuxSecretToolOnPath(): boolean {
  try {
    const r = spawnSync("secret-tool", [], { encoding: "utf8", stdio: "ignore" });
    return !r.error;
  } catch {
    return false;
  }
}

/**
 * Whether the session D-Bus has an owner for org.freedesktop.secrets.
 */
export function linuxDBusSecretServiceHasOwner(): boolean {
  try {
    const res = spawnSync(
      "dbus-send",
      [
        "--session",
        "--print-reply",
        "--dest=org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus.NameHasOwner",
        "string:org.freedesktop.secrets",
      ],
      { encoding: "utf8", timeout: 3000 }
    );
    if (res.error || res.status !== 0) {
      return false;
    }
    return /boolean\s+true/.test(res.stdout || "");
  } catch {
    return false;
  }
}

/**
 * Best-effort probe for a reachable Freedesktop Secret Service on Linux.
 * Requires `secret-tool` on PATH and/or a session D-Bus owner for
 * `org.freedesktop.secrets`.
 */
export function linuxSecretServiceReachable(): boolean {
  if (secretServiceReachableMemo !== undefined) {
    return secretServiceReachableMemo;
  }
  if (process.platform !== "linux") {
    secretServiceReachableMemo = false;
    return false;
  }
  secretServiceReachableMemo =
    linuxSecretToolOnPath() || linuxDBusSecretServiceHasOwner();
  return secretServiceReachableMemo;
}

/**
 * On Linux, Electron `safeStorage` (and thus Cursor) only encrypts when
 * a Secret Service implementation (libsecret/gnome-keyring/kwallet) is
 * available to hold the master password. Without it, Chromium falls back to
 * the hardcoded "peanuts" password — i.e. the stored secret is **obfuscated,
 * not encrypted**. Detect that so we can report it. Memoized because platform
 * and Secret Service availability do not change mid-process and this is called
 * a few times per on/status run.
 */
export function linuxSafeStorageIsObfuscatedFallback(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  return !linuxSecretServiceReachable();
}

/**
 * Whether a Linux safeStorage ciphertext JSON blob was produced with the
 * basic_text ("peanuts") backend (v10) rather than a keyring master password (v11).
 */
export function linuxEncryptUsesBasicTextBackend(encryptedJson: string): boolean {
  if (process.platform !== "linux" || plaintextMode()) {
    return false;
  }
  try {
    const parsed = JSON.parse(encryptedJson) as { data?: unknown };
    if (!parsed || !Array.isArray(parsed.data)) {
      return false;
    }
    const blob = Buffer.from(parsed.data as number[]);
    return blob.length >= 3 && blob.subarray(0, 3).toString("latin1") === "v10";
  } catch {
    return false;
  }
}

/**
 * Electron app name for the variant. Cursor's keychain item is "Cursor Safe
 * Storage".
 * @param {"cursor"} variant
 * @returns {string}
 */
function appNameFor(variant: "cursor"): string {
  return "Cursor";
}

/* -------------------------------------------------------------------------- */
/* OSCrypt AES (macOS + Linux)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Derive the AES-128 key from a master password (Chromium OSCrypt KDF).
 */
function deriveKey(masterPassword: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(masterPassword, SALT, iterations, KEY_LEN, "sha1");
}

/**
 * Chromium OSCrypt AES encryption (macOS `v10`, Linux `v10`/`v11`). Exported for
 * unit tests; production callers go through {@link encryptSecret}.
 */
export function aesEncrypt(
  plaintext: string,
  masterPassword: string,
  version: string,
  iterations: number = MAC_ITERATIONS
): Buffer {
  const key = deriveKey(masterPassword, iterations);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, IV);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from(version, "latin1"), body]);
}

/**
 * Chromium OSCrypt AES decryption (inverse of {@link aesEncrypt}). Exported for
 * unit tests; production callers go through {@link decryptSecret}.
 */
export function aesDecrypt(
  blob: Buffer,
  masterPassword: string,
  iterations: number = MAC_ITERATIONS
): string {
  const key = deriveKey(masterPassword, iterations);
  const body = blob.subarray(3); // strip the 3-byte "vNN" version prefix
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/* -------------------------------------------------------------------------- */
/* macOS — master password from the login keychain                            */
/* -------------------------------------------------------------------------- */

/**
 * Per-process cache of macOS Safe Storage master passwords. Each lookup runs
 * `security find-generic-password`, which can show a Keychain prompt; macOS
 * "Allow" is one-shot, so cursor `on` (decrypt + encrypt + availability checks)
 * used to re-prompt until the user chose "Always Allow".
 */
const macMasterPasswordCache = new Map<string, string>();

/** Test seam: clear cached macOS Safe Storage master passwords. */
export function resetMacMasterPasswordCacheForTests(): void {
  macMasterPasswordCache.clear();
}

/**
 * Read the Safe Storage master password from the macOS login keychain.
 * @param {"cursor"} variant
 * @returns {string} the password, or "" if not found.
 */
function macReadMasterPassword(variant: "cursor"): string {
  const cacheKey = variant;
  if (macMasterPasswordCache.has(cacheKey)) {
    return macMasterPasswordCache.get(cacheKey) ?? "";
  }
  const service = `${appNameFor(variant)} Safe Storage`;
  const r = spawnSync("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    return "";
  }
  const password = (r.stdout || "").replace(/\n$/, "");
  macMasterPasswordCache.set(cacheKey, password);
  return password;
}

/* -------------------------------------------------------------------------- */
/* Linux — master password from libsecret, else "peanuts" (basic backend)      */
/* -------------------------------------------------------------------------- */

/** Chromium OSCrypt v2 libsecret collection schema. */
export const LINUX_OSCRYPT_V2_SCHEMA = "chrome_libsecret_os_crypt_password_v2";

const PYTHON_OSCRYPT_V2_LOOKUP = [
  "import os, sys",
  "app = os.environ.get('FC_OSCRYPT_APPLICATION', '')",
  "schema = os.environ.get('FC_OSCRYPT_SCHEMA', '')",
  "if not app or not schema:",
  "    raise SystemExit(0)",
  "try:",
  "    import secretstorage",
  "except ImportError:",
  "    raise SystemExit(0)",
  "bus = secretstorage.dbus_init()",
  "coll = secretstorage.get_default_collection(bus)",
  "items = list(coll.search_items({'xdg:schema': schema, 'application': app}))",
  "sys.stdout.write(items[0].get_secret().decode() if items else '')",
].join("\n");

/**
 * @param {string[]} attrs flat attribute pairs for `secret-tool lookup`
 * @returns {string}
 */
function linuxSecretToolLookup(attrs: string[]): string {
  if (!linuxSecretToolOnPath()) {
    return "";
  }
  const r = spawnSync("secret-tool", ["lookup", ...attrs], { encoding: "utf8" });
  if (r.status === 0 && (r.stdout || "").length > 0) {
    return r.stdout.replace(/\n$/, "");
  }
  return "";
}

/**
 * Read the Chromium v2 OSCrypt master password scoped to the documented
 * libsecret schema plus an `application` attribute (e.g. `cursor`).
 * @param {string} application
 * @returns {string}
 */
function linuxOsCryptV2PasswordLookup(application: string): string {
  return linuxSecretToolLookup([
    "xdg:schema", LINUX_OSCRYPT_V2_SCHEMA,
    "application", application,
  ]);
}

/**
 * D-Bus/libsecret fallback when `secret-tool` is absent but Secret Service is
 * reachable (e.g. python3-secretstorage installed). Uses the same v2 schema.
 * @param {string} application
 * @returns {string}
 */
function linuxPythonOsCryptV2PasswordLookup(application: string): string {
  if (!linuxDBusSecretServiceHasOwner()) {
    return "";
  }
  const r = spawnSync("python3", ["-c", PYTHON_OSCRYPT_V2_LOOKUP], {
    encoding: "utf8",
    env: {
      ...process.env,
      FC_OSCRYPT_APPLICATION: application,
      FC_OSCRYPT_SCHEMA: LINUX_OSCRYPT_V2_SCHEMA,
    },
  });
  if (r.status === 0 && (r.stdout || "").length > 0) {
    return r.stdout.replace(/\n$/, "");
  }
  return "";
}

/**
 * Chromium v2 libsecret schema stores the OSCrypt master password under an
 * `application` attribute (e.g. `cursor`). Legacy entries use service/account
 * instead. Try both, scoped to this app only.
 * @param {"cursor"} variant
 * @returns {string[]}
 */
function linuxApplicationNameCandidates(variant: "cursor"): string[] {
  const app = appNameFor(variant);
  return [...new Set([app.toLowerCase(), app])];
}

/**
 * Try to read the Safe Storage master password from the Linux keyring. Chromium
 * stores it under libsecret with an `application` attribute (v2 schema) and/or
 * a legacy "<App> Safe Storage" service + account pair. On failure callers fall
 * back to the basic backend.
 * @param {"cursor"} variant
 * @param {{ forEncrypt?: boolean }} [opts]
 *   When `forEncrypt` is true, only use `secret-tool` lookup paths. Python3
 *   secretstorage is a decrypt-only fallback: it can return a stale legacy
 *   password or v2 key Electron would not use for encrypt.
 * @returns {string} the password, or "" when no keyring entry is found.
 */
function linuxReadMasterPassword(
  variant: "cursor",
  { forEncrypt = false } = {}
): string {
  const app = appNameFor(variant);
  const service = `${app} Safe Storage`;
  for (const application of linuxApplicationNameCandidates(variant)) {
    const appPw =
      linuxOsCryptV2PasswordLookup(application) ||
      (forEncrypt ? "" : linuxPythonOsCryptV2PasswordLookup(application));
    if (appPw) {
      return appPw;
    }
  }
  const pw = linuxSecretToolLookup(["service", service, "account", app]);
  if (pw) {
    return pw;
  }
  return "";
}

/* -------------------------------------------------------------------------- */
/* Windows — DPAPI via PowerShell (ProtectedData, CurrentUser)                 */
/* -------------------------------------------------------------------------- */

/**
 * Run a PowerShell snippet that prints a single base64 line, or "" on failure.
 * @param {string} script
 * @returns {string}
 */
function runPowerShell(script: string): string {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" }
  );
  if (r.status !== 0) {
    return "";
  }
  return (r.stdout || "").replace(/\r?\n/g, "").trim();
}

/**
 * DPAPI-protect a raw byte buffer (buffer-based to preserve binary data).
 * The previous string-based round-trip corrupted 32-byte keys because it
 * routed raw bytes through a UTF-8 string (yielding 45 bytes for a 32-byte
 * key with high-bit bytes). This function never touches a text encoding.
 * @param {Buffer} buf
 * @returns {Buffer} DPAPI-protected bytes (empty on failure).
 */
function windowsProtectBuffer(buf: Buffer): Buffer {
  const b64 = buf.toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    `$bytes=[Convert]::FromBase64String('${b64}')`,
    "$enc=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($enc)",
  ].join(";");
  const out = runPowerShell(script);
  return out ? Buffer.from(out, "base64") : Buffer.alloc(0);
}

/**
 * DPAPI-unprotect a raw byte buffer (buffer-based to preserve binary data).
 * Returns the exact bytes DPAPI produces — no UTF-8 conversion — so 32-byte
 * AES-256 keys survive the round-trip.
 * @param {Buffer} blob
 * @returns {Buffer} the decrypted bytes (empty on failure).
 */
function windowsUnprotectBuffer(blob: Buffer): Buffer {
  const b64 = blob.toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    `$bytes=[Convert]::FromBase64String('${b64}')`,
    "$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($dec)",
  ].join(";");
  const out = runPowerShell(script);
  return out ? Buffer.from(out, "base64") : Buffer.alloc(0);
}

/** @param {string} plaintext @returns {Buffer} DPAPI-protected bytes (empty on failure). */
function windowsProtect(plaintext: string): Buffer {
  return windowsProtectBuffer(Buffer.from(plaintext, "utf8"));
}

/** @param {Buffer} blob @returns {string} the decrypted plaintext (empty on failure). */
function windowsUnprotect(blob: Buffer): string {
  const buf = windowsUnprotectBuffer(blob);
  return buf.length > 0 ? buf.toString("utf8") : "";
}

/* -------------------------------------------------------------------------- */
/* Windows — AES-256-GCM with a DPAPI-protected key from `Local State`         */
/* -------------------------------------------------------------------------- */

/**
 * Read the Chromium/Electron `os_crypt` master key from the `Local State` JSON
 * file. The key is base64-encoded under `os_crypt.encrypted_key`, prefixed with
 * a 5-byte `"DPAPI"` marker, then DPAPI-protected (CurrentUser). This function
 * loads, decodes, and DPAPI-unprotects it to a raw 32-byte AES-256 key.
 *
 * @param {string} localStatePath absolute path to the `Local State` file
 * @returns {Buffer} the 32-byte AES-256-GCM key
 * @throws {Error} if the file is missing, the key field is absent, or DPAPI
 *   unprotection fails or yields a wrong-length key.
 */
export function loadWindowsOsCryptKey(localStatePath: string): Buffer {
  let raw: string;
  try {
    raw = readFileSync(localStatePath, "utf8");
  } catch {
    throw new Error(
      `Could not read the "Local State" file at ${localStatePath}. Open Cursor once (it creates the OSCrypt key on first launch) and retry.`
    );
  }
  let parsed: { os_crypt?: { encrypted_key?: unknown } };
  try {
    parsed = JSON.parse(raw) as { os_crypt?: { encrypted_key?: unknown } };
  } catch {
    throw new Error(`The "Local State" file at ${localStatePath} is not valid JSON.`);
  }
  const encKeyB64 = parsed?.os_crypt?.encrypted_key;
  if (!encKeyB64 || typeof encKeyB64 !== "string") {
    throw new Error(
      `The "Local State" file at ${localStatePath} has no os_crypt.encrypted_key. Open Cursor once and retry.`
    );
  }
  const encKey = Buffer.from(encKeyB64, "base64");
  if (encKey.subarray(0, DPAPI_PREFIX.length).toString("latin1") !== DPAPI_PREFIX) {
    // If the prefix is not "DPAPI", this may be App-Bound Encryption (v20),
    // which uses an app-identity DPAPI layer that an external process cannot
    // replicate. Fail clearly rather than producing a corrupt key.
    throw new Error(
      `The OSCrypt key in "Local State" has an unexpected prefix "${encKey.subarray(0, 5).toString("latin1")}" (expected "DPAPI"). App-Bound Encryption may be enabled; this is not yet supported.`
    );
  }
  const dpapiBlob = encKey.subarray(DPAPI_PREFIX.length);
  const key = windowsUnprotectBuffer(dpapiBlob);
  if (key.length !== WIN_KEY_LEN) {
    throw new Error(
      `DPAPI-unprotected OSCrypt key from "Local State" is ${key.length} bytes, expected ${WIN_KEY_LEN}.`
    );
  }
  return key;
}

/**
 * Chromium OSCrypt Windows encryption: `v10` + AES-256-GCM.
 * Layout: `v10(3) + nonce(12) + ciphertext + tag(16)` (tag at the end,
 * confirmed by ground-truth probe against Electron safeStorage on Windows).
 * @param {string} plaintext @param {Buffer} key32 the 32-byte AES-256 key
 * @returns {Buffer}
 */
export function windowsAesGcmEncrypt(plaintext: string, key32: Buffer): Buffer {
  const nonce = crypto.randomBytes(WIN_NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key32, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(WIN_VERSION, "latin1"), nonce, ciphertext, tag]);
}

/**
 * Chromium OSCrypt Windows decryption (inverse of {@link windowsAesGcmEncrypt}).
 * @param {Buffer} blob @param {Buffer} key32
 * @returns {string}
 */
export function windowsAesGcmDecrypt(blob: Buffer, key32: Buffer): string {
  const nonce = blob.subarray(WIN_VERSION.length, WIN_VERSION.length + WIN_NONCE_LEN);
  const tag = blob.subarray(blob.length - WIN_TAG_LEN);
  const ciphertext = blob.subarray(
    WIN_VERSION.length + WIN_NONCE_LEN,
    blob.length - WIN_TAG_LEN
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", key32, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

type SecretOpts = { variant?: "cursor"; localStatePath?: string };

/**
 * Encrypt a secret into the exact string Cursor stores in `state.vscdb`
 * (`JSON.stringify(safeStorage.encryptString(value))`).
 * @param {string} plaintext
 * @param {SecretOpts} [opts] `localStatePath` is required on Windows (path to
 *   the `Local State` file, which holds the DPAPI-protected AES-256 key).
 * @returns {string}
 */
export function encryptSecret(plaintext: string, { variant, localStatePath }: SecretOpts = {}): string {
  if (plaintextMode()) {
    return plaintext;
  }
  const platform = os.platform();
  const v = variant ?? "cursor";
  if (platform === "darwin") {
    const pw = macReadMasterPassword(v);
    if (!pw) {
      throw new Error(secretEncryptionUnavailableMessage(v));
    }
    return JSON.stringify(aesEncrypt(plaintext, pw, "v10", MAC_ITERATIONS));
  }
  if (platform === "win32") {
    if (!localStatePath) {
      throw new Error("A Local State path is required to encrypt a secret on Windows.");
    }
    const key32 = loadWindowsOsCryptKey(localStatePath);
    const enc = windowsAesGcmEncrypt(plaintext, key32);
    return JSON.stringify(enc);
  }
  // linux / others
  const keyringPw = linuxReadMasterPassword(v, { forEncrypt: true });
  if (keyringPw) {
    // Chromium OSCrypt Linux with a keyring: v11 + 1 PBKDF2 iteration.
    return JSON.stringify(aesEncrypt(plaintext, keyringPw, "v11", LINUX_ITERATIONS));
  }
  // basic_text backend (no keyring): v10 + hardcoded "peanuts" password, 1 iteration.
  return JSON.stringify(aesEncrypt(plaintext, LINUX_BASIC_PASSWORD, "v10", LINUX_ITERATIONS));
}

/**
 * Decrypt a value read from `state.vscdb` (the JSON form of the safeStorage
 * ciphertext) back to plaintext. Returns "" when it can't be decrypted.
 * @param {string} stored
 * @param {SecretOpts} [opts] `localStatePath` is required on Windows (path to
 *   the `Local State` file, which holds the DPAPI-protected AES-256 key).
 * @returns {string}
 */
export function decryptSecret(stored: string, { variant, localStatePath }: SecretOpts = {}): string {
  if (stored === "" || stored == null) {
    return "";
  }
  const v = variant ?? "cursor";
  if (plaintextMode()) {
    // The empty-buffer marker (`{"type":"Buffer","data":[]}`) is the encrypted
    // form of "" in real mode; treat it as "" here too, so an IDE-cleared key
    // decrypts to "no key" the same way under the plaintext seam.
    return stored === EMPTY_BUFFER_JSON ? "" : stored;
  }
  let blob: Buffer;
  try {
    const parsed = JSON.parse(stored) as { data?: unknown };
    if (!parsed || !Array.isArray(parsed.data)) {
      return "";
    }
    blob = Buffer.from(parsed.data as number[]);
  } catch {
    return "";
  }
  // An empty ciphertext is the "no key" shape Cursor writes when the user
  // clears a key in the IDE — there's nothing to decrypt.
  if (blob.length === 0) {
    return "";
  }
  try {
    const platform = os.platform();
    if (platform === "win32") {
      if (!localStatePath) {
        return "";
      }
      const key32 = loadWindowsOsCryptKey(localStatePath);
      return windowsAesGcmDecrypt(blob, key32);
    }
    const version = blob.subarray(0, 3).toString("latin1");
    let pw: string;
    let iterations: number;
    if (platform === "darwin") {
      pw = macReadMasterPassword(v);
      iterations = MAC_ITERATIONS;
    } else if (version === "v11") {
      // Linux keyring: v11 + keyring master password + 1 iteration.
      pw = linuxReadMasterPassword(v);
      iterations = LINUX_ITERATIONS;
    } else {
      // Linux basic_text: v10 + "peanuts" + 1 iteration.
      pw = LINUX_BASIC_PASSWORD;
      iterations = LINUX_ITERATIONS;
    }
    if (!pw) {
      return "";
    }
    return aesDecrypt(blob, pw, iterations);
  } catch {
    return "";
  }
}

/**
 * Whether the harness can produce a blob Cursor will decrypt on this machine.
 * @param {SecretOpts} [opts]
 * @returns {boolean}
 */
export function isSecretEncryptionAvailable({ variant, localStatePath }: SecretOpts = {}): boolean {
  if (plaintextMode()) {
    return true;
  }
  const v = variant ?? "cursor";
  const platform = os.platform();
  if (platform === "darwin") {
    return macReadMasterPassword(v).length > 0;
  }
  if (platform === "win32") {
    // Require a readable Local State with a loadable OSCrypt key. If the key
    // is missing Cursor hasn't launched yet — `on` should fail with the
    // actionable "open Cursor once" message rather than failing mid-encrypt.
    if (!localStatePath) {
      return false;
    }
    try {
      loadWindowsOsCryptKey(localStatePath);
      return true;
    } catch {
      return false;
    }
  }
  // linux: the basic_text backend always works ("peanuts"); a keyring is a bonus.
  return true;
}

/**
 * @param {"cursor"} variant
 * @returns {string}
 */
export function secretEncryptionUnavailableMessage(variant: "cursor"): string {
  const app = appNameFor(variant);
  const platform = os.platform();
  if (platform === "darwin") {
    return `Could not read ${app}'s "${app} Safe Storage" key from the login Keychain, so the API key can't be stored where ${app} reads it. Open ${app} once (it creates this key on first launch) and retry.`;
  }
  if (platform === "win32") {
    return `Could not load ${app}'s OSCrypt encryption key from its "Local State" file. Open ${app} once (it creates this key on first launch) and retry.`;
  }
  return `Could not encrypt the ${app} API key for ${app}'s secret storage.`;
}