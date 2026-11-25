import { lstat, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { holderAlive } from "../filelock.js";
import { makePrivateTempDir, PRIVATE_FILE_MODE, pathIsInside, restrictToOwner } from "../fsutil.js";
import { DAY_MS } from "../time.js";
import { restoreShimsFromOverlay } from "./hermes/shims.js";

/**
 * Launcher overlays: the throwaway dirs in os.tmpdir() that carry a session
 * key for one agent process. Cleanup removes each when its child exits; a
 * crash or a kill skips that, and the key sits in tmp until something
 * sweeps it. Only a dir this CLI made is ever swept, proven by the marker
 * file written into it at creation, never by its name.
 */

const OVERLAY_PREFIX = "aiand-";
const MARKER_FILE = ".aiand-overlay";
/** A session older than this is gone even if its pid was reused since. */
const ABANDONED_MS = 7 * DAY_MS;
/** The launcher's own sweep leaves anything younger alone. */
export const STALE_OVERLAY_MS = DAY_MS;

type OverlayMarker = { pid: number; createdAt: number };

/**
 * mkdtemp under os.tmpdir() plus the marker that lets a later sweep claim it.
 * The dir is owner-only before anything lands in it (Windows: tmp inherits
 * other users' read access, and a grant added once links exist could
 * propagate through them), so every overlay is both marked and private.
 */
export async function makeOverlayDir(prefix: string): Promise<string> {
  const dir = await makePrivateTempDir(prefix);
  const marker: OverlayMarker = { pid: process.pid, createdAt: Date.now() };
  try {
    const markerPath = join(dir, MARKER_FILE);
    await writeFile(markerPath, JSON.stringify(marker), { mode: PRIVATE_FILE_MODE, flag: "wx" });
    await restrictToOwner(markerPath, { dir: false });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

/** Ours to judge: a real dir (not a link) and a regular marker, both owned by this user. */
async function readMarker(dir: string): Promise<OverlayMarker | null> {
  const uid = process.getuid?.();
  try {
    const dirStat = await lstat(dir);
    if (!dirStat.isDirectory() || (uid !== undefined && dirStat.uid !== uid)) return null;
    const markerPath = join(dir, MARKER_FILE);
    const markerStat = await lstat(markerPath);
    if (!markerStat.isFile() || (uid !== undefined && markerStat.uid !== uid)) return null;
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as Partial<OverlayMarker>;
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "number") return null;
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

export type OverlaySweep = {
  /** Overlays deleted: their session is over. */
  removed: string[];
  /** Overlays left alone because the aiand process that made them still runs. */
  inUse: string[];
  /** Overlays that should have gone and did not, with why: they may still hold a key. */
  failed: { dir: string; reason: string }[];
};

/** Reason a sweep keeps an overlay: deleting it would break the user's `hermes` command. */
export const HERMES_SHIM_HELD = "a Hermes shim still points into it";

const reasonOf = (error: unknown): string =>
  (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? String(error);

/**
 * Delete marked overlays whose session is over: the process that made them
 * is gone (or the overlay is older than any session runs). `minAgeMs` spares
 * younger ones, so a routine sweep never races a launch that just started.
 * Best-effort per dir: one that cannot be removed is reported in `failed`, not
 * fatal, because `logout --all` must not call itself complete while it still
 * holds a key.
 */
export async function sweepOverlays({
  minAgeMs = 0,
}: {
  minAgeMs?: number;
} = {}): Promise<OverlaySweep> {
  const root = tmpdir();
  const result: OverlaySweep = { removed: [], inUse: [], failed: [] };
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      result.failed.push({ dir: root, reason: reasonOf(error) });
    }
    return result;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(OVERLAY_PREFIX)) continue;
    const dir = join(root, name);
    const marker = await readMarker(dir);
    if (marker === null) continue;
    const age = now - marker.createdAt;
    if (age < minAgeMs) continue;
    if (marker.pid === process.pid) continue;
    if (holderAlive(marker.pid) && age < ABANDONED_MS) {
      result.inUse.push(dir);
      continue;
    }
    try {
      // A crashed Hermes session leaves the user's store shims pointing into
      // its overlay: put them back first, and keep the overlay while any
      // still does, or the user's own `hermes` is left on a deleted path.
      if (!(await restoreShimsFromOverlay(dir))) {
        result.failed.push({ dir, reason: HERMES_SHIM_HELD });
        continue;
      }
      await rm(dir, { recursive: true, force: true });
      result.removed.push(dir);
    } catch (error) {
      // Held open (Windows), unreadable or vanished: the next sweep tries again.
      result.failed.push({ dir, reason: reasonOf(error) });
    }
  }
  return result;
}

const SCAN_MAX_DEPTH = 3;
const SCAN_MAX_FILES = 64;
const SCAN_MAX_BYTES = 1_048_576;

/** Whether a file under `dir` holds one of `keys`. Bounded, and never follows a link. */
async function holdsAnyKey(dir: string, keys: readonly string[]): Promise<boolean> {
  let budget = SCAN_MAX_FILES;
  const visit = async (path: string, depth: number): Promise<boolean> => {
    const info = await lstat(path).catch(() => null);
    if (info === null) return false;
    if (info.isDirectory()) {
      if (depth >= SCAN_MAX_DEPTH) return false;
      for (const name of await readdir(path).catch(() => [] as string[])) {
        if (await visit(join(path, name), depth + 1)) return true;
      }
      return false;
    }
    if (!info.isFile() || info.size > SCAN_MAX_BYTES || budget <= 0) return false;
    budget -= 1;
    const text = await readFile(path, "utf8").catch(() => "");
    return keys.some((key) => key.length > 0 && text.includes(key));
  };
  return visit(dir, 0);
}

/**
 * `aiand-*` folders in the temp dir that hold one of `keys` and carry no
 * overlay marker: an aiand from before the marker left its overlay with
 * nothing to prove it ours, and a crash left the key inside. Nothing is
 * deleted, since a name and a key are not proof the folder is only an overlay;
 * the caller reports them. Folders that contain one of `around` (the config and
 * agent home dirs, wherever they sit) are not what is looked for.
 */
export async function findUnmarkedKeyDirs(
  keys: readonly string[],
  around: readonly string[],
): Promise<string[]> {
  const root = tmpdir();
  const found: string[] = [];
  const uid = process.getuid?.();
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(OVERLAY_PREFIX)) continue;
    const dir = join(root, name);
    if ((await readMarker(dir)) !== null) continue;
    const info = await lstat(dir).catch(() => null);
    if (!info?.isDirectory() || (uid !== undefined && info.uid !== uid)) continue;
    const real = await realpath(dir).catch(() => dir);
    if (around.some((path) => pathIsInside(real, path))) continue;
    if (await holdsAnyKey(dir, keys)) found.push(dir);
  }
  return found;
}
