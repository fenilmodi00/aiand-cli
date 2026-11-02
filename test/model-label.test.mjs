import assert from "node:assert/strict";
import test from "node:test";

const { modelLabel } = await import("../dist/api/models.js");

test("modelLabel strips the org prefix from a catalog id", () => {
  assert.equal(modelLabel("deepseek-ai/deepseek-v4.1-flash-1017"), "deepseek-v4.1-flash-1017");
});

test("modelLabel reduces a nested agent ref to the bare model", () => {
  assert.equal(modelLabel("aiand/zai-org/glm-5.3"), "glm-5.3");
});

test("modelLabel keeps ids without an org, and falls back on an empty tail", () => {
  assert.equal(modelLabel("native"), "native");
  assert.equal(modelLabel("org/"), "org/");
});
