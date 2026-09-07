import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;
const originalEnv = { ...process.env };

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-snapshot-test-"));
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_HOME = join(dir, "home");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const snapshot = await import("../dist/agents/snapshot.js");

describe("snapshot round-trip", () => {
  test("restores byte-identical content, deleting files that did not exist", async () => {
    const home = process.env.AIAND_HOME;
    const existing = join(home, ".claude", "settings.json");
    const fresh = join(home, ".codex", "config.toml");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const original = '{"permissions":{"allow":["Bash*"]}}\n';
    writeFileSync(existing, original);

    const snapDir = await snapshot.snapshotFiles("claude", [existing, fresh]);
    assert.ok(snapDir.includes("backups"), "snapshot dir lives under backups");

    // Adapter rewrites both files; `fresh` is created, `existing` mutated.
    writeFileSync(existing, '{"env":{"ANTHROPIC_BASE_URL":"x"}}');
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(fresh, "[model_providers.aiand]\n");

    assert.equal(await snapshot.restoreSnapshot("claude"), true);
    assert.equal(readFileSync(existing, "utf8"), original);
    assert.equal(existsSync(fresh), false, "file created after snapshot is deleted on restore");
  });

  test("hasSnapshot tracks the manifest lifecycle", async () => {
    const home = process.env.AIAND_HOME;
    const file = join(home, "lifecycle.txt");
    writeFileSync(file, "v1\n");

    assert.equal(await snapshot.hasSnapshot("codex"), false);
    await snapshot.snapshotFiles("codex", [file]);
    assert.equal(await snapshot.hasSnapshot("codex"), true);
  });
});

describe("snapshot manifest", () => {
  test("records existed:false for missing files and is mode 0600", async () => {
    const home = process.env.AIAND_HOME;
    const missing = join(home, "never-written.json");
    const manifestPath = join(process.env.AIAND_CONFIG_DIR, "backups", "pi", "latest.json");

    await snapshot.snapshotFiles("pi", [missing]);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].path, missing);
    assert.equal(manifest.files[0].existed, false);
    assert.equal(manifest.files[0].backupPath, undefined);

    const mode = (await import("node:fs")).statSync(manifestPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  test("restore without a manifest returns false, without touching files", async () => {
    assert.equal(await snapshot.restoreSnapshot("nonexistent-agent"), false);
  });
});
