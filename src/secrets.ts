import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { configDir, writeFileAtomic } from "./fsutil.js";
import { CliError } from "./cli/errors.js";

export type Tier = "keychain" | "file" | "plaintext";

const SERVICE = "aiand";
const KEYCHAIN_TIMEOUT_MS = 3000;

type SecretMap = Record<string, string>;

/**
 * Where secrets live, tried in this order unless AIAND_KEY_STORAGE pins one:
 * the OS keychain (macOS `security`, Linux Secret Service via `secret-tool`),
 * an AES-256-GCM encrypted file, and a plaintext file only when explicitly
 * requested (tests / CI). Selection never silently falls back to plaintext.
 */

function tierFromEnv(): Tier | null {
  const raw = process.env.AIAND_KEY_STORAGE;
  if (raw === undefined || raw === "") return null;
  if (raw === "keychain" || raw === "file" || raw === "plaintext") return raw;
  throw new CliError(`AIAND_KEY_STORAGE must be one of: keychain, file, plaintext (got "${raw}").`);
}

// The keychain probe spawns OS tools, so its verdict is cached for the process
// lifetime. The env override is deliberately NOT cached: tests flip it between
// tiers in a single process.
let probedTier: "keychain" | "file" | null = null;

export async function detectTier(): Promise<Tier> {
  const forced = tierFromEnv();
  if (forced) return forced;
  if (probedTier === null) probedTier = (await probeKeychain()) ? "keychain" : "file";
  return probedTier;
}

// Four call sites share this label in error messages — keep them in lockstep.
const keychainTool = (): string => (process.platform === "darwin" ? "security" : "secret-tool");

async function run(
  cmd: string,
  args: string[],
  input?: string
): Promise<{ code: number | null; stdout: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; stdout: string }>();
  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: KEYCHAIN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout }));
  child.stdin.end(input);
  return promise;
}

async function keychainSet(account: string, secret: string): Promise<void> {
  const result =
    process.platform === "darwin"
      ? await run("security", ["add-generic-password", "-s", SERVICE, "-a", account, "-w", secret, "-U"])
      : await run("secret-tool", ["store", `--service=${SERVICE}`, `--account=${account}`], secret);
  if (result.code !== 0) {
    throw new Error(`${keychainTool()} could not store the secret (exit ${result.code}).`);
  }
}

async function keychainGet(account: string): Promise<string> {
  const result =
    process.platform === "darwin"
      ? await run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"])
      : await run("secret-tool", ["lookup", `--service=${SERVICE}`, `--account=${account}`]);
  if (result.code !== 0) {
    throw new Error(`${keychainTool()} could not read the secret (exit ${result.code}).`);
  }
  return result.stdout.trim();
}

async function keychainDelete(account: string): Promise<void> {
  const result =
    process.platform === "darwin"
      ? await run("security", ["delete-generic-password", "-s", SERVICE, "-a", account])
      : await run("secret-tool", ["clear", `--service=${SERVICE}`, `--account=${account}`]);
  if (result.code !== 0) {
    throw new Error(`${keychainTool()} could not delete the secret (exit ${result.code}).`);
  }
}

/**
 * Probe keychain usability by writing, reading back, and deleting a canary —
 * a tool that merely exists can still fail behind a headless dbus or a locked
 * keyring. Returns false on Windows, where no keychain CLI is wired up in v1.
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

export async function storeSecret(profile: string, blob: string): Promise<Tier> {
  const tier = await detectTier();
  if (tier === "plaintext") {
    const map = readPlaintextMap();
    map[profile] = blob;
    writePlaintextMap(map);
    return "plaintext";
  }
  if (tier === "file") {
    await fileSet(profile, blob);
    return "file";
  }
  try {
    await keychainSet(profile, blob);
    // A write that cannot be read back is worse than no write: drop to the
    // encrypted file rather than leave the profile unbootable.
    if ((await keychainGet(profile)) !== blob) throw new Error("keychain readback mismatch");
    return "keychain";
  } catch {
    await fileSet(profile, blob);
    return "file";
  }
}

export async function loadSecret(profile: string): Promise<string | null> {
  const tier = await detectTier();
  if (tier === "plaintext") {
    return readPlaintextMap()[profile] ?? null;
  }
  if (tier === "file") {
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
  const tier = await detectTier();
  if (tier === "plaintext") {
    const map = readPlaintextMap();
    if (!(profile in map)) return;
    delete map[profile];
    writePlaintextMap(map);
    return;
  }
  if (tier === "file") {
    const store = await readStore();
    if (!(profile in store)) return;
    delete store[profile];
    await writeStore(store);
    return;
  }
  try {
    await keychainDelete(profile);
  } catch {
    // already absent — deleting a missing secret is a no-op
  }
}

// --- encrypted file tier ---------------------------------------------------
// AES-256-GCM; on-disk format: [version=1][iv 12][tag 16][ciphertext]. The
// secrets map is re-encrypted whole-file on every change.

const secretsFilePath = (): string => join(configDir(), "secret-store.json");

async function getKeyMaterial(): Promise<Buffer> {
  const envKey = process.env.AIAND_SECRET_STORE_MASTER_KEY;
  if (envKey) {
    if (envKey.length !== 64) {
      throw new CliError("AIAND_SECRET_STORE_MASTER_KEY must be 64 hex characters (32 bytes).");
    }
    return Buffer.from(envKey, "hex");
  }

  const keyFile = join(configDir(), "secret-store.key");
  try {
    const key = await readFile(keyFile);
    if (key.length !== 32) {
      throw new Error("Key file must contain exactly 32 bytes");
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const key = randomBytes(32);
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    await writeFile(keyFile, key, { mode: 0o600 });
    return key;
  }
}

async function encryptStore(store: SecretMap): Promise<Buffer> {
  const plaintext = JSON.stringify(store);
  const key = await getKeyMaterial();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const version = Buffer.from([1]);
  return Buffer.concat([version, iv, authTag, encrypted]);
}

async function decryptStore(data: Buffer): Promise<SecretMap> {
  const version = data[0];
  if (version !== 1) {
    throw new Error(`Unsupported store format version: ${version}`);
  }
  const iv = data.subarray(1, 13);
  const authTag = data.subarray(13, 29);
  const encrypted = data.subarray(29);
  const key = await getKeyMaterial();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as SecretMap;
}

async function readStore(): Promise<SecretMap> {
  try {
    const data = await readFile(secretsFilePath());
    return await decryptStore(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeStore(store: SecretMap): Promise<void> {
  const encrypted = await encryptStore(store);
  await writeFileAtomic(secretsFilePath(), encrypted, { mode: 0o600 });
}

async function fileSet(account: string, secret: string): Promise<void> {
  const store = await readStore();
  store[account] = secret;
  await writeStore(store);
}

// --- plaintext tier (AIAND_KEY_STORAGE=plaintext only) ----------------------

const plaintextPath = (): string => join(configDir(), "credentials-plaintext.json");

function readPlaintextMap(): SecretMap {
  try {
    return JSON.parse(readFileSync(plaintextPath(), "utf8")) as SecretMap;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new CliError(`${plaintextPath()} is not valid JSON.`, {
        hint: "Fix it by hand, or delete it to start over.",
      });
    }
    throw error;
  }
}

function writePlaintextMap(map: SecretMap): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(plaintextPath(), JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
  chmodSync(plaintextPath(), 0o600);
}
