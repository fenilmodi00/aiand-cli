import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTestEnv } from "./helpers.mjs";

const { finalizeOnVersionChange } = await import("../dist/housekeeping/finalize.js");
const { VERSION } = await import("../dist/api/client.js");

const env = withTestEnv("aiand-finalize-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
});

const stateFile = () => join(env.dir, "finalize.json");
const writeState = (lastVersion) =>
  writeFileSync(stateFile(), JSON.stringify({ lastVersion }) + "\n");
const readState = () => JSON.parse(readFileSync(stateFile(), "utf8"));

describe("finalizeOnVersionChange", () => {
  test("returns [] when the last recorded version matches", async () => {
    writeState(VERSION);
    const notes = await finalizeOnVersionChange();
    assert.deepEqual(notes, []);
  });

  test("returns changelog notes on a version change and persists lastVersion", async () => {
    writeState("0.0.0");
    const notes = await finalizeOnVersionChange();
    assert.ok(Array.isArray(notes));
    assert.ok(notes.length > 0, "expected " + VERSION + " notes");
    // At least one line comes from the changelog's Fixed/Added sections.
    assert.ok(notes.some((n) => n.startsWith("- ") || n.startsWith("###")));
    assert.equal(readState().lastVersion, VERSION);
  });

  test("is idempotent on a second call", async () => {
    writeState("0.0.0");
    const first = await finalizeOnVersionChange();
    assert.ok(first.length > 0);
    const second = await finalizeOnVersionChange();
    assert.deepEqual(second, []);
  });
});
