import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { configDir } from "../config.js";
import { writeFileAtomic } from "../io/atomic.js";

const MANIFEST_FILE = "latest.json";

type BackupEntry = {
  path: string;
  backupPath?: string;
  existed: boolean;
};

type BackupManifest = {
  createdAt: string;
  files: BackupEntry[];
};

function backupDir(agentId: string): string {
  return join(configDir(), "backups", agentId);
}

// Windows forbids `:` in filenames, so the ISO timestamp becomes a sortable,
// filesystem-safe directory name. Millisecond precision keeps two snapshots
// of the same agent from colliding.
function snapshotStamp(date: Date): string {
  return date.toISOString().replace(/:/g, "-");
}

/**
 * Flatten an absolute path into one collision-free backup filename.
 * `~/.claude/settings.json` -> `.claude__settings.json`.
 */
function backupNameFor(file: string): string {
  return (
    file
      .replace(/^[a-zA-Z]:/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .join("__") || "file"
  );
}

async function readManifest(agentId: string): Promise<BackupManifest | null> {
  try {
    const raw = await readFile(join(backupDir(agentId), MANIFEST_FILE), "utf8");
    return JSON.parse(raw) as BackupManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Back up `files` before the agent adapter rewrites them: a timestamped
 * sibling directory holds byte-for-byte copies and `latest.json` (0600) is the
 * manifest `restoreSnapshot` replays. Files that do not exist are recorded
 * with `existed: false` so restore deletes them instead of copying.
 * Returns the snapshot directory; each call replaces the previous manifest.
 */
export async function snapshotFiles(agentId: string, files: string[]): Promise<string> {
  const dir = backupDir(agentId);
  const snapshotDir = join(dir, snapshotStamp(new Date()));
  await mkdir(snapshotDir, { recursive: true });

  const entries: BackupEntry[] = [];
  for (const file of files) {
    let existed = true;
    try {
      await stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existed = false;
    }
    if (existed) {
      const backupPath = join(snapshotDir, backupNameFor(file));
      await copyFile(file, backupPath);
      entries.push({ path: file, backupPath, existed: true });
    } else {
      entries.push({ path: file, existed: false });
    }
  }

  const manifest: BackupManifest = { createdAt: new Date().toISOString(), files: entries };
  await writeFileAtomic(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return snapshotDir;
}

/**
 * Restore every snapshotted file byte-for-byte (or delete files that did not
 * exist before we touched them), then drop the manifest and snapshot copies.
 * Returns false when there is no manifest — the config was never ours.
 */
export async function restoreSnapshot(agentId: string): Promise<boolean> {
  const manifest = await readManifest(agentId);
  if (!manifest) return false;

  for (const entry of manifest.files) {
    if (entry.existed) {
      if (!entry.backupPath) {
        throw new Error(`Backup manifest is missing backupPath for ${entry.path}.`);
      }
      await mkdir(join(entry.path, ".."), { recursive: true });
      await copyFile(entry.backupPath, entry.path);
    } else {
      await rm(entry.path, { force: true });
    }
  }

  await rm(backupDir(agentId), { recursive: true, force: true });
  return true;
}

export async function hasSnapshot(agentId: string): Promise<boolean> {
  return (await readManifest(agentId)) !== null;
}
