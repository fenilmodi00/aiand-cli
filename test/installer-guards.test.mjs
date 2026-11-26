// Each refusal in the installers' release path has a test that fails when the
// refusal is taken out: a manifest, SHA256SUMS or tarball that is wrong in one
// way is served from a loopback double, and the installer must stop and leave
// the install it found as it was. install.sh runs under bash and install.ps1
// under pwsh (CI has both); a scenario is skipped for a host that is missing.
// #58 review: 11 of 22 installer guards could be removed without a test failing.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  caseDir,
  git,
  HAS_BASH,
  leftovers,
  newReleaseDouble,
  OWNERSHIP_MARKER,
  PWSH,
  publishToDouble,
  runInstaller,
  seedCheckout,
  seedInstall,
  sha256,
  stubCliSource,
  stubTarball,
  tarEntry,
} from "./installer-fixtures.mjs";

const HOSTS = [
  ["install.sh", "sh", HAS_BASH ? false : "no bash on PATH"],
  ["install.ps1", "ps1", PWSH ? false : "no pwsh on PATH"],
];

let double;
before(async () => {
  double = await newReleaseDouble();
});
after(() => double.close());

let counter = 0;
const nextVersion = () => `9.${++counter}.0`;
const releaseEnv = (version) => ({
  AIAND_INSTALL_RELEASES_URL: `${double.base}/rel`,
  AIAND_INSTALL_NPM_REGISTRY: `${double.base}/npm`,
  AIAND_VERSION: version,
});
const INSTALLED = "9.0.1";
const installedVersion = (home) =>
  JSON.parse(readFileSync(join(home, ".aiand", "cli", "package.json"), "utf8")).version;

test("a host without pwsh is a failure on CI, not a skip", () => {
  assert.ok(!process.env.CI || PWSH, "CI runners ship pwsh; install.ps1 must be exercised there");
});

describe("an honest release installs, so a refusal below is the guard and nothing else", () => {
  for (const [file, kind, skip] of HOSTS) {
    test(file, { skip }, async () => {
      const c = caseDir();
      try {
        const v = nextVersion();
        publishToDouble(double, v);
        seedInstall(join(c.dir, "home", ".aiand", "cli"), INSTALLED);
        const run = await runInstaller(kind, c.dir, { env: releaseEnv(v) });
        // pwsh off Windows cannot run the aiand.cmd it writes, so its exit code is not read.
        if (kind === "sh") assert.equal(run.status, 0, run.stderr);
        assert.equal(installedVersion(run.home), v, run.stderr);
        assert.deepEqual(leftovers(run.home), []);
      } finally {
        c.cleanup();
      }
    });
  }
});

// `publish(version, another)` serves a release for `version` that is wrong in
// one way; `another` hands out versions that are served honestly.
const RELEASE_GUARDS = [
  {
    name: "the pinned version must be the one SHA256SUMS lists",
    expect: /lists aiand-cli-\d+\.\d+\.\d+\.tgz, not \d+\.\d+\.\d+/,
    publish(version, another) {
      const other = another();
      publishToDouble(double, other);
      publishToDouble(double, version, {
        sums: `${sha256(stubTarball(other))}  aiand-cli-${other}.tgz\n`,
      });
    },
  },
  {
    name: "SHA256SUMS must list exactly one tarball, not none",
    expect: /must list exactly one aiand-cli-<version>\.tgz; it lists 0/,
    publish(version) {
      publishToDouble(double, version, { sums: `${"0".repeat(64)}  install.sh\n` });
    },
  },
  {
    name: "SHA256SUMS must list exactly one tarball, not two",
    expect: /must list exactly one aiand-cli-<version>\.tgz; it lists 2/,
    publish(version, another) {
      const other = another();
      publishToDouble(double, version, {
        sums: `${sha256(stubTarball(version))}  aiand-cli-${version}.tgz\n${sha256(stubTarball(other))}  aiand-cli-${other}.tgz\n`,
      });
    },
  },
  {
    name: "the manifest must name @aiand/cli",
    expect: /describes other-cli@\d+\.\d+\.\d+, not @aiand\/cli@/,
    publish(version) {
      publishToDouble(double, version, { manifest: { name: "other-cli" } });
    },
  },
  {
    name: "the manifest must be for the release's version",
    expect: /describes @aiand\/cli@0\.0\.1, not @aiand\/cli@\d+\.\d+\.\d+/,
    publish(version) {
      publishToDouble(double, version, { manifest: { version: "0.0.1" } });
    },
  },
  {
    name: "the manifest must point at the tarball's own URL",
    expect: /npm lists the tarball at .*elsewhere\.tgz, not /,
    publish(version) {
      publishToDouble(double, version, {
        manifest: { dist: { tarball: `${double.base}/npm/@aiand/cli/-/elsewhere.tgz` } },
      });
    },
  },
  {
    name: "the staged package must be @aiand/cli",
    expect: /tarball is not @aiand\/cli/,
    publish(version) {
      publishToDouble(double, version, {
        tarball: stubTarball(version, [], { name: "other-cli" }),
      });
    },
  },
  {
    name: "the staged CLI must report the version its package.json holds",
    expect: /staged aiand verification failed/,
    publish(version) {
      publishToDouble(double, version, {
        tarball: stubTarball(version, [], { cli: stubCliSource({ printVersion: "0.0.1" }) }),
      });
    },
  },
  {
    name: "the staged package must hold the release's version",
    expect: /staged aiand verification failed/,
    publish(version) {
      publishToDouble(double, version, {
        tarball: stubTarball(version, [], { pkgVersion: "0.0.1" }),
      });
    },
  },
  {
    name: "the staged CLI's --help must exit 0",
    expect: /staged aiand verification failed/,
    publish(version) {
      publishToDouble(double, version, {
        tarball: stubTarball(version, [], { cli: stubCliSource({ helpExit: 3 }) }),
      });
    },
  },
];

for (const guard of RELEASE_GUARDS) {
  describe(guard.name, () => {
    for (const [file, kind, skip] of HOSTS) {
      test(file, { skip }, async () => {
        const c = caseDir();
        try {
          const v = nextVersion();
          guard.publish(v, nextVersion);
          seedInstall(join(c.dir, "home", ".aiand", "cli"), INSTALLED);
          const run = await runInstaller(kind, c.dir, { env: releaseEnv(v) });
          assert.notEqual(run.status, 0, "the installer stopped");
          assert.match(run.stderr, guard.expect);
          assert.equal(installedVersion(run.home), INSTALLED, "the install it found is untouched");
          assert.deepEqual(leftovers(run.home), []);
        } finally {
          c.cleanup();
        }
      });
    }
  });
}

// A checkout the installer made, which a release install replaces wholesale.
const CHECKOUT_GUARDS = [
  {
    name: "a checkout with local changes is kept",
    expect: /has local changes/,
    setup(checkout) {
      writeFileSync(
        join(checkout, "package.json"),
        `{"name":"@aiand/cli","version":"${INSTALLED}","edited":true}\n`,
      );
    },
    kept(checkout) {
      assert.match(readFileSync(join(checkout, "package.json"), "utf8"), /"edited":true/);
    },
  },
  {
    name: "a checkout with an untracked file is kept",
    expect: /has local changes/,
    setup(checkout) {
      writeFileSync(join(checkout, "notes.txt"), "mine\n");
    },
    kept(checkout) {
      assert.equal(readFileSync(join(checkout, "notes.txt"), "utf8"), "mine\n");
    },
  },
  {
    name: "a checkout with a commit its upstream lacks is kept",
    expect: /has local commits/,
    setup(checkout) {
      writeFileSync(join(checkout, "mine.txt"), "mine\n");
      git(checkout, "add", "mine.txt");
      git(checkout, "commit", "-qm", "my local work");
    },
    kept(checkout) {
      assert.match(git(checkout, "log", "-1", "--format=%s"), /my local work/);
    },
  },
  {
    // #58: `git switch -c mywork`, commit, run the installer: rev-list failed,
    // its empty output read as "nothing ahead", and the commit was replaced.
    name: "a commit on a branch with no upstream is kept",
    expect: /no upstream/,
    setup(checkout) {
      git(checkout, "switch", "-q", "-c", "mywork");
      writeFileSync(join(checkout, "mine.txt"), "mine\n");
      git(checkout, "add", "mine.txt");
      git(checkout, "commit", "-qm", "my local work");
    },
    kept(checkout) {
      assert.match(git(checkout, "log", "-1", "--format=%s"), /my local work/);
      assert.equal(git(checkout, "branch", "--show-current").trim(), "mywork");
    },
  },
];

describe("a clean checkout with an upstream is replaced by the release", () => {
  for (const [file, kind, skip] of HOSTS) {
    test(file, { skip }, async () => {
      const c = caseDir();
      try {
        const v = nextVersion();
        publishToDouble(double, v);
        seedCheckout(join(c.dir, "home", ".aiand", "cli"), INSTALLED);
        const run = await runInstaller(kind, c.dir, { env: releaseEnv(v) });
        assert.equal(installedVersion(run.home), v, run.stderr);
        assert.ok(!readFileSyncExists(join(run.home, ".aiand", "cli", ".git", "HEAD")));
      } finally {
        c.cleanup();
      }
    });
  }
});

function readFileSyncExists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

for (const guard of CHECKOUT_GUARDS) {
  describe(guard.name, () => {
    for (const [file, kind, skip] of HOSTS) {
      test(file, { skip }, async () => {
        const c = caseDir();
        try {
          const v = nextVersion();
          publishToDouble(double, v);
          const checkout = join(c.dir, "home", ".aiand", "cli");
          seedCheckout(checkout, INSTALLED);
          guard.setup(checkout);
          const run = await runInstaller(kind, c.dir, { env: releaseEnv(v) });
          assert.notEqual(run.status, 0, "the installer stopped");
          assert.match(run.stderr, guard.expect);
          assert.match(run.stderr, /your checkout was left untouched/);
          assert.equal(installedVersion(run.home), INSTALLED, "still the checkout's own version");
          assert.ok(readFileSyncExists(join(checkout, ".git", "HEAD")), "still a git checkout");
          assert.ok(readFileSyncExists(join(checkout, OWNERSHIP_MARKER)));
          guard.kept(checkout);
          assert.deepEqual(leftovers(run.home), []);
        } finally {
          c.cleanup();
        }
      });
    }
  });
}

// A tarball or stream larger than any release stops at the limit, with a
// message, instead of being downloaded whole and then refused. #58 review:
// a 70 MiB streamed tarball was refused after about 65 s, with no message.
describe("a download larger than the limit stops early and says why", () => {
  for (const [file, kind, skip] of HOSTS) {
    test(`${file}: a 70 MiB streamed tarball`, { skip }, async () => {
      const c = caseDir();
      try {
        const v = nextVersion();
        publishToDouble(double, v);
        writeFileSync(join(double.root, "npm", "@aiand", "cli", "-", `cli-${v}.tgz.stream`), "70");
        seedInstall(join(c.dir, "home", ".aiand", "cli"), INSTALLED);
        const before = double.streamed;
        const started = Date.now();
        const run = await runInstaller(kind, c.dir, { env: releaseEnv(v) });
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /cli-\d+\.\d+\.\d+\.tgz is larger than 16 MiB/);
        assert.match(run.stderr, /stopped downloading it and installed nothing/);
        assert.ok(Date.now() - started < 60_000, "refused promptly");
        const sent = (double.streamed - before) / (1024 * 1024);
        assert.ok(sent < 40, `the server was asked for ${sent} MiB of 70`);
        assert.equal(installedVersion(run.home), INSTALLED);
        assert.deepEqual(leftovers(run.home), []);
      } finally {
        c.cleanup();
      }
    });

    test(`${file}: a declared length over the limit is refused before the body`, {
      skip,
    }, async () => {
      const c = caseDir();
      try {
        const v = nextVersion();
        publishToDouble(double, v);
        writeFileSync(join(double.root, "npm", "@aiand", "cli", "-", `cli-${v}.tgz.declare`), "70");
        seedInstall(join(c.dir, "home", ".aiand", "cli"), INSTALLED);
        const started = Date.now();
        const run = await runInstaller(kind, c.dir, { env: releaseEnv(v), timeoutMs: 45_000 });
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /is larger than 16 MiB/);
        assert.ok(Date.now() - started < 30_000, "refused without waiting for the body");
        assert.equal(installedVersion(run.home), INSTALLED);
      } finally {
        c.cleanup();
      }
    });

    test(`${file}: a SHA256SUMS over its limit`, { skip }, async () => {
      const c = caseDir();
      try {
        const v = nextVersion();
        publishToDouble(double, v, { sums: "x".repeat(5 * 1024 * 1024) });
        seedInstall(join(c.dir, "home", ".aiand", "cli"), INSTALLED);
        const run = await runInstaller(kind, c.dir, { env: releaseEnv(v) });
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /SHA256SUMS is larger than 4 MiB/);
        assert.equal(installedVersion(run.home), INSTALLED);
      } finally {
        c.cleanup();
      }
    });

    test(`${file}: a tarball that unpacks past its limit`, { skip }, async () => {
      const c = caseDir();
      try {
        const v = nextVersion();
        const filler = tarEntry("package/dist/filler.bin", Buffer.alloc(65 * 1024 * 1024));
        publishToDouble(double, v, { tarball: stubTarball(v, [filler]) });
        seedInstall(join(c.dir, "home", ".aiand", "cli"), INSTALLED);
        const run = await runInstaller(kind, c.dir, { env: releaseEnv(v) });
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /unpacks to more than 64 MiB/);
        assert.equal(installedVersion(run.home), INSTALLED);
      } finally {
        c.cleanup();
      }
    });

    test(`${file}: a multi-MiB tarball is well within the limits`, { skip }, async () => {
      const c = caseDir();
      try {
        const v = nextVersion();
        const filler = tarEntry("package/dist/filler.bin", randomBytes(8 * 1024 * 1024));
        publishToDouble(double, v, { tarball: stubTarball(v, [filler]) });
        seedInstall(join(c.dir, "home", ".aiand", "cli"), INSTALLED);
        const run = await runInstaller(kind, c.dir, { env: releaseEnv(v) });
        assert.equal(installedVersion(run.home), v, run.stderr);
      } finally {
        c.cleanup();
      }
    });
  }
});
