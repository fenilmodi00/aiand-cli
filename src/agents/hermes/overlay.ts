import type { Dirent } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PRIVATE_FILE_MODE } from "../../fsutil.js";
import { buildHermesWrites, HERMES_PROVIDER_ID, pinHermesModel } from "./routing.js";

/**
 * The throwaway HERMES_HOME overlay: user state links back to the real home
 * while routing bytes (shared with persistent `on` through routing.ts) land
 * as real files. Removed by sessionLaunch's cleanup when the child exits.
 */
/** Entries that never get linked back: Hermes's own credential pool. */
const CREDENTIAL_ENTRIES: Record<string, true> = { ".env": true, active_profile: true };
/** Windows directory symlinks need developer mode; copy state there instead. */
const CAN_LINK_DIRS = process.platform !== "win32";
const isCredentialEntry = (name: string) =>
  CREDENTIAL_ENTRIES[name] === true || /auth|credential|token/i.test(name);
/**
 * Build the overlay home for one launch: the single builder sessionLaunch
 * uses, so persistent `on` shares it. Ordinary state (sessions, skills,
 * memories, logs) and the user's own plugins are symlinked back to the real
 * home; credential-shaped entries stay overlay-only; the real config.yaml is
 * copied, not linked, because the overlay edits it; and the overlay's own
 * `aiand` provider plugin plus its config block and `.env` carry the
 * routing (including each model's published reasoning levels). The caller
 * (sessionLaunch's cleanup) removes the overlay when the child exits.
 */
export async function buildHermesOverlay(
  realHome: string,
  routing: {
    apiKey: string;
    baseUrl: string;
    model: string;
    reasoningLevels: ReadonlyMap<string, readonly string[]>;
  },
): Promise<string> {
  const overlay = await mkdtemp(join(tmpdir(), "aiand-hermes-"));
  try {
    await linkRealHomeEntries(overlay, realHome);
    const envText = await readFile(join(realHome, ".env"), "utf8").catch(() => "");
    const configText = await readFile(join(overlay, "config.yaml"), "utf8").catch(() => "");
    const writes = buildHermesWrites({
      apiKey: routing.apiKey,
      baseUrl: routing.baseUrl,
      model: routing.model,
      envText,
      configText,
      reasoningLevels: routing.reasoningLevels,
    });
    // The overlay always carries model.default: a launch without one sends
    // an empty model and every turn is rejected (verified against 0.21.5).
    writes.config = pinHermesModel(writes.config, routing.model);
    await writeOverlayRouting(overlay, writes);
    return overlay;
  } catch (error) {
    await rm(overlay, { recursive: true, force: true });
    throw error;
  }
}

/** Write the shared routing bytes into an overlay that is already linked back. */
async function writeOverlayRouting(
  overlay: string,
  writes: { env: string; config: string; initPy: string; pluginYaml: string },
): Promise<void> {
  await writeFile(join(overlay, ".env"), writes.env, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  const dir = join(overlay, "plugins", "model-providers", HERMES_PROVIDER_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "__init__.py"), writes.initPy, "utf8");
  await writeFile(join(dir, "plugin.yaml"), writes.pluginYaml, "utf8");
  await writeFile(join(overlay, "config.yaml"), writes.config, "utf8");
}

/** Link state back into the overlay; credentials stay out, config is copied. */
async function linkRealHomeEntries(overlay: string, realHome: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(realHome, { withFileTypes: true });
  } catch {
    return; // No real home yet: a fresh install gets a fresh overlay.
  }
  for (const entry of entries) {
    if (isCredentialEntry(entry.name)) continue;
    // By NAME, not isFile(): a symlinked config.yaml reads as a link, and
    // linking it would let the overlay edit write through to the real home.
    if (entry.name === "config.yaml") {
      // Copied, not linked: the overlay edits it, the real one stays intact.
      await copyFile(join(realHome, entry.name), join(overlay, entry.name));
      continue;
    }
    if (entry.name === "plugins") {
      await linkUserPlugins(overlay, join(realHome, entry.name));
      continue;
    }
    await linkEntry(join(realHome, entry.name), join(overlay, entry.name), entry.isDirectory());
  }
}

/** One state entry, linked back; win32 copies directories (see CAN_LINK_DIRS). */
async function linkEntry(source: string, target: string, isDir: boolean): Promise<void> {
  if (isDir) {
    if (CAN_LINK_DIRS) await symlink(source, target, "dir");
    // win32 dir-symlinks need developer mode, so state is
    // copied there; hermes itself runs on Unix, this is for stub runs.
    else await cp(source, target);
  } else {
    await symlink(source, target, "file");
  }
}

/**
 * User plugins link back one by one; only our own provider id stays
 * overlay-only — the overlay writes it fresh below, so a stale user file
 * under that id must never shadow this launch's routing.
 */
async function linkUserPlugins(overlay: string, source: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch {
    // Not a directory (a stray file named plugins): link it back whole.
    await linkEntry(source, join(overlay, "plugins"), false).catch(() => {});
    return;
  }
  const target = join(overlay, "plugins");
  let made = false;
  for (const entry of entries) {
    if (entry.name === "model-providers") continue; // handled below, minus our own id
    if (!made) {
      await mkdir(target, { recursive: true });
      made = true;
    }
    await linkEntry(join(source, entry.name), join(target, entry.name), entry.isDirectory());
  }
  let providerEntries: Dirent[];
  try {
    providerEntries = await readdir(join(source, "model-providers"), { withFileTypes: true });
  } catch {
    return; // No model-providers dir: nothing more to carry.
  }
  const kept = providerEntries.filter((entry) => entry.name !== HERMES_PROVIDER_ID);
  if (kept.length === 0) return;
  const providerTarget = join(target, "model-providers");
  await mkdir(providerTarget, { recursive: true });
  for (const entry of kept) {
    await linkEntry(
      join(source, "model-providers", entry.name),
      join(providerTarget, entry.name),
      entry.isDirectory(),
    );
  }
}

/** Recursive copy for the win32 path where symlinking a dir would throw. */
async function cp(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) await cp(from, to);
    // copyFile follows a symlink: the entry arrives as a plain file.
    else await copyFile(from, to);
  }
}

/** What the checkout's store shims held before a session: bytes or link target. */
type ShimSnapshot = {
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

/** Put the shims back; delete only session additions that point at the removed overlay. */
export async function restoreShims(snapshot: ShimSnapshot | null, overlay: string): Promise<void> {
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
