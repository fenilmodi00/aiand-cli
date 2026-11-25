import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";

import { assertMode, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-snapshot-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_HOME = join(dir, "home");
  mkdirSync(join(dir, "cfg"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
});

const snapshot = await import("../dist/agents/snapshot.js");
const { CliError } = await import("../dist/cli/errors.js");

describe("snapshot round-trip", () => {
  test("restores byte-identical content, deleting files that did not exist", async () => {
    const home = process.env.AIAND_HOME;
    const existing = join(home, ".config", "opencode", "opencode.json");
    const fresh = join(home, ".config", "opencode", "extra.json");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const original = '{"theme":"dark"}\n';
    writeFileSync(existing, original);

    const snapDir = await snapshot.snapshotFiles("opencode", [existing, fresh]);
    assert.ok(snapDir.includes("snapshots"), "snapshot dir lives under snapshots");

    // Adapter rewrites both files; `fresh` is created, `existing` mutated.
    writeFileSync(existing, '{"provider":{"aiand":{}}}');
    writeFileSync(fresh, "{}\n");

    assert.equal(await snapshot.restoreSnapshot("opencode", [existing, fresh]), true);
    assert.equal(readFileSync(existing, "utf8"), original);
    assert.equal(existsSync(fresh), false, "file created after snapshot is deleted on restore");
  });

  test("hasSnapshot tracks the manifest lifecycle", async () => {
    const home = process.env.AIAND_HOME;
    const file = join(home, "lifecycle.txt");
    writeFileSync(file, "v1\n");

    assert.equal(await snapshot.hasSnapshot("opencode-fixture"), false);
    await snapshot.snapshotFiles("opencode-fixture", [file]);
    assert.equal(await snapshot.hasSnapshot("opencode-fixture"), true);
  });
});

describe("snapshot manifest", () => {
  test("records existed:false for missing files and is mode 0600", async () => {
    const home = process.env.AIAND_HOME;
    const missing = join(home, "never-written.json");
    const manifestPath = join(process.env.AIAND_CONFIG_DIR, "snapshots", "opencode", "latest.json");

    await snapshot.snapshotFiles("opencode", [missing]);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].path, missing);
    assert.equal(manifest.files[0].existed, false);
    assert.equal(manifest.files[0].backupPath, undefined);

    assertMode(manifestPath, 0o600);
  });

  test("restore without a manifest returns false, without touching files", async () => {
    assert.equal(await snapshot.restoreSnapshot("nonexistent-agent"), false);
  });

  test("discardSnapshot removes a manifest and backup copies", async () => {
    const home = process.env.AIAND_HOME;
    const file = join(home, "discard-me.json");
    writeFileSync(file, "original\n");
    await snapshot.snapshotFiles("discard-agent", [file]);
    assert.equal(await snapshot.hasSnapshot("discard-agent"), true);
    await snapshot.discardSnapshot("discard-agent");
    assert.equal(await snapshot.hasSnapshot("discard-agent"), false);
  });

  test("restore never writes a path that is not a managed file, and keeps its entry", async () => {
    const home = process.env.AIAND_HOME;
    const managed = join(home, "managed.json");
    const evil = join(home, "evil.json");
    writeFileSync(managed, "keep\n");
    writeFileSync(evil, "untouched\n");
    await snapshot.snapshotFiles("opencode", [managed]);
    const manifestPath = join(process.env.AIAND_CONFIG_DIR, "snapshots", "opencode", "latest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files.push({ path: evil, existed: true, backupPath: manifest.files[0].backupPath });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(managed, "changed\n");
    const skipped = [];
    assert.equal(
      await snapshot.restoreSnapshot("opencode", [managed], (path, reason) =>
        skipped.push([path, reason]),
      ),
      true,
    );
    assert.equal(readFileSync(evil, "utf8"), "untouched\n");
    assert.equal(readFileSync(managed, "utf8"), "keep\n");
    assert.deepEqual(skipped, [[evil, "unmanaged"]]);
    // The unmanaged entry stays for a shell that manages it; nothing else does.
    const left = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(
      left.files.map((entry) => entry.path),
      [evil],
    );
  });

  describe("added-state across a partial restore", () => {
    /** `agent` snapshotted over a managed file and one in a dir it no longer reads. */
    async function partial(agent, movedText) {
      const home = process.env.AIAND_HOME;
      const managed = join(home, `${agent}-managed.json`);
      const moved = join(home, `${agent}-moved.json`);
      writeFileSync(managed, "keep\n");
      writeFileSync(moved, movedText);
      await snapshot.snapshotFiles(agent, [managed, moved]);
      await snapshot.recordAddedState(agent, { wroteBaseUrl: "https://x/v1" });
      const addedPath = join(process.env.AIAND_CONFIG_DIR, "snapshots", agent, "added.json");
      return { managed, addedPath };
    }
    const marker = (text) => text.includes('"x-aiand"');

    test("restore keeps the record while a kept path is still wired", async () => {
      const { managed, addedPath } = await partial("keeps-record", '{"x-aiand":true}\n');
      assert.equal(
        await snapshot.restoreSnapshot("keeps-record", [managed], undefined, marker),
        true,
      );
      assert.equal(existsSync(addedPath), true, "off from the moved dir still needs it");
      assert.deepEqual(await snapshot.getAddedState("keeps-record"), {
        wroteBaseUrl: "https://x/v1",
      });
    });

    test("restore drops the record when no kept path is wired", async () => {
      const { managed, addedPath } = await partial("drops-record", "{}\n");
      assert.equal(
        await snapshot.restoreSnapshot("drops-record", [managed], undefined, marker),
        true,
      );
      assert.equal(existsSync(addedPath), false);
    });
  });

  test("restore refuses a copy source outside the snapshot directory", async () => {
    const home = process.env.AIAND_HOME;
    const managed = join(home, "managed-outside.json");
    const outside = join(home, "outside-copy.json");
    writeFileSync(managed, "keep\n");
    writeFileSync(outside, "payload\n");
    await snapshot.snapshotFiles("opencode", [managed]);
    const manifestPath = join(process.env.AIAND_CONFIG_DIR, "snapshots", "opencode", "latest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files[0].backupPath = outside;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      () => snapshot.restoreSnapshot("opencode", [managed]),
      (error) =>
        error instanceof CliError &&
        error.name === "CliError" &&
        error.exitCode !== 70 &&
        /outside the snapshot directory/.test(error.message),
    );
    assert.equal(readFileSync(managed, "utf8"), "keep\n");
  });

  test("restore --force puts the original file mode back", async () => {
    if (process.platform === "win32") return;
    const home = process.env.AIAND_HOME;
    const existing = join(home, ".config", "opencode", "mode.json");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(existing, '{"theme":"dark"}\n');
    chmodSync(existing, 0o644);
    await snapshot.snapshotFiles("opencode", [existing]);
    writeFileSync(existing, '{"provider":{"aiand":{}}}\n');
    chmodSync(existing, 0o600);
    assert.equal(await snapshot.restoreSnapshot("opencode", [existing]), true);
    assert.equal(readFileSync(existing, "utf8"), '{"theme":"dark"}\n');
    assertMode(existing, 0o644);
  });
});

describe("corrupt snapshot", () => {
  function plantCorruptBackup(agentId, name) {
    const dir = join(process.env.AIAND_CONFIG_DIR, "snapshots", agentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), "{oops");
    return dir;
  }

  function assertCorruptSnapshotError(agentId, file) {
    return (error) =>
      error instanceof CliError &&
      error.name === "CliError" &&
      !(error instanceof SyntaxError) &&
      new RegExp(`${file} is not valid JSON\\.`).test(error.message) &&
      (error.hint ?? "").includes(join("snapshots", agentId));
  }

  test("hasSnapshot on a corrupt latest.json rejects with CliError, not SyntaxError", async () => {
    plantCorruptBackup("corrupt-manifest", "latest.json");
    await assert.rejects(
      () => snapshot.hasSnapshot("corrupt-manifest"),
      assertCorruptSnapshotError("corrupt-manifest", "latest\\.json"),
    );
  });

  test("restoreSnapshot on a corrupt latest.json rejects with CliError", async () => {
    plantCorruptBackup("corrupt-restore", "latest.json");
    await assert.rejects(
      () => snapshot.restoreSnapshot("corrupt-restore", []),
      assertCorruptSnapshotError("corrupt-restore", "latest\\.json"),
    );
  });

  test("getAddedState on a corrupt added.json rejects with CliError", async () => {
    plantCorruptBackup("corrupt-added", "added.json");
    await assert.rejects(
      () => snapshot.getAddedState("corrupt-added"),
      assertCorruptSnapshotError("corrupt-added", "added\\.json"),
    );
  });

  test("getAddedState rejects a record that is not an object", async () => {
    const dir = join(process.env.AIAND_CONFIG_DIR, "snapshots", "not-object");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "added.json"), "[1, 2]");
    await assert.rejects(snapshot.getAddedState("not-object"), CliError);
    assert.equal(snapshot.getAddedStateSync("not-object"), null);
  });

  test("a valid snapshot still restores byte-for-byte alongside corrupt ones", async () => {
    const home = process.env.AIAND_HOME;
    const file = join(home, "valid-beside-corrupt.txt");
    const original = "pristine\n";
    writeFileSync(file, original);
    await snapshot.snapshotFiles("valid-beside-corrupt", [file]);
    writeFileSync(file, "mutated\n");
    assert.equal(await snapshot.restoreSnapshot("valid-beside-corrupt", [file]), true);
    assert.equal(readFileSync(file, "utf8"), original);
  });
});

describe("snapshotCovers", () => {
  test("is true only for a snapshot of exactly these files", async () => {
    const home = process.env.AIAND_HOME;
    const a = join(home, "covers", "a.json");
    const b = join(home, "covers", "b.json");
    assert.equal(await snapshot.snapshotCovers("covers", [a]), false, "no snapshot yet");
    await snapshot.snapshotFiles("covers", [a]);
    assert.equal(await snapshot.snapshotCovers("covers", [a]), true);
    assert.equal(await snapshot.snapshotCovers("covers", [b]), false);
    assert.equal(await snapshot.snapshotCovers("covers", [a, b]), false);
  });
});

describe("snapshot key hygiene", () => {
  const KEY = "sk-hygiene-key";

  test("a file already holding a known key is recorded without a copy", async () => {
    const home = process.env.AIAND_HOME;
    const wired = join(home, "hygiene", "auth.json");
    const clean = join(home, "hygiene", "settings.json");
    mkdirSync(join(home, "hygiene"), { recursive: true });
    writeFileSync(wired, `{"aiand":{"key":"${KEY}"}}\n`);
    writeFileSync(clean, '{"theme":"dark"}\n');
    const snapDir = await snapshot.snapshotFiles("hygiene", [wired, clean], { keys: [KEY] });
    const manifest = JSON.parse(
      readFileSync(
        join(process.env.AIAND_CONFIG_DIR, "snapshots", "hygiene", "latest.json"),
        "utf8",
      ),
    );
    assert.deepEqual(manifest.files[0], { path: wired, existed: true, wired: true });
    assert.ok(manifest.files[1].backupPath);
    for (const name of readdirSync(snapDir)) {
      assert.ok(!readFileSync(join(snapDir, name), "utf8").includes(KEY));
    }
    // Restore leaves the wired file alone and says so.
    const skipped = [];
    await snapshot.restoreSnapshot("hygiene", [wired, clean], (path, reason) =>
      skipped.push([path, reason]),
    );
    assert.deepEqual(skipped, [[wired, "wired"]]);
  });

  test("restore keeps the record while a skipped wired file still holds ai& wiring", async () => {
    const home = process.env.AIAND_HOME;
    const wired = join(home, "wired-skip", "providers.json");
    mkdirSync(join(home, "wired-skip"), { recursive: true });
    writeFileSync(wired, `{"aiand":{"key":"${KEY}"}}\n`);
    await snapshot.snapshotFiles("wired-skip", [wired], { keys: [KEY] });
    await snapshot.recordAddedState("wired-skip", { wroteBaseUrl: "https://other/v1" });
    const addedPath = join(process.env.AIAND_CONFIG_DIR, "snapshots", "wired-skip", "added.json");
    const holdsKey = (text) => text.includes(KEY);

    const skipped = [];
    await snapshot.restoreSnapshot(
      "wired-skip",
      [wired],
      (path, reason) => skipped.push([path, reason]),
      holdsKey,
    );
    assert.deepEqual(skipped, [[wired, "wired"]]);
    assert.equal(existsSync(addedPath), true, "a later off still needs to find what on wrote");
    assert.deepEqual(await snapshot.getAddedState("wired-skip"), {
      wroteBaseUrl: "https://other/v1",
    });

    // Once the file no longer holds the wiring, the next restore finishes the cleanup.
    writeFileSync(wired, "{}\n");
    await snapshot.restoreSnapshot("wired-skip", [wired], undefined, holdsKey);
    assert.equal(existsSync(addedPath), false);
  });

  test("the adapter's marker check also keeps a file out of the snapshot", async () => {
    const home = process.env.AIAND_HOME;
    const file = join(home, "marked.json");
    writeFileSync(file, '{"x-aiand":true}\n');
    await snapshot.snapshotFiles("marked", [file], {
      carriesWiring: (text) => text.includes("x-aiand"),
    });
    const manifest = JSON.parse(
      readFileSync(
        join(process.env.AIAND_CONFIG_DIR, "snapshots", "marked", "latest.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.files[0].wired, true);
    assert.equal(manifest.files[0].backupPath, undefined);
  });

  test("extendSnapshot keeps the first capture and adds only new paths", async () => {
    const home = process.env.AIAND_HOME;
    const first = join(home, "extend", "a.json");
    const moved = join(home, "extend", "b.json");
    mkdirSync(join(home, "extend"), { recursive: true });
    writeFileSync(first, "pre-aiand\n");
    assert.equal(await snapshot.extendSnapshot("extend", [first]), true, "creates");
    writeFileSync(first, `wired ${KEY}\n`);
    writeFileSync(moved, "moved pre-aiand\n");
    assert.equal(
      await snapshot.extendSnapshot("extend", [moved, first], { keys: [KEY] }),
      false,
      "extends",
    );
    writeFileSync(moved, "changed\n");
    assert.equal(await snapshot.restoreSnapshot("extend", [first, moved]), true);
    assert.equal(readFileSync(first, "utf8"), "pre-aiand\n");
    assert.equal(readFileSync(moved, "utf8"), "moved pre-aiand\n");
  });

  test("extendSnapshot retries a wired entry once the file is clean", async () => {
    const home = process.env.AIAND_HOME;
    const file = join(home, "retry.json");
    writeFileSync(file, `${KEY}\n`);
    await snapshot.extendSnapshot("retry", [file], { keys: [KEY] });
    assert.equal(await snapshot.snapshotCovers("retry", [file]), false, "wired never covers");
    writeFileSync(file, "clean\n");
    await snapshot.extendSnapshot("retry", [file], { keys: [KEY] });
    assert.equal(await snapshot.snapshotCovers("retry", [file]), true);
    writeFileSync(file, "later\n");
    await snapshot.restoreSnapshot("retry", [file]);
    assert.equal(readFileSync(file, "utf8"), "clean\n");
  });

  test("scrubSnapshotKeys deletes copies holding a key and marks their entries", async () => {
    const home = process.env.AIAND_HOME;
    const leaky = join(home, "scrub", "leaky.json");
    const clean = join(home, "scrub", "clean.json");
    mkdirSync(join(home, "scrub"), { recursive: true });
    writeFileSync(leaky, `{"key":"${KEY}"}\n`);
    writeFileSync(clean, "{}\n");
    // A snapshot from before the guard: the copy holds the key.
    await snapshot.snapshotFiles("scrub", [leaky, clean]);
    const removed = await snapshot.scrubSnapshotKeys([KEY]);
    assert.equal(removed.length, 1);
    assert.equal(existsSync(removed[0]), false);
    const manifest = JSON.parse(
      readFileSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "scrub", "latest.json"), "utf8"),
    );
    assert.deepEqual(manifest.files[0], { path: leaky, existed: true, wired: true });
    assert.ok(manifest.files[1].backupPath, "a clean copy stays");
    assert.deepEqual(await snapshot.scrubSnapshotKeys([KEY]), [], "idempotent");
  });

  test("scrubSnapshotKeys also deletes a copy that carries the adapter's marker, whatever key it holds", async () => {
    const home = process.env.AIAND_HOME;
    const wired = join(home, "scrub-marker", "wired.json");
    const plain = join(home, "scrub-marker", "plain.json");
    mkdirSync(join(home, "scrub-marker"), { recursive: true });
    // Wired with some earlier key: nothing here matches the key logging out.
    writeFileSync(wired, '{"x-aiand":true,"key":"sk-older-1"}\n');
    writeFileSync(plain, "{}\n");
    await snapshot.snapshotFiles("scrub-marker", [wired, plain]);

    assert.deepEqual(await snapshot.scrubSnapshotKeys([KEY]), [], "the key alone misses it");
    const marker = (agentId) =>
      agentId === "scrub-marker" ? (text) => text.includes('"x-aiand"') : undefined;
    const removed = await snapshot.scrubSnapshotKeys([KEY], marker);
    assert.equal(removed.length, 1);
    const manifest = JSON.parse(
      readFileSync(
        join(process.env.AIAND_CONFIG_DIR, "snapshots", "scrub-marker", "latest.json"),
        "utf8",
      ),
    );
    assert.deepEqual(manifest.files[0], { path: wired, existed: true, wired: true });
    assert.ok(manifest.files[1].backupPath, "a clean copy stays");
  });

  test("scrubSnapshotKeys with no snapshots dir is a no-op", async () => {
    const prev = process.env.AIAND_CONFIG_DIR;
    process.env.AIAND_CONFIG_DIR = join(process.env.AIAND_HOME, "no-config-here");
    try {
      assert.deepEqual(await snapshot.scrubSnapshotKeys([KEY]), []);
    } finally {
      process.env.AIAND_CONFIG_DIR = prev;
    }
  });
});
