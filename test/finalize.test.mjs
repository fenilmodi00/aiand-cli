import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { finalizeOnVersionChange } = await import("../dist/system/finalize.js");
const { VERSION } = await import("../dist/api/client.js");

describe("finalizeOnVersionChange", () => {
  let dir;
  const originalEnv = { ...process.env };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aiand-finalize-"));
    process.env.AIAND_CONFIG_DIR = dir;
  });
  after(() => {
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  const stateFile = () => join(dir, "finalize.json");
  const writeState = (lastVersion) =>
    writeFileSync(stateFile(), JSON.stringify({ lastVersion }) + "\n");
  const readState = () => JSON.parse(readFileSync(stateFile(), "utf8"));

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

  test("a throwing migration is caught into a note and never aborts", async () => {
    writeState("0.0.0");
    const notes = await finalizeOnVersionChange({
      migrations: [
        {
          id: "boom",
          run: async () => {
            throw new Error("migration exploded");
          },
        },
      ],
    });
    assert.ok(
      notes.some((n) => n.includes("boom") && n.includes("failed")),
      "expected a failure note, got: " + JSON.stringify(notes)
    );
    // The failure did not prevent persisting the new version.
    assert.equal(readState().lastVersion, VERSION);
  });

  test("a successful migration's note is surfaced alongside the changelog", async () => {
    writeState("0.0.0");
    const notes = await finalizeOnVersionChange({
      migrations: [
        {
          id: "greeting",
          run: async () => "config shape upgraded",
        },
      ],
    });
    assert.ok(notes.includes("config shape upgraded"));
  });
});