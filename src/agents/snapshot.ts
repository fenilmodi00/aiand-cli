import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { CliError } from "../cli/errors.js";
import { configDir, writeFileAtomic } from "../config.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, pathIsInside, restrictToOwner } from "../fsutil.js";
import { fsCliError } from "./managed-file.js";

const MANIFEST_FILE = "latest.json";
/** Files this agent's key was wired into inside a git work tree, on the user's say-so. */
const GIT_OPT_IN_FILE = "git-optin.json";

type SnapshotEntry = {
  path: string;
  backupPath?: string;
  existed: boolean;
  /**
   * The file already carried ai& wiring (our marker or a key) when it was
   * captured, so no copy was kept: it is not a pre-aiand state, and a copy
   * would outlive `off` and logout with the key inside. Restore skips it.
   */
  wired?: true;
};

/**
 * What proves a file already carries ai& wiring: any of these key literals,
 * or the adapter's own marker check. Such a file is never copied.
 */
export type SnapshotGuard = {
  keys?: readonly string[];
  carriesWiring?: (text: string) => boolean;
};

/** Shorter strings are not keys; matching them would flag unrelated files. */
const MIN_KEY_LENGTH = 8;

/** Whether `text` holds one of `keys` or the adapter's marker. */
function holdsWiring(text: string, guard: SnapshotGuard): boolean {
  if (guard.keys?.some((key) => key.length >= MIN_KEY_LENGTH && text.includes(key))) return true;
  return guard.carriesWiring?.(text) ?? false;
}

type SnapshotManifest = {
  createdAt: string;
  files: SnapshotEntry[];
  added?: AddedState;
};

/**
 * What an adapter's enable() recorded so a subtractive off can tell its own
 * values from the user's. Opaque here: each adapter owns its record's shape.
 */
type AddedState = object;

function snapshotDir(agentId: string): string {
  return join(configDir(), "snapshots", agentId);
}

// Windows forbids `:` in filenames, so the ISO timestamp becomes a sortable,
// filesystem-safe directory name. Millisecond precision keeps two snapshots
// of the same agent from colliding.
function snapshotStamp(date: Date): string {
  return date.toISOString().replace(/:/g, "-");
}

/**
 * Flatten an absolute path into one collision-free snapshot copy filename.
 * `~/.config/opencode/opencode.json` -> `.config__opencode__opencode.json`.
 */
function copyNameFor(file: string): string {
  return (
    file
      .replace(/^[a-zA-Z]:/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .join("__") || "file"
  );
}

async function readManifest(agentId: string): Promise<SnapshotManifest | null> {
  const dir = snapshotDir(agentId);
  const manifestPath = join(dir, MANIFEST_FILE);
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw) as SnapshotManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new CliError(`${manifestPath} is not valid JSON.`, {
        hint: `Delete ${dir} to discard the corrupt snapshot and start over.`,
      });
    }
    throw error;
  }
}

/** Capture `files` into a fresh timestamped dir beside the manifest; returns their entries. */
async function captureFiles(
  agentId: string,
  files: string[],
  guard: SnapshotGuard,
): Promise<{ snapDir: string; entries: SnapshotEntry[] }> {
  const dir = snapshotDir(agentId);
  const snapDir = join(dir, snapshotStamp(new Date()));
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(dir, PRIVATE_DIR_MODE);
  await restrictToOwner(dir, { dir: true });
  await mkdir(snapDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(snapDir, PRIVATE_DIR_MODE);

  const entries: SnapshotEntry[] = [];
  for (const file of files) {
    let existed = true;
    try {
      await stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A config path that exists but is unusable (ENOTDIR, EISDIR,
        // EACCES/EPERM) refuses cleanly exit 1, never a raw stack exit 70.
        throw fsCliError(file, error) ?? error;
      }
      existed = false;
    }
    if (!existed) {
      entries.push({ path: file, existed: false });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (error) {
      throw fsCliError(file, error) ?? error;
    }
    if (holdsWiring(bytes.toString("utf8"), guard)) {
      entries.push({ path: file, existed: true, wired: true });
      continue;
    }
    const backupPath = join(snapDir, copyNameFor(file));
    await copyFile(file, backupPath);
    entries.push({ path: file, backupPath, existed: true });
  }
  return { snapDir, entries };
}

/**
 * Snapshot `files` before the agent adapter rewrites them: a timestamped
 * sibling directory holds byte-for-byte copies and `latest.json` (0600) is the
 * manifest `restoreSnapshot` replays. Files that do not exist are recorded
 * with `existed: false` so restore deletes them instead of copying; a file
 * that already carries ai& wiring (`guard`) is recorded without a copy.
 * Returns the snapshot directory; each call replaces the previous manifest.
 */
export async function snapshotFiles(
  agentId: string,
  files: string[],
  guard: SnapshotGuard = {},
): Promise<string> {
  const { snapDir, entries } = await captureFiles(agentId, files, guard);
  const manifest: SnapshotManifest = { createdAt: new Date().toISOString(), files: entries };
  await writeManifest(agentId, manifest);
  return snapDir;
}

/**
 * Bring the snapshot up to `files` without giving up what it already holds:
 * the first pre-aiand capture of a path stays authoritative, so a managed
 * file that moved (PI_CODING_AGENT_DIR, COPILOT_HOME) adds the new path
 * beside the old one instead of replacing it. A path captured as `wired` is
 * retried, since `off` may have stripped it since. Returns true when this
 * call created the snapshot, the only case a failed `on` may discard it.
 */
export async function extendSnapshot(
  agentId: string,
  files: string[],
  guard: SnapshotGuard = {},
): Promise<boolean> {
  const manifest = await readManifest(agentId);
  if (!manifest) {
    await snapshotFiles(agentId, files, guard);
    return true;
  }
  const held = new Map(manifest.files.map((entry) => [resolve(entry.path), entry]));
  const missing = files.filter((file) => {
    const entry = held.get(resolve(file));
    return entry === undefined || entry.wired === true;
  });
  if (missing.length === 0) return false;
  const { entries } = await captureFiles(agentId, missing, guard);
  const fresh = new Map(entries.map((entry) => [resolve(entry.path), entry]));
  manifest.files = [
    ...manifest.files.filter((entry) => !fresh.has(resolve(entry.path))),
    ...entries,
  ];
  await writeManifest(agentId, manifest);
  return false;
}

/** Why restore left a snapshot entry alone. */
export type RestoreSkip = "wired" | "unmanaged";

/**
 * Restore every snapshotted file byte-for-byte (or delete files that did not
 * exist before we touched them), then drop the manifest and snapshot copies.
 * Returns false when there is no manifest — the config was never ours.
 *
 * `allowedFiles` (the adapter's managedFiles) is required at the command
 * boundary so a tampered latest.json cannot copy or delete arbitrary paths:
 * an entry outside it is never written, and stays in the snapshot (a managed
 * file that moved since is restorable again from the shell that names it).
 * Copy sources must also sit inside this agent's snapshot directory.
 * `skipped` hears each entry left alone, and why. `carriesWiring` is the
 * adapter's marker check: a kept path that may still be wired keeps what `on`
 * recorded, since `off` from the shell that names it needs that record.
 */
export async function restoreSnapshot(
  agentId: string,
  allowedFiles: string[],
  skipped?: (path: string, reason: RestoreSkip) => void,
  carriesWiring?: (text: string) => boolean,
): Promise<boolean> {
  const manifest = await readManifest(agentId);
  if (!manifest) return false;

  const snapRoot = await realpath(snapshotDir(agentId));
  const allowed = new Set(allowedFiles.map((file) => resolve(file)));
  const kept: SnapshotEntry[] = [];

  for (const entry of manifest.files) {
    const dest = resolve(entry.path);
    if (!allowed.has(dest)) {
      kept.push(entry);
      skipped?.(entry.path, "unmanaged");
      continue;
    }
    if (entry.wired) {
      // Captured already wired: there is no pre-aiand copy to put back. The
      // file may still carry the wiring, so it counts as kept below.
      skipped?.(entry.path, "wired");
      if (await mayBeWired(dest, carriesWiring)) kept.push(entry);
      continue;
    }
    if (entry.existed) {
      if (!entry.backupPath) {
        throw new CliError(`Snapshot manifest is missing a copy path for ${entry.path}.`, {
          hint: `Delete ${snapshotDir(agentId)} to discard the corrupt snapshot and start over.`,
        });
      }
      const src = await realpath(entry.backupPath);
      if (src === snapRoot || !pathIsInside(snapRoot, src)) {
        throw new CliError(`Snapshot copy is outside the snapshot directory: ${entry.backupPath}`, {
          hint: "The snapshot only restores copies stored inside this agent's snapshot directory.",
        });
      }
      await mkdir(dirname(dest), { recursive: true });
      // Atomic replace: readers never observe a truncated managed file even
      // if this process is killed mid-restore. Byte-identical to copyFile on
      // success, including any trailing newline. Pass the snapshot copy's
      // mode so dest is not left at the 0600 lock `on` applied.
      const bytes = await readFile(src);
      const mode = (await stat(src)).mode & 0o777;
      await writeFileAtomic(dest, bytes, { mode });
    } else {
      await rm(dest, { force: true });
    }
  }

  if (kept.length > 0) {
    // What `on` recorded is stale for the files just restored, but not for a
    // kept path that may still be wired: `off` run from a shell that names it
    // needs the record to tell our values from the user's.
    let keptWired = false;
    for (const entry of kept) {
      if (await mayBeWired(entry.path, carriesWiring)) keptWired = true;
    }
    if (!keptWired) {
      await rm(join(snapshotDir(agentId), "added.json"), { force: true });
      await rm(join(snapshotDir(agentId), GIT_OPT_IN_FILE), { force: true });
    }
    await writeManifest(agentId, {
      createdAt: manifest.createdAt,
      files: kept,
      ...(keptWired && manifest.added ? { added: manifest.added } : {}),
    });
  } else {
    await rm(snapshotDir(agentId), { recursive: true, force: true });
  }
  return true;
}

/** Whether a file still holds ai& wiring. Without the adapter's check, any file that exists might. */
async function mayBeWired(
  path: string,
  carriesWiring?: (text: string) => boolean,
): Promise<boolean> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : "",
  );
  if (text === null) return false;
  return carriesWiring === undefined ? true : carriesWiring(text);
}

export async function hasSnapshot(agentId: string): Promise<boolean> {
  return (await readManifest(agentId)) !== null;
}

/** Drop this agent's snapshot dir (manifest, copies, added.json). Used when enable() fails after a fresh snapshot. */
export async function discardSnapshot(agentId: string): Promise<void> {
  await rm(snapshotDir(agentId), { recursive: true, force: true });
}

async function writeManifest(agentId: string, manifest: SnapshotManifest): Promise<void> {
  await writeFileAtomic(
    join(snapshotDir(agentId), MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      mode: PRIVATE_FILE_MODE,
    },
  );
}

export async function recordAddedState(agentId: string, added: AddedState): Promise<void> {
  const dir = snapshotDir(agentId);
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(dir, PRIVATE_DIR_MODE);
  await restrictToOwner(dir, { dir: true });
  await writeFileAtomic(join(dir, "added.json"), `${JSON.stringify(added, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  const manifest = await readManifest(agentId);
  if (!manifest) return;
  manifest.added = added;
  await writeManifest(agentId, manifest);
}

/** Drop enable()'s added-state so a later `on` records the current file, not the first-on values. Snapshot copies stay for `restore --force`. */
export async function clearAddedState(agentId: string): Promise<void> {
  const dir = snapshotDir(agentId);
  await rm(join(dir, "added.json"), { force: true });
  await rm(join(dir, GIT_OPT_IN_FILE), { force: true });
  const manifest = await readManifest(agentId);
  if (!manifest?.added) return;
  delete manifest.added;
  await writeManifest(agentId, manifest);
}

async function readGitOptIns(agentId: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(snapshotDir(agentId), GIT_OPT_IN_FILE), "utf8"),
    );
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Remember that the user let this agent's key into `realPath`, a file inside
 * a git work tree. `AIAND_ALLOW_GIT_TRACKED` is per process, but a later key rotation
 * runs in another one, and refusing the swap there would leave the agent
 * holding a dead key. Cleared with the added-state when `off` hands back.
 */
export async function recordGitOptIn(agentId: string, realPath: string): Promise<void> {
  const known = await readGitOptIns(agentId);
  if (known.includes(realPath)) return;
  const dir = snapshotDir(agentId);
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(dir, PRIVATE_DIR_MODE);
  await writeFileAtomic(join(dir, GIT_OPT_IN_FILE), `${JSON.stringify([...known, realPath])}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
}

export async function hasGitOptIn(agentId: string, realPath: string): Promise<boolean> {
  return (await readGitOptIns(agentId)).includes(realPath);
}

/** Only an object passes: each adapter trusts its own fields, never the file's shape. */
function asRecord<T extends AddedState>(value: unknown, source: string, agentId: string): T {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  throw new CliError(`${source} does not hold an object.`, {
    hint: `Delete ${snapshotDir(agentId)} to discard the corrupt snapshot and start over.`,
  });
}

export async function getAddedState<T extends AddedState>(agentId: string): Promise<T | null> {
  const addedPath = join(snapshotDir(agentId), "added.json");
  try {
    return asRecord<T>(JSON.parse(await readFile(addedPath, "utf8")), addedPath, agentId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const manifest = await readManifest(agentId);
      return manifest?.added ? asRecord<T>(manifest.added, MANIFEST_FILE, agentId) : null;
    }
    if (error instanceof SyntaxError) {
      throw new CliError(`${addedPath} is not valid JSON.`, {
        hint: `Delete ${snapshotDir(agentId)} to discard the corrupt snapshot and start over.`,
      });
    }
    throw error;
  }
}

/**
 * getAddedState for callers that cannot await (an adapter's managedFiles);
 * null for anything unreadable, since those callers only widen a path list.
 */
export function getAddedStateSync<T extends AddedState>(agentId: string): T | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(snapshotDir(agentId), "added.json"), "utf8"),
    );
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

/** Whether the snapshot holds exactly these files, so a moved managed file gets a fresh one. */
export async function snapshotCovers(agentId: string, files: string[]): Promise<boolean> {
  const manifest = await readManifest(agentId);
  if (!manifest) return false;
  const held = new Set(
    manifest.files.filter((entry) => !entry.wired).map((entry) => resolve(entry.path)),
  );
  return held.size === files.length && files.every((file) => held.has(resolve(file)));
}

/** True when the snapshot recorded that this path did not exist before enable. */
export async function fileCreatedByUs(agentId: string, path: string): Promise<boolean> {
  const manifest = await readManifest(agentId);
  if (!manifest) return false;
  const dest = resolve(path);
  return manifest.files.some((entry) => resolve(entry.path) === dest && entry.existed === false);
}

/**
 * Delete every snapshot copy that holds one of `keys`, so a logged-out key
 * never outlives logout inside `snapshots/`. A manifest entry that pointed
 * at a deleted copy becomes `wired` (nothing to restore). Returns the paths
 * of the copies removed. A copy carrying an adapter's wiring marker goes
 * too (`carriesWiringFor` gives each agent's check): it was captured after
 * `on`, so it holds some key even if that key is not the one logging out.
 */
export async function scrubSnapshotKeys(
  keys: readonly string[],
  carriesWiringFor?: (agentId: string) => ((text: string) => boolean) | undefined,
): Promise<string[]> {
  const root = join(configDir(), "snapshots");
  let agents: string[];
  try {
    agents = await readdir(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const agentId of agents) {
    const guard: SnapshotGuard = { keys, carriesWiring: carriesWiringFor?.(agentId) };
    const dir = join(root, agentId);
    const scrubbed = new Set<string>();
    let stamps: string[];
    try {
      stamps = await readdir(dir);
    } catch {
      continue;
    }
    for (const stamp of stamps) {
      const stampDir = join(dir, stamp);
      let copies: string[];
      try {
        copies = await readdir(stampDir);
      } catch {
        continue; // latest.json, added.json: never a copy
      }
      for (const name of copies) {
        const copy = join(stampDir, name);
        const text = await readFile(copy, "utf8").catch(() => "");
        if (!holdsWiring(text, guard)) continue;
        await rm(copy, { force: true });
        scrubbed.add(resolve(copy));
        removed.push(copy);
      }
    }
    if (scrubbed.size === 0) continue;
    const manifest = await readManifest(agentId).catch(() => null);
    if (!manifest) continue;
    manifest.files = manifest.files.map((entry) =>
      entry.backupPath !== undefined && scrubbed.has(resolve(entry.backupPath))
        ? { path: entry.path, existed: true, wired: true }
        : entry,
    );
    await writeManifest(agentId, manifest);
  }
  return removed;
}
