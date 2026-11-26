import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./fsutil.js";

/**
 * The cross-process lock behind every read-modify-write of aiand's own files:
 * who holds it, when a holder counts as dead or hung, and how a stale lock is
 * taken over without two waiters both running.
 */

/** How often a holder touches its lock while `fn` runs. */
const LOCK_HEARTBEAT_MS = 5_000;
/**
 * How long a waiter must watch a live holder's lock stay exactly as it was
 * before calling it hung. The holder's event loop beats every 5 s even while
 * it waits out a 20 s PowerShell start, so a minute of silence is a stopped
 * process, or a PID that now belongs to something else: waiting longer only
 * makes a recycled PID wedge everyone for longer. Too short a limit lets two
 * processes rotate one refresh token, which the server reads as theft.
 */
const LOCK_HUNG_MS = 60_000;
/** A lock with no readable holder is probably mid-creation (open, then write). */
const LOCK_UNREADABLE_GRACE_MS = 5_000;
/**
 * A waiter polls every 50 ms. A longer gap between two polls means this
 * process was suspended (sleep, a stopped terminal) and the holder may have
 * been too, so what it has watched so far proves nothing.
 */
const LOCK_WATCH_GAP_MS = 1_000;

export type FileLockOptions = {
  heartbeatMs?: number;
  hungMs?: number;
  unreadableGraceMs?: number;
};

/** Whether a process with this pid is running (EPERM: it is, as another user). */
export function holderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const missingAsNull = (error: unknown): null => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
};

/** A steal takes milliseconds: a guard older than this belongs to a hung stealer. */
const STEAL_GUARD_MS = 10_000;

/**
 * Remove the stale lock holding `text`. Stealers take turns through a guard
 * file, and each re-judges the lock under it: judging first and removing later
 * lets a slow stealer delete the fresh lock a faster one has just created
 * (renaming it away and putting it back leaves a gap in which a third process
 * takes the name, and two holders run). A live holder only releases a lock it
 * owns, and a dead one never does, so under the guard the lock cannot change
 * between the re-check and the unlink. Returns false when it stole nothing.
 */
export async function stealLock(
  lockPath: string,
  text: string,
  isStale: StaleCheck,
): Promise<boolean> {
  const guard = `${lockPath}.steal`;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(guard, "wx", PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    await clearDeadGuard(guard);
    return false;
  }
  try {
    await handle.writeFile(String(process.pid));
    await handle.close();
    const [current, info] = await Promise.all([
      readFile(lockPath, "utf8").catch(missingAsNull),
      stat(lockPath).catch(missingAsNull),
    ]);
    if (current !== text || info === null || !isStale(current, info.mtimeMs)) return false;
    await unlink(lockPath).catch(() => {});
    return true;
  } finally {
    await handle.close().catch(() => {});
    await unlink(guard).catch(() => {});
  }
}

/** A guard whose stealer died, or hung past STEAL_GUARD_MS, would block every steal for good. */
async function clearDeadGuard(guard: string): Promise<void> {
  const [text, info] = await Promise.all([
    readFile(guard, "utf8").catch(() => null),
    stat(guard).catch(() => null),
  ]);
  if (info === null) return;
  const pid = Number(text);
  const dead = pid > 0 ? !holderAlive(pid) : false;
  if (dead || Date.now() - info.mtimeMs > STEAL_GUARD_MS) await unlink(guard).catch(() => {});
}

export type StaleCheck = (text: string, mtimeMs: number) => boolean;

/** The pid a lock names: its first word. A lock from before the nonce holds the pid alone. */
const lockPid = (text: string): number => {
  const pid = Number(text.split(" ")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
};

/**
 * Watches one lock on this process's own monotonic clock. Comparing the
 * lock's mtime with the wall clock would break when the clock jumps (sleep,
 * NTP, a manual change); a monotonic reading cannot be compared across
 * processes at all. So the waiter times how long the lock has stayed exactly
 * as it is (same holder, same mtime): a live holder changes the mtime every
 * heartbeat, whatever the clocks say, and the mtime is only ever compared
 * with its own earlier value.
 */
class LockWatch {
  private seen: string | null = null;
  private since = 0;

  /** How long, in ms, `key` has been the lock's state. */
  silentFor(key: string): number {
    const now = performance.now();
    if (key !== this.seen) {
      this.seen = key;
      this.since = now;
    }
    return now - this.since;
  }

  /** Forget what was watched: this process was not running for part of it. */
  restart(): void {
    this.seen = null;
  }
}

/** Runs `fn` while holding `lockPath`, so two aiand processes never run it at once. */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const hungMs = options.hungMs ?? LOCK_HUNG_MS;
  const unreadableGraceMs = options.unreadableGraceMs ?? LOCK_UNREADABLE_GRACE_MS;
  // Codex SIGKILLs a slow auth command, so a dead holder is common. A live
  // one is waited for: only a long silence (no heartbeat) marks it hung.
  const watch = new LockWatch();
  const isStale: StaleCheck = (text, mtimeMs) => {
    const pid = lockPid(text);
    if (pid > 0 && !holderAlive(pid)) return true;
    return watch.silentFor(`${text}@${mtimeMs}`) > (pid > 0 ? hungMs : unreadableGraceMs);
  };
  // Who holds it: the pid says where to look, the nonce says which run. Two
  // holders never share both, so a recycled pid is told apart from the holder.
  const ours = `${process.pid} ${randomBytes(8).toString("hex")}`;
  await mkdir(dirname(lockPath), { recursive: true, mode: PRIVATE_DIR_MODE });
  let lastPoll = performance.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", PRIVATE_FILE_MODE);
      await handle.writeFile(ours);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const polling = performance.now();
      if (polling - lastPoll > LOCK_WATCH_GAP_MS) watch.restart();
      // A lock that vanishes between the open and these reads is not stale, it
      // is free: judging it by a missing mtime would delete the next holder's.
      const [text, info] = await Promise.all([
        readFile(lockPath, "utf8").catch(missingAsNull),
        stat(lockPath).catch(missingAsNull),
      ]);
      if (text === null || info === null) continue;
      if (performance.now() - polling > LOCK_WATCH_GAP_MS) watch.restart();
      const stole = isStale(text, info.mtimeMs) && (await stealLock(lockPath, text, isStale));
      // Stamped before the pause, so a stop during it shows as a gap.
      lastPoll = performance.now();
      if (!stole) await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lockPath, now, now).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Only a lock still ours: one stolen from a hung run and retaken is not.
    if ((await readFile(lockPath, "utf8").catch(() => null)) === ours) {
      await unlink(lockPath).catch(() => {});
    }
  }
}
