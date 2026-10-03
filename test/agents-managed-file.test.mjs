import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  jsoncDelete,
  jsoncSet,
  parseJsonc,
  readJsoncObject,
  readTextIfExists,
} from "../dist/agents/managed-file.js";
import { withTestEnv } from "./helpers.mjs";

// Pure file helpers: only a scratch dir, no env to isolate.
const box = withTestEnv("aiand-managed-file-test-", () => {});

describe("managed-file read side", () => {
  test("readTextIfExists returns empty string for a missing file and text otherwise", async () => {
    const missing = join(box.dir, "nope.txt");
    assert.equal(await readTextIfExists(missing), "");

    const present = join(box.dir, "hi.txt");
    writeFileSync(present, "hello\n");
    assert.equal(await readTextIfExists(present), "hello\n");
  });

  test("readJsoncObject refuses a JSON-array root, never coerces it to {}", async () => {
    // An array root reaching jsoncSet would splice into array text —
    // the same mid-write crash class as invalid JSON (#18 round-2).
    const file = join(box.dir, "array-root.json");
    writeFileSync(file, '[{"a":1}]');
    await assert.rejects(readJsoncObject(file), /is not valid JSON/);
    writeFileSync(file, '"scalar"');
    await assert.rejects(readJsoncObject(file), /is not valid JSON/);
  });
});
describe("parseJsonc", () => {
  test("parseJsonc strips a UTF-8 BOM before JSON.parse", () => {
    assert.deepEqual(parseJsonc('\uFEFF{"theme":"system"}'), { theme: "system" });
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
  test("jsoncSet into comment-only object keeps interior comments", () => {
    const original = `{\n  /* keep */\n}\n`;
    const added = jsoncSet(original, ["x-aiand"], true);
    assert.match(added, /keep/);
    assert.equal(parseJsonc(added)["x-aiand"], true);
  });

  test("jsoncSet and jsoncDelete on a BOM'd object keep editing (no raw SyntaxError)", () => {
    const original = '\uFEFF{\n  "theme": "system"\n}\n';
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
