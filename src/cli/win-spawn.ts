import { lstatSync, statSync } from "node:fs";
import { isAbsolute, join, sep, win32 } from "node:path";
import { CliError } from "./errors.js";

/**
 * Windows spawn resolution for agent binaries. Node's `spawn` without a shell
 * only finds `.exe`/`.com` on PATH, but npm installs agents as `.cmd` shims
 * (`opencode.cmd`), and since the CVE-2024-27980 fix a `.cmd` cannot be
 * spawned directly at all. Batch files therefore go through `cmd.exe` with
 * every token escaped the way cross-spawn does, so user passthrough stays
 * literal: nothing in an argument is re-parsed as shell syntax.
 */

// cmd.exe metacharacters; each is neutralized with a caret.
const META = /([()\][%!^"`<>&|;, *?])/g;

/** Quote one argument for the MSVCRT parser, then caret-escape it for cmd.exe. */
export function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  let quoted = arg
    // Double the backslashes before a quote, then escape the quote.
    .replace(/(\\*)"/g, '$1$1\\"')
    // Double trailing backslashes so they do not escape the closing quote.
    .replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`.replace(META, "^$1");
  // A shim re-expands `%*` in a second cmd.exe parse, which eats one caret layer.
  return doubleEscape ? quoted.replace(META, "^$1") : quoted;
}

/**
 * The `cmd.exe /d /s /v:off /c` argv that runs batch `file` with `args` verbatim.
 * A CR or LF ends the cmd.exe line and would silently drop every later
 * argument, and no escape survives it, so such arguments are refused.
 */
export function cmdShimArgv(file: string, args: string[]): string[] {
  if (args.some((arg) => /[\r\n]/.test(arg))) {
    throw new CliError(
      `${file} is a batch file, and cmd.exe cannot pass an argument with a line break.`,
      {
        hint: "Put multi-line text in a file and pass its path instead.",
      },
    );
  }
  const line = [file.replace(META, "^$1"), ...args.map((arg) => escapeCmdArgument(arg, true))].join(
    " ",
  );
  // /v:off: a registry-enabled delayed expansion would otherwise expand !var! in arguments.
  return ["/d", "/s", "/v:off", "/c", `"${line}"`];
}

/** Where a PATH lookup probes the disk: a seam so tests can fake a Windows machine. */
export type PathLookup = { isFile: (path: string) => boolean };

/** The parts of `fs.Stats` a probe reads. */
export type StatLike = { isFile(): boolean; isSymbolicLink(): boolean; size: number };

/**
 * Whether `path` is a launchable file. A Store App Execution Alias
 * (`python.exe` under `%LOCALAPPDATA%\Microsoft\WindowsApps`) is an
 * APPEXECLINK reparse point that `stat` can fail to open or report as no
 * file; `lstat` still sees the link itself, a zero-byte file or a symlink.
 * That leniency is for that one directory, never for the rest of PATH.
 */
export function isLaunchableFile(
  path: string,
  env: NodeJS.ProcessEnv,
  disk: { stat: (path: string) => StatLike; lstat: (path: string) => StatLike },
): boolean {
  try {
    if (disk.stat(path).isFile()) return true;
  } catch {
    // fall through to the alias probe
  }
  if (!isStoreAliasDir(win32.dirname(path), env)) return false;
  try {
    const entry = disk.lstat(path);
    return entry.isSymbolicLink() || (entry.isFile() && entry.size === 0);
  } catch {
    return false;
  }
}

function isStoreAliasDir(dir: string, env: NodeJS.ProcessEnv): boolean {
  const local = windowsEnv(env, "LOCALAPPDATA");
  if (!local || !ROOTED.test(local)) return false;
  const aliases = win32.join(local, "Microsoft", "WindowsApps");
  return win32.resolve(dir).toLowerCase() === win32.resolve(aliases).toLowerCase();
}

const hostLookup = (env: NodeJS.ProcessEnv): PathLookup => ({
  isFile: (path) => isLaunchableFile(path, env, { stat: statSync, lstat: lstatSync }),
});

/** Read `name` case-insensitively: a copied `process.env` loses Windows' case folding (`Path`). */
function windowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

// A drive-rooted or UNC path. `\foo` (current drive) and `C:foo` (that drive's cwd) are not.
const ROOTED = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/**
 * The PATH directories a lookup may search. `where`, cmd.exe and libuv all try
 * the current directory first, so a `.cmd` planted in a cloned repo would
 * shadow the real binary; here an empty, relative or `.` entry is dropped. An
 * absolute entry stays even when it is the current directory: the user wrote
 * it, and the shell would run the same file.
 */
export function windowsSearchDirs(env: NodeJS.ProcessEnv): string[] {
  return (windowsEnv(env, "PATH") ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => ROOTED.test(entry));
}

function pathExts(env: NodeJS.ProcessEnv): string[] {
  // Drop empty entries: a trailing `;` is common, and "" would match the
  // extensionless sh shim npm writes for Git Bash, which Windows cannot run.
  return (windowsEnv(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => /^\.[a-z0-9_]+$/.test(ext));
}

/**
 * The first file on PATH named `bin` plus a PATHEXT extension (PATH order
 * outer, PATHEXT order inner, as cmd.exe searches), or null. Never the
 * current directory through a relative entry: see windowsSearchDirs.
 */
export function findWindowsExecutable(
  bin: string,
  env: NodeJS.ProcessEnv,
  lookup: PathLookup = hostLookup(env),
): string | null {
  if (!bin || /[\\/:]/.test(bin)) return null;
  const exts = pathExts(env);
  const own = win32.extname(bin).toLowerCase();
  const names = own && exts.includes(own) ? [bin] : exts.map((ext) => `${bin}${ext}`);
  for (const dir of windowsSearchDirs(env)) {
    for (const name of names) {
      const candidate = win32.join(dir, name);
      if (lookup.isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * A tool that ships in System32, by absolute path: a bare name would let
 * libuv try the current directory first. `SystemRoot` must be drive-rooted
 * (`C:\Windows`); anything else, a relative path included, falls back to the
 * default install location. `name` may reach into a subfolder
 * (`WindowsPowerShell/v1.0/powershell.exe`), with either separator.
 *
 * A host whose path separator is `/` is not Windows, so it has no real
 * SystemRoot: only tests that stub the tools under a fake one get there, and
 * an absolute POSIX root is taken as it is so the stubs can be found.
 */
export function windowsSystemTool(name: string, env: NodeJS.ProcessEnv): string {
  const root = windowsEnv(env, "SystemRoot");
  const parts = name.split(/[\\/]/);
  if (root && sep === "/" && isAbsolute(root)) return join(root, "System32", ...parts);
  const drive = root && /^[A-Za-z]:[\\/]/.test(root) ? root : "C:\\Windows";
  return win32.join(drive, "System32", ...parts);
}

/**
 * `env` for a process that runs through cmd.exe, with a PATH of only the
 * entries windowsSearchDirs allows. NoDefaultCurrentDirectoryInExePath rules
 * out the implicit current directory, but cmd.exe still reads `.`, `bin` or
 * `node_modules\.bin` in PATH as a directory under it, so the bare `node` of
 * an npm shim would run one planted in a cloned repo.
 */
export function shimEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key === undefined ? env : { ...env, [key]: windowsSearchDirs(env).join(";") };
}

/**
 * Resolve `bin` against PATH/PATHEXT and return what to spawn, always by
 * absolute path: a bare name would let libuv search the current directory.
 * Returns null when nothing matches, so the caller reports a missing binary.
 */
export function resolveWindowsCommand(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  lookup?: PathLookup,
): { command: string; args: string[]; verbatim: boolean; env?: NodeJS.ProcessEnv } | null {
  const file = findWindowsExecutable(bin, env, lookup);
  if (!file) return null;
  const ext = win32.extname(file).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    return {
      // Not ComSpec: the escaping above is cmd.exe's, and ComSpec may be relative or another shell.
      command: windowsSystemTool("cmd.exe", env),
      args: cmdShimArgv(file, args),
      verbatim: true,
      env: shimEnv(env),
    };
  }
  return { command: file, args, verbatim: false };
}
