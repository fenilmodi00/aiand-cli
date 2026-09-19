import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { chmod, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";


/**
 * Read-only on-disk state machinery shared by the config layer, secrets
 * store, and the agent adapters. A leaf module: it imports nothing from the
 * project, so the config↔secrets edge stays acyclic (both import from here
 * instead of from each other).
 */

export function configDir(): string {
  if (process.env.AIAND_CONFIG_DIR) return process.env.AIAND_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "aiand") : join(homedir(), ".config", "aiand");
}

/**
 * The HOME agents resolve their config from. Tests point this at a temp dir
 * so adapters never touch the real user HOME; it also lets a user scope
 * wiring (e.g. `AIAND_HOME=/mnt/c/Users/me`) when they want it.
 */
export function agentHome(): string {
  return process.env.AIAND_HOME || homedir();
}

async function resolveForConfigCheck(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
    return null;
  }
}

async function isUnderConfigDir(dir: string): Promise<boolean> {
  const root = await resolveForConfigCheck(configDir());
  if (root === null) return false;
  const target = await resolveForConfigCheck(dir);
  if (target === null) return false;
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..");
}

export async function existingFileMode(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Write a file atomically: write to a temp file in the same directory, then
 * rename over the target. On POSIX the rename is atomic, so readers (e.g.
 * OpenCode loading opencode.json) never observes a truncated file even if
 * this process is killed mid-write. Writes follow symlinks to the real file
 * instead of replacing the link, so dotfile-managed setups (stow/chezmoi)
 * survive aiand writes. When `mode` is omitted, the resolved target's
 * permissions are preserved rather than replaced by the process umask's
 * default. The single atomic writer in the repo — the secrets store
 * (Buffer ciphertext) and every adapter config ride on it.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: { mode?: number } = {}
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir mode only covers newly created dirs — tighten our own config tree
  // best-effort; never chmod third-party dirs (e.g. ~/.config/opencode).
  if (await isUnderConfigDir(dir)) {
    await chmod(dir, 0o700).catch(() => {});
  }
  // Follow the whole symlink chain so rename(2) lands on the real file
  // instead of replacing the link. Only ENOENT falls back to filePath:
  // a fresh path isn't a symlink, and replacing a broken link with the
  // regular file is the correct recovery. Any other error (EACCES, ELOOP)
  // fails closed — a fallback there could rename over a symlink we could
  // not resolve.
  let real = filePath;
  try {
    real = await realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const realDir = dirname(real);
  const targetMode = options.mode ?? (await existingFileMode(real));
  const tempPath = join(
    realDir,
    `.${process.pid}-${randomBytes(6).toString("hex")}.tmp`
  );
  try {
    const handle = await open(tempPath, "w", targetMode ?? 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, real);
    // rename is atomic but not durable: flush the file before (handle.sync
    // above) and the directory entry after, so a crash cannot lose the write.
    // Directory fsync after rename via a throwaway fd, best-effort — some
    // filesystems (e.g. network mounts) reject directory fsync with EINVAL.
    if (process.platform !== "win32") {
      // Best-effort: some filesystems (network mounts) reject directory
      // fsync with EINVAL — skip durability there rather than fail the write.
      try {
        const dirFd = await open(realDir, "r");
        try {
          await dirFd.sync();
        } finally {
          await dirFd.close();
        }
      } catch {
        // durability unavailable on this filesystem
      }
    }
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  if (targetMode !== undefined) {
    await chmod(real, targetMode);
  }
}