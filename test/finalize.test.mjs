import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { withTestEnv } from "./helpers.mjs";

const { finalizeOnVersionChange } = await import("../dist/housekeeping/finalize.js");
const { VERSION } = await import("../dist/api/client.js");

const env = withTestEnv("aiand-finalize-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
});

const stateFile = () => join(env.dir, "finalize.json");
const writeState = (lastVersion) =>
  writeFileSync(stateFile(), `${JSON.stringify({ lastVersion })}\n`);
const readState = () => JSON.parse(readFileSync(stateFile(), "utf8"));

describe("finalizeOnVersionChange", () => {
  test("returns [] when the last recorded version matches", async () => {
    writeState(VERSION);
    const notes = await finalizeOnVersionChange();
    assert.deepEqual(notes, []);
  });

  test("returns one release-notes link on a version change and persists lastVersion", async () => {
    writeState("0.0.0");
    const notes = await finalizeOnVersionChange();
    assert.deepEqual(notes, [
      `What's new in v${VERSION}: https://github.com/aiandlabs/aiand-cli/releases/tag/v${VERSION}`,
    ]);
    assert.equal(readState().lastVersion, VERSION);
  });

  test("is idempotent on a second call", async () => {
    writeState("0.0.0");
    const first = await finalizeOnVersionChange();
    assert.deepEqual(first, [
      `What's new in v${VERSION}: https://github.com/aiandlabs/aiand-cli/releases/tag/v${VERSION}`,
    ]);
    const second = await finalizeOnVersionChange();
    assert.deepEqual(second, []);
  });

  test("first install records the version and prints no notes", async () => {
    try {
      unlinkSync(stateFile());
    } catch {
      /* no prior state */
    }
    const notes = await finalizeOnVersionChange();
    assert.deepEqual(notes, []);
    assert.equal(readState().lastVersion, VERSION);
  });
});
