import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { CliError } from "../cli/errors.js";
import { configDir, writeFileAtomic } from "../config.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, pathIsInside } from "../fsutil.js";
import { fsCliError } from "./managed-file.js";

const MANIFEST_FILE = "latest.json";

type SnapshotEntry = {
  path: string;
  backupPath?: string;
  existed: boolean;
};

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

/**
 * Snapshot `files` before the agent adapter rewrites them: a timestamped
 * sibling directory holds byte-for-byte copies and `latest.json` (0600) is the
 * manifest `restoreSnapshot` replays. Files that do not exist are recorded
 * with `existed: false` so restore deletes them instead of copying.
 * Returns the snapshot directory; each call replaces the previous manifest.
 */
export async function snapshotFiles(agentId: string, files: string[]): Promise<string> {
  const dir = snapshotDir(agentId);
  const snapDir = join(dir, snapshotStamp(new Date()));
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(dir, PRIVATE_DIR_MODE);
  await mkdir(snapDir, { mode: PRIVATE_DIR_MODE });
  await chmod(snapDir, PRIVATE_DIR_MODE);

  const entries: SnapshotEntry[] = [];
  for (const file of files) {
    let existed = true;
    try {
      await stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // HERMES_HOME pointing at a file (ENOTDIR), an unreadable path
        // (EACCES/EPERM): refuse cleanly exit 1, never a raw stack exit 70.
        throw fsCliError(file, error) ?? error;
      }
      existed = false;
    }
    if (existed) {
      const backupPath = join(snapDir, copyNameFor(file));
      try {
        await copyFile(file, backupPath);
      } catch (error) {
        // A directory squatting on a managed-file path (EISDIR) refuses the
        // same clean way.
        throw fsCliError(file, error) ?? error;
      }
      entries.push({ path: file, backupPath, existed: true });
    } else {
      entries.push({ path: file, existed: false });
    }
  }

  const manifest: SnapshotManifest = { createdAt: new Date().toISOString(), files: entries };
  await writeFileAtomic(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  return snapDir;
}

/**
 * Restore every snapshotted file byte-for-byte (or delete files that did not
 * exist before we touched them), then drop the manifest and snapshot copies.
 * Returns false when there is no manifest — the config was never ours.
 *
 * `allowedFiles` (the adapter's managedFiles) is required at the command
 * boundary so a tampered latest.json cannot copy or delete arbitrary paths.
 * Copy sources must also sit inside this agent's snapshot directory.
 */
export async function restoreSnapshot(agentId: string, allowedFiles: string[]): Promise<boolean> {
  const manifest = await readManifest(agentId);
  if (!manifest) return false;

  const snapRoot = await realpath(snapshotDir(agentId));
  const allowed = new Set(allowedFiles.map((file) => resolve(file)));

  for (const entry of manifest.files) {
    const dest = resolve(entry.path);
    if (!allowed.has(dest)) {
      throw new CliError(
        `Snapshot restore refused a path that is not a managed file: ${entry.path}`,
        {
          hint: "The snapshot only restores this agent's managed files. Delete the snapshot directory if it was tampered with, then re-run `on`.",
        },
      );
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

  await rm(snapshotDir(agentId), { recursive: true, force: true });
  return true;
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
  const manifest = await readManifest(agentId);
  if (!manifest?.added) return;
  delete manifest.added;
  await writeManifest(agentId, manifest);
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
  const held = new Set(manifest.files.map((entry) => resolve(entry.path)));
  return held.size === files.length && files.every((file) => held.has(resolve(file)));
}

/** True when the snapshot recorded that this path did not exist before enable. */
export async function fileCreatedByUs(agentId: string, path: string): Promise<boolean> {
  const manifest = await readManifest(agentId);
  if (!manifest) return false;
  const dest = resolve(path);
  return manifest.files.some((entry) => resolve(entry.path) === dest && entry.existed === false);
}
