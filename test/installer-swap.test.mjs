// An update swaps the verified copy in for ~/.aiand/cli in two moves: the old
// install aside, the new one in. A run stopped between them must not leave
// `aiand` without a CLI: the exit trap puts the old install back, and a run that
// was killed outright (no trap) is repaired by the next one before it does
// anything else. Folders a run leaves behind are cleaned up, and only the
// installer's own.
// #58 review: a kill between the two `mv`s lost ~/.aiand/cli, and the EXIT trap
// deleted the staged copy without restoring cli.prev-<pid>.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  caseDir,
  HAS_BASH,
  leftovers,
  newReleaseDouble,
  PWSH,
  publishToDouble,
  runInstaller,
  seedInstall,
} from "./installer-fixtures.mjs";

let double;
before(async () => {
  double = await newReleaseDouble();
});
after(() => double.close());

const OLD = "9.0.1";
const NEW = "9.7.0";
const releaseEnv = (version) => ({
  AIAND_INSTALL_RELEASES_URL: `${double.base}/rel`,
  AIAND_INSTALL_NPM_REGISTRY: `${double.base}/npm`,
  AIAND_VERSION: version,
});
// A release nobody published: the run fails after the start-of-run repairs.
const MISSING = "9.99.99";
const versionAt = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
const names = (dir) => readdirSync(dir).sort();

// A pid that no process has: the child has exited by the time spawnSync returns.
const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;

/**
 * A directory first on PATH holding an `mv` that, the first time it is asked to
 * move a staging folder into place, sends `signal` to the installer instead and
 * moves nothing. Every other `mv` is the real one.
 */
function fakeMvDir(dir, installDir, signal) {
  const bin = join(dir, "fakebin");
  mkdirSync(bin, { recursive: true });
  const realMv = spawnSync("sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim();
  const fired = join(dir, "mv-fired");
  writeFileSync(
    join(bin, "mv"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  */.cli-staging-*)",
      `    if [ "$2" = "${installDir}" ] && [ ! -e "${fired}" ]; then`,
      `      : > "${fired}"`,
      `      kill -${signal} $PPID`,
      "      exit 0",
      "    fi ;;",
      "esac",
      `exec "${realMv}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "mv"), 0o755);
  return { bin, fired };
}

describe("install.sh: stopped between the two moves of the swap", { skip: !HAS_BASH }, () => {
  for (const signal of ["TERM", "INT", "HUP"]) {
    test(`SIG${signal} puts the previous install back and removes the staging folder`, async () => {
      const c = caseDir();
      try {
        publishToDouble(double, NEW);
        const install = join(c.dir, "home", ".aiand", "cli");
        seedInstall(install, OLD);
        const { bin, fired } = fakeMvDir(c.dir, install, signal);
        const run = await runInstaller("sh", c.dir, {
          env: releaseEnv(NEW),
          path: `${bin}:${process.env.PATH}`,
        });
        assert.ok(existsSync(fired), "the swap was reached and interrupted");
        assert.equal(run.status, 130, run.stderr);
        assert.equal(versionAt(install), OLD, "the previous install is back");
        assert.deepEqual(leftovers(run.home), []);
      } finally {
        c.cleanup();
      }
    });
  }

  describe("SIGKILL, which no trap sees", () => {
    async function killed(c) {
      publishToDouble(double, NEW);
      const install = join(c.dir, "home", ".aiand", "cli");
      seedInstall(install, OLD);
      const { bin, fired } = fakeMvDir(c.dir, install, "KILL");
      const run = await runInstaller("sh", c.dir, {
        env: releaseEnv(NEW),
        path: `${bin}:${process.env.PATH}`,
      });
      assert.ok(existsSync(fired));
      assert.equal(run.signal, "SIGKILL");
      assert.ok(!existsSync(install), "the install directory is gone, as after a real kill");
      assert.ok(leftovers(run.home).some((n) => n.startsWith("cli.prev-")));
      assert.ok(leftovers(run.home).some((n) => n.startsWith(".cli-staging-")));
      return install;
    }

    test("the next run puts the previous install back first, even when it then fails", async () => {
      const c = caseDir();
      try {
        const install = await killed(c);
        const rerun = await runInstaller("sh", c.dir, { env: releaseEnv(MISSING) });
        assert.notEqual(rerun.status, 0);
        assert.equal(versionAt(install), OLD);
        assert.match(rerun.stderr, /Put back the previous installation from .*cli\.prev-/);
        assert.deepEqual(leftovers(rerun.home), []);
      } finally {
        c.cleanup();
      }
    });

    test("the next run that succeeds updates from the restored install and leaves nothing", async () => {
      const c = caseDir();
      try {
        const install = await killed(c);
        const rerun = await runInstaller("sh", c.dir, { env: releaseEnv(NEW) });
        assert.equal(rerun.status, 0, rerun.stderr);
        assert.equal(versionAt(install), NEW);
        assert.deepEqual(leftovers(rerun.home), []);
      } finally {
        c.cleanup();
      }
    });
  });
});

const HOSTS = [
  ["install.sh", "sh", HAS_BASH ? false : "no bash on PATH"],
  ["install.ps1", "ps1", PWSH ? false : "no pwsh on PATH"],
];

describe("a previous install set aside by a run that was killed", () => {
  for (const [file, kind, skip] of HOSTS) {
    test(`${file}: is put back when the install directory is missing`, { skip }, async () => {
      const c = caseDir();
      try {
        const aiand = join(c.dir, "home", ".aiand");
        seedInstall(join(aiand, `cli.prev-${deadPid}`), OLD);
        mkdirSync(join(aiand, `.cli-staging-${deadPid}-abcdef`, "dist"), { recursive: true });
        writeFileSync(join(aiand, `.cli-staging-${deadPid}-abcdef`, "dist", "index.js"), "");
        const run = await runInstaller(kind, c.dir, { env: releaseEnv(MISSING) });
        assert.notEqual(run.status, 0);
        assert.equal(versionAt(join(aiand, "cli")), OLD);
        assert.deepEqual(leftovers(run.home), []);
      } finally {
        c.cleanup();
      }
    });

    // The name carries the pid of the run that set the install aside, bare
    // (`cli.prev-<pid>`) or with the suffix a second swap in the same run adds.
    for (const [shape, name] of [
      ["bare", (pid) => `cli.prev-${pid}`],
      ["suffixed", (pid) => `cli.prev-${pid}-1700000000-42`],
    ]) {
      test(`${file}: a ${shape} name of a dead run is put back`, { skip }, async () => {
        const c = caseDir();
        try {
          const aiand = join(c.dir, "home", ".aiand");
          seedInstall(join(aiand, name(deadPid)), OLD);
          const run = await runInstaller(kind, c.dir, { env: releaseEnv(MISSING) });
          assert.notEqual(run.status, 0);
          assert.equal(versionAt(join(aiand, "cli")), OLD);
          assert.deepEqual(leftovers(run.home), []);
        } finally {
          c.cleanup();
        }
      });

      // Another installer is between the two moves of its swap: putting its
      // install back would make its second move nest the new one inside it.
      test(`${file}: a ${shape} name of a running installer is neither put back nor deleted`, {
        skip,
      }, async () => {
        const c = caseDir();
        try {
          const aiand = join(c.dir, "home", ".aiand");
          const live = join(aiand, name(process.pid));
          seedInstall(live, OLD);
          const run = await runInstaller(kind, c.dir, { env: releaseEnv(MISSING) });
          assert.notEqual(run.status, 0);
          assert.ok(!existsSync(join(aiand, "cli")), "not moved into place under the other run");
          assert.equal(versionAt(live), OLD, "left where it was, intact");
        } finally {
          c.cleanup();
        }
      });
    }

    test(`${file}: is not put back when it is not an @aiand/cli install`, { skip }, async () => {
      const c = caseDir();
      try {
        const aiand = join(c.dir, "home", ".aiand");
        mkdirSync(join(aiand, `cli.prev-${deadPid}`), { recursive: true });
        writeFileSync(
          join(aiand, `cli.prev-${deadPid}`, "package.json"),
          '{"name":"somebody-else"}',
        );
        const run = await runInstaller(kind, c.dir, { env: releaseEnv(MISSING) });
        assert.notEqual(run.status, 0);
        assert.ok(!existsSync(join(aiand, "cli")));
        assert.ok(
          existsSync(join(aiand, `cli.prev-${deadPid}`, "package.json")),
          "left where it was",
        );
      } finally {
        c.cleanup();
      }
    });
  }
});

describe("what an earlier run left next to the install is cleaned up, and only that", () => {
  for (const [file, kind, skip] of HOSTS) {
    test(file, { skip }, async () => {
      const c = caseDir();
      try {
        const aiand = join(c.dir, "home", ".aiand");
        seedInstall(join(aiand, "cli"), OLD);
        const put = (name, files = {}) => {
          mkdirSync(join(aiand, name), { recursive: true });
          for (const [rel, body] of Object.entries(files))
            writeFileSync(join(aiand, name, rel), body);
        };
        const aiandPkg = { "package.json": '{"name":"@aiand/cli","version":"9.0.0"}' };
        // Removed: a dead run's staging folders (empty, partial, and from before
        // names carried a pid) and its finished swap's previous install.
        put(`.cli-staging-${deadPid}-empty`);
        put(`.cli-staging-${deadPid}-partial`, aiandPkg);
        put(".cli-staging-legacy", aiandPkg);
        put(`cli.prev-${deadPid}`, aiandPkg);
        // Kept: a run that is still going (its staging folder or its set-aside install), anything that is not ours, and a link.
        put(`.cli-staging-${process.pid}-alive`, aiandPkg);
        put(`cli.prev-${process.pid}`, aiandPkg);
        put(`cli.prev-${process.pid}-1700000000-42`, aiandPkg);
        put(`.cli-staging-${deadPid}-foreign`, { "package.json": '{"name":"somebody-else"}' });
        put(`cli.prev-${deadPid}-2`, { "package.json": '{"name":"somebody-else"}' });
        put("cli.prev-notes", { "readme.txt": "mine" });
        const outside = join(c.dir, "outside");
        mkdirSync(outside);
        writeFileSync(join(outside, "keep.txt"), "keep");
        symlinkSync(outside, join(aiand, `.cli-staging-${deadPid}-link`));

        const run = await runInstaller(kind, c.dir, { env: releaseEnv(MISSING) });
        assert.notEqual(run.status, 0);
        assert.deepEqual(
          names(aiand),
          [
            `.cli-staging-${deadPid}-foreign`,
            `.cli-staging-${deadPid}-link`,
            `.cli-staging-${process.pid}-alive`,
            "cli",
            `cli.prev-${process.pid}`,
            `cli.prev-${process.pid}-1700000000-42`,
            `cli.prev-${deadPid}-2`,
            "cli.prev-notes",
          ].sort(),
        );
        assert.ok(lstatSync(join(aiand, `.cli-staging-${deadPid}-link`)).isSymbolicLink());
        assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
        assert.equal(versionAt(join(aiand, "cli")), OLD);
      } finally {
        c.cleanup();
      }
    });
  }
});
