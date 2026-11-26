import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { test } from "node:test";
import {
  cmdShimArgv,
  escapeCmdArgument,
  findWindowsExecutable,
  isLaunchableFile,
  resolveWindowsCommand,
  shimEnv,
  windowsSearchDirs,
  windowsSystemTool,
} from "../dist/cli/win-spawn.js";

// The end-to-end proof is scripts/e2e.mjs on the windows-latest runner, which
// round-trips metacharacters through a real .cmd shim. These pin the shape.

test("win-spawn: a plain argument is quoted and caret-escaped", () => {
  assert.equal(escapeCmdArgument("--version", false), '^"--version^"');
});

test("win-spawn: shim arguments are escaped twice for the %* re-parse", () => {
  assert.equal(escapeCmdArgument("a&b", true), '^^^"a^^^&b^^^"');
});

test("win-spawn: embedded quotes and trailing backslashes survive MSVCRT parsing", () => {
  assert.equal(escapeCmdArgument('q"t', false), '^"q\\^"t^"');
  assert.equal(escapeCmdArgument("trail\\", false), '^"trail\\\\^"');
});

test("win-spawn: every cmd.exe metacharacter is neutralized", () => {
  const escaped = escapeCmdArgument('()[]%!^"`<>&|;, *?', false);
  // Strip escaped pairs; no bare metacharacter may remain.
  assert.equal(escaped.replace(/\^./g, "").match(/[()\][%!^"`<>&|;, *?]/), null);
});

test("win-spawn: cmdShimArgv wraps one /d /s /v:off /c command line", () => {
  const argv = cmdShimArgv("C:\\npm\\opencode.cmd", ["run", "x y"]);
  // /v:off: delayed expansion enabled in the registry must not expand !var!.
  assert.deepEqual(argv.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
  assert.equal(argv.length, 5);
  assert.ok(argv[4].startsWith('"C:\\npm\\opencode.cmd '), argv[4]);
  assert.ok(argv[4].endsWith('"'), argv[4]);
});

test("cmdShimArgv refuses a line break, which would end the cmd.exe line", () => {
  for (const arg of ["a\nb", "a\r\nb", "trailing\r"]) {
    assert.throws(() => cmdShimArgv("C:\\bin\\opencode.cmd", ["run", arg]), /line break/);
  }
});

// A fake Windows disk: `files` exist (case-insensitively), the cwd is a cloned repo.
const REPO = "C:\\src\\cloned-repo";
const NPM = "C:\\Users\\me\\AppData\\Roaming\\npm";
const fakeDisk = (files) => {
  const set = new Set(files.map((file) => file.toLowerCase()));
  return { isFile: (path) => set.has(path.toLowerCase()) };
};
const winEnv = (path, extra = {}) => ({ PATH: path, PATHEXT: ".COM;.EXE;.BAT;.CMD", ...extra });

test("PATH walk: a .cmd planted in the current directory is never found", () => {
  const disk = fakeDisk([`${REPO}\\opencode.cmd`, `${NPM}\\opencode.cmd`]);
  assert.equal(findWindowsExecutable("opencode", winEnv(NPM), disk), `${NPM}\\opencode.cmd`);
  assert.equal(findWindowsExecutable("opencode", winEnv(""), disk), null);
});

test("PATH walk: `.`, relative, empty and drive-relative entries are dropped", () => {
  const path = [
    ".",
    "",
    "  ",
    ".\\bin",
    "bin",
    "node_modules\\.bin",
    "C:tools",
    "\\tools",
    NPM,
  ].join(";");
  assert.deepEqual(windowsSearchDirs(winEnv(path)), [NPM]);
  const disk = fakeDisk([`${REPO}\\npm.cmd`, `${REPO}\\bin\\npm.cmd`, `${NPM}\\npm.cmd`]);
  assert.equal(findWindowsExecutable("npm", winEnv(path), disk), `${NPM}\\npm.cmd`);
});

test("PATH walk: an absolute entry that is the current directory is kept, the user wrote it", () => {
  const path = [`${REPO}\\`, `"${REPO}"`, NPM].join(";");
  assert.deepEqual(windowsSearchDirs(winEnv(path)), [`${REPO}\\`, REPO, NPM]);
  const disk = fakeDisk([`${REPO}\\tool.cmd`]);
  assert.equal(findWindowsExecutable("tool", winEnv(REPO), disk), `${REPO}\\tool.cmd`);
  // Spelled relatively, the same directory is still refused.
  assert.deepEqual(windowsSearchDirs(winEnv(`.;${REPO.split("\\").at(-1)};${REPO}\\.\\`)), [
    `${REPO}\\.\\`,
  ]);
  assert.equal(findWindowsExecutable("tool", winEnv("."), disk), null);
});

test("PATH walk: quoted and UNC entries are searched", () => {
  const path = '"C:\\Program Files\\nodejs";\\\\server\\share\\bin';
  assert.deepEqual(windowsSearchDirs(winEnv(path)), [
    "C:\\Program Files\\nodejs",
    "\\\\server\\share\\bin",
  ]);
});

test("PATH walk: PATH order first, then PATHEXT order within a directory", () => {
  const first = "C:\\first";
  const second = "C:\\second";
  const disk = fakeDisk([`${first}\\tool.cmd`, `${first}\\tool.exe`, `${second}\\tool.com`]);
  const env = winEnv(`${first};${second}`);
  assert.equal(findWindowsExecutable("tool", env, disk), `${first}\\tool.exe`);
  assert.equal(
    findWindowsExecutable("tool", { ...env, PATHEXT: ".CMD;.EXE" }, disk),
    `${first}\\tool.cmd`,
  );
});

test("PATH walk: npm's extensionless sh shim is skipped for the .cmd beside it", () => {
  const bin = "C:\\Users\\me\\.local\\bin";
  const disk = fakeDisk([`${bin}\\aiand`, `${bin}\\aiand.cmd`]);
  assert.equal(findWindowsExecutable("aiand", winEnv(bin), disk), `${bin}\\aiand.cmd`);
  // A trailing `;` in PATHEXT must not make "" an extension.
  const onlySh = fakeDisk([`${bin}\\aiand`]);
  assert.equal(
    findWindowsExecutable("aiand", winEnv(bin, { PATHEXT: ".EXE;.CMD;" }), onlySh),
    null,
  );
});

test("PATH walk: Path and PathExt are read case-insensitively from a copied env", () => {
  const disk = fakeDisk([`${NPM}\\opencode.cmd`]);
  const env = { Path: NPM, PathExt: ".EXE;.CMD" };
  assert.equal(findWindowsExecutable("opencode", env, disk), `${NPM}\\opencode.cmd`);
});

test("PATH walk: a name with a PATHEXT extension matches exactly; a path is refused", () => {
  const disk = fakeDisk([`${NPM}\\sqlite3.exe`, `${REPO}\\x.cmd`]);
  assert.equal(findWindowsExecutable("sqlite3.exe", winEnv(NPM), disk), `${NPM}\\sqlite3.exe`);
  assert.equal(findWindowsExecutable(".\\x", winEnv(NPM), disk), null);
  assert.equal(findWindowsExecutable("C:x", winEnv(NPM), disk), null);
  assert.equal(findWindowsExecutable("", winEnv(NPM), disk), null);
});

test("resolveWindowsCommand spawns a PATH .exe directly and a cwd one not at all", () => {
  const disk = fakeDisk([`${REPO}\\codex.exe`, `${NPM}\\codex.exe`]);
  assert.deepEqual(resolveWindowsCommand("codex", ["--help"], winEnv(NPM), disk), {
    command: `${NPM}\\codex.exe`,
    args: ["--help"],
    verbatim: false,
  });
  assert.equal(resolveWindowsCommand("codex", [], winEnv("."), disk), null);
});

test("system tools come from System32 under SystemRoot, whatever its case", () => {
  assert.equal(
    windowsSystemTool("tasklist.exe", { SystemRoot: "D:\\Win" }),
    "D:\\Win\\System32\\tasklist.exe",
  );
  assert.equal(
    windowsSystemTool("cmd.exe", { SYSTEMROOT: "C:\\WINDOWS" }),
    "C:\\WINDOWS\\System32\\cmd.exe",
  );
});

test("a System32 tool may sit in a subfolder, spelled with either separator", () => {
  const env = { SystemRoot: "C:\\Windows" };
  const expected = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  assert.equal(windowsSystemTool("WindowsPowerShell/v1.0/powershell.exe", env), expected);
  assert.equal(windowsSystemTool("WindowsPowerShell\\v1.0\\powershell.exe", env), expected);
});

test("a POSIX host takes an absolute SystemRoot as given: the seam tests stub tools through", {
  skip: sep !== "/",
}, () => {
  assert.equal(
    windowsSystemTool("icacls.exe", { SystemRoot: "/tmp/fake" }),
    "/tmp/fake/System32/icacls.exe",
  );
  assert.equal(
    windowsSystemTool("WindowsPowerShell/v1.0/powershell.exe", { SYSTEMROOT: "/tmp/fake" }),
    "/tmp/fake/System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  for (const root of ["", ".", "tmp/fake"]) {
    assert.equal(
      windowsSystemTool("icacls.exe", { SystemRoot: root }),
      "C:\\Windows\\System32\\icacls.exe",
      "a relative root never wins",
    );
  }
});

test("system tools fall back to C:\\Windows when SystemRoot is unset or not drive-rooted", () => {
  for (const env of [{}, { SystemRoot: "" }, { SystemRoot: "Windows" }, { SystemRoot: "." }]) {
    assert.equal(windowsSystemTool("rundll32.exe", env), "C:\\Windows\\System32\\rundll32.exe");
  }
});

test("a .cmd shim runs through System32's cmd.exe, not ComSpec or a bare name", () => {
  const disk = fakeDisk([`${NPM}\\opencode.cmd`]);
  const env = winEnv(NPM, { SystemRoot: "C:\\Windows", ComSpec: "cmd.exe" });
  const resolved = resolveWindowsCommand("opencode", ["run"], env, disk);
  assert.equal(resolved.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(resolved.verbatim, true);
  assert.ok(resolved.args.at(-1).includes(`${NPM}\\opencode.cmd`), resolved.args.at(-1));
});

// Store App Execution Aliases (python.exe, winget.exe, ...): zero-byte APPEXECLINK
// reparse points that stat may refuse to open.
const LOCAL = "C:\\Users\\me\\AppData\\Local";
const ALIASES = `${LOCAL}\\Microsoft\\WindowsApps`;
const stats = (kind) => ({
  isFile: () => kind === "file" || kind === "empty",
  isSymbolicLink: () => kind === "link",
  size: kind === "file" ? 4096 : 0,
});
const diskOf = (entries, { statFails = true } = {}) => ({
  stat: (path) => {
    const kind = entries[path.toLowerCase()];
    if (kind === undefined || (statFails && kind !== "file")) throw new Error("EACCES");
    return stats(kind);
  },
  lstat: (path) => {
    const kind = entries[path.toLowerCase()];
    if (kind === undefined) throw new Error("ENOENT");
    return stats(kind);
  },
});
const aliasEnv = winEnv(ALIASES, { LOCALAPPDATA: LOCAL });

test("an App Execution Alias that stat cannot open is still launchable", () => {
  for (const kind of ["link", "empty"]) {
    const disk = diskOf({ [`${ALIASES}\\python.exe`.toLowerCase()]: kind });
    assert.equal(isLaunchableFile(`${ALIASES}\\python.exe`, aliasEnv, disk), true, kind);
  }
  const lookup = {
    isFile: (path) =>
      isLaunchableFile(
        path,
        aliasEnv,
        diskOf({ [`${ALIASES}\\python.exe`.toLowerCase()]: "link" }),
      ),
  };
  assert.equal(findWindowsExecutable("python", aliasEnv, lookup), `${ALIASES}\\python.exe`);
  assert.deepEqual(resolveWindowsCommand("python", ["-V"], aliasEnv, lookup), {
    command: `${ALIASES}\\python.exe`,
    args: ["-V"],
    verbatim: false,
  });
});

test("the alias leniency is for the WindowsApps directory under LOCALAPPDATA only", () => {
  const entries = {
    [`${ALIASES}\\python.exe`.toLowerCase()]: "link",
    [`${ALIASES}\\nested\\python.exe`.toLowerCase()]: "link",
    "c:\\other\\python.exe": "link",
    "c:\\other\\empty.exe": "empty",
  };
  const disk = diskOf(entries);
  for (const path of [
    `${ALIASES}\\nested\\python.exe`,
    "C:\\other\\python.exe",
    "C:\\other\\empty.exe",
  ]) {
    assert.equal(isLaunchableFile(path, aliasEnv, disk), false, path);
  }
  // No LOCALAPPDATA, or a relative one: nowhere is an alias directory.
  for (const env of [winEnv(ALIASES), winEnv(ALIASES, { LOCALAPPDATA: "AppData\\Local" })]) {
    assert.equal(isLaunchableFile(`${ALIASES}\\python.exe`, env, disk), false);
  }
  // Case-insensitive, and Local may be spelled with a trailing slash.
  assert.equal(
    isLaunchableFile(
      `${ALIASES.toUpperCase()}\\PYTHON.EXE`,
      winEnv("", { LOCALAPPDATA: `${LOCAL}\\` }),
      diskOf({ [`${ALIASES.toUpperCase()}\\PYTHON.EXE`.toLowerCase()]: "link" }),
    ),
    true,
  );
});

test("a missing file, a directory and a non-empty non-link are not launchable aliases", () => {
  const path = `${ALIASES}\\python.exe`;
  assert.equal(isLaunchableFile(path, aliasEnv, diskOf({})), false);
  const directory = { isFile: () => false, isSymbolicLink: () => false, size: 0 };
  assert.equal(
    isLaunchableFile(path, aliasEnv, {
      stat: () => {
        throw new Error("EACCES");
      },
      lstat: () => directory,
    }),
    false,
  );
});

test("an ordinary file that stats fine never needs the alias path", () => {
  const disk = diskOf({ "c:\\tools\\a.exe": "file" });
  assert.equal(isLaunchableFile("C:\\tools\\a.exe", aliasEnv, disk), true);
});

// The shim's own bare `node` is found by cmd.exe, which reads a relative PATH entry as a
// directory under the current one even with NoDefaultCurrentDirectoryInExePath set.
test("a .cmd shim runs under a PATH of absolute entries only", () => {
  const path = [".", "", "node_modules\\.bin", "bin", NPM, "C:\\Program Files\\nodejs"].join(";");
  const disk = fakeDisk([`${NPM}\\opencode.cmd`]);
  const resolved = resolveWindowsCommand("opencode", ["--version"], winEnv(path), disk);
  assert.equal(resolved.env.PATH, `${NPM};C:\\Program Files\\nodejs`);
  assert.equal(resolved.env.PATHEXT, ".COM;.EXE;.BAT;.CMD", "everything else is kept");
  assert.equal(winEnv(path).PATH, path, "the caller's env is not modified");
});

test("shimEnv keeps the spelling of the PATH variable and leaves an env with none alone", () => {
  assert.deepEqual(shimEnv({ Path: `.;${NPM}`, X: "1" }), { Path: NPM, X: "1" });
  const bare = { X: "1" };
  assert.equal(shimEnv(bare), bare);
});

test("a native executable keeps the PATH it was given", () => {
  const disk = fakeDisk(["C:\\tools\\omp.exe"]);
  const resolved = resolveWindowsCommand("omp", [], winEnv("C:\\tools;."), disk);
  assert.equal(resolved.command, "C:\\tools\\omp.exe");
  assert.equal(resolved.env, undefined);
});

// The same premise against the real cmd.exe. The control spawns the shim with the caller's PATH
// and a planted node.cmd runs; resolveWindowsCommand's env keeps it from running.
test("a .cmd shim's bare node is never resolved from a relative PATH entry", {
  skip: process.platform !== "win32" && "needs the real cmd.exe",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "aiand-shim-"));
  try {
    const evil = join(root, "evil");
    const bin = join(root, "bin");
    mkdirSync(join(evil, "sub"), { recursive: true });
    mkdirSync(bin);
    const marker = join(root, "PLANTED");
    const planted = `@echo PLANTED>> "${marker}"\r\n@exit /b 99\r\n`;
    writeFileSync(join(evil, "node.cmd"), planted);
    writeFileSync(join(evil, "sub", "node.cmd"), planted);
    writeFileSync(
      join(bin, "opencode.cmd"),
      "@echo off\r\nnode -e \"process.stdout.write('REAL-NODE')\"\r\n",
    );

    // process.env spells it `Path`; a second `PATH` key beside it would leave the two to disagree.
    const inherited = Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH");
    const env = {
      ...Object.fromEntries(inherited),
      PATH: [".", "", "sub", bin, dirname(process.execPath), process.env.PATH ?? ""].join(
        delimiter,
      ),
      NoDefaultCurrentDirectoryInExePath: "1",
    };
    const resolved = resolveWindowsCommand("opencode", ["--version"], env);
    assert.ok(resolved, "the shim is found on the absolute entry");
    const run = (spawnEnv) =>
      spawnSync(resolved.command, resolved.args, {
        cwd: evil,
        env: spawnEnv,
        windowsVerbatimArguments: resolved.verbatim,
        encoding: "utf8",
      });

    const control = run(env);
    assert.ok(
      existsSync(marker),
      `control: the relative PATH entry reaches the planted node.cmd (${control.stdout})`,
    );
    rmSync(marker);

    const guarded = run(resolved.env ?? env);
    assert.equal(guarded.stdout, "REAL-NODE", guarded.stderr);
    assert.equal(existsSync(marker), false, "the planted node.cmd ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
