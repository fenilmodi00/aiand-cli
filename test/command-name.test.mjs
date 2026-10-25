import assert from "node:assert/strict";
import test from "node:test";

const { commandName } = await import("../dist/config.js");

/** Scoped AIAND_COMMAND_NAME: set for the callback, restored after. */
function withCommandName(value, fn) {
  const previous = process.env.AIAND_COMMAND_NAME;
  if (value === undefined) delete process.env.AIAND_COMMAND_NAME;
  else process.env.AIAND_COMMAND_NAME = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.AIAND_COMMAND_NAME;
    else process.env.AIAND_COMMAND_NAME = previous;
  }
}

test("commandName defaults to aiand when the env var is unset", () => {
  withCommandName(undefined, () => {
    assert.equal(commandName(), "aiand");
  });
});

test("commandName honors AIAND_COMMAND_NAME", () => {
  withCommandName("aiand-v2", () => {
    assert.equal(commandName(), "aiand-v2");
  });
});

test("commandName falls back to aiand for a path-like value", () => {
  withCommandName("../evil", () => {
    assert.equal(commandName(), "aiand");
  });
});

// Read at module load, so the env var must be set before this import — and
// this file's process must not have imported the module for the default case.
process.env.AIAND_COMMAND_NAME = "aiand-v2";
const { buildOmpProviderBlock, readOmpProviderBlock } = await import(
  "../dist/agents/omp/provider.js"
);
const { yamlRender } = await import("../dist/agents/omp/yaml.js");
delete process.env.AIAND_COMMAND_NAME;

test("omp provider block uses the renamed command as provider id and marker", () => {
  process.env.AIAND_COMMAND_NAME = "aiand-v2";
  try {
    const block = buildOmpProviderBlock({ apiKey: "sk-test-key" });
    assert.equal(block.managedBy, "aiand-v2");
    const text = yamlRender({ providers: { "aiand-v2": block } });
    const owned = readOmpProviderBlock(text);
    assert.equal(owned.kind, "ours");
    assert.equal(owned.block.apiKey, "sk-test-key");
    // The production identity must not appear as a key or marker value.
    assert.ok(!/^\s{2}aiand:/m.test(text));
    assert.notEqual(block.managedBy, "aiand");
  } finally {
    delete process.env.AIAND_COMMAND_NAME;
  }
});
