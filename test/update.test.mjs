import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { compareVersions, checkForUpdate } = await import("../dist/housekeeping/update.js");
const { VERSION } = await import("../dist/api/client.js");

// Build a version string safely above the local one (same part count).
function newerVersion(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

// Inject a fake clock and fetch; each check writes its own cache file under
// the temp AIAND_CONFIG_DIR.
async function run(opts) {
  let fetchCalls = 0;
  const fetchImpl = opts.fetchImpl ?? (() => ({ version: opts.latest ?? "9.9.9" }));
  const info = await checkForUpdate({
    now: opts.now ?? (() => Date.now()),
    fetchImpl: (...args) => {
      fetchCalls += 1;
      return fetchImpl(...args);
    },
  });
  return { info, fetchCalls };
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
  let dir;
  const originalEnv = { ...process.env };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aiand-update-"));
    process.env.AIAND_CONFIG_DIR = dir;
    // The developer/CI runner may have CI exported; clear it so the
    // kill-switch tests run, and re-set it only inside the CI test itself.
    delete process.env.CI;
  });
  after(() => {
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  const cfg = (name) => join(dir, name);
  const writeCache = (payload) =>
    writeFileSync(cfg("update-check.json"), JSON.stringify(payload) + "\n");
  const readCache = () => JSON.parse(readFileSync(cfg("update-check.json"), "utf8"));
  const hour = 60 * 60 * 1000;

  test("returns update info when cached latest is strictly newer", async () => {
    writeCache({ checkedAt: Date.now(), ok: true, latest: newerVersion(VERSION) });
    const { info, fetchCalls } = await run({});
    assert.equal(fetchCalls, 0);
    assert.deepEqual(info, { current: VERSION, latest: newerVersion(VERSION) });
  });

  test("returns null when cached latest equals local version", async () => {
    writeCache({ checkedAt: Date.now(), ok: true, latest: VERSION });
    const { info, fetchCalls } = await run({});
    assert.equal(fetchCalls, 0);
    assert.equal(info, null);
  });

  test("fetches when cache is stale (>24h) and returns newer info", async () => {
    let now = Date.now();
    writeCache({ checkedAt: Date.now() - 25 * hour, ok: true, latest: VERSION });
    const { info, fetchCalls } = await run({
      now: () => now,
      fetchImpl: () => {
        now = Date.now();
        return { version: newerVersion(VERSION) };
      },
    });
    assert.equal(fetchCalls, 1);
    assert.deepEqual(info, { current: VERSION, latest: newerVersion(VERSION) });
    assert.equal(readCache().ok, true);
    assert.equal(readCache().latest, newerVersion(VERSION));
  });

  test("fetch failure writes the failed cache and returns null", async () => {
    writeCache({ checkedAt: Date.now() - 25 * hour, ok: true, latest: VERSION });
    const { info, fetchCalls } = await run({
      fetchImpl: () => {
        throw new Error("network down");
      },
    });
    assert.equal(fetchCalls, 1);
    assert.equal(info, null);
    assert.equal(readCache().ok, false);
    assert.ok(Date.now() - readCache().checkedAt < 1000);
  });

  test("no refetch during failure retry window (1h)", async () => {
    writeCache({ checkedAt: Date.now(), ok: false });
    const { info, fetchCalls } = await run({});
    assert.equal(fetchCalls, 0);
    assert.equal(info, null);
  });

  test("refetches after the failure retry window", async () => {
    writeCache({ checkedAt: Date.now() - 2 * hour, ok: false });
    const { info, fetchCalls } = await run({
      fetchImpl: () => {
        throw new Error("still down");
      },
    });
    assert.equal(fetchCalls, 1);
    assert.equal(info, null); // fetch failed again → failed cache, null
    assert.equal(readCache().ok, false);
  });

  test("respects the AIAND_UPDATE_CHECK=0 kill-switch (no IO)", async () => {
    writeCache({ checkedAt: Date.now() - 25 * hour, ok: true, latest: newerVersion(VERSION) });
    const before = readFileSync(cfg("update-check.json"), "utf8");
    process.env.AIAND_UPDATE_CHECK = "0";
    const { info, fetchCalls } = await run({});
    delete process.env.AIAND_UPDATE_CHECK;
    assert.equal(info, null);
    assert.equal(fetchCalls, 0);
    assert.equal(readFileSync(cfg("update-check.json"), "utf8"), before); // untouched
  });

  test("respects NO_UPDATE_CHECK=1", async () => {
    process.env.NO_UPDATE_CHECK = "1";
    const { info, fetchCalls } = await run({});
    delete process.env.NO_UPDATE_CHECK;
    assert.equal(info, null);
    assert.equal(fetchCalls, 0);
  });

  test("skips when CI is set", async () => {
    process.env.CI = "1";
    const { info, fetchCalls } = await run({});
    delete process.env.CI;
    assert.equal(info, null);
    assert.equal(fetchCalls, 0);
  });

  test("never throws (malformed registry payload)", async () => {
    // fetch resolves to an object without a version field → treated as failure
    const { info } = await run({ fetchImpl: () => ({}) });
    assert.equal(info, null);
    assert.equal(readCache().ok, false);
  });
});