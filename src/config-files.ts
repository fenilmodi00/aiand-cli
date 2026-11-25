import { randomBytes } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What aiand keeps in its config dir, shared by the code that wipes it
 * (`auth/config-wipe`, by name, once a dir is vouched for) and the predicate
 * here that vouches for a dir with its marker. The wipe lists and the vouch
 * proof are kept apart on purpose: a name in a wipe list is not evidence the
 * directory is aiand's. A leaf module, so neither imports the other.
 */

/** Proof for `logout --all` that a directory is aiand's own. */
export const CONFIG_MARKER_FILE = ".aiand-config";

/**
 * The marker names an install with a random id, and `config.json` records the
 * same id as `config_id`. A file that is empty, or copied from another
 * install, carries nothing that matches, so it cannot vouch for a directory.
 */
const CONFIG_ID = /^[0-9a-f]{32}$/;
const MARKER_ID_LINE = /^id: ([0-9a-f]{32})$/m;
/** A marker or config.json larger than this is not one aiand wrote. */
const MAX_READ_BYTES = 64 * 1024;

export const newConfigId = (): string => randomBytes(16).toString("hex");

export const isConfigId = (value: unknown): value is string =>
  typeof value === "string" && CONFIG_ID.test(value);

export const markerText = (id: string): string =>
  `This directory belongs to the ai& CLI (aiand). \`aiand logout --all\` deletes what aiand keeps here.\nid: ${id}\n`;

/** A regular file's text, or null when it is missing, not a file, or too big to be ours. */
async function readSmallFile(path: string): Promise<string | null> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.size > MAX_READ_BYTES) return null;
  return readFile(path, "utf8").catch(() => null);
}

/** The id in a dir's marker; null for a missing marker, an empty one, or an older one that names none. */
export async function readMarkerId(real: string): Promise<string | null> {
  const text = await readSmallFile(join(real, CONFIG_MARKER_FILE));
  return text === null ? null : (MARKER_ID_LINE.exec(text)?.[1] ?? null);
}

/** The `config_id` recorded in a dir's `config.json`, or null. */
export async function readConfigId(real: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse((await readSmallFile(join(real, "config.json"))) ?? "");
    const id = (parsed as { config_id?: unknown } | null)?.config_id;
    return isConfigId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * The files a sign-in is stored in. Other tools keep files by these names
 * too, and losing one is losing a sign-in, so only a `config.json` of
 * aiand's vouches for them: a marker beside them is never enough.
 */
export const SIGN_IN_STORE_FILES: ReadonlySet<string> = new Set([
  "credentials.json",
  "credentials-plaintext.json",
  "secret-store.json",
  "secret-store.key",
  "secret-store.dpapi.json",
]);

/**
 * Files aiand writes into its config dir, wiped by `auth/config-wipe` once a
 * dir is vouched for. This is a wipe list, never proof a dir is aiand's: it
 * also names files other tools keep (`store.db` and its SQLite sidecars,
 * `agent-keys.json`, `bench-sweep.json`, `welcome.json`). A new sign-in store
 * file goes in SIGN_IN_STORE_FILES.
 */
export const CONFIG_FILES: ReadonlySet<string> = new Set([
  "config.json",
  ...SIGN_IN_STORE_FILES,
  "secret-store.lock",
  "secret-store.lock.steal",
  "credentials.lock",
  "credentials.lock.steal",
  "wired.json",
  "finalize.json",
  "update-check.json",
  "model-catalog.json",
  "opencode-api.json",
  // The local request store (store/index.ts), including the WAL sidecars
  // SQLite produces beside it, and the files the attribution, harness/compare
  // and welcome surfaces keep next to it.
  "store.db",
  "store.db-wal",
  "store.db-shm",
  "agent-keys.json",
  "bench-sweep.json",
  "welcome.json",
]);

/**
 * Directories aiand makes in its config dir, wiped once a dir is vouched for.
 * `locks` also holds the store sync lock (`locks/store-sync`, store/index.ts)
 * beside the refresh locks. Shared with `auth/config-wipe`: `snapshots` and
 * `locks` are generic names, so a wipe only empties them of aiand's entries,
 * while the rest are aiand's own directories and go whole. Like
 * `CONFIG_FILES`, this is not proof: `tasks` and `compare-runs` are names
 * other tools use too.
 */
export const CONFIG_DIRS: ReadonlySet<string> = new Set([
  "snapshots",
  "locks",
  "compare-runs",
  "tasks",
]);

/**
 * The files whose names only aiand uses. One of them is the strong evidence
 * `mayMarkConfigDir` needs before aiand vouches for a dir with its marker, so
 * the wipe list can grow with names other tools share without making those
 * names proof. `snapshots` and `locks` may sit beside that evidence (a cache
 * write makes one), but a directory holding only them or only a v2 name
 * (`store.db`, `agent-keys.json`, `welcome.json`, `bench-sweep.json`,
 * `tasks`, `compare-runs`) is not aiand's to claim.
 */
const VOUCH_FILES: ReadonlySet<string> = new Set([
  "secret-store.lock",
  "secret-store.lock.steal",
  "credentials.lock",
  "credentials.lock.steal",
  "wired.json",
  "finalize.json",
  "update-check.json",
  "model-catalog.json",
  "opencode-api.json",
]);

/** The dirs that may sit beside a vouch file; they never vouch on their own. */
const MARKABLE_DIRS: ReadonlySet<string> = new Set(["snapshots", "locks"]);

/** Leftovers of an interrupted atomic write or key publish. */
export const STRAY_TEMP = /^(?:\.\d+-[0-9a-f]+\.tmp|secret-store\.key\.\d+\.[0-9a-f]+\.tmp)$/;

/** Whether `config.json` has the shape aiand writes: a profile name and a profiles table. */
export async function holdsAiandConfig(real: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(real, "config.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const { profile, profiles } = parsed as { profile?: unknown; profiles?: unknown };
    return (
      typeof profile === "string" &&
      typeof profiles === "object" &&
      profiles !== null &&
      !Array.isArray(profiles)
    );
  } catch {
    return false;
  }
}

/**
 * Whether aiand may vouch for `root` with its marker: its `config.json` has
 * aiand's shape (an install older than the marker), or the dir holds at least
 * one file only aiand writes (`VOUCH_FILES`) and nothing but aiand's own
 * caches, dirs and temp files, a new or empty dir included. A dir holding
 * only the marker is markable too, so an empty or older marker in an
 * otherwise empty dir can be replaced with one that names the install. The
 * wipe lists are deliberately not the proof: `CONFIG_FILES`/`CONFIG_DIRS`
 * also name things other tools keep (`store.db`, `agent-keys.json`,
 * `welcome.json`, `bench-sweep.json`, `tasks`, `compare-runs`), so a dir
 * holding only those could be anyone's and a cache write there must drop no
 * marker. A dir with anything else in it, or a `config.json` of another
 * tool's shape, is someone else's: an `AIAND_CONFIG_DIR` typed as `~/.docker`
 * must stay unproven so `logout --all` refuses it. So is one holding a
 * sign-in file and no `config.json`: sign-in writes `config.json` right after
 * the credential, so aiand's own sign-in files never sit without one for
 * long, and a marker dropped by a cache write must not vouch for another
 * tool's credentials.
 */
export async function mayMarkConfigDir(root: string): Promise<boolean> {
  if (await holdsAiandConfig(root)) return true;
  const names = await readdir(root);
  const vouched =
    names.some((name) => VOUCH_FILES.has(name)) ||
    names.every((name) => name === CONFIG_MARKER_FILE);
  return (
    vouched &&
    names.every(
      (name) =>
        name !== "config.json" &&
        !SIGN_IN_STORE_FILES.has(name) &&
        (name === CONFIG_MARKER_FILE ||
          VOUCH_FILES.has(name) ||
          MARKABLE_DIRS.has(name) ||
          STRAY_TEMP.test(name)),
    )
  );
}
