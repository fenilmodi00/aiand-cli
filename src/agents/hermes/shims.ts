import {
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { PRIVATE_FILE_MODE } from "../../fsutil.js";

/** Beside the overlay's marker: what the sweep needs to put the shims back. */
const SHIMS_FILE = ".aiand-overlay-shims";

/** What the checkout's store shims held before a session: bytes or link target. */
export type ShimSnapshot = {
  dir: string;
  entries: Record<string, { body?: Buffer; link?: string; mode: number }>;
};

/**
 * Locate hermes's store shims (checkout/.hermes/bin/hermes{,-acp}) from the
 * PATH binary: either the PATH entry is that directory already, or it is the
 * install's convenience shim `exec <root>/.hermes/bin/hermes "$@"`.
 */
async function shimDirFor(binPath: string | null): Promise<string | null> {
  if (binPath === null) return null;
  // The PATH entry may be the store shim itself, reached directly or through
  // a symlink: resolve it first, then check where it lives.
  const resolved = await realpath(binPath).catch(() => binPath);
  if (resolved.includes("/.hermes/bin/")) return dirname(resolved);
  // A convenience shim: `exec <checkout>/.hermes/bin/hermes "$@"`.
  let text: string;
  try {
    text = await readFile(resolved, "utf8");
  } catch {
    return null;
  }
  const exec = /^exec (\S+) "\$@"$/m.exec(text);
  const target = exec?.[1];
  return target?.includes("/.hermes/bin/") ? dirname(target) : null;
}

/**
 * Snapshot the store shims before a launch. Hermes self-relocates them to
 * whatever HERMES_HOME the session runs under, so an overlay launch rewrites
 * them to the overlay's tools path — which dies with cleanup, stranding the
 * user's own `hermes` binary. The cleanup restores these bytes. Best effort:
 * a PATH binary that reveals no checkout (a `.cmd` shim, an exotic install)
 * simply gets no snapshot. Concurrent launches race on the same shims;
 * the launcher assumes sessions run one at a time.
 */
export async function snapshotShims(binPath: string | null): Promise<ShimSnapshot | null> {
  const dir = await shimDirFor(binPath);
  if (dir === null) return null;
  const entries: ShimSnapshot["entries"] = {};
  for (const name of await readdir(dir).catch(() => [])) {
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        entries[name] = { link: await readlink(path), mode: info.mode & 0o777 };
      } else if (info.isFile()) {
        entries[name] = { body: await readFile(path), mode: info.mode & 0o777 };
      }
    } catch {
      // A racing hermes process touched it: leave that entry to hers.
    }
  }
  return { dir, entries };
}

/**
 * Whether a session-added entry points at the removed overlay: a symlink
 * into it, or a file whose bytes name it (a relocated shim script). Only
 * those are cleanup's to remove — anything else added mid-session (a user
 * drop, another installer) is legitimate and stays.
 */
async function pointsAtOverlay(path: string, overlay: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      return target === overlay || target.startsWith(`${overlay}/`);
    }
    if (info.isFile()) {
      const body = await readFile(path, "utf8").catch(() => null);
      return body?.includes(overlay) ?? false;
    }
    return false;
  } catch {
    return false; // Vanished mid-cleanup: nothing to remove.
  }
}

/**
 * Put the shims back; delete only session additions that point at the removed
 * overlay. `onlyAtOverlay` (a sweep of a crashed session) puts back only a
 * shim that still points into the overlay: one the user updated since is
 * theirs, and restoring the old copy would revert it.
 */
export async function restoreShims(
  snapshot: ShimSnapshot | null,
  overlay: string,
  { onlyAtOverlay = false }: { onlyAtOverlay?: boolean } = {},
): Promise<void> {
  if (snapshot === null) return;
  for (const name of await readdir(snapshot.dir).catch(() => [])) {
    if (snapshot.entries[name] === undefined) {
      if (await pointsAtOverlay(join(snapshot.dir, name), overlay)) {
        await unlink(join(snapshot.dir, name)).catch(() => {});
      }
    }
  }
  for (const [name, entry] of Object.entries(snapshot.entries)) {
    const path = join(snapshot.dir, name);
    if (onlyAtOverlay && !(await pointsAtOverlay(path, overlay))) continue;
    try {
      const info = await lstat(path);
      if (entry.link !== undefined) {
        const target = await readlink(path);
        if (info.isSymbolicLink() && target === entry.link) continue;
        await unlink(path);
        await symlink(entry.link, path);
        continue;
      }
      if (info.isFile() && entry.body !== undefined) {
        const current = await readFile(path);
        if (current.equals(entry.body)) continue;
      }
      await unlink(path);
    } catch {
      // Missing entry: fall through to the rewrite below.
    }
    if (entry.link !== undefined) {
      await symlink(entry.link, path).catch(() => {});
    } else if (entry.body !== undefined) {
      await writeFile(path, entry.body, { mode: entry.mode }).catch(() => {});
    }
  }
}

type ShimFile = {
  dir: string;
  entries: Record<string, { body?: string; link?: string; mode: number }>;
};

/**
 * Persist the snapshot inside the overlay. A session that dies before its
 * cleanup leaves the shims pointing into the overlay; the sweep that later
 * deletes the overlay restores them from this file first, or the user's own
 * `hermes` would be stranded on a path that no longer exists.
 */
export async function persistShims(overlay: string, snapshot: ShimSnapshot | null): Promise<void> {
  if (snapshot === null) return;
  const file: ShimFile = { dir: snapshot.dir, entries: {} };
  for (const [name, entry] of Object.entries(snapshot.entries)) {
    file.entries[name] = {
      mode: entry.mode,
      ...(entry.link !== undefined ? { link: entry.link } : {}),
      ...(entry.body !== undefined ? { body: entry.body.toString("base64") } : {}),
    };
  }
  await writeFile(join(overlay, SHIMS_FILE), JSON.stringify(file), { mode: PRIVATE_FILE_MODE });
}

async function loadShims(overlay: string): Promise<ShimSnapshot | null> {
  let parsed: ShimFile;
  try {
    parsed = JSON.parse(await readFile(join(overlay, SHIMS_FILE), "utf8")) as ShimFile;
  } catch {
    return null;
  }
  if (typeof parsed.dir !== "string" || !isAbsolute(parsed.dir)) return null;
  const entries: ShimSnapshot["entries"] = {};
  for (const [name, entry] of Object.entries(parsed.entries ?? {})) {
    // A name that is not a plain file name would write outside the shim dir.
    if (basename(name) !== name || name === "." || name === "..") continue;
    entries[name] = {
      mode: entry.mode,
      ...(typeof entry.link === "string" ? { link: entry.link } : {}),
      ...(typeof entry.body === "string" ? { body: Buffer.from(entry.body, "base64") } : {}),
    };
  }
  return { dir: parsed.dir, entries };
}

/**
 * Put back the shims a swept overlay's session never restored, then report
 * whether the shim dir is clear of the overlay. False means something in it
 * still points inside, so the caller must leave the overlay in place.
 */
export async function restoreShimsFromOverlay(overlay: string): Promise<boolean> {
  const snapshot = await loadShims(overlay);
  if (snapshot === null) return true;
  await restoreShims(snapshot, overlay, { onlyAtOverlay: true });
  for (const name of await readdir(snapshot.dir).catch(() => [])) {
    if (await pointsAtOverlay(join(snapshot.dir, name), overlay)) return false;
  }
  return true;
}
