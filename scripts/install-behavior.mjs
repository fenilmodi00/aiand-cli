// Installer behavior cases: isolated mkdtemp HOME per case, check()/results
// style like scripts/e2e.mjs. NOT wired to npm test; run from the installer
// CI job (node scripts/install-behavior.mjs).

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PWSH_SMOKE_TIMEOUT_MS = 60_000;
// What the installers stamp to mark a checkout and a launcher as their own.
const OWNERSHIP_MARKER = ".aiand-installer-owned";
const LAUNCHER_HEADER = "aiand launcher";

const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

// A check that could not run. Locally it prints SKIP and never reads as a pass;
// on CI, where every runner ships pwsh, a skip is a failure so a missing host
// cannot hide a script that does not parse.
function skip(name, detail) {
  const onCi = Boolean(process.env.CI);
  results.push(`${onCi ? "FAIL" : "SKIP"} ${name} — ${detail}${onCi ? " (required on CI)" : ""}`);
  if (onCi) process.exitCode = 1;
}

function listPowerShellFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listPowerShellFiles(path));
    else if (/\.ps(m)?1$/i.test(entry.name)) found.push(path);
  }
  return found;
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
  for (const key of ["HOME", "AIAND_DIR", "AIAND_SOURCE", "AIAND_CONFIG_DIR"]) {
    if (typeof next[key] === "string" && /^[A-Za-z]:[\\/]/.test(next[key])) {
      next[key] = toGitBashPath(next[key]);
    }
  }
  return next;
}

function runBash(args, env) {
  const argv = args.map((arg, i) =>
    i === 0 && process.platform === "win32" ? toGitBashPath(arg) : arg,
  );
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
    // The side-by-side knobs are scrubbed too: a leaked one from the outer
    // environment would move the install to ~/.aiand/cli-v2 and rename the
    // launcher the cases below assert.
    AIAND_CONFIG_DIR: undefined,
    AIAND_INSTALL_NAME: undefined,
    AIAND_BRANCH: undefined,
    AIAND_COMMAND_NAME: undefined,
    AIAND_V2_SIDEBYSIDE: "0",
    AIAND_API_KEY: undefined,
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
    { cwd: repo },
  );
}

// Minimal source repo that passes verify_built_cli without npm: package.json
// plus a dist/index.js stub answering --version/--help from package.json.
function gitInitRunnableCli(repo, version) {
  gitInit(repo, {
    "package.json": `${JSON.stringify({ name: "@aiand/cli", version }, null, 2)}\n`,
    "dist/index.js": [
      'const fs = require("fs");',
      'const path = require("path");',
      'const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));',
      "const arg = process.argv[2];",
      'if (arg === "--version") console.log(pkg.version);',
      'else if (arg === "--help") console.log("aiand test stub");',
      "else process.exit(1);",
      "",
    ].join("\n"),
  });
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
      const run = runBash(
        [installer],
        childEnv(home, { AIAND_SOURCE: "https://evil.example/aiand-cli.git" }),
      );
      const stderr = run.stderr ?? "";
      check("allowlist reject exits non-zero", (run.status ?? 0) !== 0, `status=${run.status}`);
      check(
        "allowlist reject mentions allowlist",
        stderr.includes("not an allowlisted"),
        stderr.split("\n").find((l) => l.includes("not an allowlisted")) ??
          stderr.split("\n")[0] ??
          "",
      );
      check(
        "allowlist reject leaves no checkout",
        !existsSync(join(home, ".aiand", "cli")),
        join(home, ".aiand", "cli"),
      );
      // A leading dash would reach `git clone` as an option.
      const planted = join(caseDir, "upload-pack-ran");
      for (const source of [
        "git@evil.example:aiand-cli.git",
        "github.com:evil/aiand-cli.git",
        `--upload-pack=touch ${planted}`,
        "-hiddenrepo",
      ]) {
        const scp = runBash([installer], childEnv(home, { AIAND_SOURCE: source }));
        check(
          `allowlist reject ${source} exits non-zero`,
          (scp.status ?? 0) !== 0,
          `status=${scp.status}`,
        );
        check(
          `allowlist reject ${source} mentions allowlist`,
          (scp.stderr ?? "").includes("not an allowlisted"),
          (scp.stderr ?? "").split("\n").find((l) => l.includes("not an allowlisted")) ??
            (scp.stderr ?? "").split("\n")[0] ??
            "",
        );
      }
      check("a dash-led AIAND_SOURCE never runs as a git option", !existsSync(planted), planted);
      const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
      check(
        "install.sh ends git clone options with --",
        /git clone --quiet --depth 1 -- "\$\{SOURCE\}"/.test(sh),
        "git clone … -- SOURCE",
      );
      const ps1 = readFileSync(join(ROOT, "install.ps1"), "utf8");
      check(
        "install.ps1 ends git clone options with --",
        ps1.includes("& git clone --quiet --depth 1 '--' $Source") &&
          ps1.includes("if ($url.StartsWith('-'))"),
        "git clone … '--' $Source",
      );
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
        "package.json": `${JSON.stringify({ name: "@aiand/cli", version: "0.0.0-old" }, null, 2)}\n`,
        "dist/index.js": '#!/usr/bin/env node\nconsole.log("0.0.0-old");\n',
      });
      const installDir = join(home, ".aiand", "cli");
      mkdirSync(dirname(installDir), { recursive: true });
      execFileSync("git", ["clone", "-q", originDir, installDir]);
      // The marker is untracked, exactly as a real install leaves it (older
      // installs never wrote it to .git/info/exclude). The update must still
      // pass the local-changes check and reach staging.
      writeFileSync(join(installDir, OWNERSHIP_MARKER), "aiand-cli installer ownership marker\n");
      const headBefore = execFileSync("git", ["-C", installDir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const binDir = join(home, ".local", "bin");
      mkdirSync(binDir, { recursive: true });
      const launcher = join(binDir, "aiand");
      // Header marks it installer-written: every real installer version bakes
      // "# aiand launcher" into the launcher, so an upgrade must not refuse it.
      writeFileSync(
        launcher,
        `#!/bin/sh\n# ${LAUNCHER_HEADER} (test stub)\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${join(installDir, "dist", "index.js")}" "$@"\n`,
      );
      chmodSync(launcher, 0o755);

      const srcDir = join(caseDir, "src");
      gitInit(srcDir, {
        "package.json": `${JSON.stringify({ name: "@aiand/cli", version: "0.0.0-new" }, null, 2)}\n`,
        "index.js": "console.log('new');\n",
      });

      const installer = copiedInstaller(caseDir);
      const run = runBash([installer], childEnv(home, { AIAND_SOURCE: srcDir }));
      const stderr = run.stderr ?? "";
      check("staged failure exits non-zero", (run.status ?? 0) !== 0, `status=${run.status}`);
      check(
        "update ignores the untracked ownership marker",
        !stderr.includes("has local changes"),
        stderr.split("\n").find((l) => l.includes("local changes")) ?? "",
      );
      check(
        "staged failure reports the old install was left unchanged",
        stderr.includes("left unchanged"),
        stderr.split("\n").find((l) => l.includes("left unchanged")) ??
          stderr.split("\n").pop() ??
          "",
      );
      // The launcher is a sh script, so run it through bash (Git Bash on Windows).
      const after = runBash([launcher, "--version"], childEnv(home));
      const versionAfter =
        after.status === 0
          ? (after.stdout ?? "").trim()
          : `ERROR: status=${after.status} ${(after.stderr ?? "").split("\n")[0]}`;
      check(
        "staged failure keeps the old launcher working",
        versionAfter === "0.0.0-old",
        versionAfter,
      );
      const headAfter = existsSync(installDir)
        ? execFileSync("git", ["-C", installDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
        : "<checkout gone>";
      check(
        "staged failure leaves old HEAD unchanged",
        headAfter === headBefore,
        `${headBefore.slice(0, 12)} -> ${String(headAfter).slice(0, 12)}`,
      );
      const aiandDir = join(home, ".aiand");
      const leftovers = existsSync(aiandDir)
        ? readdirSync(aiandDir).filter((n) => n.startsWith(".cli-staging-"))
        : [];
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
        childEnv(home, { AIAND_SOURCE: "https://evil.example/aiand-cli.git", NO_COLOR: "1" }),
      );
      const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      check(
        "NO_COLOR keeps the ==> marker",
        combined.includes("==>"),
        combined.split("\n")[0] ?? "",
      );
      check(
        "NO_COLOR emits no CSI escapes",
        !combined.includes("\x1b["),
        combined.includes("\x1b[") ? "found CSI" : "",
      );
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
        `${JSON.stringify({ name: "@aiand/cli", version: "0.0.0-old" }, null, 2)}\n`,
      );
      writeFileSync(join(installDir, OWNERSHIP_MARKER), "aiand-cli installer ownership marker\n");
      const binDir = join(home, ".local", "bin");
      mkdirSync(binDir, { recursive: true });
      const launcher = join(binDir, "aiand");
      writeFileSync(launcher, `#!/bin/sh\n# ${LAUNCHER_HEADER} (test stub)\nexit 7\n`);
      chmodSync(launcher, 0o755);
      const installer = copiedInstaller(caseDir);
      const run = runBash([installer, "uninstall"], childEnv(home));
      check("uninstall aborts when off fails", (run.status ?? 0) !== 0, `status=${run.status}`);
      check(
        "uninstall off-failure ran the launcher (not a foreign refusal)",
        (run.stderr ?? "").includes("agent teardown failed"),
        (run.stderr ?? "").split("\n").find((l) => l.includes("Error")) ?? `status=${run.status}`,
      );
      check("uninstall off-failure leaves the checkout", existsSync(installDir), installDir);
      check("uninstall off-failure leaves the launcher", existsSync(launcher), launcher);
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("uninstall off-failure harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 6: unknown install argv usage-errors instead of silently installing ----
if (!HAS_BASH) {
  check("unknown argv skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const home = join(caseDir, "home");
      mkdirSync(home, { recursive: true });
      const installer = copiedInstaller(caseDir);
      for (const bad of ["--frobnicate", "--force"]) {
        const run = runBash([installer, bad], childEnv(home));
        check(
          `unknown argv ${bad} exits non-zero`,
          (run.status ?? 0) !== 0,
          `status=${run.status}`,
        );
        check(
          `unknown argv ${bad} prints usage`,
          (run.stderr ?? "").includes("Usage: bash install.sh"),
          (run.stderr ?? "").split("\n").find((l) => l.includes("Usage")) ?? `status=${run.status}`,
        );
        check(
          `unknown argv ${bad} leaves no checkout`,
          !existsSync(join(home, ".aiand", "cli")),
          join(home, ".aiand", "cli"),
        );
      }
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("unknown-argv harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 7: install refuses a foreign launcher, leaves it byte-identical --
if (!HAS_BASH) {
  check("foreign-launcher install skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const home = join(caseDir, "home");
      mkdirSync(home, { recursive: true });
      const binDir = join(home, ".local", "bin");
      mkdirSync(binDir, { recursive: true });
      const launcher = join(binDir, "aiand");
      const foreign = "#!/bin/sh\necho mine\n";
      writeFileSync(launcher, foreign);
      chmodSync(launcher, 0o755);
      const srcDir = join(caseDir, "src");
      gitInitRunnableCli(srcDir, "0.0.0-new");
      const installer = copiedInstaller(caseDir);
      const run = runBash(
        [installer],
        childEnv(home, { AIAND_SOURCE: srcDir, AIAND_SKIP_BUILD: "1" }),
      );
      const stderr = run.stderr ?? "";
      check("install refuses a foreign launcher", (run.status ?? 0) !== 0, `status=${run.status}`);
      check(
        "foreign-launcher refusal is actionable",
        stderr.includes("was not written by the aiand installer"),
        stderr.split("\n").find((l) => l.includes("Error")) ?? stderr.split("\n").pop() ?? "",
      );
      check(
        "foreign launcher left byte-identical",
        existsSync(launcher) && readFileSync(launcher, "utf8") === foreign,
        existsSync(launcher) ? launcher : "launcher gone",
      );
      check(
        "foreign-launcher refusal leaves no checkout (fails before clone/swap)",
        !existsSync(join(home, ".aiand", "cli")),
        join(home, ".aiand", "cli"),
      );
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check(
      "foreign-launcher install harness",
      false,
      String(error?.message ?? error).split("\n")[0],
    );
  }
}

// --- case 8: uninstall refuses to execute or rm a foreign launcher ---------
if (!HAS_BASH) {
  check("foreign-launcher uninstall skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const home = join(caseDir, "home");
      const installDir = join(home, ".aiand", "cli");
      mkdirSync(installDir, { recursive: true });
      writeFileSync(
        join(installDir, "package.json"),
        `${JSON.stringify({ name: "@aiand/cli", version: "0.0.0-old" }, null, 2)}\n`,
      );
      writeFileSync(join(installDir, OWNERSHIP_MARKER), "aiand-cli installer ownership marker\n");
      const binDir = join(home, ".local", "bin");
      mkdirSync(binDir, { recursive: true });
      const launcher = join(binDir, "aiand");
      const foreign = "#!/bin/sh\necho mine\n";
      writeFileSync(launcher, foreign);
      chmodSync(launcher, 0o755);
      const installer = copiedInstaller(caseDir);

      const run = runBash([installer, "uninstall"], childEnv(home));
      check(
        "uninstall refuses to run a foreign launcher",
        (run.status ?? 0) !== 0,
        `status=${run.status}`,
      );
      check(
        "foreign-launcher uninstall names the refusal",
        (run.stderr ?? "").includes("refusing to run"),
        (run.stderr ?? "").split("\n").find((l) => l.includes("Error")) ?? `status=${run.status}`,
      );
      check("refused uninstall leaves the checkout", existsSync(installDir), installDir);
      check(
        "refused uninstall leaves the launcher byte-identical",
        existsSync(launcher) && readFileSync(launcher, "utf8") === foreign,
        existsSync(launcher) ? launcher : "launcher gone",
      );

      const forced = runBash([installer, "uninstall", "--force"], childEnv(home));
      check(
        "uninstall --force exits zero with a foreign launcher",
        (forced.status ?? 1) === 0,
        `status=${forced.status}`,
      );
      check(
        "uninstall --force still removes the owned checkout",
        !existsSync(installDir),
        installDir,
      );
      check(
        "uninstall --force keeps the foreign launcher byte-identical",
        existsSync(launcher) && readFileSync(launcher, "utf8") === foreign,
        existsSync(launcher) ? launcher : "launcher gone",
      );
      check(
        "uninstall --force reports the kept launcher",
        `${forced.stdout ?? ""}${forced.stderr ?? ""}`.includes("Kept foreign launcher"),
        (`${forced.stdout ?? ""}${forced.stderr ?? ""}`.split("\n").pop() ?? "").slice(0, 120),
      );
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check(
      "foreign-launcher uninstall harness",
      false,
      String(error?.message ?? error).split("\n")[0],
    );
  }
}

// --- case 8b: uninstall refuses to execute or rm a foreign aiand.cmd -------
if (!HAS_BASH) {
  check("foreign-cmd uninstall skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const home = join(caseDir, "home");
      const installDir = join(home, ".aiand", "cli");
      mkdirSync(installDir, { recursive: true });
      writeFileSync(
        join(installDir, "package.json"),
        `${JSON.stringify({ name: "@aiand/cli", version: "0.0.0-old" }, null, 2)}\n`,
      );
      writeFileSync(join(installDir, OWNERSHIP_MARKER), "aiand-cli installer ownership marker\n");
      const binDir = join(home, ".local", "bin");
      mkdirSync(binDir, { recursive: true });
      const launcherCmd = join(binDir, "aiand.cmd");
      const foreign = "#!/bin/sh\nexit 0\n";
      writeFileSync(launcherCmd, foreign);
      chmodSync(launcherCmd, 0o755);
      const installer = copiedInstaller(caseDir);

      const run = runBash([installer, "uninstall"], childEnv(home));
      check(
        "uninstall refuses to run a foreign aiand.cmd",
        (run.status ?? 0) !== 0,
        `status=${run.status}`,
      );
      check(
        "foreign-cmd uninstall names the refusal",
        (run.stderr ?? "").includes("refusing to run"),
        (run.stderr ?? "").split("\n").find((l) => l.includes("Error")) ?? `status=${run.status}`,
      );
      check(
        "refused uninstall leaves the foreign aiand.cmd",
        existsSync(launcherCmd) && readFileSync(launcherCmd, "utf8") === foreign,
        existsSync(launcherCmd) ? launcherCmd : "aiand.cmd gone",
      );
      check("refused uninstall leaves the checkout", existsSync(installDir), installDir);

      const forced = runBash([installer, "uninstall", "--force"], childEnv(home));
      check(
        "uninstall --force exits zero with a foreign aiand.cmd",
        (forced.status ?? 1) === 0,
        `status=${forced.status}`,
      );
      check(
        "uninstall --force still removes the owned checkout",
        !existsSync(installDir),
        installDir,
      );
      check(
        "uninstall --force keeps the foreign aiand.cmd",
        existsSync(launcherCmd) && readFileSync(launcherCmd, "utf8") === foreign,
        existsSync(launcherCmd) ? launcherCmd : "aiand.cmd gone",
      );
      check(
        "uninstall --force reports the kept aiand.cmd",
        `${forced.stdout ?? ""}${forced.stderr ?? ""}`.includes("Kept foreign launcher"),
        (`${forced.stdout ?? ""}${forced.stderr ?? ""}`.split("\n").pop() ?? "").slice(0, 120),
      );
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("foreign-cmd uninstall harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 9: SHELL=fish/nushell prints a PATH snippet, edits no bash rc ----
if (!HAS_BASH) {
  check("fish/nushell PATH skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const srcDir = join(caseDir, "src");
      gitInitRunnableCli(srcDir, "0.0.0-new");
      const installer = copiedInstaller(caseDir);
      for (const [shell, snippet] of [
        ["/usr/bin/fish", "fish_add_path"],
        ["/usr/bin/nu", "config.nu"],
      ]) {
        const home = join(caseDir, `home-${shell === "/usr/bin/fish" ? "fish" : "nu"}`);
        mkdirSync(home, { recursive: true });
        const bashrc = join(home, ".bashrc");
        const sentinel = "# pre-existing rc\n";
        writeFileSync(bashrc, sentinel);
        const run = runBash(
          [installer],
          childEnv(home, { AIAND_SOURCE: srcDir, AIAND_SKIP_BUILD: "1", SHELL: shell }),
        );
        const name = `SHELL=${shell}`;
        check(`${name} install exits zero`, (run.status ?? 1) === 0, `status=${run.status}`);
        const launcher = join(home, ".local", "bin", "aiand");
        check(
          `${name} writes an aiand launcher`,
          existsSync(launcher) && readFileSync(launcher, "utf8").includes(LAUNCHER_HEADER),
          launcher,
        );
        const bashrcAfter = readFileSync(bashrc, "utf8");
        check(
          `${name} leaves .bashrc byte-identical`,
          bashrcAfter === sentinel,
          JSON.stringify(bashrcAfter),
        );
        check(
          `${name} prints a PATH snippet`,
          (run.stdout ?? "").includes(snippet),
          (run.stdout ?? "").split("\n").find((l) => l.includes("Note")) ?? "(no notes)",
        );
        check(
          `${name} prints no bashrc PATH note`,
          !(run.stdout ?? "").includes("to PATH in"),
          (run.stdout ?? "").split("\n").find((l) => l.includes("Note")) ?? "no notes",
        );
      }
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("fish/nushell PATH harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 10: SHELL=zsh still gets a .zshrc PATH entry (SHELL-first guard) ---
if (!HAS_BASH) {
  check("zsh PATH skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const home = join(caseDir, "home");
      mkdirSync(home, { recursive: true });
      const srcDir = join(caseDir, "src");
      gitInitRunnableCli(srcDir, "0.0.0-new");
      const installer = copiedInstaller(caseDir);
      const run = runBash(
        [installer],
        childEnv(home, { AIAND_SOURCE: srcDir, AIAND_SKIP_BUILD: "1", SHELL: "/bin/zsh" }),
      );
      check("SHELL=zsh install exits zero", (run.status ?? 1) === 0, `status=${run.status}`);
      const zshrc = join(home, ".zshrc");
      check(
        "SHELL=zsh writes the .zshrc PATH entry",
        existsSync(zshrc) &&
          readFileSync(zshrc, "utf8").includes('export PATH="') &&
          readFileSync(zshrc, "utf8").includes(".local/bin"),
        existsSync(zshrc) ? readFileSync(zshrc, "utf8").trim() : "no .zshrc",
      );
      check(
        "SHELL=zsh leaves .bashrc alone",
        !existsSync(join(home, ".bashrc")),
        join(home, ".bashrc"),
      );
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("zsh PATH harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 11: a shadowing aiand on PATH is noted -----------------------------
if (!HAS_BASH) {
  check("PATH-shadow note skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const home = join(caseDir, "home");
      mkdirSync(home, { recursive: true });
      const shadowBin = join(caseDir, "shadowbin");
      mkdirSync(shadowBin, { recursive: true });
      const shadowLauncher = join(shadowBin, "aiand");
      writeFileSync(shadowLauncher, "#!/bin/sh\necho stale\n");
      chmodSync(shadowLauncher, 0o755);
      const shadowPath = `${shadowBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
      const probe = runBash(["-c", "command -v aiand"], childEnv(home, { PATH: shadowPath }));
      if ((probe.stdout ?? "").trim() !== toGitBashPath(shadowLauncher)) {
        check(
          "PATH-shadow note skipped (shadow not resolvable)",
          true,
          (probe.stdout ?? "").trim() || "unresolvable",
        );
      } else {
        const srcDir = join(caseDir, "src");
        gitInitRunnableCli(srcDir, "0.0.0-new");
        const installer = copiedInstaller(caseDir);
        const run = runBash(
          [installer],
          childEnv(home, { AIAND_SOURCE: srcDir, AIAND_SKIP_BUILD: "1", PATH: shadowPath }),
        );
        check("shadowed install exits zero", (run.status ?? 1) === 0, `status=${run.status}`);
        check(
          "shadowed install still writes the bashrc PATH note",
          (run.stdout ?? "").includes("to PATH in"),
          (run.stdout ?? "").split("\n").find((l) => l.includes("to PATH in")) ?? "(no PATH note)",
        );
        check(
          "shadowed install notes the shadowing aiand",
          (run.stdout ?? "").includes("shadows the new launcher") &&
            (run.stdout ?? "").includes(shadowBin),
          (run.stdout ?? "").split("\n").find((l) => l.includes("Note")) ?? "(no notes)",
        );
      }
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("PATH-shadow harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 12: re-running the installer updates an existing install ------------
// The first install writes the untracked ownership marker into the checkout;
// the second run must not mistake it for a local change.
if (!HAS_BASH) {
  check("re-run update skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const home = join(caseDir, "home");
      mkdirSync(home, { recursive: true });
      const srcDir = join(caseDir, "src");
      gitInitRunnableCli(srcDir, "0.0.0-one");
      const installer = copiedInstaller(caseDir);
      const env = childEnv(home, {
        AIAND_SOURCE: srcDir,
        AIAND_SKIP_BUILD: "1",
        AIAND_NO_MODIFY_PATH: "1",
      });
      const first = runBash([installer], {
        ...env,
        AIAND_API_KEY: "sk-test-install-behavior-0000",
      });
      check(
        "re-run: first install exits zero",
        (first.status ?? 1) === 0,
        `status=${first.status}`,
      );
      // `aiand login` stores nothing under AIAND_API_KEY, so no login hint.
      const firstErr = first.stderr ?? "";
      check(
        "re-run: AIAND_API_KEY means done, not a login hint",
        firstErr.includes("Done. Using the key in AIAND_API_KEY.") &&
          !firstErr.includes("Run 'aiand login'"),
        firstErr.split("\n").find((l) => l.includes("Done")) ?? "(no done line)",
      );

      writeFileSync(
        join(srcDir, "package.json"),
        `${JSON.stringify({ name: "@aiand/cli", version: "0.0.0-two" }, null, 2)}\n`,
      );
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
          "-qam",
          "two",
        ],
        { cwd: srcDir },
      );
      const second = runBash([installer], env);
      check(
        "re-run: update exits zero",
        (second.status ?? 1) === 0,
        (second.stderr ?? "").split("\n").find((l) => /error/i.test(l)) ??
          `status=${second.status}`,
      );
      // spawnSync pipes stdio, so there is no terminal: the installer must
      // print the version itself and never block on the login question.
      const secondErr = second.stderr ?? "";
      check(
        "re-run: installer prints the installed version",
        secondErr.includes("Installed aiand 0.0.0-two"),
        secondErr.split("\n").find((l) => l.includes("Installed")) ?? "(no version line)",
      );
      check(
        "re-run: no terminal means no login prompt, only the hint",
        !secondErr.includes("Log in to ai& now?") && secondErr.includes("Run 'aiand login'"),
        secondErr.split("\n").find((l) => l.includes("Done") || l.includes("Log in")) ?? "",
      );
      const launcher = join(home, ".local", "bin", "aiand");
      // The launcher is a bash script, which Windows cannot exec directly.
      const run = runBash([launcher, "--version"], childEnv(home));
      const version =
        run.status === 0
          ? (run.stdout ?? "").trim()
          : `ERROR: status=${run.status} ${(run.stderr ?? "").split("\n")[0]}`;
      check("re-run: launcher reports the updated version", version === "0.0.0-two", version);

      // With the baked node gone, the PATH fallback must not take a node
      // planted in the current directory through a "." PATH entry.
      if (process.platform !== "win32") {
        const repo = join(caseDir, "repo");
        mkdirSync(repo);
        const ran = join(caseDir, "planted-node-ran");
        writeFileSync(join(repo, "node"), `#!/bin/sh\ntouch "${ran}"\n`, { mode: 0o755 });
        const bash = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
        const planted = spawnSync(bash, [launcher, "--version"], {
          cwd: repo,
          encoding: "utf8",
          env: childEnv(home, { PATH: ".", AIAND_NODE_BIN: join(caseDir, "gone", "node") }),
        });
        check(
          "launcher refuses a node reached only through the current directory",
          planted.status !== 0 &&
            (planted.stderr ?? "").includes("Node.js was not found") &&
            !existsSync(ran),
          `status=${planted.status} ran=${existsSync(ran)}`,
        );
      }
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("re-run update harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 13: aiand.cmd's node fallback never searches the current directory --
// Static, so it runs without a Windows host; installer-windows runs the
// fallback for real (planted node.exe in the cwd, PATH = System32).
{
  const ps1 = readFileSync(join(ROOT, "install.ps1"), "utf8");
  const cmdText = ps1.slice(
    ps1.indexOf('$cmdText = @"'),
    ps1.indexOf('"@', ps1.indexOf('$cmdText = @"')),
  );
  check(
    "aiand.cmd falls back through %~$PATH:, not where.exe",
    !/\bwhere\b[^.]/i.test(cmdText.replace(/^REM.*$/gm, "")) &&
      cmdText.includes('for %%i in (node.exe) do set "NODE_BIN=%%~`$PATH:i"'),
    "where.exe tries the current directory before PATH",
  );
  check(
    "aiand.cmd accepts a PATH fallback hit only from a PATH entry spelled in full",
    cmdText.includes('set "AIAND_NODE_PATHS=;%PATH:"=%;"') &&
      cmdText.includes('call set "AIAND_NODE_HIT=%%AIAND_NODE_PATHS:;%AIAND_NODE_DIR%;=%%"') &&
      cmdText.includes('call set "AIAND_NODE_HIT=%%AIAND_NODE_PATHS:;%AIAND_NODE_DIR%\\;=%%"') &&
      (
        cmdText.match(/if not "%AIAND_NODE_HIT%"=="%AIAND_NODE_PATHS%" goto :aiand_have_node/g) ??
        []
      ).length === 2,
    "a hit under the current directory is refused unless its directory is a drive-rooted or UNC PATH entry",
  );
  check(
    "aiand.cmd no longer refuses every node below the current directory",
    !cmdText.includes("AIAND_CWD") && !cmdText.includes("AIAND_PARENT"),
    "a node under %USERPROFILE% (fnm, scoop) or on C:\\ must be found when PATH names it",
  );
  check(
    "aiand.cmd keeps the not-found message and clears its search variables before node runs",
    cmdText.includes(":aiand_no_node\necho aiand: Node.js was not found.") &&
      cmdText.indexOf('set "AIAND_NODE_PATHS="') > cmdText.indexOf(":aiand_have_node") &&
      !/^set "AIAND_DIR=/m.test(cmdText),
    "AIAND_DIR is the CLI's own variable; the scan must not overwrite it",
  );
  check(
    "aiand.cmd scopes its variables and refuses delayed expansion",
    /^@echo off\r?\nsetlocal DisableDelayedExpansion\r?$/m.test(cmdText),
    "setlocal must follow @echo off: no leaked NODE_BIN, no !var! in arguments",
  );
}

// --- release path: a loopback double for GitHub releases and the npm registry --
// The installers take their release URLs from AIAND_INSTALL_RELEASES_URL and
// AIAND_INSTALL_NPM_REGISTRY (loopback only). The double serves files from a
// fixture tree: `<path>.status` answers with that status, `<path>.redirect`
// with a 302 to the URL inside. It runs in its own process because the cases
// below block on spawnSync.
const RELEASE_DOUBLE = `
const http = require("http"); const fs = require("fs"); const path = require("path");
const root = process.argv[1];
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(400).end(); return; }
  if (fs.existsSync(file + ".status")) { res.writeHead(Number(fs.readFileSync(file + ".status", "utf8"))).end("refused"); return; }
  if (fs.existsSync(file + ".redirect")) { res.writeHead(302, { location: fs.readFileSync(file + ".redirect", "utf8").trim() }).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end("not found"); return; }
  res.writeHead(200).end(fs.readFileSync(file));
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

async function startReleaseDouble(root) {
  const child = spawn(process.execPath, ["-e", RELEASE_DOUBLE, root], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
    child.once("exit", (code) => reject(new Error(`release double exited ${code}`)));
  });
  return { child, port, base: `http://127.0.0.1:${port}` };
}

function tarEntry(name, body = Buffer.alloc(0), { type = "0", mode = 0o644 } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

const STUB_CLI = [
  'const fs = require("fs");',
  'const path = require("path");',
  'const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));',
  "const arg = process.argv[2];",
  'if (arg === "--version") console.log(pkg.version);',
  'else if (arg === "--help") console.log("aiand test stub");',
  "else process.exit(1);",
  "",
].join("\n");

// An npm-shaped tarball (everything under package/) of a runnable stub CLI.
function stubTarball(version, extra = []) {
  return gzipSync(
    Buffer.concat([
      tarEntry(
        "package/package.json",
        Buffer.from(JSON.stringify({ name: "@aiand/cli", version })),
      ),
      tarEntry("package/dist/index.js", Buffer.from(STUB_CLI), { mode: 0o755 }),
      ...extra,
      Buffer.alloc(1024),
    ]),
  );
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sha512 = (buf) => `sha512-${createHash("sha512").update(buf).digest("base64")}`;

// Publish `version` to the double: the npm manifest and tarball plus the
// GitHub release's SHA256SUMS. `served` replaces the tarball bytes npm hands
// out, `npmIntegrityOf` and `sumsOf` pick which bytes each channel vouches for.
function publishToDouble(root, base, version, { tarball, served, npmIntegrityOf, sumsOf } = {}) {
  const real = tarball ?? stubTarball(version);
  const npmDir = join(root, "npm", "@aiand", "cli");
  mkdirSync(join(npmDir, "-"), { recursive: true });
  writeFileSync(join(npmDir, "-", `cli-${version}.tgz`), served ?? real);
  writeFileSync(
    join(npmDir, version),
    JSON.stringify({
      name: "@aiand/cli",
      version,
      dist: {
        integrity: sha512(npmIntegrityOf ?? real),
        tarball: `${base}/npm/@aiand/cli/-/cli-${version}.tgz`,
      },
    }),
  );
  const relDir = join(root, "rel", "download", `v${version}`);
  mkdirSync(relDir, { recursive: true });
  writeFileSync(
    join(relDir, "SHA256SUMS"),
    `${sha256(sumsOf ?? real)}  aiand-cli-${version}.tgz\n${"0".repeat(64)}  install.sh\n`,
  );
}

function setLatest(root, base, version) {
  const latest = join(root, "rel", "latest", "download");
  mkdirSync(latest, { recursive: true });
  rmSync(join(latest, "SHA256SUMS.status"), { force: true });
  writeFileSync(join(latest, "SHA256SUMS.redirect"), `${base}/rel/download/v${version}/SHA256SUMS`);
}

const doubleRoot = mkdtempSync(join(tmpdir(), "aiand-release-double-"));
const double = await startReleaseDouble(doubleRoot);
const releaseEnv = {
  AIAND_INSTALL_RELEASES_URL: `${double.base}/rel`,
  AIAND_INSTALL_NPM_REGISTRY: `${double.base}/npm`,
  AIAND_NO_MODIFY_PATH: "1",
};

function stagingLeftovers(home) {
  const aiandDir = join(home, ".aiand");
  return existsSync(aiandDir)
    ? readdirSync(aiandDir).filter((n) => n.startsWith(".cli-staging-") || n.includes(".prev-"))
    : [];
}

if (!HAS_BASH) {
  check("release-path cases skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const home = join(caseDir, "home");
      mkdirSync(home, { recursive: true });
      const installer = copiedInstaller(caseDir);
      const installDir = join(home, ".aiand", "cli");
      const launcher = join(home, ".local", "bin", "aiand");
      const env = childEnv(home, releaseEnv);
      const firstLine = (text, needle) =>
        (text ?? "").split("\n").find((l) => l.includes(needle)) ??
        (text ?? "").split("\n").filter(Boolean).pop() ??
        "";

      // First-ever run with no release published: fail clearly, install nothing.
      const none = runBash([installer], env);
      check("no release: exits non-zero", (none.status ?? 0) !== 0, `status=${none.status}`);
      check(
        "no release: says no published release was found",
        (none.stderr ?? "").includes("no published release was found"),
        firstLine(none.stderr, "release"),
      );
      check(
        "no release: points at npm install -g @aiand/cli meanwhile",
        (none.stderr ?? "").includes("npm install -g @aiand/cli"),
        firstLine(none.stderr, "npm install"),
      );
      check("no release: never falls back to a clone", !existsSync(installDir), installDir);

      // Rate limited: a 403 from GitHub reads as a rate limit, not a 404.
      const latestDir = join(doubleRoot, "rel", "latest", "download");
      mkdirSync(latestDir, { recursive: true });
      writeFileSync(join(latestDir, "SHA256SUMS.status"), "403");
      const limited = runBash([installer], env);
      check(
        "rate limited: exits non-zero and names the rate limit",
        (limited.status ?? 0) !== 0 && (limited.stderr ?? "").includes("rate limit"),
        firstLine(limited.stderr, "rate limit"),
      );
      check("rate limited: installs nothing", !existsSync(installDir), installDir);

      // Overrides are for the loopback double only.
      const evil = runBash([installer], {
        ...env,
        AIAND_INSTALL_RELEASES_URL: "https://evil.example/releases",
      });
      check(
        "non-loopback release URL override is refused",
        (evil.status ?? 0) !== 0 && (evil.stderr ?? "").includes("is not allowed"),
        firstLine(evil.stderr, "not allowed"),
      );

      // Latest release: resolved from SHA256SUMS, verified, installed.
      publishToDouble(doubleRoot, double.base, "9.9.8");
      publishToDouble(doubleRoot, double.base, "9.9.9");
      setLatest(doubleRoot, double.base, "9.9.9");
      const first = runBash([installer], env);
      check(
        "latest release: install exits zero",
        (first.status ?? 1) === 0,
        firstLine(first.stderr, "error") || `status=${first.status}`,
      );
      check(
        "latest release: verified against both npm and SHA256SUMS",
        (first.stderr ?? "").includes(
          "Verified @aiand/cli 9.9.9 against npm's sha512 and the release's SHA256SUMS",
        ),
        firstLine(first.stderr, "Verified"),
      );
      const v1 = runBash([launcher, "--version"], childEnv(home));
      check(
        "latest release: launcher reports 9.9.9",
        (v1.stdout ?? "").trim() === "9.9.9",
        v1.stdout,
      );
      check(
        "latest release: install is marked installer-owned, with no .git",
        existsSync(join(installDir, OWNERSHIP_MARKER)) && !existsSync(join(installDir, ".git")),
        installDir,
      );
      check("latest release: no staging leftovers", stagingLeftovers(home).length === 0, "");

      // AIAND_VERSION pins a release; replacing a release install (no .git) works.
      const pinned = runBash([installer], { ...env, AIAND_VERSION: "9.9.8" });
      const v2 = runBash([launcher, "--version"], childEnv(home));
      check(
        "AIAND_VERSION installs that release over a release install",
        (pinned.status ?? 1) === 0 && (v2.stdout ?? "").trim() === "9.9.8",
        `status=${pinned.status} version=${(v2.stdout ?? "").trim()} ${firstLine(pinned.stderr, "error")}`,
      );
      const missing = runBash([installer], { ...env, AIAND_VERSION: "1.2.3" });
      check(
        "AIAND_VERSION naming no release fails clearly",
        (missing.status ?? 0) !== 0 &&
          (missing.stderr ?? "").includes("release v1.2.3 was not found"),
        firstLine(missing.stderr, "v1.2.3"),
      );
      const bogus = runBash([installer], { ...env, AIAND_VERSION: "latest; rm -rf ~" });
      check(
        "AIAND_VERSION that is not a version is refused",
        (bogus.status ?? 0) !== 0 && (bogus.stderr ?? "").includes("is not a version"),
        firstLine(bogus.stderr, "version"),
      );

      const keepsOld = (label) => {
        const after = runBash([launcher, "--version"], childEnv(home));
        check(
          `${label}: old install untouched`,
          (after.stdout ?? "").trim() === "9.9.8",
          after.stdout,
        );
        check(`${label}: no staging leftovers`, stagingLeftovers(home).length === 0, "");
      };

      // Tampered in transit: the bytes npm serves do not match its own sha512.
      const honest = stubTarball("9.10.0");
      const tampered = stubTarball("9.10.0", [
        tarEntry("package/dist/evil.js", Buffer.from("process.exit(0)\n")),
      ]);
      publishToDouble(doubleRoot, double.base, "9.10.0", { tarball: honest, served: tampered });
      setLatest(doubleRoot, double.base, "9.10.0");
      const transit = runBash([installer], env);
      check(
        "npm sha512 mismatch aborts",
        (transit.status ?? 0) !== 0 &&
          (transit.stderr ?? "").includes("does not match npm's sha512") &&
          (transit.stderr ?? "").includes("left unchanged"),
        firstLine(transit.stderr, "integrity"),
      );
      keepsOld("npm sha512 mismatch");

      // npm alone compromised: its manifest vouches for the tampered bytes,
      // but the GitHub release's SHA256SUMS does not.
      publishToDouble(doubleRoot, double.base, "9.10.0", {
        tarball: honest,
        served: tampered,
        npmIntegrityOf: tampered,
        sumsOf: honest,
      });
      const npmOnly = runBash([installer], env);
      check(
        "SHA256SUMS mismatch aborts even when npm agrees with itself",
        (npmOnly.status ?? 0) !== 0 &&
          (npmOnly.stderr ?? "").includes(
            "does not match the sha256 in the v9.10.0 release's SHA256SUMS",
          ),
        firstLine(npmOnly.stderr, "integrity"),
      );
      keepsOld("SHA256SUMS mismatch");

      // A tarball both channels vouch for still may not write outside staging.
      const escapedFile = join(home, ".aiand", "escaped.txt");
      for (const [label, entry] of [
        ["a .. entry", tarEntry("package/../escaped.txt", Buffer.from("x"))],
        ["a symlink entry", tarEntry("package/dist/link", Buffer.alloc(0), { type: "2" })],
        [
          "an entry name carrying terminal escapes",
          tarEntry("package/dist/\u001b]0;pwned\u0007\u001b[31mevil", Buffer.alloc(0), {
            type: "2",
          }),
        ],
      ]) {
        const evilTar = stubTarball("9.11.0", [entry]);
        publishToDouble(doubleRoot, double.base, "9.11.0", { tarball: evilTar });
        setLatest(doubleRoot, double.base, "9.11.0");
        const unsafe = runBash([installer], env);
        check(
          `tarball with ${label} aborts`,
          (unsafe.status ?? 0) !== 0 &&
            /unsafe path|only files and directories/.test(unsafe.stderr ?? ""),
          firstLine(unsafe.stderr, "tarball"),
        );
        check(
          `tarball with ${label} prints no terminal control bytes`,
          !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(unsafe.stderr ?? ""),
          JSON.stringify(firstLine(unsafe.stderr, "error:")),
        );
        check(
          `tarball with ${label} writes nothing outside staging`,
          !existsSync(escapedFile),
          escapedFile,
        );
        keepsOld(`tarball with ${label}`);
      }

      // A release below the first SHA256SUMS one is refused, pinned or not: a
      // SHA256SUMS naming one was not made by the release process.
      publishToDouble(doubleRoot, double.base, "0.7.9");
      setLatest(doubleRoot, double.base, "0.7.9");
      const belowFloor = runBash([installer], env);
      check(
        "a latest release older than the first SHA256SUMS release is refused",
        (belowFloor.status ?? 0) !== 0 &&
          (belowFloor.stderr ?? "").includes(
            "older than 0.8.0, the first release published with a SHA256SUMS",
          ),
        firstLine(belowFloor.stderr, "older than"),
      );
      keepsOld("below-floor latest");
      const pinnedBelow = runBash([installer], { ...env, AIAND_VERSION: "0.7.9" });
      check(
        "AIAND_VERSION below the first SHA256SUMS release is refused too",
        (pinnedBelow.status ?? 0) !== 0 &&
          (pinnedBelow.stderr ?? "").includes("AIAND_VERSION names @aiand/cli 0.7.9"),
        firstLine(pinnedBelow.stderr, "AIAND_VERSION"),
      );
      keepsOld("below-floor AIAND_VERSION");

      // The latest release resolving to something older than what is installed
      // is a downgrade, whoever asked. (AIAND_VERSION naming an older release
      // is the deliberate way, covered above: 9.9.9 to 9.9.8.) Installed: 9.9.8.
      for (const [label, older, args] of [
        ["a lower patch version", "9.9.7", []],
        ["a prerelease of the installed version", "9.9.8-rc.1", []],
        ["a lower version, through update", "9.9.7", ["update"]],
      ]) {
        publishToDouble(doubleRoot, double.base, older);
        setLatest(doubleRoot, double.base, older);
        const down = runBash([installer, ...args], env);
        check(
          `downgrade refused: latest is ${label}`,
          (down.status ?? 0) !== 0 &&
            (down.stderr ?? "").includes("older than the installed 9.9.8") &&
            (down.stderr ?? "").includes(`AIAND_VERSION=${older}`),
          firstLine(down.stderr, "downgrade"),
        );
        keepsOld(`downgrade to ${older}`);
      }

      // The installed copy of install.sh fetches a release; it never rebuilds
      // the install it sits in.
      copyFileSync(join(ROOT, "install.sh"), join(installDir, "install.sh"));
      setLatest(doubleRoot, double.base, "9.9.9");
      const fromInstall = runBash([join(installDir, "install.sh")], env);
      const v3 = runBash([launcher, "--version"], childEnv(home));
      check(
        "the installed install.sh updates to the latest release",
        (fromInstall.status ?? 1) === 0 &&
          (fromInstall.stderr ?? "").includes("Downloading the release") &&
          (v3.stdout ?? "").trim() === "9.9.9",
        `status=${fromInstall.status} version=${(v3.stdout ?? "").trim()} ${firstLine(fromInstall.stderr, "error")}`,
      );

      // `update` always takes the release path, even with AIAND_SOURCE set.
      // 9.9.10 is above 9.9.9 numerically, not lexicographically.
      publishToDouble(doubleRoot, double.base, "9.9.10");
      setLatest(doubleRoot, double.base, "9.9.10");
      const srcDir = join(caseDir, "src");
      gitInitRunnableCli(srcDir, "0.0.0-dev");
      const upd = runBash([installer, "update"], { ...env, AIAND_SOURCE: srcDir });
      const v4 = runBash([launcher, "--version"], childEnv(home));
      check(
        "update ignores AIAND_SOURCE and installs the release",
        (upd.status ?? 1) === 0 && (v4.stdout ?? "").trim() === "9.9.10",
        `status=${upd.status} version=${(v4.stdout ?? "").trim()} ${firstLine(upd.stderr, "error")}`,
      );
      const extra = runBash([installer, "update", "--force"], env);
      check(
        "update with extra arguments prints usage",
        (extra.status ?? 0) !== 0 &&
          (extra.stderr ?? "").includes("Usage: bash install.sh [update"),
        firstLine(extra.stderr, "Usage"),
      );

      // A custom AIAND_DIR install updates itself from its own install.sh
      // without AIAND_DIR set again, the way the update notice runs it.
      const customDir = join(home, "tools", "aiand");
      const custom = runBash([installer], { ...env, AIAND_DIR: customDir });
      copyFileSync(join(ROOT, "install.sh"), join(customDir, "install.sh"));
      publishToDouble(doubleRoot, double.base, "9.9.11");
      setLatest(doubleRoot, double.base, "9.9.11");
      const customUpd = runBash([join(customDir, "install.sh"), "update"], env);
      const customPkg = JSON.parse(readFileSync(join(customDir, "package.json"), "utf8"));
      check(
        "update from a custom AIAND_DIR install's own install.sh updates that directory",
        (custom.status ?? 1) === 0 &&
          (customUpd.status ?? 1) === 0 &&
          customPkg.version === "9.9.11",
        `install=${custom.status} update=${customUpd.status} version=${customPkg.version} ${firstLine(customUpd.stderr, "error")}`,
      );

      // The update notice reads npm's latest dist-tag, the installer the latest
      // GitHub release. With npm ahead of the release, `update` says why it
      // found nothing newer, so the notice cannot look like an update loop.
      // Installed in customDir: 9.9.11, which is also the latest release.
      const npmLatestFile = join(doubleRoot, "npm", "@aiand", "cli", "latest");
      writeFileSync(npmLatestFile, JSON.stringify({ name: "@aiand/cli", version: "9.9.12" }));
      const behind = runBash([installer, "update"], { ...env, AIAND_DIR: customDir });
      check(
        "update says npm is ahead of the GitHub release instead of looking like a no-op",
        (behind.status ?? 1) === 0 &&
          (behind.stderr ?? "").includes(
            "already up to date at 9.9.11; npm shows @aiand/cli 9.9.12, but its GitHub release is not out yet",
          ),
        firstLine(behind.stderr, "note"),
      );
      writeFileSync(npmLatestFile, JSON.stringify({ name: "@aiand/cli", version: "9.9.11" }));
      const even = runBash([installer, "update"], { ...env, AIAND_DIR: customDir });
      check(
        "update says nothing about npm when the release is the npm latest",
        (even.status ?? 1) === 0 && !(even.stderr ?? "").includes("GitHub release is not out yet"),
        firstLine(even.stderr, "note"),
      );

      // A developer's own git clone at AIAND_DIR is not the installer's to
      // replace: a release install swaps the directory wholesale. With the
      // installer's ownership marker (an older install, which wrote one) it is.
      // (A clone, so its branch has an upstream: one without is refused either way.)
      const devOrigin = join(caseDir, "dev-origin");
      const devDir = join(home, "dev-clone");
      gitInitRunnableCli(devOrigin, "0.0.0-dev");
      execFileSync("git", ["clone", "-q", devOrigin, devDir]);
      const devRun = runBash([installer], { ...env, AIAND_DIR: devDir });
      check(
        "a release install refuses a developer's git clone it did not create",
        (devRun.status ?? 0) !== 0 &&
          (devRun.stderr ?? "").includes("the installer did not create") &&
          existsSync(join(devDir, ".git")),
        firstLine(devRun.stderr, "Error"),
      );
      writeFileSync(join(devDir, OWNERSHIP_MARKER), "aiand-cli installer ownership marker\n");
      const ownedRun = runBash([installer], { ...env, AIAND_DIR: devDir });
      check(
        "a release install replaces a git checkout that carries the ownership marker",
        (ownedRun.status ?? 1) === 0 && !existsSync(join(devDir, ".git")),
        firstLine(ownedRun.stderr, "Error"),
      );
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("release-path harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// Both installers run one release helper; a fix to one copy must reach both.
{
  const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
  const ps1 = readFileSync(join(ROOT, "install.ps1"), "utf8");
  const shHelper = sh.split("<<'AIAND_RELEASE_HELPER'\n")[1]?.split("\nAIAND_RELEASE_HELPER\n")[0];
  const psHelper = ps1.replace(/\r\n/g, "\n").split("$ReleaseHelper = @'\n")[1]?.split("\n'@\n")[0];
  check(
    "install.sh and install.ps1 embed the same release helper",
    typeof shHelper === "string" && shHelper.length > 1000 && shHelper === psHelper,
    `sh=${shHelper?.length ?? "missing"} ps1=${psHelper?.length ?? "missing"}`,
  );
}

// The summary, the cache flag, the version read, and the off-Windows launcher.
{
  const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
  const ps1 = readFileSync(join(ROOT, "install.ps1"), "utf8");
  const summaryScript = "dist/agents/install-summary.js";
  check(
    "both installers print the agent summary from the installed package",
    sh.includes("print_agent_summary") &&
      sh.includes(summaryScript) &&
      ps1.includes("Write-AgentSummary") &&
      ps1.includes(summaryScript),
    summaryScript,
  );
  check(
    "source-build npm ci passes --prefer-offline in both installers",
    sh.includes("npm ci --ignore-scripts --no-fund --no-audit --prefer-offline") &&
      ps1.includes("npm ci --ignore-scripts --no-fund --no-audit --prefer-offline"),
    "npm ci",
  );
  const versionFn = sh.slice(
    sh.indexOf("package_json_version() {"),
    sh.indexOf("\n# The version of the aiand install at INSTALL_DIR"),
  );
  const versionProbe = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        versionFn,
        "pkg=$(mktemp)",
        'printf \'%s\' \'{"name":"@aiand/cli","version":"1.2.3","nested":{"version":"9.9.9"}}\' > "$pkg"',
        'got=$(package_json_version "$pkg")',
        'rm -f "$pkg"',
        "printf '%s' \"$got\"",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  check(
    "install.sh reads the first version key, not a later one on the same line",
    (versionProbe.status ?? 1) === 0 &&
      (versionProbe.stdout ?? "") === "1.2.3" &&
      sh.includes("package_json_version ") &&
      !sh.includes('JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version'),
    (versionProbe.stderr ?? versionProbe.stdout ?? "").split("\n")[0],
  );
  check(
    "install.ps1 runs aiand.cmd only on Windows",
    ps1.includes("if ($env:OS -eq 'Windows_NT') { $launcherName = 'aiand.cmd' }") &&
      ps1.includes("Show-InstalledVersion -Launcher $launcher") &&
      ps1.includes("Invoke-LoginOffer -Launcher $launcher"),
    "launcher",
  );
}

// A push to main must not change what a new install runs: the one-liners take
// the bootstrap from the latest release's assets (docs/adr/0001).
{
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
  const ps1 = readFileSync(join(ROOT, "install.ps1"), "utf8");
  const assets = "https://github.com/aiandlabs/aiand-cli/releases/latest/download";
  check(
    "README one-liners fetch the installers from the latest release's assets",
    readme.includes(`curl -fsSL ${assets}/install.sh | bash`) &&
      readme.includes(`irm ${assets}/install.ps1 | iex`),
    "README.md",
  );
  const mainBootstrap = /raw\.githubusercontent\.com\/aiandlabs\/aiand-cli\/main\/install/;
  check(
    "no installer-facing doc points a new install at the main branch",
    ![readme, sh, ps1].some((text) => mainBootstrap.test(text)),
    "README.md, install.sh, install.ps1",
  );
}

// --- uninstall --purge: sign out first, then delete the config dir ------
// A stub launcher logs each invocation. `logoutAll` decides whether its
// `logout --help` advertises --all (the newer CLI) or not (the per-profile
// fallback through `config profiles --json`). `allOut` is what `logout --all
// --json` prints and `profileOut` what `logout --profile <name> --json` prints
// per profile; both default to a revoked device-minted key. `logoutExit` is
// the exit status of every logout call (an old CLI exits 0 after a failed
// revoke, the newer one exits 1). Like the real CLI, `logout --all` exits 1
// unless given --force (stdin is not a terminal). With `logoutRemovesConfig` it
// also deletes the config directory, as the real `logout --all` does.
const revokedRow = (profile) => ({ profile, source: "device-login", revoked: true });
function purgeFixture(
  caseDir,
  {
    logoutAll = true,
    logoutRemovesConfig = false,
    logoutExit = 0,
    credentialNames = [],
    allOut = { complete: true, profiles: [revokedRow("default"), revokedRow("work")] },
    profileOut = {},
  } = {},
) {
  const home = join(caseDir, "home");
  const checkout = join(home, ".aiand", "cli");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "package.json"), `${JSON.stringify({ name: "@aiand/cli" })}\n`);
  writeFileSync(join(checkout, OWNERSHIP_MARKER), "aiand-cli installer ownership marker\n");
  const config = join(home, ".config", "aiand");
  mkdirSync(join(config, "snapshots"), { recursive: true });
  writeFileSync(
    join(config, "credentials.json"),
    `${JSON.stringify(Object.fromEntries(credentialNames.map((name) => [name, {}])))}\n`,
  );
  const log = join(caseDir, "calls.log");
  const outDir = join(caseDir, "logout-out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "all.json"), `${JSON.stringify(allOut)}\n`);
  for (const name of ["default", "work"]) {
    const out = profileOut[name] ?? revokedRow(name);
    writeFileSync(join(outDir, `profile-${name}.json`), `${JSON.stringify(out, null, 2)}\n`);
  }
  const binDir = join(home, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, "aiand");
  writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      `# ${LAUNCHER_HEADER} (test stub)`,
      `echo "$*" >> "${log}"`,
      'if [ "$1 $2" = "logout --help" ]; then',
      `  echo "${logoutAll ? "  --all   sign out of every profile" : "  --profile <name>"}"; exit 0`,
      "fi",
      'if [ "$1 $2 $3" = "config profiles --json" ]; then',
      `  printf '[\\n  {\\n    "name": "default",\\n    "active": true\\n  },\\n  {\\n    "name": "work",\\n    "active": false\\n  }\\n]\\n'; exit 0`,
      "fi",
      'if [ "$1 $2" = "logout --all" ] && [ "$3" != "--force" ]; then',
      '  echo "Pass --force to confirm when not at a terminal." >&2; exit 1',
      "fi",
      'if [ "$1 $2" = "logout --all" ]; then',
      ...(logoutRemovesConfig ? [`  rm -rf "${config}"`] : []),
      `  cat "${outDir}/all.json"; exit ${logoutExit}`,
      "fi",
      'if [ "$1 $2" = "logout --profile" ]; then',
      `  cat "${outDir}/profile-$3.json"; exit ${logoutExit}`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);
  if (process.platform === "win32") {
    // install.ps1 runs aiand.cmd where it exists, and Windows cannot run the
    // sh stub itself: a .cmd with the installer's header hands it to Git's sh.
    const sh = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
      .map((name) => process.env[name])
      .filter(Boolean)
      .map((root) => join(root, "Git", "bin", "sh.exe"))
      .find((path) => existsSync(path));
    if (sh) {
      writeFileSync(
        `${launcher}.cmd`,
        `@echo off\r\nREM ${LAUNCHER_HEADER} (test stub)\r\n"${sh}" "%~dp0aiand" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      );
    }
  }
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { home, checkout, config, launcher, calls };
}

if (!HAS_BASH) {
  check("uninstall --purge cases skipped (no bash)", true, "bash not installed");
} else {
  const purgeCase = (name, fn) => {
    try {
      const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
      try {
        fn(caseDir);
      } finally {
        rmSync(caseDir, { recursive: true, force: true });
      }
    } catch (error) {
      check(`${name} harness`, false, String(error?.message ?? error).split("\n")[0]);
    }
  };
  const purgeEnv = (home, extra = {}) =>
    childEnv(home, { AIAND_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined, ...extra });

  purgeCase("purge with logout --all", (caseDir) => {
    const f = purgeFixture(caseDir);
    const installer = copiedInstaller(caseDir);
    const run = runBash([installer, "uninstall", "--purge"], purgeEnv(f.home));
    check("purge: exits zero", (run.status ?? 1) === 0, (run.stderr ?? "").split("\n")[0]);
    check(
      "purge: turns agents off, then runs logout --all",
      JSON.stringify(f.calls()) ===
        JSON.stringify(["init --off", "logout --help", "logout --all --force --json"]),
      f.calls().join(" | "),
    );
    check("purge: removes the config directory", !existsSync(f.config), f.config);
    check(
      "purge: removes the checkout and launcher",
      !existsSync(f.checkout) && !existsSync(f.launcher),
      "",
    );
    check(
      "purge: says what it removed",
      (run.stdout ?? "").includes("Removed profiles, credentials, and agent snapshots"),
      (run.stdout ?? "").trim().split("\n").pop() ?? "",
    );
  });

  // The real `logout --all` deletes the config directory itself, so the purge
  // finds it already gone and must still finish cleanly.
  purgeCase("purge after logout --all removed the config directory", (caseDir) => {
    const f = purgeFixture(caseDir, { logoutRemovesConfig: true });
    const run = runBash([copiedInstaller(caseDir), "uninstall", "--purge"], purgeEnv(f.home));
    check(
      "purge: finishes when logout --all already removed the config directory",
      (run.status ?? 1) === 0 &&
        !existsSync(f.config) &&
        !existsSync(f.checkout) &&
        (run.stdout ?? "").includes("Removed profiles, credentials, and agent snapshots"),
      `${run.status} ${(run.stderr ?? "").split("\n")[0]}`,
    );
  });

  purgeCase("purge per-profile fallback", (caseDir) => {
    const f = purgeFixture(caseDir, { logoutAll: false });
    const installer = copiedInstaller(caseDir);
    const run = runBash([installer, "uninstall", "--purge"], purgeEnv(f.home));
    check(
      "purge on a CLI without --all signs out of each profile",
      (run.status ?? 1) === 0 &&
        f.calls().includes("logout --profile default --json") &&
        f.calls().includes("logout --profile work --json") &&
        !f.calls().some((call) => call.startsWith("logout --all")),
      f.calls().join(" | "),
    );
    check("purge fallback removes the config directory itself", !existsSync(f.config), f.config);
  });

  // The sign-in a failed revoke leaves behind is the only thing that can
  // revoke that key later, so no outcome that fails to confirm a revoke may
  // let the purge go on to delete the checkout, launcher or config directory.
  const refusesPurge = (label, options, expect, prepare) =>
    purgeCase(`purge: ${label}`, (caseDir) => {
      const f = purgeFixture(caseDir, options);
      prepare?.(f);
      const installer = copiedInstaller(caseDir);
      const run = runBash([installer, "uninstall", "--purge"], purgeEnv(f.home));
      check(
        `purge: ${label} aborts`,
        (run.status ?? 0) !== 0 && (run.stderr ?? "").includes(expect),
        (run.stderr ?? "").split("\n").find((l) => l.includes("Error")) ?? "",
      );
      check(
        `purge: ${label} deletes nothing`,
        existsSync(f.config) && existsSync(f.checkout) && existsSync(f.launcher),
        "",
      );
    });
  const failedRow = (profile) => ({
    profile,
    source: "device-login",
    revoked: false,
    kept: true,
    error: "the server could not be reached",
  });
  refusesPurge(
    "a non-zero logout --all with no result",
    { logoutExit: 3, allOut: "" },
    "could not read the result",
  );
  refusesPurge(
    "logout --all keeping a profile whose revoke failed",
    {
      logoutExit: 1,
      allOut: { complete: false, profiles: [revokedRow("default"), failedRow("work")] },
    },
    "could not revoke the keys of: work",
  );
  refusesPurge(
    "logout --all that exits 0 over an unrevoked key",
    { allOut: { complete: true, profiles: [failedRow("default")] } },
    "could not revoke the keys of: default",
  );
  refusesPurge(
    "an old per-profile logout that exits 0 after a failed revoke",
    {
      logoutAll: false,
      profileOut: { work: { profile: "work", revoked: false, source: "device-login" } },
    },
    "key for work was revoked",
  );
  refusesPurge(
    "a per-profile logout that fails without a result",
    { logoutAll: false, logoutExit: 1, profileOut: { default: "", work: "" } },
    "could not confirm",
  );

  // A `logout --all` that could not read credentials.json reports no profiles
  // and complete:false; with names in credentials.json that is not "nothing was
  // signed in". Likewise a bare empty list over a credentials.json with names.
  refusesPurge(
    "logout --all that could not read the credentials",
    {
      logoutExit: 1,
      allOut: {
        complete: false,
        profiles: [],
        problems: ["Could not read stored credentials: boom"],
      },
    },
    "could not revoke the keys of:",
  );
  refusesPurge(
    "logout --all with an empty profile list over a credentials.json that names profiles",
    { credentialNames: ["default", "work"], allOut: { complete: true, profiles: [] } },
    "could not revoke the keys of: default, work",
  );
  refusesPurge(
    "a credentials.json profile the per-profile fallback never signed out of",
    { logoutAll: false, credentialNames: ["default", "work", "ghost"] },
    "key for ghost was revoked",
  );
  refusesPurge("an unreadable credentials.json", { credentialNames: [] }, "could not read", (f) =>
    writeFileSync(join(f.config, "credentials.json"), "{not json"),
  );
  refusesPurge(
    "an unreadable row alongside complete:false problems",
    {
      logoutExit: 1,
      allOut: {
        complete: false,
        profiles: [{ profile: "work", source: "unknown", revoked: false, kept: true }],
        problems: ["Could not read config.json: boom"],
      },
    },
    "could not revoke the keys of:",
  );

  // Every key revoked but `logout --all` exited 1 with things left on disk:
  // the purge says what is left, keeps what it kept, and exits non-zero.
  purgeCase("purge after a logout --all that kept things", (caseDir) => {
    const f = purgeFixture(caseDir, {
      logoutExit: 1,
      allOut: {
        complete: false,
        profiles: [revokedRow("default"), revokedRow("work")],
        keys_left_on_disk: ["~/.config/opencode/opencode.json"],
        config_dir: { path: "x", removed: false, left: ["notes.txt"], kept: ["snapshots/claude"] },
        problems: [],
      },
    });
    writeFileSync(join(f.config, "snapshots", "claude"), "snapshot\n");
    const run = runBash([copiedInstaller(caseDir), "uninstall", "--purge"], purgeEnv(f.home));
    const err = run.stderr ?? "";
    check(
      "purge: an incomplete logout --all exits non-zero",
      (run.status ?? 0) !== 0,
      String(run.status),
    );
    check(
      "purge: names the key file logout --all reported",
      err.includes("An ai& key is still in ~/.config/opencode/opencode.json"),
      err.split("\n").find((l) => l.includes("key")) ?? "",
    );
    check(
      "purge: says what it kept in the config directory",
      err.includes("Kept snapshots/claude") && err.includes("notes.txt"),
      "",
    );
    check(
      "purge: leaves the config directory and the snapshot it kept",
      existsSync(join(f.config, "snapshots", "claude")),
      f.config,
    );
    check(
      "purge: never claims the config directory was removed",
      !(run.stdout ?? "").includes("Removed profiles, credentials"),
      (run.stdout ?? "").trim().split("\n").pop() ?? "",
    );
    check(
      "purge: still removes the checkout and launcher",
      !existsSync(f.checkout) && !existsSync(f.launcher),
      "",
    );
  });
  purgeCase("purge after a non-zero logout --all that emptied the config directory", (caseDir) => {
    const f = purgeFixture(caseDir, {
      logoutExit: 1,
      allOut: {
        complete: false,
        profiles: [revokedRow("default")],
        keys_left_on_disk: [],
        config_dir: { path: "x", removed: false, left: [], kept: [] },
        problems: [],
      },
    });
    rmSync(join(f.config, "snapshots"), { recursive: true });
    rmSync(join(f.config, "credentials.json"));
    const run = runBash([copiedInstaller(caseDir), "uninstall", "--purge"], purgeEnv(f.home));
    check(
      "purge: removes an emptied config directory after a non-zero logout --all",
      (run.status ?? 1) === 0 && !existsSync(f.config),
      `${run.status} ${(run.stderr ?? "").split("\n")[0]}`,
    );
  });

  purgeCase("purge sign-out with pasted and signed-out profiles", (caseDir) => {
    const pasted = { profile: "default", source: "pasted-key", revoked: false };
    const signedOut = { profile: "work", revoked: false, signed_in: false };
    const all = purgeFixture(caseDir, {
      allOut: { complete: true, profiles: [pasted, revokedRow("work")] },
    });
    const run = runBash([copiedInstaller(caseDir), "uninstall", "--purge"], purgeEnv(all.home));
    check(
      "purge: a pasted key is not a failed revoke",
      (run.status ?? 1) === 0 && !existsSync(all.config),
      (run.stderr ?? "").split("\n")[0],
    );
    const caseDir2 = join(caseDir, "per-profile");
    mkdirSync(caseDir2);
    const per = purgeFixture(caseDir2, {
      logoutAll: false,
      profileOut: { default: pasted, work: signedOut },
    });
    const run2 = runBash([copiedInstaller(caseDir2), "uninstall", "--purge"], purgeEnv(per.home));
    check(
      "purge: pasted and signed-out profiles pass on a CLI without --all",
      (run2.status ?? 1) === 0 && !existsSync(per.config),
      (run2.stderr ?? "").split("\n")[0],
    );
  });

  // HOME reached through a symlink (macOS /var, a /home that links elsewhere):
  // the config dir is guarded by its canonical path, and one that was never
  // created has nothing to guard or delete.
  for (const [label, withConfig] of [
    ["no config dir", false],
    ["an existing config dir", true],
  ]) {
    purgeCase(`purge through a symlinked HOME with ${label}`, (caseDir) => {
      const realDir = join(caseDir, "real");
      mkdirSync(realDir);
      const f = purgeFixture(realDir);
      if (!withConfig) rmSync(join(f.home, ".config"), { recursive: true });
      const linkedHome = join(caseDir, "linked-home");
      symlinkSync(f.home, linkedHome);
      const run = runBash([copiedInstaller(caseDir), "uninstall", "--purge"], purgeEnv(linkedHome));
      check(
        `purge through a symlinked HOME with ${label}: succeeds`,
        (run.status ?? 1) === 0 && !existsSync(f.checkout) && !existsSync(f.launcher),
        (run.stderr ?? "").split("\n").find((l) => l.includes("Error")) ?? "",
      );
      check(
        `purge through a symlinked HOME with ${label}: ${withConfig ? "removes it" : "says there was none"}`,
        withConfig
          ? !existsSync(f.config)
          : (run.stdout ?? "").includes("There was no config directory"),
        (run.stdout ?? "").trim().split("\n").pop() ?? "",
      );
    });
  }

  purgeCase("purge --force skips sign-out", (caseDir) => {
    const f = purgeFixture(caseDir, { allOut: { complete: false, profiles: [failedRow("work")] } });
    const run = runBash(
      [copiedInstaller(caseDir), "uninstall", "--force", "--purge"],
      purgeEnv(f.home),
    );
    check(
      "purge --force deletes without signing out, and says keys were not revoked",
      (run.status ?? 1) === 0 &&
        !existsSync(f.config) &&
        !f.calls().some((call) => call.startsWith("logout")) &&
        (run.stdout ?? "").includes("not revoked"),
      (run.stderr ?? "").split("\n")[0],
    );
  });

  purgeCase("purge config-dir guards", (caseDir) => {
    const f = purgeFixture(caseDir);
    const installer = copiedInstaller(caseDir);
    const outside = join(caseDir, "outside", "aiand");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep");
    const documents = join(f.home, "Documents");
    mkdirSync(documents, { recursive: true });
    writeFileSync(join(documents, "keep.txt"), "keep");
    const linkParent = join(f.home, "linked");
    mkdirSync(linkParent, { recursive: true });
    symlinkSync(outside, join(linkParent, "aiand"));
    for (const [label, dir] of [
      ["outside HOME", outside],
      ["not named aiand", documents],
      ["HOME itself", f.home],
      ["a symlink out of HOME", join(linkParent, "aiand")],
    ]) {
      const run = runBash(
        [installer, "uninstall", "--purge"],
        purgeEnv(f.home, { AIAND_CONFIG_DIR: dir }),
      );
      check(
        `purge refuses a config dir ${label}`,
        (run.status ?? 0) !== 0 && (run.stderr ?? "").includes("refusing to purge"),
        (run.stderr ?? "").split("\n")[0],
      );
    }
    check(
      "refused purges delete nothing and run nothing",
      existsSync(join(outside, "keep.txt")) &&
        existsSync(join(documents, "keep.txt")) &&
        existsSync(f.checkout) &&
        existsSync(f.launcher) &&
        f.calls().length === 0,
      f.calls().join(" | "),
    );
  });

  purgeCase("purge --force", (caseDir) => {
    const f = purgeFixture(caseDir);
    const installer = copiedInstaller(caseDir);
    const run = runBash([installer, "uninstall", "--force", "--purge"], purgeEnv(f.home));
    check(
      "purge --force deletes without running the CLI, and says keys were not revoked",
      (run.status ?? 1) === 0 &&
        !existsSync(f.config) &&
        f.calls().length === 0 &&
        (run.stdout ?? "").includes("were not revoked"),
      `status=${run.status} calls=${f.calls().join(" | ")}`,
    );
  });

  purgeCase("uninstall without purge", (caseDir) => {
    const f = purgeFixture(caseDir);
    const installer = copiedInstaller(caseDir);
    const run = runBash([installer, "uninstall"], purgeEnv(f.home));
    check(
      "uninstall without --purge never signs out and keeps the config directory",
      (run.status ?? 1) === 0 &&
        existsSync(join(f.config, "credentials.json")) &&
        !f.calls().some((c) => c.startsWith("logout")),
      f.calls().join(" | "),
    );
  });
}

// --- case 12b: stage 3 names where the tree came from -------------------------
// A clone announces its source; a checkout the script sits in says so instead.
// The side-by-side case below keys on the clone line, so it is pinned here.
if (!HAS_BASH) {
  check("source provenance skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const home = join(caseDir, "home");
      mkdirSync(home, { recursive: true });
      const installer = copiedInstaller(caseDir);

      const cloneSrc = join(caseDir, "cloned-src");
      gitInitRunnableCli(cloneSrc, "0.0.0-clone");
      const cloned = runBash(
        [installer],
        childEnv(home, {
          AIAND_SOURCE: cloneSrc,
          AIAND_SKIP_BUILD: "1",
          AIAND_NO_MODIFY_PATH: "1",
        }),
      );
      check(
        "cloned source reports using source from",
        (cloned.stderr ?? "").includes(`Using source from ${toGitBashPath(cloneSrc)}`),
        (cloned.stderr ?? "").split("\n").find((l) => l.startsWith("Using ")) ?? "",
      );
      check(
        "cloned source does not claim a local checkout",
        !(cloned.stderr ?? "").includes("Using the local checkout"),
        (cloned.stderr ?? "").split("\n").find((l) => l.includes("local checkout")) ?? "",
      );

      // In-place: install.sh lives inside the checkout, so SCRIPT_DIR is an
      // @aiand/cli package and the installer uses it without cloning.
      const localSrc = join(caseDir, "local-src");
      gitInitRunnableCli(localSrc, "0.0.0-local");
      copyFileSync(join(ROOT, "install.sh"), join(localSrc, "install.sh"));
      const home2 = join(caseDir, "home-local");
      mkdirSync(home2, { recursive: true });
      const local = runBash(
        [join(localSrc, "install.sh")],
        childEnv(home2, {
          AIAND_SOURCE: localSrc,
          AIAND_SKIP_BUILD: "1",
          AIAND_NO_MODIFY_PATH: "1",
        }),
      );
      check(
        "in-place source reports using the local checkout",
        (local.stderr ?? "").includes("Using the local checkout"),
        (local.stderr ?? "").split("\n").find((l) => l.startsWith("Using ")) ?? "",
      );
      check(
        "in-place source announces no clone",
        !(local.stderr ?? "").includes("Using source from"),
        (local.stderr ?? "").split("\n").find((l) => l.includes("Using source from")) ?? "",
      );
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("source provenance harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 14: the side-by-side preview installs as aiand-v2 -----------------
// With AIAND_V2_SIDEBYSIDE=1 (the branch's default when the harness does not
// pin production) every production path — the `aiand` launcher, ~/.aiand/cli —
// must stay untouched, while the install lands its own checkout and config dir
// from the cli-v2 branch, bakes its identity into the launcher, and uninstalls
// itself without touching production.
if (!HAS_BASH) {
  check("side-by-side preview skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const home = join(caseDir, "home");
      mkdirSync(home, { recursive: true });
      const srcDir = join(caseDir, "src");
      // The default branch carries a different version, so a clone that
      // ignored AIAND_BRANCH cannot pass the version check below.
      gitInitRunnableCli(srcDir, "0.0.0-default");
      const defaultBranch = execFileSync(
        "git",
        ["-C", srcDir, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf8" },
      ).trim();
      if (defaultBranch !== "cli-v2") {
        execFileSync("git", ["-C", srcDir, "checkout", "-q", "-b", "cli-v2"]);
      }
      writeFileSync(
        join(srcDir, "package.json"),
        `${JSON.stringify({ name: "@aiand/cli", version: "0.9.0-v2" }, null, 2)}\n`,
      );
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
          "-qam",
          "preview",
        ],
        { cwd: srcDir },
      );
      const installer = copiedInstaller(caseDir);
      const env = childEnv(home, {
        AIAND_V2_SIDEBYSIDE: "1",
        AIAND_SOURCE: srcDir,
        AIAND_SKIP_BUILD: "1",
        AIAND_NO_MODIFY_PATH: "1",
      });
      const run = runBash([installer], env);
      const stderr = run.stderr ?? "";
      check(
        "side-by-side install exits zero",
        (run.status ?? 1) === 0,
        stderr.split("\n").find((l) => /error/i.test(l)) ?? `status=${run.status}`,
      );
      const v2Launcher = join(home, ".local", "bin", "aiand-v2");
      check(
        "side-by-side writes the aiand-v2 launcher",
        existsSync(v2Launcher) && readFileSync(v2Launcher, "utf8").includes(LAUNCHER_HEADER),
        v2Launcher,
      );
      const launcherBody = existsSync(v2Launcher) ? readFileSync(v2Launcher, "utf8") : "";
      check(
        "launcher bakes the preview command name",
        launcherBody.includes('export AIAND_COMMAND_NAME="aiand-v2"'),
        launcherBody.split("\n").find((l) => l.includes("AIAND_COMMAND_NAME")) ?? "(absent)",
      );
      check(
        "launcher bakes its install dir",
        launcherBody.includes("export AIAND_DIR="),
        launcherBody.split("\n").find((l) => l.includes("AIAND_DIR")) ?? "(absent)",
      );
      check(
        "side-by-side leaves the production launcher alone",
        !existsSync(join(home, ".local", "bin", "aiand")),
        join(home, ".local", "bin", "aiand"),
      );
      check(
        "side-by-side leaves the production checkout alone",
        !existsSync(join(home, ".aiand", "cli")),
        join(home, ".aiand", "cli"),
      );
      const v2Checkout = join(home, ".aiand", "cli-v2");
      check(
        "preview checkout lives beside production's, installer-owned",
        existsSync(join(v2Checkout, OWNERSHIP_MARKER)),
        v2Checkout,
      );
      check(
        "side-by-side clone announces its branch source",
        stderr.includes(`Using source from ${toGitBashPath(srcDir)}`),
        stderr.split("\n").find((l) => l.startsWith("Using ")) ?? "",
      );
      const version = runBash([v2Launcher, "--version"], childEnv(home));
      check(
        "aiand-v2 launcher reports the cli-v2 branch version",
        version.status === 0 && (version.stdout ?? "").trim() === "0.9.0-v2",
        (version.stdout ?? "").trim() || `status=${version.status}`,
      );

      // Uninstall --force (no agent fixtures to tear down) removes exactly
      // the preview files and keeps the preview config dir named in output.
      const off = runBash(
        [installer, "uninstall", "--force"],
        childEnv(home, { AIAND_V2_SIDEBYSIDE: "1" }),
      );
      const offOut = `${off.stdout ?? ""}${off.stderr ?? ""}`;
      check(
        "side-by-side uninstall exits zero",
        (off.status ?? 1) === 0,
        offOut.split("\n").find((l) => /error/i.test(l)) ?? `status=${off.status}`,
      );
      check(
        "side-by-side uninstall removes the aiand-v2 launcher",
        !existsSync(v2Launcher),
        v2Launcher,
      );
      check(
        "side-by-side uninstall removes the preview checkout",
        !existsSync(v2Checkout),
        v2Checkout,
      );
      check(
        "side-by-side uninstall keeps the production paths alone",
        !existsSync(join(home, ".local", "bin", "aiand")) &&
          !existsSync(join(home, ".aiand", "cli")),
        "production launcher or checkout appeared",
      );
      check(
        "side-by-side uninstall names the preview config dir",
        offOut.includes("aiand-v2") && offOut.includes("profiles"),
        offOut.split("\n").find((l) => l.includes("profiles")) ?? "(no config note)",
      );
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("side-by-side preview harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 15: the launcher's own install.sh rerun fetches, not rebuilds -----
// `aiand-v2 update` re-runs the checkout's install.sh with the launcher's
// baked AIAND_SOURCE; there SCRIPT_DIR == INSTALL_DIR, and the rerun must
// fetch remote changes (staged clone + swap), not rebuild the old tree in
// place ("Using the local checkout").
if (!HAS_BASH) {
  check("launcher update fetch skipped (no bash)", true, "bash not installed");
} else if (process.platform === "win32") {
  // The rerun's staged swap renames the checkout while bash still holds the
  // running install.sh open — a sharing violation on Windows, for production
  // `aiand update` just the same. The fetch semantics are POSIX coverage.
  check(
    "launcher update fetch skipped (win32 cannot swap the running script's checkout)",
    true,
    "posix-only",
  );
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const home = join(caseDir, "home");
      mkdirSync(home, { recursive: true });
      const srcDir = join(caseDir, "src");
      gitInitRunnableCli(srcDir, "0.0.0-one");
      execFileSync("git", ["-C", srcDir, "branch", "-m", "cli-v2"]);
      // The checkout must carry install.sh so the rerun can find it, exactly
      // as a real checkout does.
      copyFileSync(join(ROOT, "install.sh"), join(srcDir, "install.sh"));
      execFileSync("git", ["-C", srcDir, "add", "install.sh"]);
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
          "install.sh",
        ],
        { cwd: srcDir },
      );
      const installer = copiedInstaller(caseDir);
      const env = childEnv(home, {
        AIAND_V2_SIDEBYSIDE: "1",
        AIAND_SOURCE: srcDir,
        AIAND_SKIP_BUILD: "1",
        AIAND_NO_MODIFY_PATH: "1",
      });
      const first = runBash([installer], env);
      check(
        "launcher update: first install exits zero",
        (first.status ?? 1) === 0,
        (first.stderr ?? "").split("\n").find((l) => /error/i.test(l)) ?? `status=${first.status}`,
      );

      writeFileSync(
        join(srcDir, "package.json"),
        `${JSON.stringify({ name: "@aiand/cli", version: "0.0.0-two" }, null, 2)}\n`,
      );
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
          "-qam",
          "two",
        ],
        { cwd: srcDir },
      );

      const checkoutInstaller = join(home, ".aiand", "cli-v2", "install.sh");
      const second = runBash([checkoutInstaller], env);
      const stderr = second.stderr ?? "";
      check(
        "launcher update: checkout rerun exits zero",
        (second.status ?? 1) === 0,
        stderr.split("\n").find((l) => /error/i.test(l)) ?? `status=${second.status}`,
      );
      check(
        "launcher update fetches the baked source instead of rebuilding in place",
        !stderr.includes("Using the local checkout") &&
          stderr.includes(`Using source from ${toGitBashPath(srcDir)}`),
        stderr.split("\n").find((l) => l.startsWith("Using ")) ?? "",
      );
      const version = runBash(
        [join(home, ".local", "bin", "aiand-v2"), "--version"],
        childEnv(home),
      );
      check(
        "launcher reports the fetched version after update",
        version.status === 0 && (version.stdout ?? "").trim() === "0.0.0-two",
        (version.stdout ?? "").trim() || `status=${version.status}`,
      );
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("launcher update fetch harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 4: PowerShell launcher write + uninstall identity (skip without a host) ------
{
  const ps1Path = join(ROOT, "install.ps1");
  let host = null;
  for (const cmd of ["pwsh", "powershell.exe"]) {
    const probe = spawnSync(cmd, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"], {
      encoding: "utf8",
    });
    if (!probe.error && probe.status === 0) {
      host = cmd;
      break;
    }
  }
  if (!host) {
    skip(
      "pwsh subchecks (parse, launchers, uninstall, release)",
      "no pwsh or powershell.exe on PATH",
    );
  } else if (!existsSync(ps1Path)) {
    skip(
      "pwsh subchecks (parse, launchers, uninstall, release)",
      "install.ps1 not found next to this script",
    );
  } else {
    // A script that does not parse fails on a user's machine and passes every
    // string assertion below, so parse each one first.
    const psFiles = listPowerShellFiles(ROOT);
    const parseRun = spawnSync(
      host,
      [
        "-NoProfile",
        "-Command",
        `$bad = @()
foreach ($p in ($env:AIAND_PS_FILES -split "\n")) {
  if (-not $p) { continue }
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$tokens, [ref]$errors)
  foreach ($e in $errors) { $bad += ('{0}:{1}: {2}' -f $p, $e.Extent.StartLineNumber, $e.Message) }
}
if ($bad.Count -gt 0) { $bad | ForEach-Object { Write-Output $_ }; exit 1 }
Write-Output 'ok'`,
      ],
      {
        encoding: "utf8",
        timeout: PWSH_SMOKE_TIMEOUT_MS,
        env: { ...process.env, AIAND_PS_FILES: psFiles.join("\n") },
      },
    );
    check(
      `every PowerShell script parses (${psFiles.length} file${psFiles.length === 1 ? "" : "s"}, ${host})`,
      psFiles.length > 0 && (parseRun.status ?? 1) === 0,
      (parseRun.stdout ?? "")
        .trim()
        .split("\n")
        .filter((l) => l !== "ok")
        .join("; ") ||
        (parseRun.stderr ?? "").trim().split("\n")[0] ||
        `status=${parseRun.status}`,
    );
    const ps1 = readFileSync(ps1Path, "utf8");
    check(
      "install.ps1 identity uses ConvertFrom-Json",
      ps1.includes("function Read-PackageJson") && ps1.includes("ConvertFrom-Json"),
      "PS 5.1 strips quotes from native node -e scripts",
    );
    check(
      "install.ps1 writes launchers with here-strings and WriteAllText",
      ps1.includes('$cmdText = @"') &&
        ps1.includes('$bashText = @"') &&
        ps1.includes("[System.IO.File]::WriteAllText") &&
        !ps1.includes("$cmdLines") &&
        !ps1.includes("$bashLines"),
      "PS comma/+ inside @() and Out-File wrapping both break aiand.cmd",
    );
    check(
      "install.ps1 Git Bash shim converts Windows paths to /c/ form",
      ps1.includes("function ConvertTo-UnixPath") &&
        ps1.includes("$nodeBinUnix = ConvertTo-UnixPath") &&
        ps1.includes("$entryUnix = ConvertTo-UnixPath") &&
        ps1.includes("function Get-GitBash") &&
        ps1.includes("Set-UnixExecutable"),
      "backslashes in the bash shim split C:\\nodejs\\node.exe on \\n",
    );
    check(
      "install.ps1 identity-gates launchers",
      ps1.includes("function Test-AiandLauncher") &&
        ps1.includes(`$LauncherHeader = '${LAUNCHER_HEADER}'`) &&
        ps1.includes('-like "*$LauncherHeader*"') &&
        ps1.includes("Kept foreign launcher"),
      "uninstall must not execute or Remove-Item a foreign aiand(.cmd)",
    );

    // install.ps1 refuses a foreign Launcher before clone/build/swap, mirroring
    // install.sh refuse_foreign_launcher at main() start (a piped install must
    // not replace the checkout and then abort without writing launchers).
    const invokeMain = ps1.slice(ps1.indexOf("function Invoke-Main"));
    const refuseAt = invokeMain.indexOf("Refuse-ForeignLauncher");
    check(
      "install.ps1 Invoke-Main refuses foreign launchers before clone/build",
      refuseAt !== -1 &&
        invokeMain.indexOf("Clone-ToStaging") > refuseAt &&
        invokeMain.indexOf("Fetch-ReleaseToStaging") > refuseAt &&
        invokeMain.indexOf("Ensure-Build") > refuseAt,
      `refuse@${refuseAt} clone@${invokeMain.indexOf("Clone-ToStaging")} build@${invokeMain.indexOf("Ensure-Build")}`,
    );
    check(
      "install.ps1 early refuse covers aiand.cmd and the Git Bash shim",
      invokeMain.includes("Refuse-ForeignLauncher -Path (Join-Path $BinDir 'aiand.cmd')") &&
        invokeMain.includes("Refuse-ForeignLauncher -Path (Join-Path $BinDir 'aiand')"),
      "both BinDir launchers must refuse before Clone-ToStaging",
    );
    const installLauncher = ps1.slice(
      ps1.indexOf("function Install-CliLauncher"),
      ps1.indexOf("function Get-TrimmedFsPath"),
    );
    check(
      "install.ps1 update takes the release path and targets its own install",
      invokeMain.includes("$MainArgs[0] -eq 'update'") &&
        invokeMain.includes("-not $update -and $script:ScriptDir") &&
        invokeMain.includes("-not $update -and $Source") &&
        invokeMain.includes("$script:InstallDir = $script:ScriptDir"),
      "update must not rebuild a checkout or clone AIAND_SOURCE",
    );
    check(
      "install.ps1 Install-CliLauncher keeps the defense-in-depth refuse",
      installLauncher.includes("Refuse-ForeignLauncher -Path $launcherCmd") &&
        installLauncher.includes("Refuse-ForeignLauncher -Path $launcherBash"),
      "late refuse stays so owned launchers still rewrite and foreign ones abort",
    );

    let winPs1 = ps1Path;
    const wsl = spawnSync("wslpath", ["-w", ps1Path], { encoding: "utf8" });
    if (!wsl.error && wsl.status === 0 && wsl.stdout.trim()) winPs1 = wsl.stdout.trim();

    // GitHub ubuntu-latest ships pwsh. $env:TEMP and (Get-Process).Path are
    // often empty there; Join-Path $null is the "Path because it is null"
    // bind error. Nested Join-Path (not '.aiand\\cli') keeps Unix pwsh
    // creating .aiand/cli instead of a single '.aiand\\cli' directory.
    const smoke = `
$ErrorActionPreference = 'Stop'
$tmpRoot = [System.IO.Path]::GetTempPath()
$iso = Join-Path $tmpRoot ('aiand-ib-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $iso -Force | Out-Null
$env:USERPROFILE = $iso
$env:HOME = $iso
$env:AIAND_NO_MODIFY_PATH = '1'
$checkout = Join-Path (Join-Path $iso '.aiand') 'cli'
New-Item -ItemType Directory -Path $checkout -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $checkout 'package.json'), '{"name":"@aiand/cli"}' + [Environment]::NewLine)
[System.IO.File]::WriteAllText((Join-Path $checkout '${OWNERSHIP_MARKER}'), 'aiand-cli installer ownership marker' + [Environment]::NewLine)
$bin = Join-Path (Join-Path $iso '.local') 'bin'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $bin 'aiand.cmd'), '@echo off' + [Environment]::NewLine)
[System.IO.File]::WriteAllText((Join-Path $bin 'aiand'), '# ${LAUNCHER_HEADER}' + [Environment]::NewLine)
$runner = $null
try { $runner = [string](Get-Process -Id $PID).Path } catch { }
if ([string]::IsNullOrWhiteSpace($runner)) {
  $cmd = Get-Command -Name pwsh -ErrorAction SilentlyContinue
  if (-not $cmd) { $cmd = Get-Command -Name powershell -ErrorAction SilentlyContinue }
  if ($cmd) { $runner = [string]$cmd.Source }
}
if ([string]::IsNullOrWhiteSpace($runner)) { throw 'could not resolve pwsh path' }
& $runner -NoProfile -ExecutionPolicy Bypass -File '${winPs1.replace(/'/g, "''")}' uninstall --force
if ($LASTEXITCODE -ne 0) { throw "uninstall exit $LASTEXITCODE" }
if (-not (Test-Path (Join-Path $bin 'aiand.cmd'))) { throw 'foreign aiand.cmd was deleted' }
if (Test-Path (Join-Path $bin 'aiand')) { throw 'owned launcher still present' }
if (Test-Path $checkout) { throw 'checkout still present' }
Remove-Item -Recurse -Force $iso -ErrorAction SilentlyContinue
Write-Output 'ok'
`;
    const run = spawnSync(host, ["-NoProfile", "-Command", smoke], {
      encoding: "utf8",
      timeout: PWSH_SMOKE_TIMEOUT_MS,
    });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    check(
      "install.ps1 uninstall --force keeps a foreign launcher and removes owned files",
      (run.status ?? 1) === 0 && out.split("\n").pop() === "ok",
      out.split("\n").filter(Boolean).pop() ?? `status=${run.status}`,
    );

    // Foreign-launcher install refusal via pwsh, without a full install: the
    // copied PS1 forces the clone path, but the evil AIAND_SOURCE is never
    // reached — the early refuse fires first (message + byte-identical
    // launcher + no checkout, like bash case 7). Never runs npm ci.
    const foreignSmoke = `
$ErrorActionPreference = 'Stop'
$tmpRoot = [System.IO.Path]::GetTempPath()
$runner = $null
try { $runner = [string](Get-Process -Id $PID).Path } catch { }
if ([string]::IsNullOrWhiteSpace($runner)) {
  $found = Get-Command -Name pwsh -ErrorAction SilentlyContinue
  if (-not $found) { $found = Get-Command -Name powershell -ErrorAction SilentlyContinue }
  if ($found) { $runner = [string]$found.Source }
}
if ([string]::IsNullOrWhiteSpace($runner)) { throw 'could not resolve pwsh path' }
foreach ($leaf in @('aiand.cmd', 'aiand')) {
  $iso = Join-Path $tmpRoot ('aiand-ib-foreign-' + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $iso -Force | Out-Null
  $bin = Join-Path (Join-Path $iso '.local') 'bin'
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  $foreignPath = Join-Path $bin $leaf
  $foreignBody = 'echo mine'
  [System.IO.File]::WriteAllText($foreignPath, $foreignBody + [Environment]::NewLine)
  $scriptDir = Join-Path $iso 'scriptdir'
  New-Item -ItemType Directory -Path $scriptDir -Force | Out-Null
  Copy-Item -LiteralPath '${winPs1.replace(/'/g, "''")}' -Destination (Join-Path $scriptDir 'install.ps1') -Force
  $env:USERPROFILE = $iso
  $env:HOME = $iso
  $env:AIAND_SOURCE = 'https://evil.example/aiand-cli.git'
  $env:AIAND_NO_MODIFY_PATH = '1'
  $copied = Join-Path $scriptDir 'install.ps1'
  $prevErr = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = & $runner -NoProfile -ExecutionPolicy Bypass -File $copied 2>&1 | Out-String
  $code = $LASTEXITCODE; $ErrorActionPreference = $prevErr
  if ($code -eq 0) { throw "install with foreign $leaf exited 0" }
  if ($out -notmatch 'was\\s+not\\s+written\\s+by\\s+the\\s+aiand\\s+installer') { throw "foreign $leaf refusal missed the launcher message" }
  $after = [System.IO.File]::ReadAllText($foreignPath)
  if ($after -ne ($foreignBody + [Environment]::NewLine)) { throw "foreign $leaf was modified" }
  if (Test-Path -LiteralPath (Join-Path (Join-Path $iso '.aiand') 'cli')) { throw "checkout created despite foreign $leaf" }
  Remove-Item -Recurse -Force $iso -ErrorAction SilentlyContinue
}
Write-Output 'ok'
`;
    const foreignRun = spawnSync(host, ["-NoProfile", "-Command", foreignSmoke], {
      encoding: "utf8",
      timeout: PWSH_SMOKE_TIMEOUT_MS,
    });
    const foreignOut = `${foreignRun.stdout ?? ""}${foreignRun.stderr ?? ""}`.trim();
    check(
      "install.ps1 refuses a foreign launcher before clone (no checkout, byte-identical)",
      (foreignRun.status ?? 1) === 0 && foreignOut.split("\n").pop() === "ok",
      foreignOut.split("\n").filter(Boolean).pop() ?? `status=${foreignRun.status}`,
    );

    // uninstall --purge under pwsh, driven through the Git Bash shim stub
    // (Linux pwsh cannot run aiand.cmd): sign-out runs before anything is
    // deleted, and a config dir reached through a link is refused.
    for (const [label, logoutAll, logoutRemovesConfig] of [
      ["logout --all", true, false],
      ["a logout --all that removes the config dir itself", true, true],
      ["the per-profile fallback", false, false],
    ]) {
      const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
      try {
        const f = purgeFixture(caseDir, { logoutAll, logoutRemovesConfig });
        const run = spawnSync(
          host,
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path, "uninstall", "--purge"],
          {
            encoding: "utf8",
            timeout: PWSH_SMOKE_TIMEOUT_MS,
            env: childEnv(f.home, { AIAND_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined }),
          },
        );
        const calls = f.calls();
        check(
          `install.ps1 uninstall --purge with ${label} signs out, then deletes the config dir`,
          (run.status ?? 1) === 0 &&
            calls[0] === "init --off" &&
            (logoutAll
              ? calls.includes("logout --all --force --json")
              : calls.includes("logout --profile default --json") &&
                calls.includes("logout --profile work --json")) &&
            !existsSync(f.config) &&
            !existsSync(f.checkout),
          `status=${run.status} calls=${calls.join(" | ")} ${(run.stderr ?? "").split("\n")[0]}`,
        );
      } finally {
        rmSync(caseDir, { recursive: true, force: true });
      }
    }
    {
      const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
      try {
        const f = purgeFixture(caseDir);
        const outside = join(caseDir, "outside", "aiand");
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "keep.txt"), "keep");
        const linkParent = join(f.home, "linked");
        mkdirSync(linkParent, { recursive: true });
        symlinkSync(join(caseDir, "outside"), join(linkParent, "via"));
        const results = [join(linkParent, "via", "aiand"), join(f.home, "Documents")].map((dir) => {
          mkdirSync(dir, { recursive: true });
          return spawnSync(
            host,
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path, "uninstall", "--purge"],
            {
              encoding: "utf8",
              timeout: PWSH_SMOKE_TIMEOUT_MS,
              env: childEnv(f.home, { AIAND_CONFIG_DIR: dir }),
            },
          );
        });
        check(
          "install.ps1 uninstall --purge refuses a linked or misnamed config dir, deleting nothing",
          results.every(
            (r) => (r.status ?? 0) !== 0 && (r.stderr ?? "").includes("refusing to purge"),
          ) &&
            existsSync(join(outside, "keep.txt")) &&
            existsSync(f.checkout) &&
            f.calls().length === 0,
          results.map((r) => (r.stderr ?? "").split("\n")[0]).join(" | "),
        );
      } finally {
        rmSync(caseDir, { recursive: true, force: true });
      }
    }

    // The release path under pwsh: a tampered tarball and a missing release
    // both stop before anything lands in ~/.aiand/cli; an honest release
    // unpacks verified (Linux pwsh cannot run the aiand.cmd it then writes, so
    // the exit code of that run is not asserted).
    const tamperedHonest = stubTarball("9.12.0");
    publishToDouble(doubleRoot, double.base, "9.12.0", {
      tarball: tamperedHonest,
      served: stubTarball("9.12.0", [tarEntry("package/dist/evil.js", Buffer.from("1\n"))]),
    });
    publishToDouble(doubleRoot, double.base, "9.13.0");
    setLatest(doubleRoot, double.base, "9.12.0");
    const releaseSmoke = `
$ErrorActionPreference = 'Stop'
$tmpRoot = [System.IO.Path]::GetTempPath()
$runner = $null
try { $runner = [string](Get-Process -Id $PID).Path } catch { }
if ([string]::IsNullOrWhiteSpace($runner)) {
  $found = Get-Command -Name pwsh -ErrorAction SilentlyContinue
  if (-not $found) { $found = Get-Command -Name powershell -ErrorAction SilentlyContinue }
  if ($found) { $runner = [string]$found.Source }
}
if ([string]::IsNullOrWhiteSpace($runner)) { throw 'could not resolve pwsh path' }
$iso = Join-Path $tmpRoot ('aiand-ib-release-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$scriptDir = Join-Path $iso 'scriptdir'
New-Item -ItemType Directory -Path $scriptDir -Force | Out-Null
Copy-Item -LiteralPath '${winPs1.replace(/'/g, "''")}' -Destination (Join-Path $scriptDir 'install.ps1') -Force
$copied = Join-Path $scriptDir 'install.ps1'
$checkout = Join-Path (Join-Path $iso '.aiand') 'cli'
$env:USERPROFILE = $iso
$env:HOME = $iso
$env:AIAND_NO_MODIFY_PATH = '1'
Remove-Item Env:AIAND_SOURCE -ErrorAction SilentlyContinue
Remove-Item Env:AIAND_VERSION -ErrorAction SilentlyContinue
$env:AIAND_INSTALL_RELEASES_URL = '${double.base}/rel'
$env:AIAND_INSTALL_NPM_REGISTRY = '${double.base}/npm'
$ErrorActionPreference = 'Continue'
$out = & $runner -NoProfile -ExecutionPolicy Bypass -File $copied 2>&1 | Out-String
$code = $LASTEXITCODE
if ($code -eq 0) { throw 'a tampered release installed' }
if ($out -notmatch "does not match npm's sha512") { throw "tampered release: no integrity message: $out" }
if (Test-Path -LiteralPath $checkout) { throw 'tampered release created the checkout' }
$env:AIAND_VERSION = '1.2.3'
$out = & $runner -NoProfile -ExecutionPolicy Bypass -File $copied 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) { throw 'a missing release installed' }
if ($out -notmatch 'release v1\\.2\\.3 was not found') { throw "missing release: unclear message: $out" }
if (Test-Path -LiteralPath $checkout) { throw 'missing release created the checkout' }
$env:AIAND_VERSION = '9.13.0'
$out = & $runner -NoProfile -ExecutionPolicy Bypass -File $copied 2>&1 | Out-String
if ($out -notmatch "Verified @aiand/cli 9\\.13\\.0 against npm's sha512") { throw "honest release: not verified: $out" }
$pkg = Get-Content -Raw -LiteralPath (Join-Path $checkout 'package.json') | ConvertFrom-Json
if ($pkg.version -ne '9.13.0') { throw "honest release: installed $($pkg.version)" }
if (-not (Test-Path -LiteralPath (Join-Path $checkout '${OWNERSHIP_MARKER}'))) { throw 'honest release: no ownership marker' }
Remove-Item -Recurse -Force $iso -ErrorAction SilentlyContinue
Write-Output 'ok'
`;
    const releaseRun = spawnSync(host, ["-NoProfile", "-Command", releaseSmoke], {
      encoding: "utf8",
      timeout: PWSH_SMOKE_TIMEOUT_MS,
    });
    const releaseOut = `${releaseRun.stdout ?? ""}${releaseRun.stderr ?? ""}`.trim();
    check(
      "install.ps1 release path: tampered and missing releases abort, an honest one verifies",
      (releaseRun.status ?? 1) === 0 && releaseOut.split("\n").pop() === "ok",
      releaseOut.split("\n").filter(Boolean).pop() ?? `status=${releaseRun.status}`,
    );
  }
}

double.child.kill();
rmSync(doubleRoot, { recursive: true, force: true });

console.log(results.join("\n"));
const skipped = results.filter((r) => r.startsWith("SKIP"));
console.log(
  results.some((r) => r.startsWith("FAIL"))
    ? "INSTALL-BEHAVIOR: FAILURES PRESENT"
    : skipped.length > 0
      ? `INSTALL-BEHAVIOR: PASS WITH ${skipped.length} SKIPPED (install pwsh to run them)`
      : "INSTALL-BEHAVIOR: ALL PASS",
);
