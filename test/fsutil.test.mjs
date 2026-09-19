import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configDir, writeFileAtomic } from "../dist/fsutil.js";

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-fsutil-test-"));
  // configDir() must point inside the sandbox: the "chmod under configDir"
  // test writes through the real configDir() and must never touch ~/.config/aiand.
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  test("writes through a symlink instead of replacing the link", async () => {
    const sandbox = mkdtempSync(join(dir, "link-"));
    const real = join(sandbox, "real.json");
    const link = join(sandbox, "link.json");
    writeFileSync(real, '{"old":true}\n');
    symlinkSync(real, link);

    const next = '{"new":true}\n';
    await writeFileAtomic(link, next, { mode: 0o600 });

    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(link, "utf8"), next);
    assert.equal(readFileSync(real, "utf8"), next);
    assert.deepEqual(
      readdirSync(sandbox).filter((name) => name.endsWith(".tmp")),
      []
    );
  });

  test("writes a plain path and preserves an existing file's mode", async () => {
    const sandbox = mkdtempSync(join(dir, "plain-"));
    const target = join(sandbox, "config.json");
    writeFileSync(target, '{"old":true}\n');
    chmodSync(target, 0o640);

    const next = '{"new":true}\n';
    await writeFileAtomic(target, next);
    assert.equal(readFileSync(target, "utf8"), next);
    assert.equal(statSync(target).mode & 0o777, 0o640);
    assert.deepEqual(
      readdirSync(sandbox).filter((name) => name.endsWith(".tmp")),
      []
    );
  });

  test("writes through a relative symlink", async () => {
    const sandbox = mkdtempSync(join(dir, "rel-"));
    const real = join(sandbox, "real.json");
    const link = join(sandbox, "link.json");
    writeFileSync(real, '{"old":true}\n');
    symlinkSync("real.json", link);

    const next = '{"new":true}\n';
    await writeFileAtomic(link, next, { mode: 0o600 });
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(real, "utf8"), next);
  });

  test("does not chmod third-party parent directories", async () => {
    const thirdParty = mkdtempSync(join(dir, "third-party-"));
    chmodSync(thirdParty, 0o755);
    const target = join(thirdParty, "nested", "config.json");
    await writeFileAtomic(target, '{"ok":true}\n', { mode: 0o600 });
    assert.equal(statSync(thirdParty).mode & 0o777, 0o755);
    assert.equal(readFileSync(target, "utf8"), '{"ok":true}\n');
  });

  test("chmod 0700 parents under configDir", async () => {
    const cfgRoot = configDir();
    const nested = join(cfgRoot, "profiles", "nested");
    mkdirSync(nested, { recursive: true, mode: 0o755 });
    chmodSync(nested, 0o755);
    const target = join(nested, "state.json");
    await writeFileAtomic(target, '{"ok":true}\n', { mode: 0o600 });
    assert.equal(statSync(nested).mode & 0o777, 0o700);
    assert.equal(readFileSync(target, "utf8"), '{"ok":true}\n');
  });

  test("does not chmod symlinked-outside parent directories under configDir", async () => {
    if (process.platform === "win32") return;
    const cfgRoot = configDir();
    mkdirSync(cfgRoot, { recursive: true });
    const outside = mkdtempSync(join(dir, "outside-"));
    chmodSync(outside, 0o755);
    const linkPath = join(cfgRoot, "outside-link");
    try {
      symlinkSync(outside, linkPath);
    } catch {
      return;
    }
    const target = join(linkPath, "nested", "config.json");
    await writeFileAtomic(target, '{"ok":true}\n', { mode: 0o600 });
    assert.equal(statSync(outside).mode & 0o777, 0o755);
    assert.equal(readFileSync(target, "utf8"), '{"ok":true}\n');
  });

  test("replaces a broken symlink with a regular file", async () => {
    const sandbox = mkdtempSync(join(dir, "broken-"));
    const link = join(sandbox, "link.json");
    symlinkSync(join(sandbox, "missing.json"), link);

    const next = '{"new":true}\n';
    await writeFileAtomic(link, next, { mode: 0o600 });
    assert.equal(lstatSync(link).isSymbolicLink(), false);
    assert.equal(readFileSync(link, "utf8"), next);
  });
});
