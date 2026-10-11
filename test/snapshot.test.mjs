import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";

import { withTestEnv } from "./helpers.mjs";

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

    if (process.platform !== "win32") {
      assert.equal(statSync(manifestPath).mode & 0o777, 0o600);
    }
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

  test("restore refuses a path that is not a managed file", async () => {
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
    await assert.rejects(
      () => snapshot.restoreSnapshot("opencode", [managed]),
      (error) =>
        error instanceof CliError &&
        error.name === "CliError" &&
        error.exitCode !== 70 &&
        /not a managed file/.test(error.message) &&
        Boolean(error.hint),
    );
    assert.equal(readFileSync(evil, "utf8"), "untouched\n");
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
    assert.equal(statSync(existing).mode & 0o777, 0o644);
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
