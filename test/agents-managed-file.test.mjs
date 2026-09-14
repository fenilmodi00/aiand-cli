import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../dist/cli/errors.js";
import { parseJsonc, readJsonOrEmpty, readTextIfExists } from "../dist/agents/managed-file.js";

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
      readJsonOrEmpty(broken, "opencode"),
      (error) =>
        error instanceof CliError &&
        error.name === "CliError" &&
        /broken\.json is not valid JSON\./.test(error.message) &&
        /delete it and run aiand opencode on again/.test(error.hint ?? "")
    );
  });

  test("readJsonOrEmpty with `what` formats the fix-by-hand hint for that file", async () => {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ nope");
    await assert.rejects(
      readJsonOrEmpty(broken, "opencode", "opencode.json"),
      (error) =>
        error instanceof CliError &&
        /Fix opencode\.json by hand, or delete it and run aiand opencode on again/.test(
          error.hint ?? ""
        )
    );
  });
});

describe("parseJsonc", () => {
  test("keeps ,} and ,] sequences inside string values", () => {
    // Global trailing-comma regex would corrupt these; the scan must be
    // string-aware the same way comment stripping is.
    assert.deepEqual(parseJsonc('{"pattern":",}","other":",]"}'), {
      pattern: ",}",
      other: ",]",
    });
  });

  test("strips trailing commas after comments", () => {
    assert.deepEqual(parseJsonc('{\n  "a": 1, // keep\n  "b": [2,],\n}\n'), {
      a: 1,
      b: [2],
    });
  });

  test("unclosed block comment yields SyntaxError from JSON.parse", () => {
    assert.throws(() => parseJsonc('{ "a": 1 /* never closed'), SyntaxError);
  });

  test("trailing unterminated block comment is rejected, not swallowed", () => {
    assert.throws(() => parseJsonc('{"theme":"system"} /*'), SyntaxError);
  });
});
