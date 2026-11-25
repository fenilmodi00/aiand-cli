import type { Dirent } from "node:fs";
import { copyFile, link, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PRIVATE_FILE_MODE } from "../../fsutil.js";
import { makeOverlayDir } from "../overlays.js";
import { buildHermesWrites, HERMES_PROVIDER_ID, pinHermesModel } from "./routing.js";

/**
 * The throwaway HERMES_HOME overlay: user state links back to the real home
 * while routing bytes (shared with persistent `on` through routing.ts) land
 * as real files. Removed by sessionLaunch's cleanup when the child exits.
 */
/** Entries that never get linked back: Hermes's own credential pool. */
const CREDENTIAL_ENTRIES: Record<string, true> = { ".env": true, active_profile: true };
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
  const overlay = await makeOverlayDir("aiand-hermes-");
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

/**
 * One state entry, linked back. A win32 directory becomes a junction, not a
 * symlink: a directory symlink needs Developer Mode there, and the copy
 * fallback it used to get silently discards everything the session wrote
 * into the overlay when cleanup removes it. Junctions need no privilege and
 * still write through. A refused file entry hard-links instead: a hard link
 * needs no NTFS privilege and writes through, so session writes land in the
 * real home and cleanup removes only the overlay's directory entry. The file
 * chain is symlink -> hard link -> plain copyFile, because cp() mkdirs and
 * readdirs, which throws ENOTDIR on a regular file like ~/.hermes/state.db.
 * Only a host that refuses even the hard link (EXDEV, an exotic filesystem)
 * falls back at all; a refused directory still copies via cp().
 */
async function linkEntry(source: string, target: string, isDir: boolean): Promise<void> {
  const kind = process.platform === "win32" && isDir ? "junction" : isDir ? "dir" : "file";
  try {
    await symlink(source, target, kind);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
    if (!isDir) await link(source, target).catch(() => copyFile(source, target));
    else await cp(source, target);
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

/** Recursive copy: the last-resort fallback when the host refuses to link. */
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
