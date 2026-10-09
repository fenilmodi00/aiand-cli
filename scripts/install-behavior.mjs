// Installer behavior cases: isolated mkdtemp HOME per case, check()/results
// style like scripts/e2e.mjs. NOT wired to npm test; run from the installer
// CI job (node scripts/install-behavior.mjs).

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
    ...extra,
  };
}

// Agent ids the installers probe for the post-install summary.
const AGENT_IDS = ["opencode", "claude", "pi", "omp"];

// PATH scrubbed of any directory that resolves an agent binary, so the
// summary matrix is hermetic even on dev machines with agents installed.
// Toolchain directories (node/git/npm/bash) are never dropped.
function scrubbedPath(fakebin) {
  const keep = new Set();
  for (const tool of ["node", "npm", "git", "bash"]) {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (!dir) continue;
      try {
        if (existsSync(join(dir, tool))) keep.add(dir);
      } catch {}
    }
  }
  const out = [fakebin];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || keep.has(dir) || out.includes(dir)) {
      if (dir && !out.includes(dir)) out.push(dir);
      continue;
    }
    let leak = false;
    for (const id of AGENT_IDS) {
      for (const ext of ["", ".cmd", ".exe", ".bat", ".ps1"]) {
        try {
          if (existsSync(join(dir, id + ext))) {
            leak = true;
            break;
          }
        } catch {}
      }
      if (leak) break;
    }
    if (!leak) out.push(dir);
  }
  return out.join(delimiter);
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
      for (const source of ["git@evil.example:aiand-cli.git", "github.com:evil/aiand-cli.git"]) {
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
      const first = runBash([installer], env);
      check(
        "re-run: first install exits zero",
        (first.status ?? 1) === 0,
        `status=${first.status}`,
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
      const launcher = join(home, ".local", "bin", "aiand");
      // The launcher is a bash script, which Windows cannot exec directly.
      const run = runBash([launcher, "--version"], childEnv(home));
      const version =
        run.status === 0
          ? (run.stdout ?? "").trim()
          : `ERROR: status=${run.status} ${(run.stderr ?? "").split("\n")[0]}`;
      check("re-run: launcher reports the updated version", version === "0.0.0-two", version);
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("re-run update harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 13: agent summary across detected-agent shapes (bash runtime) ----
if (!HAS_BASH) {
  check("agent summary skipped (no bash)", true, "bash not installed");
} else {
  try {
    const caseDir = mkdtempSync(join(tmpdir(), "aiand-install-behavior-"));
    try {
      const srcDir = join(caseDir, "src");
      gitInitRunnableCli(srcDir, "0.0.0-new");
      const installer = copiedInstaller(caseDir);
      const shapes = [
        {
          name: "none",
          bins: [],
          present: [
            "No coding agents detected on this machine.",
            "opencode  Install it with: npm install -g opencode-ai@",
            "omp  Install it with: bun install -g @oh-my-pi/pi-coding-agent",
            "Install one, then run 'aiand init'.",
          ],
          absent: ["Detected agents:"],
        },
        {
          name: "some",
          bins: ["opencode", "pi"],
          present: [
            "Detected agents:",
            "✓ opencode",
            "✓ pi",
            "Not installed:",
            "claude  Install it with: npm install -g @anthropic-ai/claude-code",
            "Next: run 'aiand init' to wire them to ai&.",
          ],
          absent: ["No coding agents detected"],
        },
        {
          name: "all",
          bins: ["opencode", "claude", "pi", "omp"],
          present: ["Detected agents:", "✓ omp", "Next: run 'aiand init' to wire them to ai&."],
          absent: ["Not installed:", "No coding agents detected"],
        },
      ];
      for (const shape of shapes) {
        const home = join(caseDir, `home-${shape.name}`);
        mkdirSync(home, { recursive: true });
        const fakebin = join(caseDir, `fakebin-${shape.name}`);
        mkdirSync(fakebin, { recursive: true });
        for (const bin of shape.bins) {
          const stub = join(fakebin, bin);
          writeFileSync(stub, "#!/bin/sh\nexit 0\n");
          chmodSync(stub, 0o755);
        }
        const run = runBash(
          [installer],
          childEnv(home, {
            AIAND_SOURCE: srcDir,
            AIAND_SKIP_BUILD: "1",
            AIAND_NO_MODIFY_PATH: "1",
            PATH: scrubbedPath(fakebin),
          }),
        );
        const tag = `summary/${shape.name}`;
        check(`${tag} install exits zero`, (run.status ?? 1) === 0, `status=${run.status}`);
        const stdout = run.stdout ?? "";
        for (const fragment of shape.present) {
          check(
            `${tag} prints ${JSON.stringify(fragment.slice(0, 40))}`,
            stdout.includes(fragment),
            stdout
              .split("\n")
              .find(
                (l) => l.includes("agent") || l.includes("Next") || l.includes("Install one"),
              ) ?? "(summary missing)",
          );
        }
        for (const fragment of shape.absent) {
          check(`${tag} omits ${JSON.stringify(fragment)}`, !stdout.includes(fragment), fragment);
        }
      }
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  } catch (error) {
    check("agent summary harness", false, String(error?.message ?? error).split("\n")[0]);
  }
}

// --- case 14: installer speed flags + agent-summary statics (no host needed) ---
{
  const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
  const ps1Path = join(ROOT, "install.ps1");
  const ps1Static = readFileSync(ps1Path, "utf8");
  const opencodeTs = readFileSync(join(ROOT, "src", "agents", "opencode", "adapter.ts"), "utf8");
  const openCodeVersion = (/OPENCODE_VERSION = "([^"]+)"/.exec(opencodeTs) ?? [])[1] ?? "";
  check(
    "install.sh npm ci reuses the cache",
    sh.includes("npm ci --ignore-scripts --no-fund --no-audit --prefer-offline"),
    "AIAND_SOURCE updates pay full download without it",
  );
  check(
    "install.ps1 npm ci reuses the cache",
    ps1Static.includes("npm ci --ignore-scripts --no-fund --no-audit --prefer-offline"),
    "AIAND_SOURCE updates pay full download without it",
  );
  const verifySh = sh.slice(sh.indexOf("verify_built_cli()"), sh.indexOf("ensure_build()"));
  check(
    "install.sh verify reads the version without a node spawn",
    !verifySh.includes("node -p") && verifySh.includes("--version") && verifySh.includes("--help"),
    "the version probe was the third node spawn",
  );
  const verifyPs1 = ps1Static.slice(
    ps1Static.indexOf("function Verify-BuiltCli"),
    ps1Static.indexOf("function Ensure-Build"),
  );
  check(
    "install.ps1 verify stays at two node spawns",
    verifyPs1 !== "" &&
      !verifyPs1.includes("node -p") &&
      verifyPs1.includes("--version") &&
      verifyPs1.includes("--help"),
    "Read-PackageJson already avoids the version spawn",
  );
  check(
    "agent hints stay in step with INSTALL_HINTS",
    openCodeVersion !== "" &&
      sh.includes(`opencode-ai@${openCodeVersion}`) &&
      ps1Static.includes(`opencode-ai@${openCodeVersion}`) &&
      sh.includes("npm install -g @anthropic-ai/claude-code") &&
      ps1Static.includes("npm install -g @anthropic-ai/claude-code"),
    `INSTALL_HINTS pins opencode-ai@${openCodeVersion || "?"}`,
  );
  check(
    "agent summary covers pi and omp",
    sh.includes("npm install -g @mariozechner/pi-coding-agent") &&
      ps1Static.includes("npm install -g @mariozechner/pi-coding-agent") &&
      sh.includes("bun install -g @oh-my-pi/pi-coding-agent") &&
      ps1Static.includes("bun install -g @oh-my-pi/pi-coding-agent"),
    "the summary probes opencode/claude/pi/omp",
  );
  check(
    "agent summary runs after the notes, before Done",
    sh.indexOf("print_agent_summary") > sh.indexOf("print_install_notes") &&
      ps1Static.indexOf("Write-AgentSummary") > ps1Static.indexOf("Write-InstallNotes"),
    "notes -> summary -> Done",
  );
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
    check("pwsh launcher subcheck skipped (pwsh missing)", true, "pwsh not installed");
  } else if (!existsSync(ps1Path)) {
    check(
      "pwsh launcher subcheck skipped (install.ps1 absent)",
      true,
      "install.ps1 not found next to this script",
    );
  } else {
    const ps1 = readFileSync(ps1Path, "utf8");
    const ps1Bytes = readFileSync(ps1Path);
    check(
      "install.ps1 ships without a BOM",
      !(
        ps1Bytes.length >= 3 &&
        ps1Bytes[0] === 0xef &&
        ps1Bytes[1] === 0xbb &&
        ps1Bytes[2] === 0xbf
      ),
      "a BOM makes irm | iex fail line 1 ('#' is not recognized) and demotes param()",
    );
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

    // Agent-summary matrix via pwsh: AIAND_SKIP_BUILD=1 plus a stub dist/
    // keeps this fast (no npm). Fake bins ship both an extensionless +x
    // stub (Unix Get-Command) and a .cmd stub (Windows PATHEXT lookup).
    const summarySmoke = `
$ErrorActionPreference = 'Stop'
$tmpRoot = [System.IO.Path]::GetTempPath()
$sep = [System.IO.Path]::PathSeparator
$runner = $null
try { $runner = [string](Get-Process -Id $PID).Path } catch { }
if ([string]::IsNullOrWhiteSpace($runner)) {
  $found = Get-Command -Name pwsh -ErrorAction SilentlyContinue
  if (-not $found) { $found = Get-Command -Name powershell -ErrorAction SilentlyContinue }
  if ($found) { $runner = [string]$found.Source }
}
if ([string]::IsNullOrWhiteSpace($runner)) { throw 'could not resolve pwsh path' }
$shapes = @(
  @{ Name = 'none'; Bins = @(); Want = @('No coding agents detected on this machine.', 'Install one, then run'); NotWant = @('Detected agents:') },
  @{ Name = 'some'; Bins = @('opencode', 'pi'); Want = @('Detected agents:', 'opencode', 'Not installed:', 'claude  Install it with:', 'wire them to ai&.'); NotWant = @('No coding agents detected') },
  @{ Name = 'all'; Bins = @('opencode', 'claude', 'pi', 'omp'); Want = @('Detected agents:', 'wire them to ai&.'); NotWant = @('Not installed:', 'No coding agents detected') }
)
foreach ($shape in $shapes) {
  $iso = Join-Path $tmpRoot ('aiand-ib-sum-' + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $iso -Force | Out-Null
  $fakebin = Join-Path $iso 'fakebin'
  New-Item -ItemType Directory -Path $fakebin -Force | Out-Null
  foreach ($leaf in $shape.Bins) {
    # Extensionless stub for Unix Get-Command, .cmd stub for Windows
    # PATHEXT. chmod is not a command under Windows PowerShell (and a
    # no-match wildcard is a hard error under 'Stop'), so the +x bit rides
    # .NET instead: sets the executable bit on Unix and is a no-op on
    # Windows, where the .cmd extension already makes it runnable.
    [System.IO.File]::WriteAllText((Join-Path $fakebin $leaf), '#!/bin/sh' + [Environment]::NewLine + 'exit 0' + [Environment]::NewLine)
    [System.IO.File]::WriteAllText((Join-Path $fakebin ($leaf + '.cmd')), '@echo off' + [Environment]::NewLine + 'exit /b 0' + [Environment]::NewLine)
    if ($IsLinux -or $IsMacOS) {
      [System.IO.File]::SetUnixFileMode((Join-Path $fakebin $leaf), [System.IO.UnixFileMode]::UserExecute)
    }
  }
  $src = Join-Path $iso 'src'
  New-Item -ItemType Directory -Path $src -Force | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $src 'package.json'), '{"name":"@aiand/cli","version":"0.0.0-new"}' + [Environment]::NewLine)
  $dist = Join-Path $src 'dist'
  New-Item -ItemType Directory -Path $dist -Force | Out-Null
  $stub = 'const arg = process.argv[2]; if (arg === "--version") console.log("0.0.0-new"); else if (arg === "--help") console.log("stub"); else process.exit(1);' + [Environment]::NewLine
  [System.IO.File]::WriteAllText((Join-Path $dist 'index.js'), $stub)
  & git init -q $src
  & git -C $src add -A
  & git -C $src -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false commit -qm seed
  $scriptDir = Join-Path $iso 'scriptdir'
  New-Item -ItemType Directory -Path $scriptDir -Force | Out-Null
  Copy-Item -LiteralPath '${winPs1.replace(/'/g, "''")}' -Destination (Join-Path $scriptDir 'install.ps1') -Force
  $env:USERPROFILE = $iso
  $env:HOME = $iso
  $env:AIAND_SOURCE = $src
  $env:AIAND_SKIP_BUILD = '1'
  $env:AIAND_NO_MODIFY_PATH = '1'
  $agentIds = @('opencode', 'claude', 'pi', 'omp')
  $agentExts = @('', '.cmd', '.exe', '.bat', '.ps1')
  $kept = @()
  foreach ($d in ($env:PATH -split [regex]::Escape($sep))) {
    if ([string]::IsNullOrWhiteSpace($d)) { continue }
    $leak = $false
    foreach ($a in $agentIds) {
      foreach ($e in $agentExts) {
        if (Test-Path -LiteralPath (Join-Path $d ($a + $e))) { $leak = $true; break }
      }
      if ($leak) { break }
    }
    if (-not $leak) { $kept += $d }
  }
  $env:PATH = $fakebin + $sep + ($kept -join $sep)
  $copied = Join-Path $scriptDir 'install.ps1'
  $prevErr = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = & $runner -NoProfile -ExecutionPolicy Bypass -File $copied 2>&1 | Out-String
  $code = $LASTEXITCODE; $ErrorActionPreference = $prevErr
  if ($code -ne 0) { throw ($shape.Name + ' install exited ' + $code + ' :: ' + $out) }
  foreach ($fragment in $shape.Want) { if ($out -notmatch [regex]::Escape($fragment)) { throw ($shape.Name + ' summary missed ' + $fragment) } }
  foreach ($fragment in $shape.NotWant) { if ($out -match [regex]::Escape($fragment)) { throw ($shape.Name + ' summary wrongly has ' + $fragment) } }
  Remove-Item -Recurse -Force $iso -ErrorAction SilentlyContinue
}
Write-Output 'ok'
`;
    const summaryRun = spawnSync(host, ["-NoProfile", "-Command", summarySmoke], {
      encoding: "utf8",
      timeout: PWSH_SMOKE_TIMEOUT_MS,
    });
    const summaryOut = `${summaryRun.stdout ?? ""}${summaryRun.stderr ?? ""}`.trim();
    check(
      "install.ps1 prints the agent summary (none/some detected)",
      (summaryRun.status ?? 1) === 0 && summaryOut.split("\n").pop() === "ok",
      summaryOut.split("\n").filter(Boolean).pop() ?? `status=${summaryRun.status}`,
    );
  }
}

console.log(results.join("\n"));
console.log(
  results.every((r) => r.startsWith("PASS"))
    ? "INSTALL-BEHAVIOR: ALL PASS"
    : "INSTALL-BEHAVIOR: FAILURES PRESENT",
);
