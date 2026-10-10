import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BIN, withEnv, withFetch, withTestEnv } from "./helpers.mjs";

const { compareVersions, checkForUpdate } = await import("../dist/housekeeping/update.js");
const { VERSION } = await import("../dist/api/client.js");
const { updateInstallHint } = await import("../dist/index.js");

// Build a version string safely above the local one (same part count).
function newerVersion(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

// Env box: the cache file lives under the temp AIAND_CONFIG_DIR, kill-switch
// vars are cleared so the gates can be exercised per-test.
const env = withTestEnv("aiand-update-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.CI;
  delete process.env.AIAND_UPDATE_CHECK;
  delete process.env.NO_UPDATE_CHECK;
});

const cfg = (name) => join(env.dir, name);
const cachePath = () => cfg("update-check.json");
const writeCache = (payload) => writeFileSync(cachePath(), `${JSON.stringify(payload)}\n`);
const readCache = () => JSON.parse(readFileSync(cachePath(), "utf8"));
const hour = 60 * 60 * 1000;

describe("compareVersions (dotted-integer, same-length padded)", () => {
  test("newer > older", () => {
    assert.ok(compareVersions("1.2.3", "1.2.2") > 0);
  });
  test("older < newer", () => {
    assert.ok(compareVersions("1.2.2", "1.2.3") < 0);
  });
  test("equal", () => {
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });
  test("shorter padded by zeros", () => {
    assert.ok(compareVersions("1.2.10", "1.2.9") > 0);
    assert.ok(compareVersions("1.2", "1.1.9") > 0);
    assert.equal(compareVersions("1.2", "1.2.0"), 0);
  });
  test("a prerelease is older than the matching release", () => {
    assert.ok(compareVersions("1.0.0-rc.1", "1.0.0") < 0);
    assert.ok(compareVersions("1.0.0", "1.0.0-rc.1") > 0);
  });
});

/** A fetch stub that counts calls and answers with `respond()`. */
function countingFetch(respond) {
  const stub = async () => {
    stub.calls += 1;
    return respond();
  };
  stub.calls = 0;
  return stub;
}

const registryReply = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("checkForUpdate", () => {
  test("returns update info when cached latest is strictly newer", async () => {
    writeCache({ checkedAt: Date.now(), ok: true, latest: newerVersion(VERSION) });
    const info = await checkForUpdate();
    assert.deepEqual(info, { current: VERSION, latest: newerVersion(VERSION) });
  });

  test("ignores a prerelease on the latest dist-tag when the install is stable", async () => {
    writeCache({ checkedAt: Date.now(), ok: true, latest: "99.0.0-rc.1" });
    const info = await checkForUpdate();
    assert.equal(info, null);
  });

  test("returns null when cached latest equals local version", async () => {
    writeCache({ checkedAt: Date.now(), ok: true, latest: VERSION });
    const info = await checkForUpdate();
    assert.equal(info, null);
  });

  test("fetches when cache is stale (>24h) and returns newer info", async () => {
    writeCache({ checkedAt: Date.now() - 25 * hour, ok: true, latest: VERSION });
    const fetch = countingFetch(() => registryReply({ version: newerVersion(VERSION) }));
    await withFetch(fetch, async () => {
      const info = await checkForUpdate();
      assert.equal(fetch.calls, 1);
      assert.deepEqual(info, { current: VERSION, latest: newerVersion(VERSION) });
      assert.equal(readCache().ok, true);
      assert.equal(readCache().latest, newerVersion(VERSION));
    });
  });

  test("fetch failure writes the failed cache and returns null", async () => {
    writeCache({ checkedAt: Date.now() - 25 * hour, ok: true, latest: VERSION });
    const fetch = countingFetch(() => {
      throw new Error("network down");
    });
    await withFetch(fetch, async () => {
      const info = await checkForUpdate();
      assert.equal(fetch.calls, 1);
      assert.equal(info, null);
      assert.equal(readCache().ok, false);
      assert.ok(Date.now() - readCache().checkedAt < 1000);
    });
  });

  test("no refetch during failure retry window (1h)", async () => {
    writeCache({ checkedAt: Date.now(), ok: false });
    const fetch = countingFetch(() => {
      throw new Error("must not fetch inside the retry window");
    });
    await withFetch(fetch, async () => {
      const info = await checkForUpdate();
      assert.equal(fetch.calls, 0);
      assert.equal(info, null);
    });
  });

  test("refetches after the failure retry window", async () => {
    writeCache({ checkedAt: Date.now() - 2 * hour, ok: false });
    const fetch = countingFetch(() => {
      throw new Error("still down");
    });
    await withFetch(fetch, async () => {
      const info = await checkForUpdate();
      assert.equal(fetch.calls, 1);
      assert.equal(info, null); // fetch failed again -> failed cache, null
      assert.equal(readCache().ok, false);
    });
  });

  // Each kill-switch starts from a stale cache, so a regressed gate would
  // fetch; the counting stub proves it never does.
  for (const [name, vars] of [
    ["AIAND_UPDATE_CHECK=0", { AIAND_UPDATE_CHECK: "0" }],
    ["NO_UPDATE_CHECK=1", { NO_UPDATE_CHECK: "1" }],
    ["CI", { CI: "1" }],
  ]) {
    test(`respects the ${name} kill-switch (no IO)`, async () => {
      writeCache({ checkedAt: Date.now() - 25 * hour, ok: true, latest: newerVersion(VERSION) });
      const before = readFileSync(cachePath(), "utf8");
      const fetch = countingFetch(() => registryReply({ version: newerVersion(VERSION) }));
      await withEnv(vars, () =>
        withFetch(fetch, async () => {
          assert.equal(await checkForUpdate(), null);
        }),
      );
      assert.equal(fetch.calls, 0);
      assert.equal(readFileSync(cachePath(), "utf8"), before); // untouched
    });
  }

  test("never throws (malformed registry payload)", async () => {
    // registry resolves to a body without a version field -> treated as failure
    writeCache({ checkedAt: Date.now() - 25 * hour, ok: true, latest: VERSION });
    const fetch = countingFetch(() => registryReply({}));
    await withFetch(fetch, async () => {
      const info = await checkForUpdate();
      assert.equal(info, null);
      assert.equal(readCache().ok, false);
    });
  });
});

describe("updateInstallHint", () => {
  test("install.sh launch returns a runnable bash command", () => {
    assert.equal(
      updateInstallHint({ platform: "linux", launched: "/tmp/fixture/.aiand/cli/dist/index.js" }),
      "bash ~/.aiand/cli/install.sh",
    );
  });

  test("win32 install returns a runnable ps1 path", () => {
    assert.equal(
      updateInstallHint({
        platform: "win32",
        launched: "C:\\Users\\u\\.aiand\\cli\\dist\\index.js",
      }),
      '& "$env:USERPROFILE\\.aiand\\cli\\install.ps1"',
    );
  });

  test("npm-global launch still returns npm install", () => {
    assert.equal(
      updateInstallHint({
        launched: "/usr/local/lib/node_modules/@aiand/cli/dist/index.js",
        aiandDir: "",
      }),
      "npm install -g @aiand/cli",
    );
  });

  test("AIAND_DIR launch returns the install hint", () => {
    assert.equal(
      updateInstallHint({
        platform: "linux",
        launched: "/opt/aiand/dist/index.js",
        aiandDir: "/opt/aiand",
      }),
      "bash ~/.aiand/cli/install.sh",
    );
  });

  test("never returns the old re-run placeholder", () => {
    const hints = [
      updateInstallHint({ launched: "/tmp/fixture/.aiand/cli/dist/index.js" }),
      updateInstallHint({
        platform: "win32",
        launched: "C:\\Users\\u\\.aiand\\cli\\dist\\index.js",
      }),
      updateInstallHint({
        launched: "/usr/local/lib/node_modules/@aiand/cli/dist/index.js",
        aiandDir: "",
      }),
    ];
    for (const hint of hints) {
      assert.doesNotMatch(hint, /re-run install/);
    }
  });
});

describe("updateInstallHint default launched path", () => {
  // No explicit `launched`: the hint reads process.argv[1], so run it in a
  // child whose argv[1] is an npm-global install path.
  test("an npm-global argv[1] prints npm install", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { updateInstallHint } from ${JSON.stringify(pathToFileURL(BIN).href)}; console.log("HINT:" + updateInstallHint());`,
        "/usr/local/lib/node_modules/@aiand/cli/dist/index.js",
      ],
      { env: { ...process.env, AIAND_DIR: "" } },
    );
    assert.match(stdout, /HINT:npm install -g @aiand\/cli/);
  });
});
