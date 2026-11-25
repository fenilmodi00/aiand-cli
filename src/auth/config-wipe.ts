import { lstat, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  CONFIG_DIRS,
  CONFIG_FILES,
  CONFIG_MARKER_FILE,
  holdsAiandConfig,
  mayMarkConfigDir,
  readConfigId,
  readMarkerId,
  SIGN_IN_STORE_FILES,
  STRAY_TEMP,
} from "../config-files.js";

/**
 * What `logout --all` deletes from a config dir, and the proof it needs
 * first. Deletion is by name, so the name alone never earns it: the dir must
 * prove it is aiand's, and a subdirectory we only share a name with (`locks`,
 * `snapshots`) is emptied of aiand's entries, never removed whole, while one
 * aiand owns (`compare-runs`, `tasks`) goes whole.
 */

/** withFileLock's files in `locks/`: one per profile's token refresh, and the store sync. */
const LOCK_FILE = /^(?:refresh-.+|store-sync(?:\.steal)?)$/;
/** The timestamped capture dirs captureFiles makes inside a snapshot dir. */
const SNAPSHOT_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/;
const SNAPSHOT_STATE_FILES = ["latest.json", "added.json", "git-optin.json"];

/** The files a kept sign-in lives in: its profile (authUrl), metadata and every storage tier. */
export const SIGN_IN_FILES: ReadonlySet<string> = new Set(["config.json", ...SIGN_IN_STORE_FILES]);

export type WipePlan = {
  /** Top-level aiand files to leave: the sign-in a failed revoke still needs for a retry. */
  keep: ReadonlySet<string>;
  /** Agents whose snapshot dir (copies, manifest, added-state) stays. */
  keepSnapshots: ReadonlySet<string>;
};

export type WipeResult = {
  /** The config dir itself is gone. */
  removed: boolean;
  /** Entries that are not aiand's, so nothing touched them. */
  left: string[];
  /** aiand's own entries the plan kept. */
  kept: string[];
};

const isDirectory = async (path: string): Promise<boolean> =>
  (await lstat(path).catch(() => null))?.isDirectory() ?? false;

/** Delete a regular file or link; false for a directory, which is never one of ours by this name. */
async function removeFile(path: string): Promise<boolean> {
  if (await isDirectory(path)) return false;
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  return true;
}

/**
 * Whether `real` is a directory aiand made. A `config.json` that records an id
 * is vouched for by the marker alone, and only by one carrying that id: an
 * empty marker, or one copied from another install, proves nothing. A
 * `config.json` with aiand's schema and no id (an install older than the
 * ids) proves it by its shape. With no usable `config.json`, a marker that
 * names an id counts when the dir holds nothing but aiand's caches (a dir
 * `aiand models` wrote a cache into and nothing else), and an empty dir has
 * nothing to lose. A sign-in file is never vouched for by the marker alone
 * (see `mayMarkConfigDir`), so a dir holding one needs that `config.json`.
 */
export async function provesAiandConfigDir(real: string): Promise<boolean> {
  const [markerId, configId] = await Promise.all([readMarkerId(real), readConfigId(real)]);
  if (configId !== null) return markerId === configId;
  if (await holdsAiandConfig(real)) return true;
  if (markerId !== null && (await mayMarkConfigDir(real).catch(() => false))) return true;
  return (await readdir(real).catch(() => ["?"])).length === 0;
}

/** Whether a dir in `snapshots/` is one aiand's snapshot code made. */
async function isSnapshotDir(path: string): Promise<boolean> {
  if (!(await isDirectory(path))) return false;
  const names = await readdir(path).catch(() => ["?"]);
  if (names.length === 0) return true;
  if (names.some((name) => SNAPSHOT_STATE_FILES.includes(name))) return true;
  return names.every((name) => SNAPSHOT_STAMP.test(name));
}

/** Empty `snapshots/` of aiand's snapshot dirs (minus the kept ones); returns what stayed and why. */
async function wipeSnapshots(
  root: string,
  keepSnapshots: ReadonlySet<string>,
): Promise<{ left: string[]; kept: string[] }> {
  const left: string[] = [];
  const kept: string[] = [];
  const dir = join(root, "snapshots");
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if (keepSnapshots.has(name)) kept.push(`snapshots/${name}`);
    else if (await isSnapshotDir(path)) await rm(path, { recursive: true, force: true });
    else left.push(`snapshots/${name}`);
  }
  await rmdir(dir).catch(() => {});
  return { left, kept };
}

/** Empty `locks/` of aiand's lock files; anything else in it is not ours. */
async function wipeLocks(root: string): Promise<string[]> {
  const left: string[] = [];
  const dir = join(root, "locks");
  for (const name of await readdir(dir)) {
    if (!LOCK_FILE.test(name) || !(await removeFile(join(dir, name)))) left.push(`locks/${name}`);
  }
  await rmdir(dir).catch(() => {});
  return left;
}

/**
 * Remove a directory aiand owns whole (`compare-runs`, `tasks`). False when
 * the name is not a directory of ours (a file or link by that name is left
 * alone) or cannot be removed; the caller reports it as left.
 */
async function removeOwnedDir(path: string): Promise<boolean> {
  if (!(await isDirectory(path))) return false;
  try {
    await rm(path, { recursive: true, force: true });
    return true;
  } catch {
    // A locked or unreadable entry stays; logout --all reports it as left.
    return false;
  }
}

/**
 * Delete what aiand keeps in `real` (a dir `provesAiandConfigDir` vouched
 * for), minus the plan's keeps. The dir goes only when nothing else is in it.
 */
export async function wipeConfigDir(real: string, plan: WipePlan): Promise<WipeResult> {
  const left: string[] = [];
  const kept: string[] = [];
  for (const name of await readdir(real)) {
    const path = join(real, name);
    if (name === CONFIG_MARKER_FILE) continue;
    if (STRAY_TEMP.test(name)) {
      await removeFile(path);
    } else if (CONFIG_FILES.has(name)) {
      if (plan.keep.has(name)) kept.push(name);
      else if (!(await removeFile(path))) left.push(name);
    } else if ((name === "snapshots" || name === "locks") && !(await isDirectory(path))) {
      left.push(name);
    } else if (name === "snapshots") {
      const result = await wipeSnapshots(real, plan.keepSnapshots);
      left.push(...result.left);
      kept.push(...result.kept);
    } else if (name === "locks") {
      left.push(...(await wipeLocks(real)));
    } else if (CONFIG_DIRS.has(name)) {
      // `snapshots` and `locks` were handled above: their names are generic.
      if (!(await removeOwnedDir(path))) left.push(name);
    } else {
      left.push(name);
    }
  }
  if (kept.length === 0) await removeFile(join(real, CONFIG_MARKER_FILE));
  const remaining = await readdir(real);
  if (remaining.length > 0) return { removed: false, left, kept };
  await rmdir(real);
  return { removed: true, left, kept };
}
