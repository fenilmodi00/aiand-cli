import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../dist/cli/errors.js";
import {
  parseJsonc,
  readJsonOrEmpty,
  readTextIfExists,
  jsoncSet,
  jsoncDelete,
} from "../dist/agents/managed-file.js";

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
  test("parseJsonc strips a UTF-8 BOM before JSON.parse", () => {
    assert.deepEqual(parseJsonc("\uFEFF{\"theme\":\"system\"}"), { theme: "system" });
  });

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

describe("jsonc surgical edit", () => {
  test("jsoncDelete of the last key preserves comments inside the object", () => {
    const original = `{\n  /* keep */\n  "x-aiand": true\n}\n`;
    const removed = jsoncDelete(original, ["x-aiand"]);
    assert.match(removed, /keep/);
    assert.deepEqual(parseJsonc(removed), {});
  });

  test("jsoncSet inserts a key and jsoncDelete removes it, leaving comments and key order", () => {
    const original = `{
  // user comment
  "theme": "dark",
  "keybinds": { "quit": "q" },
}
`;
    const added = jsoncSet(original, ["x-aiand"], true);
    assert.match(added, /user comment/);
    assert.match(added, /"theme": "dark"/);
    assert.equal(parseJsonc(added).theme, "dark");
    assert.equal(parseJsonc(added)["x-aiand"], true);

    const removed = jsoncDelete(added, ["x-aiand"]);
    assert.equal(removed, original);
  });

  test("jsoncSet writes nested provider.aiand without rewriting sibling providers", () => {
    const original = `{
  "provider": {
    "anthropic": { "name": "Anthropic" }
  }
}
`;
    const next = jsoncSet(original, ["provider", "aiand"], { options: { apiKey: "sk-x" } });
    const parsed = parseJsonc(next);
    assert.equal(parsed.provider.anthropic.name, "Anthropic");
    assert.equal(parsed.provider.aiand.options.apiKey, "sk-x");
    assert.match(next, /Anthropic/);

    const stripped = jsoncDelete(next, ["provider", "aiand"]);
    assert.equal(parseJsonc(stripped).provider.anthropic.name, "Anthropic");
    assert.equal(parseJsonc(stripped).provider.aiand, undefined);
    assert.match(stripped, /Anthropic/);
  });

  test("jsoncSet on empty text creates an object; jsoncDelete of the last key leaves {}", () => {
    const created = jsoncSet("", ["model"], "aiand/glm");
    assert.equal(parseJsonc(created).model, "aiand/glm");
    const empty = jsoncDelete(created, ["model"]);
    assert.deepEqual(parseJsonc(empty), {});
  });

  test("jsoncSet and jsoncDelete on a BOM'd object keep editing (no raw SyntaxError)", () => {
    const original = "\uFEFF{\n  \"theme\": \"system\"\n}\n";
    const added = jsoncSet(original, ["x-aiand"], true);
    assert.equal(added.startsWith("\uFEFF"), true);
    assert.equal(parseJsonc(added).theme, "system");
    assert.equal(parseJsonc(added)["x-aiand"], true);
    const removed = jsoncDelete(added, ["x-aiand"]);
    assert.equal(removed, original);
  });

});

describe("jsoncSet layout", () => {
  test("insert keeps normal JSON layout and deletes byte-identically, both comma styles", () => {
    const files = [
      `{\n  "theme": "dark"\n}\n`, // no trailing comma
      `{\n  "theme": "dark",\n}\n`, // trailing comma
    ];
    for (const text of files) {
      const set = jsoncSet(text, ["x-aiand"], true);
      // Normal layout: comma on the prior line, brace on its own line.
      assert.ok(set.includes(`"theme": "dark",\n  "x-aiand"`), set);
      assert.ok(!set.includes("\n,"), `comma on its own line in: ${set}`);
      // And deleting what we added restores the original bytes.
      assert.equal(jsoncDelete(set, ["x-aiand"]), text);
    }
  });
});
