import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { catalogModel } from "./helpers.mjs";

const { launchDefault, putBackStep } = await import("../dist/agents/claude/put-back.js");

const AIAND = "zai-org/glm-5.3";
const CATALOG = [catalogModel(AIAND), catalogModel("openai/gpt-5")];
const WIRED = { AIAND_MANAGED: "1", ANTHROPIC_BASE_URL: "https://api.aiand.com" };

const EVENTS = {
  "saves an ai& model": () => ({ model: AIAND }),
  "saves an Anthropic model": () => ({ model: "sonnet" }),
  "removes the default": () => ({}),
  "leaves it as it was": (before) => (before === undefined ? {} : { model: before }),
  "runs on": () => ({ model: AIAND, env: WIRED }),
};

// [launch, event, model put back, user default after, wired after]
const TABLE = [
  ["no default", "saves an ai& model", AIAND, undefined, false],
  ["no default", "saves an Anthropic model", undefined, "sonnet", false],
  ["no default", "removes the default", undefined, undefined, false],
  ["no default", "leaves it as it was", undefined, undefined, false],
  ["no default", "runs on", undefined, undefined, true],
  ["opus", "saves an ai& model", AIAND, "opus", false],
  ["opus", "saves an Anthropic model", undefined, "sonnet", false],
  ["opus", "removes the default", undefined, undefined, false],
  ["opus", "leaves it as it was", undefined, "opus", false],
  ["opus", "runs on", undefined, "opus", true],
  ["wired", "saves an ai& model", undefined, "opus", true],
  ["wired", "saves an Anthropic model", undefined, "opus", true],
  ["wired", "removes the default", undefined, "opus", true],
  ["wired", "leaves it as it was", undefined, "opus", true],
  ["wired", "runs on", undefined, "opus", true],
];

const LAUNCH = {
  "no default": () => ({ model: undefined }),
  opus: () => ({ model: "opus" }),
  wired: () => ({ model: "opus", wired: true }),
};

describe("put-back table", () => {
  test("covers every launch state against every event", () => {
    assert.equal(TABLE.length, Object.keys(LAUNCH).length * Object.keys(EVENTS).length);
  });

  for (const [launch, event, put, after, wired] of TABLE) {
    test(`${launch}, user ${event}`, () => {
      const user = LAUNCH[launch]();
      const settings = EVENTS[event](user.model);
      assert.equal(putBackStep(user, settings, CATALOG), put);
      assert.equal(user.model, after);
      assert.equal(user.wired === true, wired);
    });
  }
});

describe("put-back sequences", () => {
  test("a default the user changes mid-session is the one put back", () => {
    const user = { model: "opus" };
    putBackStep(user, { model: "sonnet" }, CATALOG);
    assert.equal(putBackStep(user, { model: AIAND }, CATALOG), AIAND);
    assert.equal(user.model, "sonnet");
  });

  test("once on wires the file, off keeping the ai& model is left alone", () => {
    const user = { model: "opus" };
    putBackStep(user, { model: AIAND, env: WIRED }, CATALOG);
    assert.equal(putBackStep(user, { model: AIAND }, CATALOG), undefined);
  });
});

describe("launch default", () => {
  for (const [what, settings, expected] of [
    ["no default", {}, { model: undefined }],
    ["an Anthropic default", { model: "opus" }, { model: "opus" }],
    ["an ai& default left by an earlier session", { model: AIAND }, { model: undefined }],
    ["a file wired by on", { model: AIAND, env: WIRED }, { model: AIAND, wired: true }],
  ]) {
    test(what, () => assert.deepEqual(launchDefault(settings, CATALOG), expected));
  }
});
