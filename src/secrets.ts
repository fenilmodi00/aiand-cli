import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./cli/errors.js";
import { windowsSystemTool } from "./cli/win-spawn.js";
import { withFileLock } from "./filelock.js";
import {
  configDir,
  ownerRestrictionFailedFor,
  PRIVATE_FILE_MODE,
  prepareConfigDir,
  runTool,
  writeFileAtomic,
} from "./fsutil.js";
import {
  fileSet,
  fileTierPaths,
  readStore,
  removeFileEntry,
  type SecretMap,
} from "./secrets-file.js";
import { SECOND_MS } from "./time.js";

export type Tier = "keychain" | "dpapi" | "file" | "plaintext";

const SERVICE = "aiand";
const KEYCHAIN_TIMEOUT_MS = 3 * SECOND_MS;

/**
 * Where secrets live, tried in this order unless AIAND_KEY_STORAGE pins one:
 * the OS store (macOS `security`, Linux Secret Service via `secret-tool`,
 * Windows DPAPI through PowerShell), an AES-256-GCM encrypted file, and a
 * plaintext file only when explicitly requested (tests / CI). Selection
 * never silently falls back to plaintext.
 */

function tierFromEnv(): Tier | null {
  const raw = process.env.AIAND_KEY_STORAGE;
  if (raw === undefined || raw === "") return null;
  if (raw === "keychain" && process.platform === "win32") {
    throw new CliError("AIAND_KEY_STORAGE=keychain is not supported on Windows.", {
      hint: "Use dpapi, file or plaintext.",
    });
  }
  if (raw === "dpapi" && process.platform !== "win32") {
    throw new CliError("AIAND_KEY_STORAGE=dpapi works only on Windows.");
  }
  if (raw === "keychain" || raw === "dpapi" || raw === "file" || raw === "plaintext") return raw;
  throw new CliError(
    `AIAND_KEY_STORAGE must be one of: keychain, dpapi, file, plaintext (got "${raw}").`,
  );
}

// The keychain probe spawns OS tools, so its verdict is cached for the process
// lifetime. The env override is deliberately NOT cached: tests flip it between
// tiers in a single process.
let probedTier: "keychain" | "file" | null = null;

export async function detectTier(): Promise<Tier> {
  const forced = tierFromEnv();
  if (forced) return forced;
  // DPAPI is not probed: a probe would cost a PowerShell start on every
  // run. Its first real use decides, and a failure sticks for the process.
  if (process.platform === "win32") return dpapiFailure === null ? "dpapi" : "file";
  if (probedTier === null) probedTier = (await probeKeychain()) ? "keychain" : "file";
  return probedTier;
}

// The keychain error messages name the tool through this one label.
const keychainTool = (): string => (process.platform === "darwin" ? "security" : "secret-tool");

// Windows has no keychain tier. `secret-tool` would be a bare name the OS tries
// in the current directory first, so no helper spawns anything there.
const NO_KEYCHAIN = "no OS keychain on Windows";

const run = (cmd: string, args: string[], input?: string) =>
  runTool(cmd, args, { input, timeoutMs: KEYCHAIN_TIMEOUT_MS });

/**
 * The command line handed to `security -i` on stdin, so the secret never
 * appears in the child's argv (same-user `ps` can read argv for the child's
 * lifetime). `security` has no stdin flag for the password itself; the -i
 * mode reads whole commands from stdin. POSIX single-quoting keeps the blob
 * one token under a shell-like tokenizer; under a plain whitespace tokenizer
 * the quotes stay literal, the readback in keychainSet then mismatches, and
 * storeSecret falls back to the encrypted file — the blob is never exposed.
 */
const posixQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function securityInteractiveSetCommand(account: string, secret: string): string {
  return `add-generic-password -s ${SERVICE} -a ${posixQuote(account)} -U -w ${posixQuote(secret)}\n`;
}

async function keychainSet(account: string, secret: string): Promise<void> {
  if (process.platform === "win32") throw new Error(NO_KEYCHAIN);
  if (process.platform === "darwin") {
    // `security -i` exit codes are unreliable, so the write counts only when
    // the readback matches. -U replaces an existing item instead of adding a
    // duplicate. On failure storeSecret falls back to the encrypted file;
    // the blob never goes into argv.
    await run("security", ["-i"], securityInteractiveSetCommand(account, secret));
    if ((await keychainGet(account)) !== secret) {
      throw new Error("keychain readback mismatch");
    }
    return;
  }
  const result = await run(
    "secret-tool",
    ["store", "--label=aiand", "service", SERVICE, "account", account],
    secret,
  );
  if (result.code !== 0) {
    throw new Error(`${keychainTool()} could not store the secret (exit ${result.code}).`);
  }
  // A write that cannot be read back is worse than no write.
  if ((await keychainGet(account)) !== secret) {
    throw new Error("keychain readback mismatch");
  }
}

async function keychainGet(account: string): Promise<string> {
  if (process.platform === "win32") throw new Error(NO_KEYCHAIN);
  const result =
    process.platform === "darwin"
      ? await run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"])
      : await run("secret-tool", ["lookup", "service", SERVICE, "account", account]);
  if (result.code !== 0) {
    throw new Error(`${keychainTool()} could not read the secret (exit ${result.code}).`);
  }
  return result.stdout.trim();
}

async function keychainDelete(account: string): Promise<void> {
  if (process.platform === "win32") return;
  const result =
    process.platform === "darwin"
      ? await run("security", ["delete-generic-password", "-s", SERVICE, "-a", account])
      : await run("secret-tool", ["clear", "service", SERVICE, "account", account]);
  if (result.code !== 0) {
    throw new Error(`${keychainTool()} could not delete the secret (exit ${result.code}).`);
  }
}

/**
 * Write, read back, and delete a canary: a tool that exists can still fail
 * behind a headless dbus or a locked keyring. Windows has DPAPI instead.
 */
async function probeKeychain(): Promise<boolean> {
  if (process.platform === "win32") return false;
  const account = `aiand-probe-${randomBytes(8).toString("hex")}`;
  const secret = randomBytes(16).toString("hex");
  try {
    await keychainSet(account, secret);
    return (await keychainGet(account)) === secret;
  } catch {
    return false;
  } finally {
    await keychainDelete(account).catch(() => {});
  }
}

// Each store is a whole-file read-modify-write, and Node interleaves async
// I/O: two concurrent stores (or a store racing a delete) would each read the
// same old map and one update would be lost. Every mutation of a store chains
// through this lock — writeFileAtomic keeps each single write atomic, the
// chain keeps the sequence serial within the process, and the file lock keeps
// it serial across processes (Codex starts one aiand per session, each able
// to migrate a different profile). One lock covers all three stores, so a
// migration can move a secret between two of them atomically. It is not
// re-entrant: code that runs under it must not call back into `serialized`.
// Slow work (PowerShell, and whoami/icacls through prepareConfigDir) stays
// outside, or a waiter would call the lock stale.
let fileTierLock: Promise<void> = Promise.resolve();

const storeLockPath = (): string => join(configDir(), "secret-store.lock");

function serialized<T>(op: () => Promise<T>): Promise<T> {
  const guarded = async () => {
    await prepareConfigDir();
    return withFileLock(storeLockPath(), op);
  };
  const next = fileTierLock.then(guarded, guarded);
  fileTierLock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
export async function storeSecret(profile: string, blob: string): Promise<Tier> {
  const tier = await detectTier();
  if (tier === "plaintext") {
    await serialized(async () => {
      const map = readPlaintextMap();
      map[profile] = blob;
      await writePlaintextMap(map);
    });
    return "plaintext";
  }
  if (tier === "file") {
    await serialized(() => fileSet(profile, blob));
    await dropDpapiEntry(profile);
    return "file";
  }
  if (tier === "dpapi") {
    try {
      await dpapiSet(profile, blob);
    } catch (error) {
      const reason = noteDpapiFailure(error);
      process.stderr.write(
        `Warning: ${DPAPI_FAILURE_TEXT[reason]}; stored in the owner-only file instead.\n`,
      );
      await serialized(() => fileSet(profile, blob));
      await dropDpapiEntry(profile);
      return "file";
    }
    return "dpapi";
  }
  try {
    // keychainSet verifies its own readback; any failure drops to the
    // encrypted file rather than leave the profile unbootable.
    await keychainSet(profile, blob);
    return "keychain";
  } catch {
    process.stderr.write(
      "Warning: OS keychain write failed; stored in the owner-only file instead.\n",
    );
    await serialized(() => fileSet(profile, blob));
    return "file";
  }
}

export async function loadSecret(profile: string, recordedTier?: Tier): Promise<string | null> {
  const tier = recordedTier ?? (await detectTier());
  if (tier === "plaintext") {
    return readPlaintextMap()[profile] ?? null;
  }
  if (tier === "file") {
    const store = await readStore();
    // A migration into DPAPI drops the file copy before credentials.json
    // records the new tier; an interrupted one is still readable.
    return store[profile] ?? (await dpapiGet(profile).catch(() => null));
  }
  if (tier === "dpapi") {
    if (process.platform !== "win32") {
      throw new CliError("This key was stored with Windows DPAPI; sign in again here.", {
        hint: "Run `aiand login`. To keep Windows and this system signed in at once, give this one its own AIAND_CONFIG_DIR.",
      });
    }
    try {
      const secret = await dpapiGet(profile);
      if (secret !== null) return secret;
    } catch (error) {
      noteDpapiFailure(error);
      process.stderr.write(
        "Warning: Windows DPAPI could not decrypt the stored key; run `aiand login` again.\n",
      );
    }
    const store = await readStore();
    return store[profile] ?? null;
  }
  try {
    return await keychainGet(profile);
  } catch {
    // The keychain probe passed but this read failed (locked keyring, dbus
    // hiccup) — the encrypted file is where the fallback write would have
    // landed, so look there before giving up.
    const store = await readStore();
    return store[profile] ?? null;
  }
}

export async function deleteSecret(profile: string): Promise<void> {
  // A Storage tier change strands the old blob (refresh token included):
  // keychain→file or plaintext→file leaves the previous store holding a
  // still-valid session that logout never revokes. Sweep every tier
  // best-effort instead of trusting the recorded one.
  try {
    await keychainDelete(profile);
  } catch {
    // already absent (or no keychain on this machine) — a no-op
  }
  try {
    await dropFileEntry(profile);
  } catch {
    // unreadable/missing store means no residue to remove
  }
  try {
    await dropDpapiEntry(profile);
  } catch {
    // unreadable/missing store means no residue to remove
  }
  try {
    await serialized(async () => {
      const map = readPlaintextMap();
      if (!(profile in map)) return;
      delete map[profile];
      await writePlaintextMap(map);
    });
  } catch {
    // unreadable/missing map means no residue to remove
  }
}

/** How a migration ended: moved, left alone because the secret changed under it, or why DPAPI failed. */
export type Migration = "moved" | "changed" | DpapiFailure;

/**
 * Move a file-tier secret into DPAPI and drop the file copy, but only if the
 * file still holds `blob`: a sign-in or rotation in another process since the
 * caller read it would be overwritten with a stale refresh token. Never falls
 * back or warns, since the caller is only reading.
 */
export async function migrateToDpapi(profile: string, blob: string): Promise<Migration> {
  try {
    return (await dpapiSet(profile, blob, { migrating: true })) ?? "moved";
  } catch (error) {
    return noteDpapiFailure(error);
  }
}

// --- Windows DPAPI tier ------------------------------------------------------
// Each secret is protected for the current Windows user (DPAPI CurrentUser
// scope, bound to the logon credentials) by Windows PowerShell, which ships
// with every Windows and needs no native module. The ciphertext map lives in
// the config dir. The secret crosses into PowerShell base64-encoded on stdin
// only, so no console code page can mangle it and it never reaches argv or
// the environment. One PowerShell start per write or cold read.

/** Why DPAPI could not be used: Constrained Language Mode, or anything else. */
export type DpapiFailure = "clm" | "unavailable";

const DPAPI_STORE_FILE = "secret-store.dpapi.json";
// PowerShell's first start on a cold machine can take several seconds.
const DPAPI_TIMEOUT_MS = 20 * SECOND_MS;
const DPAPI_OUTPUT = "aiand-dpapi:";
const DPAPI_CLM_EXIT = 3;
const DPAPI_FAILURE_TEXT: Record<DpapiFailure, string> = {
  clm: "PowerShell runs in Constrained Language Mode here, which blocks Windows DPAPI",
  unavailable:
    "Windows DPAPI could not be reached through PowerShell (AIAND_KEY_STORAGE=file stops aiand trying)",
};

class DpapiError extends Error {
  readonly reason: DpapiFailure;
  constructor(reason: DpapiFailure) {
    super(DPAPI_FAILURE_TEXT[reason]);
    this.reason = reason;
  }
}

let dpapiFailure: DpapiFailure | null = null;
// Keyed by the ciphertext the plaintext came from: another process rotating
// the token rewrites the ciphertext, and a read under the refresh lock must
// then see the new blob, not this process's copy of the one it replaced.
const dpapiPlaintext = new Map<string, { ciphertext: string; blob: string }>();

/** True when the file tier's dir, store or key could not be made owner-only on Windows. */
export const fileTierNotOwnerOnly = (): boolean => ownerRestrictionFailedFor(fileTierPaths());

/** The DPAPI failure seen in this process, if any. */
export const dpapiUnavailable = (): DpapiFailure | null => dpapiFailure;

function noteDpapiFailure(error: unknown): DpapiFailure {
  dpapiFailure = error instanceof DpapiError ? error.reason : "unavailable";
  return dpapiFailure;
}

/**
 * The -Command script. No double quotes, so the argument survives Windows
 * command-line quoting untouched. -Command text is not subject to execution
 * policy (that governs script files), so no -ExecutionPolicy flag is
 * needed; Constrained Language Mode, which AppLocker and WDAC impose, does
 * block Add-Type and is reported as its own exit code. Protect reads its own
 * output back before answering: a write that cannot be read is worse than
 * none.
 */
export function dpapiScript(op: "Protect" | "Unprotect"): string {
  const pd = "[System.Security.Cryptography.ProtectedData]";
  const verify =
    op === "Protect"
      ? `if ([Convert]::ToBase64String(${pd}::Unprotect($r,$null,$s)) -ne [Convert]::ToBase64String($b)) { exit 4 }`
      : "";
  return [
    "$ErrorActionPreference='Stop'",
    `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit ${DPAPI_CLM_EXIT} }`,
    "Add-Type -AssemblyName System.Security",
    "$s=[System.Security.Cryptography.DataProtectionScope]::CurrentUser",
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    `$r=${pd}::${op}($b,$null,$s)`,
    verify,
    `[Console]::Out.Write('${DPAPI_OUTPUT}'+[Convert]::ToBase64String($r))`,
  ]
    .filter(Boolean)
    .join("; ");
}

export const powershellPath = (): string =>
  windowsSystemTool("WindowsPowerShell/v1.0/powershell.exe", process.env);

async function dpapi(op: "Protect" | "Unprotect", inputBase64: string): Promise<string> {
  // A config dir shared with Windows (WSL, a synced home) can name this tier
  // on a machine that has no PowerShell to ask: never spawn off Windows.
  if (process.platform !== "win32") throw new DpapiError("unavailable");
  let result: { code: number | null; stdout: string };
  try {
    result = await runTool(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-Command", dpapiScript(op)],
      { input: inputBase64, timeoutMs: DPAPI_TIMEOUT_MS },
    );
  } catch {
    throw new DpapiError("unavailable");
  }
  if (result.code === DPAPI_CLM_EXIT) throw new DpapiError("clm");
  const output = result.stdout.match(new RegExp(`${DPAPI_OUTPUT}([A-Za-z0-9+/=]+)`))?.[1];
  if (result.code !== 0 || !output) throw new DpapiError("unavailable");
  return output;
}

/**
 * Protect `blob` and record it. The file-tier copy goes last, and only after
 * a fresh read of the store confirms the entry is there: a lost DPAPI write
 * must never cost the only copy. A file copy that cannot be dropped (a store
 * that no longer decrypts) does not fail a write DPAPI already holds.
 * `migrating` writes only while the file copy still equals `blob`; it
 * returns "changed" when it does not, and nothing then touches either store.
 */
async function dpapiSet(
  profile: string,
  blob: string,
  options: { migrating?: boolean } = {},
): Promise<"changed" | undefined> {
  const ciphertext = await dpapi("Protect", Buffer.from(blob, "utf8").toString("base64"));
  const outcome = await serialized(async (): Promise<"changed" | "raced" | "written"> => {
    if (options.migrating) {
      const fileCopy = (await readStore().catch(() => ({}) as SecretMap))[profile];
      if (fileCopy !== blob) {
        // Gone because a racing migration moved it is fine; anything else changed.
        return fileCopy === undefined && profile in readDpapiMap() ? "raced" : "changed";
      }
    }
    const map = readDpapiMap();
    map[profile] = ciphertext;
    await writeDpapiMap(map);
    if (readDpapiMap()[profile] !== ciphertext) throw new DpapiError("unavailable");
    await removeFileEntry(profile).catch(() => {});
    return "written";
  });
  if (outcome === "changed") return outcome;
  if (outcome === "written") dpapiPlaintext.set(profile, { ciphertext, blob });
  return undefined;
}

async function dpapiGet(profile: string): Promise<string | null> {
  const ciphertext = readDpapiMap()[profile];
  if (ciphertext === undefined) {
    dpapiPlaintext.delete(profile);
    return null;
  }
  const cached = dpapiPlaintext.get(profile);
  if (cached?.ciphertext === ciphertext) return cached.blob;
  const blob = Buffer.from(await dpapi("Unprotect", ciphertext), "base64").toString("utf8");
  dpapiPlaintext.set(profile, { ciphertext, blob });
  return blob;
}

async function dropDpapiEntry(profile: string): Promise<void> {
  dpapiPlaintext.delete(profile);
  await serialized(async () => {
    const map = readDpapiMap();
    if (!(profile in map)) return;
    delete map[profile];
    await writeDpapiMap(map);
  });
}

const writeDpapiMap = (map: SecretMap): Promise<void> =>
  writeFileAtomic(dpapiPath(), `${JSON.stringify(map, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });

const dpapiPath = (): string => join(configDir(), DPAPI_STORE_FILE);

const readDpapiMap = (): SecretMap => readJsonMap(dpapiPath());

const dropFileEntry = (account: string): Promise<void> =>
  serialized(() => removeFileEntry(account));

// --- plaintext tier (AIAND_KEY_STORAGE=plaintext only) ----------------------

const plaintextPath = (): string => join(configDir(), "credentials-plaintext.json");

const readPlaintextMap = (): SecretMap => readJsonMap(plaintextPath());

function readJsonMap(path: string): SecretMap {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SecretMap;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new CliError(`${path} is not valid JSON.`, {
        hint: "Fix it by hand, or delete it to start over.",
      });
    }
    throw error;
  }
}

async function writePlaintextMap(map: SecretMap): Promise<void> {
  await writeFileAtomic(plaintextPath(), `${JSON.stringify(map, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
}
