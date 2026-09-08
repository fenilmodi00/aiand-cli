import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../dist/cli/errors.js";
import { deepEqual, readJsonOrEmpty, readTextIfExists } from "../dist/agents/managed-file.js";

let dir;
const originalEnv = { ...process.env };

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-managed-file-test-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

describe("managed-file read side", () => {
  test("readTextIfExists returns empty string for a missing file and text otherwise", async () => {
    const missing = join(dir, "nope.txt");
    assert.equal(await readTextIfExists(missing), "");

    const present = join(dir, "hi.txt");
    writeFileSync(present, "hello\n");
    assert.equal(await readTextIfExists(present), "hello\n");
  });

  test("readJsonOrEmpty returns {} for a missing file", async () => {
    assert.deepEqual(await readJsonOrEmpty(join(dir, "missing.json"), "agent"), {});
  });

  test("readJsonOrEmpty coerces top-level non-object JSON (array/scalar) to {} so enable can't wedge", async () => {
    const arrayPath = join(dir, "array.json");
    writeFileSync(arrayPath, "[1, 2, 3]");
    assert.deepEqual(await readJsonOrEmpty(arrayPath, "agent"), {});

    const scalarPath = join(dir, "scalar.json");
    writeFileSync(scalarPath, "42");
    assert.deepEqual(await readJsonOrEmpty(scalarPath, "agent"), {});
  });

  test("readJsonOrEmpty turns invalid JSON into a CliError naming the file with the agent hint", async () => {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    await assert.rejects(
      readJsonOrEmpty(broken, "claude"),
      (error) =>
        error instanceof CliError &&
        error.name === "CliError" &&
        /broken\.json is not valid JSON\./.test(error.message) &&
        /delete it and run aiand claude on again/.test(error.hint ?? "")
    );
  });

  test("readJsonOrEmpty with `what` formats the fix-by-hand hint for that file", async () => {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ nope");
    await assert.rejects(
      readJsonOrEmpty(broken, "pi", "auth.json"),
      (error) =>
        error instanceof CliError &&
        /Fix auth\.json by hand, or delete it and run aiand pi on again/.test(
          error.hint ?? ""
        )
    );
  });

  test("deepEqual ignores key order and compares arrays positionally", () => {
    assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
    assert.equal(deepEqual([1, 2], [1, 2]), true);
    assert.equal(deepEqual([1, 2], [2, 1]), false);
    assert.equal(deepEqual({ a: [1, 2] }, { a: [1, 2] }), true);
    assert.equal(deepEqual({ a: 1 }, { a: 2 }), false);
    assert.equal(deepEqual(null, null), true);
    assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  });
});