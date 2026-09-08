import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withTestEnv } from "./helpers.mjs";

const { compareVersions, checkForUpdate } = await import("../dist/housekeeping/update.js");
const { VERSION } = await import("../dist/api/client.js");

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
const writeCache = (payload) => writeFileSync(cachePath(), JSON.stringify(payload) + "\n");
const readCache = () => JSON.parse(readFileSync(cachePath(), "utf8"));
const hour = 60 * 60 * 1000;

/** Stub the registry fetch for the duration of `fn`, counting calls. */
async function withFetch(impl, fn) {
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    return impl(...args);
  };
  try {
    return await fn(fetchCalls ? undefined : undefined, () => fetchCalls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

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
});

describe("checkForUpdate", () => {
  test("returns update info when cached latest is strictly newer", async () => {
    writeCache({ checkedAt: Date.now(), ok: true, latest: newerVersion(VERSION) });
    const info = await checkForUpdate();
    assert.deepEqual(info, { current: VERSION, latest: newerVersion(VERSION) });
  });

  test("returns null when cached latest equals local version", async () => {
    writeCache({ checkedAt: Date.now(), ok: true, latest: VERSION });
    const info = await checkForUpdate();
    assert.equal(info, null);
  });

  test("fetches when cache is stale (>24h) and returns newer info", async () => {
    writeCache({ checkedAt: Date.now() - 25 * hour, ok: true, latest: VERSION });
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ version: newerVersion(VERSION) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const info = await checkForUpdate();
      assert.equal(fetchCalls, 1);
      assert.deepEqual(info, { current: VERSION, latest: newerVersion(VERSION) });
      assert.equal(readCache().ok, true);
      assert.equal(readCache().latest, newerVersion(VERSION));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("fetch failure writes the failed cache and returns null", async () => {
    writeCache({ checkedAt: Date.now() - 25 * hour, ok: true, latest: VERSION });
    const before = Date.now();
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("network down");
    };
    try {
      const info = await checkForUpdate();
      assert.equal(fetchCalls, 1);
      assert.equal(info, null);
      assert.equal(readCache().ok, false);
      assert.ok(Date.now() - readCache().checkedAt < 1000);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("no refetch during failure retry window (1h)", async () => {
    writeCache({ checkedAt: Date.now(), ok: false });
    const info = await checkForUpdate();
    assert.equal(info, null);
  });

  test("refetches after the failure retry window", async () => {
    writeCache({ checkedAt: Date.now() - 2 * hour, ok: false });
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("still down");
    };
    try {
      const info = await checkForUpdate();
      assert.equal(fetchCalls, 1);
      assert.equal(info, null); // fetch failed again → failed cache, null
      assert.equal(readCache().ok, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("respects the AIAND_UPDATE_CHECK=0 kill-switch (no IO)", async () => {
    writeCache({ checkedAt: Date.now() - 25 * hour, ok: true, latest: newerVersion(VERSION) });
    const before = readFileSync(cachePath(), "utf8");
    process.env.AIAND_UPDATE_CHECK = "0";
    const info = await checkForUpdate();
    delete process.env.AIAND_UPDATE_CHECK;
    assert.equal(info, null);
    assert.equal(readFileSync(cachePath(), "utf8"), before); // untouched
  });

  test("respects NO_UPDATE_CHECK=1", async () => {
    process.env.NO_UPDATE_CHECK = "1";
    const info = await checkForUpdate();
    delete process.env.NO_UPDATE_CHECK;
    assert.equal(info, null);
  });

  test("skips when CI is set", async () => {
    process.env.CI = "1";
    const info = await checkForUpdate();
    delete process.env.CI;
    assert.equal(info, null);
  });

  test("never throws (malformed registry payload)", async () => {
    // registry resolves to a body without a version field → treated as failure
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const info = await checkForUpdate();
      assert.equal(info, null);
      assert.equal(readCache().ok, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
