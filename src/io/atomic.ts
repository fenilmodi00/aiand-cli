import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

async function existingFileMode(filePath: string): Promise<number | undefined> {
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
 * Claude Code loading settings.json) never observe a truncated file even if
 * this process is killed mid-write. When `mode` is omitted, an existing
 * target's permissions are preserved rather than replaced by the process
 * umask's default.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  options: { mode?: number } = {}
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const targetMode = options.mode ?? (await existingFileMode(filePath));
  const tempPath = join(
    dirname(filePath),
    `.${process.pid}-${randomBytes(6).toString("hex")}.tmp`
  );
  try {
    if (targetMode !== undefined) {
      await writeFile(tempPath, data, { mode: targetMode });
    } else {
      await writeFile(tempPath, data);
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  if (targetMode !== undefined) {
    await chmod(filePath, targetMode);
  }
}
