import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { withTestEnv } from "./helpers.mjs";

const { hasPlayedWelcome, markWelcomePlayed } = await import("../dist/housekeeping/welcome.js");

const env = withTestEnv("aiand-welcome-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
});

const stateFile = () => join(env.dir, "welcome.json");
const readState = () => JSON.parse(readFileSync(stateFile(), "utf8"));

describe("welcome marker", () => {
  test("a fresh install has not played the splash", () => {
    assert.equal(hasPlayedWelcome(), false);
  });

  test("the flag reads back from disk", () => {
    writeFileSync(stateFile(), `${JSON.stringify({ welcomed: true })}\n`);
    assert.equal(hasPlayedWelcome(), true);
  });

  test("a malformed file reads as not-played, not a throw", () => {
    writeFileSync(stateFile(), "{not json");
    assert.equal(hasPlayedWelcome(), false);
  });

  test("a missing field reads as not-played", () => {
    writeFileSync(stateFile(), `${JSON.stringify({ other: 1 })}\n`);
    assert.equal(hasPlayedWelcome(), false);
  });

  test("markWelcomePlayed persists the flag", async () => {
    await markWelcomePlayed();
    assert.deepEqual(readState(), { welcomed: true });
    assert.equal(hasPlayedWelcome(), true);
  });
});
