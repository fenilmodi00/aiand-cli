import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  chmodSync,
  lstatSync,
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

import { writeFileAtomic } from "../dist/fsutil.js";

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-fsutil-test-"));
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
