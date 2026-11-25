import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CliError } from "./cli/errors.js";
import {
  configDir,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  restrictToOwner,
  writeFileAtomic,
} from "./fsutil.js";

/** Account → secret blob, as every tier stores it. */
export type SecretMap = Record<string, string>;

// The encrypted file tier. Callers hold secrets.ts's `serialized` around any
// read-modify-write of it; nothing here takes that lock.
// AES-256-GCM; on-disk format: [version][iv][auth tag][ciphertext]. The
// secrets map is re-encrypted whole-file on every change.
const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const STORE_FORMAT_VERSION = 1;
const IV_OFFSET = 1; // after the version byte
const AUTH_TAG_OFFSET = IV_OFFSET + IV_BYTES;
const CIPHERTEXT_OFFSET = AUTH_TAG_OFFSET + AUTH_TAG_BYTES;
const MASTER_KEY_HEX = new RegExp(`^[0-9a-fA-F]{${KEY_BYTES * 2}}$`);

const SECRET_STORE_FILE = "secret-store.json";
const SECRET_KEY_FILE = "secret-store.key";
/** What a file-tier credential lives in: the dir, the store and its key. */
export const fileTierPaths = (): string[] => [
  configDir(),
  join(configDir(), SECRET_STORE_FILE),
  join(configDir(), SECRET_KEY_FILE),
];
/** link() errors that mean the filesystem cannot hard-link at all. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);
/** How long a first run waits for a racing run's key write to finish. */
const RACED_KEY_POLL_MS = 20;
const RACED_KEY_POLLS = 25;

/**
 * Wait until another run's `secret-store.key` holds a full key. With link()
 * it always does; the exclusive-create fallback can be caught mid-write.
 * Gives up after RACED_KEY_POLLS, leaving the length check to report it.
 */
async function waitForRacedKey(keyFile: string): Promise<void> {
  for (let poll = 0; poll < RACED_KEY_POLLS; poll += 1) {
    if ((await readFile(keyFile)).length >= KEY_BYTES) return;
    await sleep(RACED_KEY_POLL_MS);
  }
}
const STORE_FILES = `${SECRET_STORE_FILE} and ${SECRET_KEY_FILE}`;

const secretsFilePath = (): string => join(configDir(), SECRET_STORE_FILE);

async function getKeyMaterial(): Promise<Buffer> {
  const envKey = process.env.AIAND_SECRET_STORE_MASTER_KEY;
  if (envKey) {
    if (!MASTER_KEY_HEX.test(envKey)) {
      throw new CliError(
        `AIAND_SECRET_STORE_MASTER_KEY must be ${KEY_BYTES * 2} hex characters (${KEY_BYTES} bytes).`,
      );
    }
    return Buffer.from(envKey, "hex");
  }

  const keyFile = join(configDir(), SECRET_KEY_FILE);
  try {
    const key = await readFile(keyFile);
    if (key.length !== KEY_BYTES) {
      throw new CliError(`${keyFile} must contain exactly ${KEY_BYTES} bytes.`, {
        hint: `Delete ${STORE_FILES} to start over.`,
      });
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const key = randomBytes(KEY_BYTES);
    await mkdir(dirname(keyFile), { recursive: true, mode: PRIVATE_DIR_MODE });
    await restrictToOwner(dirname(keyFile), { dir: true });
    // Two first runs racing here must agree on one key, or the store
    // encrypted under the loser's key can never be read. Write the key to a
    // private temp file, then publish it with link(), which fails if the key
    // already exists: the key file only ever appears complete, so the loser
    // never reads a half-written one.
    const staged = `${keyFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(staged, key, { mode: PRIVATE_FILE_MODE, flag: "wx" });
      try {
        await link(staged, keyFile);
      } catch (linkError) {
        // FAT, exFAT, and some network or FUSE mounts have no hard links.
        // An exclusive create still lets exactly one run win; a racer that
        // catches it mid-write waits in waitForRacedKey.
        if (!NO_HARD_LINKS.has((linkError as NodeJS.ErrnoException).code ?? "")) throw linkError;
        await writeFile(keyFile, key, { mode: PRIVATE_FILE_MODE, flag: "wx" });
      }
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code === "EEXIST") {
        await waitForRacedKey(keyFile);
        return getKeyMaterial();
      }
      throw writeError;
    } finally {
      await unlink(staged).catch(() => {});
    }
    return key;
  }
}

async function encryptStore(store: SecretMap): Promise<Buffer> {
  const plaintext = JSON.stringify(store);
  const key = await getKeyMaterial();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const version = Buffer.from([STORE_FORMAT_VERSION]);
  return Buffer.concat([version, iv, authTag, encrypted]);
}

async function decryptStore(data: Buffer): Promise<SecretMap> {
  const version = data[0];
  if (version !== STORE_FORMAT_VERSION) {
    throw new Error(`Unsupported store format version: ${version}`);
  }
  const iv = data.subarray(IV_OFFSET, AUTH_TAG_OFFSET);
  const authTag = data.subarray(AUTH_TAG_OFFSET, CIPHERTEXT_OFFSET);
  const encrypted = data.subarray(CIPHERTEXT_OFFSET);
  const key = await getKeyMaterial();
  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as SecretMap;
}

export async function readStore(): Promise<SecretMap> {
  try {
    const data = await readFile(secretsFilePath());
    return await decryptStore(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    if (error instanceof CliError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code) {
      throw new CliError(
        `${secretsFilePath()}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Wrong-but-valid master key, corrupt ciphertext, bad version, unparseable
    // JSON: all surface here as GCM/format errors. Point at the fix instead of
    // leaking "Unsupported state or unable to authenticate data" as exit 70.
    throw new CliError(`${secretsFilePath()} cannot be decrypted.`, {
      hint: `Check AIAND_SECRET_STORE_MASTER_KEY, or delete ${STORE_FILES} to start over.`,
    });
  }
}

async function writeStore(store: SecretMap): Promise<void> {
  const encrypted = await encryptStore(store);
  await writeFileAtomic(secretsFilePath(), encrypted, { mode: PRIVATE_FILE_MODE });
}

export async function fileSet(account: string, secret: string): Promise<void> {
  const store = await readStore();
  store[account] = secret;
  await writeStore(store);
}

/** Drop an entry from the file store; the caller holds `serialized`. */
export async function removeFileEntry(account: string): Promise<void> {
  const store = await readStore();
  if (!(account in store)) return;
  delete store[account];
  await writeStore(store);
}
