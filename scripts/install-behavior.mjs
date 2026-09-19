// Installer behavior cases: isolated mkdtemp HOME per case, check()/results
// style like scripts/e2e.mjs. NOT wired to npm test; run from the installer
// CI job (node scripts/install-behavior.mjs).
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  rmSync,
  mkdtempSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

// Git Bash eats backslashes in argv (`C:\Users\...` → `C:Users...`). Convert
// Windows paths to `/c/...` before handing them to bash.
function toGitBashPath(p) {
  const s = String(p).replace(/\\/g, "/");
  const m = s.match(/^([A-Za-z]):\/(.*)$/);
  return m ? `/${m[1].toLowerCase()}/${m[2]}` : s;
}

const HAS_BASH = (() => {
  const probe = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
  return !probe.error && probe.status === 0 && (probe.stdout ?? "").includes("ok");
})();

function bashEnv(env) {
  if (process.platform !== "win32") return env;
  const next = { ...env };
  for (const key of ["HOME", "AIAND_DIR", "AIAND_SOURCE"]) {
    if (typeof next[key] === "string" && /^[A-Za-z]:[\\/]/.test(next[key])) {
      next[key] = toGitBashPath(next[key]);
    }
  }
  return next;
}

function runBash(args, env) {
  const argv = args.map((arg, i) => (i === 0 && process.platform === "win32" ? toGitBashPath(arg) : arg));
  return spawnSync("bash", argv, { env: bashEnv(env), encoding: "utf8" });
}

// Scrub the installer's own knobs like scripts/e2e.mjs, then apply per-case
// overrides (isolated HOME, AIAND_SOURCE under test).
function childEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AIAND_DIR: undefined,
    AIAND_UNINSTALL_FORCE: undefined,
    AIAND_SOURCE: undefined,
    ...extra,
  };
}

// Copy only install.sh into a temp dir so SCRIPT_DIR is not an @aiand/cli
// checkout and the installer takes the clone path.
function copiedInstaller(caseDir) {
  const scriptDir = join(caseDir, "scriptdir");
  mkdirSync(scriptDir, { recursive: true });
  copyFileSync(join(ROOT, "install.sh"), join(scriptDir, "install.sh"));
  return join(scriptDir, "install.sh");
}

function gitInit(repo, files) {
  mkdirSync(repo, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "seed",
    ],
    { cwd: repo }
  );
}

if (!HAS_BASH) {
  check("bash installer cases skipped (no bash)", true, "bash not installed");
} else {
// --- case 1: allowlist reject ------------------------------------------------
try {
  const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
  try {
    const home = join(caseDir, "home");
    mkdirSync(home, { recursive: true });
    const installer = copiedInstaller(caseDir);
    const run = runBash([installer], childEnv(home, { AIAND_SOURCE: "https://evil.example/aiand-cli.git" }));
    const stderr = run.stderr ?? "";
    check("allowlist reject exits non-zero", (run.status ?? 0) !== 0, `status=${run.status}`);
    check(
      "allowlist reject mentions allowlist",
      stderr.includes("not an allowlisted"),
      stderr.split("\n").find((l) => l.includes("not an allowlisted")) ?? stderr.split("\n")[0] ?? ""
    );
    check("allowlist reject leaves no checkout", !existsSync(join(home, ".aiand", "cli")), join(home, ".aiand", "cli"));
    for (const source of ["git@evil.example:aiand-cli.git", "github.com:evil/aiand-cli.git"]) {
      const scp = runBash([installer], childEnv(home, { AIAND_SOURCE: source }));
      check(
        `allowlist reject ${source} exits non-zero`,
        (scp.status ?? 0) !== 0,
        `status=${scp.status}`
      );
      check(
        `allowlist reject ${source} mentions allowlist`,
        (scp.stderr ?? "").includes("not an allowlisted"),
        (scp.stderr ?? "").split("\n").find((l) => l.includes("not an allowlisted")) ?? (scp.stderr ?? "").split("\n")[0] ?? ""
      );
    }
  } finally {
    rmSync(caseDir, { recursive: true, force: true });
  }
} catch (error) {
  check("allowlist reject harness", false, String(error?.message ?? error).split("\n")[0]);
}

// --- case 2: staged failure leaves the old install untouched ------------------

// Old install is a clone of a local origin (fetch succeeds, HEAD is the
// ancestor) so the failure lands at `npm ci` in staging: AIAND_SOURCE has no
// package-lock.json and the installer must abort with the old tree intact.
try {
  const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
  try {
    const home = join(caseDir, "home");
    const originDir = join(caseDir, "origin");
    gitInit(originDir, {
      "package.json": JSON.stringify({ name: "@aiand/cli", version: "0.0.0-old" }, null, 2) + "\n",
      "dist/index.js": '#!/usr/bin/env node\nconsole.log("0.0.0-old");\n',
      ".aiand-installer-owned": "aiand-cli installer ownership marker\n",
    });
    const installDir = join(home, ".aiand", "cli");
    mkdirSync(dirname(installDir), { recursive: true });
    execFileSync("git", ["clone", "-q", originDir, installDir]);
    const headBefore = execFileSync("git", ["-C", installDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const launcher = join(binDir, "aiand");
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${join(installDir, "dist", "index.js")}" "$@"\n`
    );
    chmodSync(launcher, 0o755);

    const srcDir = join(caseDir, "src");
    gitInit(srcDir, {
      "package.json": JSON.stringify({ name: "@aiand/cli", version: "0.0.0-new" }, null, 2) + "\n",
      "index.js": "console.log('new');\n",
    });

    const installer = copiedInstaller(caseDir);
    const run = runBash([installer], childEnv(home, { AIAND_SOURCE: srcDir }));
    const stderr = run.stderr ?? "";
    check("staged failure exits non-zero", (run.status ?? 0) !== 0, `status=${run.status}`);
    check(
      "staged failure reports the old install was left unchanged",
      stderr.includes("left unchanged"),
      stderr.split("\n").find((l) => l.includes("left unchanged")) ?? stderr.split("\n").pop() ?? ""
    );
    let versionAfter = "";
    try {
      versionAfter = execFileSync(launcher, ["--version"], { env: childEnv(home), encoding: "utf8" }).trim();
    } catch (error) {
      versionAfter = `ERROR: ${String(error?.message ?? error).split("\n")[0]}`;
    }
    check("staged failure keeps the old launcher working", versionAfter === "0.0.0-old", versionAfter);
    const headAfter = existsSync(installDir)
      ? execFileSync("git", ["-C", installDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
      : "<checkout gone>";
    check(
      "staged failure leaves old HEAD unchanged",
      headAfter === headBefore,
      `${headBefore.slice(0, 12)} -> ${String(headAfter).slice(0, 12)}`
    );
    const aiandDir = join(home, ".aiand");
    const leftovers = existsSync(aiandDir) ? readdirSync(aiandDir).filter((n) => n.startsWith(".cli-staging-")) : [];
    check("staged failure leaves no staging dirs", leftovers.length === 0, leftovers.join(","));
  } finally {
    rmSync(caseDir, { recursive: true, force: true });
  }
} catch (error) {
  check("staged-failure harness", false, String(error?.message ?? error).split("\n")[0]);
}

// --- case 3: NO_COLOR ----------------------------------------------------------
try {
  const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
  try {
    const home = join(caseDir, "home");
    mkdirSync(home, { recursive: true });
    const installer = copiedInstaller(caseDir);
    const run = runBash(
      [installer],
      childEnv(home, { AIAND_SOURCE: "https://evil.example/aiand-cli.git", NO_COLOR: "1" })
    );
    const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    check("NO_COLOR keeps the ==> marker", combined.includes("==>"), combined.split("\n")[0] ?? "");
    check("NO_COLOR emits no CSI escapes", !combined.includes("\x1b["), combined.includes("\x1b[") ? "found CSI" : "");
  } finally {
    rmSync(caseDir, { recursive: true, force: true });
  }
} catch (error) {
  check("NO_COLOR harness", false, String(error?.message ?? error).split("\n")[0]);
}

}


// --- case 5: uninstall aborts when init --off fails, files kept --------------
if (!HAS_BASH) {
  check("uninstall off-failure skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const home = join(caseDir, "home");
      const installDir = join(home, ".aiand", "cli");
      mkdirSync(installDir, { recursive: true });
      writeFileSync(
        join(installDir, "package.json"),
        JSON.stringify({ name: "@aiand/cli", version: "0.0.0-old" }, null, 2) + "\n"
      );
      writeFileSync(join(installDir, ".aiand-installer-owned"), "aiand-cli installer ownership marker\n");
      const binDir = join(home, ".local", "bin");
      mkdirSync(binDir, { recursive: true });
      const launcher = join(binDir, "aiand");
      writeFileSync(launcher, "#!/bin/sh\nexit 7\n");
      chmodSync(launcher, 0o755);
      const installer = copiedInstaller(caseDir);
      const run = runBash([installer, "uninstall"], childEnv(home));
      check("uninstall aborts when off fails", (run.status ?? 0) !== 0, `status=${run.status}`);
      check("uninstall off-failure leaves the checkout", existsSync(installDir), installDir);
      check("uninstall off-failure leaves the launcher", existsSync(launcher), launcher);
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("uninstall off-failure harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 4: PowerShell launcher write + uninstall identity (skip without a host) ------
{
  const ps1Path = join(ROOT, "install.ps1");
  let host = null;
  for (const cmd of ["pwsh", "powershell.exe"]) {
    const probe = spawnSync(cmd, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      host = cmd;
      break;
    }
  }
  if (!host) {
    check("pwsh launcher subcheck skipped (pwsh missing)", true, "pwsh not installed");
  } else if (!existsSync(ps1Path)) {
    check("pwsh launcher subcheck skipped (install.ps1 absent)", true, "sibling not landed");
  } else {
    const ps1 = readFileSync(ps1Path, "utf8");
    check(
      "install.ps1 identity uses ConvertFrom-Json",
      ps1.includes("function Read-PackageJson") && ps1.includes("ConvertFrom-Json"),
      "PS 5.1 strips quotes from native node -e scripts"
    );
    check(
      "install.ps1 writes launchers with here-strings and WriteAllText",
      ps1.includes('$cmdText = @"') &&
        ps1.includes('$bashText = @"') &&
        ps1.includes("[System.IO.File]::WriteAllText") &&
        !ps1.includes("$cmdLines") &&
        !ps1.includes("$bashLines"),
      "PS comma/+ inside @() and Out-File wrapping both break aiand.cmd"
    );
    check(
      "install.ps1 Git Bash shim converts Windows paths to /c/ form",
      ps1.includes("function ConvertTo-UnixPath") &&
        ps1.includes("$nodeBinUnix = ConvertTo-UnixPath") &&
        ps1.includes("$entryUnix = ConvertTo-UnixPath") &&
        ps1.includes("function Get-GitBash") &&
        ps1.includes("Set-UnixExecutable"),
      "backslashes in the bash shim split C:\\nodejs\\node.exe on \\n"
    );

    let winPs1 = ps1Path;
    const wsl = spawnSync("wslpath", ["-w", ps1Path], { encoding: "utf8" });
    if (!wsl.error && wsl.status === 0 && wsl.stdout.trim()) winPs1 = wsl.stdout.trim();

    const smoke = `
$ErrorActionPreference = 'Stop'
$iso = Join-Path $env:TEMP ('aiand-ib-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $iso -Force | Out-Null
$env:USERPROFILE = $iso
$env:HOME = $iso
$env:AIAND_NO_MODIFY_PATH = '1'
$checkout = Join-Path $iso '.aiand\\cli'
New-Item -ItemType Directory -Path $checkout -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $checkout 'package.json'), '{"name":"@aiand/cli"}' + [Environment]::NewLine)
[System.IO.File]::WriteAllText((Join-Path $checkout '.aiand-installer-owned'), 'aiand-cli installer ownership marker' + [Environment]::NewLine)
$bin = Join-Path $iso '.local\\bin'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $bin 'aiand.cmd'), '@echo off' + [Environment]::NewLine)
$runner = (Get-Process -Id $PID).Path
& $runner -NoProfile -ExecutionPolicy Bypass -File '${winPs1.replace(/'/g, "''")}' uninstall --force
if ($LASTEXITCODE -ne 0) { throw "uninstall exit $LASTEXITCODE" }
if (Test-Path (Join-Path $bin 'aiand.cmd')) { throw 'aiand.cmd still present' }
if (Test-Path $checkout) { throw 'checkout still present' }
Remove-Item -Recurse -Force $iso -ErrorAction SilentlyContinue
Write-Output 'ok'
`;
    const run = spawnSync(host, ["-NoProfile", "-Command", smoke], { encoding: "utf8", timeout: 60_000 });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    check(
      "install.ps1 uninstall --force removes an owned checkout",
      (run.status ?? 1) === 0 && out.split("\n").pop() === "ok",
      out.split("\n").filter(Boolean).pop() ?? `status=${run.status}`
    );
  }
}

console.log(results.join("\n"));
console.log(results.every((r) => r.startsWith("PASS")) ? "INSTALL-BEHAVIOR: ALL PASS" : "INSTALL-BEHAVIOR: FAILURES PRESENT");
