import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  fsCliError,
  jsoncDelete,
  jsoncSet,
  parseJsonc,
  readJsoncObject,
  readTextIfExists,
} from "../dist/agents/managed-file.js";
import { snapshotFiles } from "../dist/agents/snapshot.js";
import { CliError } from "../dist/cli/errors.js";
import { withEnv, withTestEnv } from "./helpers.mjs";

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

  test("readTextIfExists maps a file-as-parent (ENOTDIR) to a CliError", async () => {
    // Fuzz hostile-path (A9): HERMES_HOME pointing at a file made stat throw raw
    // ENOTDIR, surfacing as `Unexpected error` exit 70.
    const blocker = join(box.dir, "blocker");
    writeFileSync(blocker, "in the way\n");
    await assert.rejects(readTextIfExists(join(blocker, ".env")), (error) => {
      assert.equal(error.name, "CliError");
      assert.equal(error.exitCode, 1);
      assert.match(error.message, /not a directory/);
      assert.ok(error.message.includes(join(blocker, ".env")), "names the path");
      assert.match(error.hint ?? "", /Remove or rename/);
      return true;
    });
  });

  test("readTextIfExists maps a directory-as-file (EISDIR) to a CliError", async () => {
    // Fuzz hostile-path (A10): a directory squatting on the .env path made read
    // throw raw EISDIR, surfacing as `Unexpected error` exit 70.
    const dir = join(box.dir, "squatter");
    mkdirSync(dir, { recursive: true });
    await assert.rejects(readTextIfExists(dir), (error) => {
      assert.equal(error.name, "CliError");
      assert.equal(error.exitCode, 1);
      assert.match(error.message, /it is a directory/);
      assert.match(error.hint ?? "", /Remove or rename/);
      return true;
    });
  });

  test("readTextIfExists maps an unreadable file (EACCES) to a CliError", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const locked = join(box.dir, "locked.txt");
    writeFileSync(locked, "secret\n");
    chmodSync(locked, 0o000);
    try {
      await assert.rejects(readTextIfExists(locked), (error) => {
        assert.equal(error.name, "CliError");
        assert.equal(error.exitCode, 1);
        assert.match(error.message, /permission denied/);
        return true;
      });
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  test("fsCliError passes other errors through as null", () => {
    const raw = Object.assign(new Error("boom"), { code: "ENOENT" });
    assert.equal(fsCliError(join(box.dir, "x"), raw), null);
  });

  test("snapshotFiles maps hostile paths to a CliError, never a raw errno", async () => {
    // The same hostile-path class through the snapshot path every `on` takes.
    await withEnv({ AIAND_CONFIG_DIR: join(box.dir, "cfg") }, async () => {
      const blocker = join(box.dir, "snap-blocker");
      writeFileSync(blocker, "in the way\n");
      await assert.rejects(snapshotFiles("managed-file-test", [join(blocker, ".env")]), (error) => {
        assert.equal(error.name, "CliError");
        assert.equal(error.exitCode, 1);
        assert.match(error.message, /not a directory/);
        return true;
      });
    });
  });
});

describe("readJsoncObject", () => {
  test("missing and blank files read as {}", async () => {
    assert.deepEqual(await readJsoncObject(join(box.dir, "absent.json")), {});
    const blank = join(box.dir, "blank.json");
    writeFileSync(blank, "   \n");
    assert.deepEqual(await readJsoncObject(blank), {});
  });

  test("readJsoncObject: a non-object root is the invalid-JSON error, not a silent {}", async () => {
    const models = join(box.dir, "models.json");
    writeFileSync(models, "[1,2]");
    const hint = "Fix it by hand, or delete it and run aiand pi on again.";
    await assert.rejects(
      readJsoncObject(models, hint),
      (error) =>
        error instanceof CliError &&
        error.message === `${models} is not valid JSON.` &&
        error.hint === hint,
    );
  });

  test("scalar roots are the invalid-JSON error too, not a silent {}", async () => {
    // Both shapes parse cleanly but cannot hold the object paths
    // adapters splice, so each must fail at the read the same way.
    for (const text of ['"just a string"', "true"]) {
      const file = join(box.dir, "scalar.json");
      writeFileSync(file, text);
      await assert.rejects(
        readJsoncObject(file, "recover"),
        (error) =>
          error instanceof CliError &&
          error.message === `${file} is not valid JSON.` &&
          error.hint === "recover",
      );
    }
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
