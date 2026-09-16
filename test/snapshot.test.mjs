import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-snapshot-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_HOME = join(dir, "home");
});

const snapshot = await import("../dist/agents/snapshot.js");

describe("snapshot round-trip", () => {
  test("restores byte-identical content, deleting files that did not exist", async () => {
    const home = process.env.AIAND_HOME;
    const existing = join(home, ".config", "opencode", "opencode.json");
    const fresh = join(home, ".config", "opencode", "extra.json");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const original = '{"theme":"dark"}\n';
    writeFileSync(existing, original);

    const snapDir = await snapshot.snapshotFiles("opencode", [existing, fresh]);
    assert.ok(snapDir.includes("backups"), "snapshot dir lives under backups");

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
    const manifestPath = join(process.env.AIAND_CONFIG_DIR, "backups", "opencode", "latest.json");

    await snapshot.snapshotFiles("opencode", [missing]);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].path, missing);
    assert.equal(manifest.files[0].existed, false);
    assert.equal(manifest.files[0].backupPath, undefined);

    const mode = statSync(manifestPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  test("restore without a manifest returns false, without touching files", async () => {
    assert.equal(await snapshot.restoreSnapshot("nonexistent-agent"), false);
  });

  test("restore refuses a path that is not a managed file", async () => {
    const home = process.env.AIAND_HOME;
    const managed = join(home, "managed.json");
    const evil = join(home, "evil.json");
    writeFileSync(managed, "keep\n");
    writeFileSync(evil, "untouched\n");
    await snapshot.snapshotFiles("opencode", [managed]);
    const manifestPath = join(process.env.AIAND_CONFIG_DIR, "backups", "opencode", "latest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files.push({ path: evil, existed: true, backupPath: manifest.files[0].backupPath });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    await assert.rejects(
      () => snapshot.restoreSnapshot("opencode", [managed]),
      /not a managed file/
    );
    assert.equal(readFileSync(evil, "utf8"), "untouched\n");
  });
});
