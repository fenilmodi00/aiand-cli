import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, rmSync, type Stats, statSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CliError } from "./cli/errors.js";
import { systemToolEnv } from "./cli/spawn-env.js";
import { windowsSystemTool } from "./cli/win-spawn.js";
import {
  CONFIG_MARKER_FILE,
  markerText,
  mayMarkConfigDir,
  newConfigId,
  readConfigId,
  readMarkerId,
} from "./config-files.js";

/**
 * Config paths, containment checks, and the atomic writer, shared by config,
 * secrets, and the adapters. It imports the error type, the spawn helpers
 * under `cli/`, and the config-marker rules, so config and secrets import from
 * here instead of each other. The cross-process lock is re-exported from
 * `filelock.ts`, the one implementation.
 */

/** Owner-only read/write: config, credentials, secrets, and agent configs we write. */
export const PRIVATE_FILE_MODE = 0o600;
/** Owner-only directory: the config dir and snapshot dirs. */
export const PRIVATE_DIR_MODE = 0o700;
/** What a file we lock to 0600 goes back to when we cannot tell what it had. */
export const DEFAULT_FILE_MODE = 0o644;

/**
 * Run a helper tool with stdin piped and stdout captured. A secret, when
 * there is one, rides `input` only: argv and the environment are readable by
 * other processes of the same user for the child's lifetime.
 */
export async function runTool(
  cmd: string,
  args: string[],
  options: { input?: string; timeoutMs: number },
): Promise<{ code: number | null; stdout: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    code: number | null;
    stdout: string;
  }>();
  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: systemToolEnv(),
    windowsHide: true,
  });
  // Not spawn's own `timeout`: its timer outlives a spawn that fails with
  // ENOENT and holds the process open for the full timeout.
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, stdout });
  });
  // A fast-exiting tool (broken dbus, PATH shim) closes stdin before the write
  // lands: without this listener that EPIPE is an unhandled crash, not a
  // fallback to the next storage tier.
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
  return promise;
}

const WINDOWS_TOOL_TIMEOUT_MS = 10_000;

interface WindowsUser {
  /** `*<SID>` for icacls, or DOMAIN\\user when whoami cannot answer. */
  principal: string;
  /** What icacls prints for this user's own entry: DOMAIN\\user, or the SID. */
  names: string[];
}

let ownerPrincipal: Promise<WindowsUser | null> | undefined;
// The sync path's own cache; undefined means "not asked yet", null a real answer.
let ownerPrincipalSync: WindowsUser | null | undefined;
const restrictedDirs = new Set<string>();
// Paths whose last owner-only restriction failed in this process. Persisted
// by saveCredential so `status`, which writes nothing, can still tell.
const unrestricted = new Set<string>();

/**
 * Forget the owner principal and every restriction this process recorded, so
 * the next restrictToOwner asks whoami and icacls again. Tests that stub those
 * tools use it: on a real Windows host an earlier write has already cached the
 * real user's SID.
 */
export function resetOwnerRestriction(): void {
  ownerPrincipal = undefined;
  ownerPrincipalSync = undefined;
  restrictedDirs.clear();
  unrestricted.clear();
}

/**
 * True when an owner-only ACL could not be applied to one of `paths`. Asked
 * about the paths a caller wrote, not the process: an unrelated overlay or
 * snapshot dir that failed earlier says nothing about the credential file.
 * Always false off Windows.
 */
export const ownerRestrictionFailedFor = (paths: string[]): boolean =>
  paths.some((path) => unrestricted.has(path));

/** Who is running, from `whoami /user /fo csv /nh`; the environment when it did not answer. */
function windowsUserFrom(stdout: string): WindowsUser | null {
  const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  const ownedName = stdout.match(/^\s*"([^"]+)"/)?.[1];
  if (sid) {
    return {
      principal: `*${sid}`,
      names: [sid, ...(ownedName ? [ownedName] : [])].map((n) => n.toLowerCase()),
    };
  }
  const user = process.env.USERNAME;
  if (!user) return null;
  const name = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  return { principal: name, names: [name.toLowerCase()] };
}

/** Who is running, as icacls spells them; once per process. */
function currentUser(): Promise<WindowsUser | null> {
  ownerPrincipal ??= runTool(
    windowsSystemTool("whoami.exe", process.env),
    ["/user", "/fo", "csv", "/nh"],
    { timeoutMs: WINDOWS_TOOL_TIMEOUT_MS },
  )
    .then((result) => windowsUserFrom(result.code === 0 ? result.stdout : ""))
    .catch(() => windowsUserFrom(""));
  return ownerPrincipal;
}

/** `runTool` without the await, for the sync temp-dir path. */
function runToolSync(cmd: string, args: string[]): { code: number | null; stdout: string } {
  try {
    const result = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: WINDOWS_TOOL_TIMEOUT_MS,
      env: systemToolEnv(),
      windowsHide: true,
    });
    return { code: result.error ? null : result.status, stdout: result.stdout ?? "" };
  } catch {
    return { code: null, stdout: "" };
  }
}

/**
 * `currentUser` for the sync path. A separate cache: the promise one cannot
 * be awaited here, and the sync caller returns before it could settle.
 */
function currentUserSync(): WindowsUser | null {
  if (ownerPrincipalSync === undefined) {
    const whoami = runToolSync(windowsSystemTool("whoami.exe", process.env), [
      "/user",
      "/fo",
      "csv",
      "/nh",
    ]);
    ownerPrincipalSync = windowsUserFrom(whoami.code === 0 ? whoami.stdout : "");
  }
  return ownerPrincipalSync;
}

/**
 * The principals `icacls <path>` lists, in the spelling icacls takes back. The
 * first line starts with the path as given; the rest are indented.
 */
function listedPrincipals(output: string, path: string): string[] {
  const found: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") break;
    const entry = (line.startsWith(path) ? line.slice(path.length) : line).trim();
    const at = entry.indexOf(":(");
    if (at > 0) found.push(entry.slice(0, at));
  }
  return found;
}

/** `icacls` arguments that make `path` owner-only, inheritable on a dir. */
function ownerGrantArgs(path: string, user: WindowsUser, isDir: boolean): string[] {
  return [path, "/inheritance:r", "/grant:r", `${user.principal}:${isDir ? "(OI)(CI)F" : "F"}`];
}

/** `icacls` arguments removing every listed principal that is not the user. */
function ownerRemovalArgs(path: string, user: WindowsUser, listed: string[]): string[] {
  return [
    path,
    ...listed
      .filter((name) => !user.names.includes(name.toLowerCase()))
      .flatMap((name) => ["/remove", /^S-1-/.test(name) ? `*${name}` : name]),
  ];
}

/** Keep the process-wide record of what is owner-only and what failed. */
function recordOwnerRestriction(path: string, record: string, ok: boolean, isDir: boolean): void {
  if (ok) {
    unrestricted.delete(record);
    if (isDir) restrictedDirs.add(path);
  } else {
    unrestricted.add(record);
  }
}

/** AIAND_DEBUG=1 names the tool failure; the caller only sees its boolean. */
function reportOwnerRestriction(path: string, error: unknown): void {
  if (process.env.AIAND_DEBUG !== "1") return;
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Warning: could not restrict ${path} to its owner: ${reason}\n`);
}

/**
 * Windows ignores the 0600/0700 modes the rest of this module sets, so a
 * file or dir holding the key gets an owner-only DACL instead: the current
 * user alone has full control and every other entry is gone. A dir's grant is
 * inheritable, so what is created in it afterwards is owner-only from its
 * first byte; restrict a dir before writing into it. No-op off Windows.
 *
 * `/inheritance:r` drops only entries marked inherited, and `/grant:r`
 * replaces only the named user's own entry. Entries another user or a group
 * holds directly (a dir made by an elevated process, or one a person edited)
 * would survive both, so the entries are listed afterwards and each remaining
 * principal is removed. A handle opened before this call keeps the access it
 * was granted then; Windows checks the DACL only at open.
 *
 * Best-effort: a failure leaves the ACL as it was and is recorded for
 * `ownerRestrictionFailedFor`, and reported under AIAND_DEBUG=1. `recordAs`
 * names the path a failure is recorded against when it differs from `path`,
 * as for a temp file about to be renamed over the real one. Resolves false
 * on failure.
 */
export async function restrictToOwner(
  path: string,
  options: { dir?: boolean; recordAs?: string } = {},
): Promise<boolean> {
  if (process.platform !== "win32") return true;
  if (restrictedDirs.has(path)) return true;
  const record = options.recordAs ?? path;
  try {
    const isDir = options.dir ?? (await stat(path)).isDirectory();
    const user = await currentUser();
    if (!user) throw new Error("the current user is unknown");
    const icacls = windowsSystemTool("icacls.exe", process.env);
    const run = (args: string[]) => runTool(icacls, args, { timeoutMs: WINDOWS_TOOL_TIMEOUT_MS });
    const granted = await run(ownerGrantArgs(path, user, isDir));
    if (granted.code !== 0) throw new Error(`icacls exited ${granted.code}`);
    const listed = await run([path]);
    if (listed.code !== 0) throw new Error(`icacls exited ${listed.code} listing the ACL`);
    const removal = ownerRemovalArgs(path, user, listedPrincipals(listed.stdout, path));
    if (removal.length > 1) {
      const removed = await run(removal);
      if (removed.code !== 0) throw new Error(`icacls exited ${removed.code} removing entries`);
    }
    recordOwnerRestriction(path, record, true, isDir);
    return true;
  } catch (error) {
    recordOwnerRestriction(path, record, false, false);
    reportOwnerRestriction(path, error);
    return false;
  }
}

/**
 * `restrictToOwner` without the await, for a caller that must hand back a
 * private dir before it returns. Same `icacls` sequence and the same record;
 * only the tool runner differs, so the ACL convention stays one. No-op off
 * Windows, where the caller sets the mode.
 */
function restrictToOwnerSync(
  path: string,
  options: { dir?: boolean; recordAs?: string } = {},
): boolean {
  if (process.platform !== "win32") return true;
  if (restrictedDirs.has(path)) return true;
  const record = options.recordAs ?? path;
  try {
    const isDir = options.dir ?? statSync(path).isDirectory();
    const user = currentUserSync();
    if (!user) throw new Error("the current user is unknown");
    const icacls = windowsSystemTool("icacls.exe", process.env);
    const run = (args: string[]) => runToolSync(icacls, args);
    const granted = run(ownerGrantArgs(path, user, isDir));
    if (granted.code !== 0) throw new Error(`icacls exited ${granted.code}`);
    const listed = run([path]);
    if (listed.code !== 0) throw new Error(`icacls exited ${listed.code} listing the ACL`);
    const removal = ownerRemovalArgs(path, user, listedPrincipals(listed.stdout, path));
    if (removal.length > 1) {
      const removed = run(removal);
      if (removed.code !== 0) throw new Error(`icacls exited ${removed.code} removing entries`);
    }
    recordOwnerRestriction(path, record, true, isDir);
    return true;
  } catch (error) {
    recordOwnerRestriction(path, record, false, false);
    reportOwnerRestriction(path, error);
    return false;
  }
}

/** The refusal both temp-dir makers throw after removing the dir. */
function privateTempDirError(): CliError {
  return new CliError("A temporary directory was not private; nothing was written.", {
    hint: "Try again; if it repeats, point TEMP at a directory only you can use.",
  });
}

/**
 * A throwaway dir under the temp dir that only the current user can open, for
 * a session key, a share image, or a task workspace copy. On Windows the temp
 * dir may let others create entries, so the dir is restricted before anything
 * is written and must still be empty after: an entry another user planted
 * while it carried the inherited ACL, including a file they hold open, is
 * refused rather than written through. A dir that cannot be restricted is
 * refused too. Once the DACL is owner-only nobody else can add one, so the
 * files written into it afterwards are ours alone. The caller removes the dir.
 */
export async function makePrivateTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    // Fails closed: a dir that could not be restricted keeps the ACL it
    // inherited, and the key would be written under it.
    const restricted = await restrictToOwner(dir, { dir: true });
    if (!restricted || (process.platform === "win32" && (await readdir(dir)).length > 0)) {
      throw privateTempDirError();
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

/**
 * `makePrivateTempDir` for a caller that cannot await: the same fail-closed
 * rule and, on Windows, the same owner-only DACL path, with the dir made and
 * restricted in one synchronous step (0700 on POSIX). A dir that cannot be
 * made private is removed and refused, never handed back. The caller removes
 * the dir.
 */
export function makePrivateTempDirSync(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    let restricted = true;
    if (process.platform === "win32") {
      restricted = restrictToOwnerSync(dir, { dir: true });
    } else {
      chmodSync(dir, PRIVATE_DIR_MODE);
    }
    if (!restricted || (process.platform === "win32" && readdirSync(dir).length > 0)) {
      throw privateTempDirError();
    }
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The refusal below is the fact the caller must see; a dir that could
      // not be removed is still not handed back.
    }
    if (error instanceof CliError) throw error;
    if (process.env.AIAND_DEBUG === "1") {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Warning: could not make ${dir} private: ${reason}\n`);
    }
    throw privateTempDirError();
  }
  return dir;
}

/**
 * Create the config dir and, on Windows, resolve the current user and restrict
 * the dir to them. Run it before taking a lock that guards a write there: the
 * whoami and icacls starts it makes can take 10 s each on a cold machine, and a
 * waiter calls a lock stale long before that. After it, writeFileAtomic into
 * this dir spawns nothing.
 */
export async function prepareConfigDir(): Promise<void> {
  const dir = configDir();
  try {
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch {
    // The write that follows reports a path it cannot use, in its own words.
    return;
  }
  await chmod(dir, PRIVATE_DIR_MODE).catch(() => {});
  await restrictToOwner(dir, { dir: true });
}

export function configDir(): string {
  if (process.env.AIAND_CONFIG_DIR) return assertConfigDir(process.env.AIAND_CONFIG_DIR);
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "aiand") : join(homedir(), ".config", "aiand");
}

/**
 * #87: AIAND_CONFIG_DIR pointing at a regular file (or other non-directory)
 * used to surface as a raw ENOTDIR/EEXIST stack deep inside a read or write.
 * Guard the boundary once: every config, credential, and secret path routes
 * through configDir(), so one stat check covers reads and writes.
 */
function assertConfigDir(dir: string): string {
  let st: Stats;
  try {
    st = statSync(dir);
  } catch {
    return dir; // ENOENT etc. — reads fall through to their own handling, writes create it.
  }
  if (!st.isDirectory()) {
    throw new CliError(`Config dir is not a directory: ${dir}`, {
      hint: "Point AIAND_CONFIG_DIR at a directory, or unset it to use the default location.",
    });
  }
  return dir;
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

/**
 * Pure containment predicate behind `configRootContaining`. On win32,
 * `relative('C:\\cfg', 'D:\\other')` returns the absolute `D:\other`
 * (no `..` prefix), so an absolute `rel` must also reject — otherwise
 * `writeFileAtomic` would chmod 0700 a foreign drive. The `pathImpl`
 * parameter exists only so tests can exercise win32 semantics on POSIX.
 */
export function pathIsInside(
  root: string,
  target: string,
  pathImpl: {
    relative: (from: string, to: string) => string;
    isAbsolute: (p: string) => boolean;
  } = { relative, isAbsolute },
): boolean {
  if (target === root) return true;
  const rel = pathImpl.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !pathImpl.isAbsolute(rel);
}

/** The config dir's real path when `dir` is inside it, else null. */
async function configRootContaining(dir: string): Promise<string | null> {
  const root = await resolveForConfigCheck(configDir());
  if (root === null) return null;
  const target = await resolveForConfigCheck(dir);
  if (target === null) return null;
  return pathIsInside(root, target) ? root : null;
}

/**
 * Proof that a directory is aiand's own: `logout --all` deletes by name, so
 * a mistyped AIAND_CONFIG_DIR must never look like ours just because it
 * holds a `config.json`. aiand drops this file in the first time it writes
 * there, naming the install with a random id that `config.json` records too;
 * an empty file, or one copied from elsewhere, names nothing that matches.
 * A marker that names no id (an older aiand's) is replaced, but only in a dir
 * that is aiand's by content. One that names an id is never rewritten: an id
 * that is not the one `config.json` records means that `config.json` came
 * from another install, and making the two agree would vouch for it.
 */
async function ensureConfigMarker(root: string): Promise<void> {
  try {
    // Only a dir that is aiand's by content gets vouched for: any write under
    // the config dir, a cache file included, passes through here.
    if (!(await mayMarkConfigDir(root))) return;
    if ((await readMarkerId(root)) !== null) return;
    const configId = await readConfigId(root);
    const path = join(root, CONFIG_MARKER_FILE);
    const existing = await lstat(path).catch(() => null);
    if (existing?.isDirectory()) return;
    if (existing) await unlink(path);
    const handle = await open(path, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(markerText(configId ?? newConfigId()));
    } finally {
      await handle.close();
    }
  } catch {
    // Unwritable: the marker is proof for logout --all, never a
    // precondition for the write that triggered it.
  }
}

/** Mark the config dir if it has no marker yet, now that its `config.json` was written. */
export async function syncConfigMarker(): Promise<void> {
  const root = await configRootContaining(configDir());
  if (root !== null) await ensureConfigMarker(root);
}

/**
 * The id `saveConfig` records: the marker's, dropping the marker first when
 * the dir may have one and has none. Read before `config.json` is written, so
 * the two are written with one id rather than made to agree afterwards.
 */
export async function configMarkerId(): Promise<string | null> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE }).catch(() => {});
  const root = await configRootContaining(dir);
  if (root === null) return null;
  await ensureConfigMarker(root);
  return readMarkerId(root);
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
 * Windows rename-over-existing fails transiently with EPERM/EACCES while a
 * concurrent process still holds the destination (an antivirus scan, a
 * reader that opened the file between our open and the rename). POSIX rename
 * is atomic and never needs this; on win32 a short jittered retry lets the
 * racing writer through instead of failing a write that one more attempt
 * would land — the secrets-store first-run race depends on it.
 */
async function renameWithWin32Retry(from: string, to: string): Promise<void> {
  if (process.platform !== "win32") {
    await rename(from, to);
    return;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EACCES") || attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
    }
  }
}

/**
 * Temp file in the same directory, then rename over the target, so readers
 * (OpenCode loading opencode.json) never see a truncated file. Follows
 * symlinks to the real file so stow/chezmoi links survive. Without `mode`, the
 * target's existing permissions are kept rather than the umask default.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = dirname(filePath);
  try {
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch (error) {
    // A file squatting where a directory belongs: POSIX says ENOTDIR here,
    // Windows EEXIST, and the same read that would have caught it first sees
    // ENOENT there, so this is the only place a Windows run learns of it.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTDIR") throw error;
    throw new CliError(`Cannot write ${filePath}: a parent path is not a directory.`, {
      hint: "Remove or rename the file blocking the path, then try again.",
    });
  }
  // mkdir mode only covers newly created dirs — tighten our own config tree
  // best-effort; never chmod third-party dirs (e.g. ~/.config/opencode).
  const configRoot = await configRootContaining(dir);
  if (configRoot !== null) {
    await chmod(dir, PRIVATE_DIR_MODE).catch(() => {});
    await restrictToOwner(dir, { dir: true });
    await ensureConfigMarker(configRoot);
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
  const tempPath = join(realDir, `.${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(tempPath, "w", targetMode ?? PRIVATE_FILE_MODE);
    try {
      // Before the first byte, so the key is never readable under the
      // parent's inherited ACL; rename keeps the DACL.
      // A dir restricted this run hands its owner-only DACL to what is created in it.
      if (options.mode === PRIVATE_FILE_MODE && !restrictedDirs.has(realDir)) {
        await restrictToOwner(tempPath, { dir: false, recordAs: real });
      }
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithWin32Retry(tempPath, real);
    // rename is atomic but not durable: flush the file before (handle.sync
    // above) and the directory entry after, so a crash cannot lose the write.
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

/**
 * The one cross-process lock lives in `filelock.ts` (nonce holders, heartbeat,
 * guarded stale takeover). Re-exported here because the store's sync path has
 * always imported it from this module; there is no second implementation.
 */
export { withFileLock } from "./filelock.js";
