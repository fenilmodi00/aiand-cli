import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import {
  assertMode,
  enableInput as baseEnableInput,
  catalogModel,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

withTestEnv("aiand-claude-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { claudeAdapter } = await import("../dist/agents/claude/adapter.js");
const { buildClaudeSettings, contextTokens } = await import("../dist/agents/claude/settings.js");
const { CliError } = await import("../dist/cli/errors.js");

const MAIN = "moonshotai/kimi-k3";
const FAST = "deepseek-ai/deepseek-v4.1-flash-1017";
const OTHER = "zai-org/glm-5.3";
const CATALOG = [
  catalogModel(OTHER, { context_window: 1048576 }),
  catalogModel(MAIN, { context_window: 1048576, capabilities: ["tool_calling", "vision"] }),
  catalogModel(FAST, { context_window: 262144 }),
];
const MAIN_SLOTS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

const settingsPath = () => join(process.env.AIAND_HOME, ".claude", "settings.json");
const addedJsonPath = () => join(process.env.AIAND_CONFIG_DIR, "snapshots", "claude", "added.json");
const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));
const seed = (value) => {
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), typeof value === "string" ? value : JSON.stringify(value, null, 2));
};
// The global default the setup layer resolves; Claude's own order must win over it.
const enableInput = (overrides = {}) =>
  baseEnableInput({
    model: OTHER,
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    ...overrides,
  });

/**
 * Every model setting holds `model`: each env key naming a model (the slots,
 * ANTHROPIC_MODEL, and any added later such as the safety-check model) and
 * the startup `model`.
 */
function assertOnlyModel(settings, model) {
  if (settings.model !== undefined) assert.equal(settings.model, model, "model");
  const keys = Object.keys(settings.env).filter((key) => /_MODEL$/.test(key));
  assert.ok(keys.includes("ANTHROPIC_DEFAULT_HAIKU_MODEL"), "the fast slot is written");
  for (const key of keys) assert.equal(settings.env[key], model, key);
}

beforeEach(() => {
  rmSync(join(process.env.AIAND_HOME, ".claude"), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "claude"), {
    recursive: true,
    force: true,
  });
});

describe("claude on", () => {
  test("a fresh settings.json routes every slot, blanks the API key, denies WebSearch, 0600", async () => {
    const result = await claudeAdapter.enable(enableInput());
    const { env, permissions } = readSettings();
    assert.equal(env.ANTHROPIC_BASE_URL, "https://api.aiand.com");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-test-key");
    assert.equal(env.ANTHROPIC_API_KEY, "");
    assert.equal(env.AIAND_MANAGED, "1");
    assert.equal(env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "x-aiand-agent: claude");
    assert.equal(env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
    for (const key of ["BEDROCK", "VERTEX", "FOUNDRY"]) {
      assert.equal(env[`CLAUDE_CODE_USE_${key}`], "0", key);
    }
    for (const slot of MAIN_SLOTS) assert.equal(env[slot], MAIN, slot);
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST);
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
    assert.deepEqual(permissions.deny, ["WebSearch"]);
    assertMode(settingsPath(), 0o600);
    assert.equal(result.model, MAIN);
    assert.equal(result.catalogModel, MAIN);
    assert.doesNotMatch(readFileSync(addedJsonPath(), "utf8"), /sk-test-key/);

    assert.deepEqual(await claudeAdapter.probe(), { active: true, model: MAIN });
  });

  // Auto mode's safety checks default to the Sonnet slot, ~30k
  // uncached input tokens each, and cost several times the coding work.
  test("auto-mode safety checks run on the fast model, on Claude Code's own requests", async () => {
    await claudeAdapter.enable(enableInput());
    const { env } = readSettings();
    assert.equal(env.CLAUDE_CODE_AUTO_MODE_MODEL, FAST);
    assert.equal(env.CLAUDE_CODE_AUTO_MODE_SERVER, "0");
    // --model puts every slot on the chosen model, safety checks included.
    await claudeAdapter.enable(enableInput({ model: OTHER, pinModel: true }));
    assert.equal(
      readSettings().env.CLAUDE_CODE_AUTO_MODE_MODEL,
      OTHER,
      "--model moves the checks too",
    );
    assert.equal(readSettings().env.CLAUDE_CODE_AUTO_MODE_SERVER, "0");
  });

  test("with no fast model in the catalog, safety checks share the main model", async () => {
    await claudeAdapter.enable(enableInput({ catalog: CATALOG.filter((m) => m.id !== FAST) }));
    assert.equal(readSettings().env.CLAUDE_CODE_AUTO_MODE_MODEL, MAIN);
  });

  test("a safety-check model the user set on a catalog model stays, and comes back on off", async () => {
    seed({ env: { CLAUDE_CODE_AUTO_MODE_MODEL: OTHER, CLAUDE_CODE_AUTO_MODE_SERVER: "1" } });
    await claudeAdapter.enable(enableInput());
    const { env } = readSettings();
    assert.equal(env.CLAUDE_CODE_AUTO_MODE_MODEL, OTHER);
    assert.equal(env.CLAUDE_CODE_AUTO_MODE_SERVER, "0");
    await claudeAdapter.disable();
    assert.deepEqual(readSettings().env, {
      CLAUDE_CODE_AUTO_MODE_MODEL: OTHER,
      CLAUDE_CODE_AUTO_MODE_SERVER: "1",
    });
  });

  test("a safety-check model ai& cannot serve is replaced and handed back on off", async () => {
    seed({ env: { CLAUDE_CODE_AUTO_MODE_MODEL: "claude-haiku-5-5" } });
    await claudeAdapter.enable(enableInput());
    assert.equal(readSettings().env.CLAUDE_CODE_AUTO_MODE_MODEL, FAST);
    await claudeAdapter.disable();
    assert.deepEqual(readSettings().env, { CLAUDE_CODE_AUTO_MODE_MODEL: "claude-haiku-5-5" });
  });

  test("the profile's model wins over the Claude order", async () => {
    await claudeAdapter.enable(enableInput({ profileModel: OTHER }));
    assert.equal(readSettings().env.ANTHROPIC_DEFAULT_SONNET_MODEL, OTHER);
  });

  // 0.8.0 left the fast slot on DeepSeek while the user chose another model.
  test("--model puts every slot on that model, the fast slot too", async () => {
    await claudeAdapter.enable(enableInput());
    const result = await claudeAdapter.enable(enableInput({ model: OTHER, pinModel: true }));
    assertOnlyModel(readSettings(), OTHER);
    assert.deepEqual(result.warnings, []);
    const status = await claudeAdapter.modelSlots();
    assert.deepEqual(status.warnings, []);
    assert.deepEqual(
      status.slots.map((slot) => slot.model),
      Array(status.slots.length).fill(OTHER),
    );
  });

  test("--fast-model is the one other model, for the fast slot", async () => {
    await claudeAdapter.enable(enableInput({ model: OTHER, pinModel: true, fastModel: FAST }));
    const { env } = readSettings();
    for (const slot of MAIN_SLOTS) assert.equal(env[slot], OTHER, slot);
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST);
    assert.deepEqual((await claudeAdapter.modelSlots()).warnings, [], "both were chosen");
    // A re-on keeps both choices.
    await claudeAdapter.enable(enableInput());
    assert.equal(readSettings().env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST);
    assert.equal(readSettings().env.ANTHROPIC_DEFAULT_SONNET_MODEL, OTHER);
    // --model alone drops the separate fast model.
    await claudeAdapter.enable(enableInput({ model: MAIN, pinModel: true }));
    assertOnlyModel(readSettings(), MAIN);
  });

  test("a re-on without --model keeps every slot on the model last chosen", async () => {
    await claudeAdapter.enable(enableInput({ model: OTHER, pinModel: true }));
    await claudeAdapter.enable(enableInput());
    assertOnlyModel(readSettings(), OTHER);
  });

  test("the profile's model is a choice: every slot follows it", async () => {
    await claudeAdapter.enable(enableInput({ profileModel: OTHER }));
    assertOnlyModel(readSettings(), OTHER);
  });

  test("with no model chosen, the fast slot takes the fast default and status says so", async () => {
    await claudeAdapter.enable(enableInput());
    const status = await claudeAdapter.modelSlots();
    const fast = status.slots.find((slot) => slot.key === "ANTHROPIC_DEFAULT_HAIKU_MODEL");
    assert.equal(fast.model, FAST);
    assert.match(
      status.warnings.join("\n"),
      /fast \(haiku\) model .* is deepseek-ai\/deepseek-v4\.1-flash-1017, not moonshotai\/kimi-k3/,
    );
    // No choice was made, so the hint names no model.
    assert.equal(
      status.warnings.at(-1),
      "To put every slot on one model, run aiand claude on --model <id>.",
    );
  });

  test("a 0.8.0 wiring with the fast slot left on DeepSeek moves it on a re-on", async () => {
    // What 0.8.0's `on --model OTHER` wrote, and recorded without `chosen`.
    await claudeAdapter.enable(enableInput({ model: OTHER, pinModel: true }));
    const record = JSON.parse(readFileSync(addedJsonPath(), "utf8"));
    delete record.choice;
    record.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = FAST;
    writeFileSync(addedJsonPath(), JSON.stringify(record));
    const settings = readSettings();
    settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = FAST;
    seed(settings);
    assert.match((await claudeAdapter.modelSlots()).warnings.join(" "), /is deepseek/);
    await claudeAdapter.enable(enableInput());
    assertOnlyModel(readSettings(), OTHER);
  });

  test("with no model chosen, a re-on keeps the defaults even after the default order moves", async () => {
    const QWEN = "qwen/qwen3.8-27b";
    const withoutKimi = [...CATALOG.filter((m) => m.id !== MAIN), catalogModel(QWEN)];
    await claudeAdapter.enable(enableInput({ catalog: withoutKimi }));
    assert.equal(readSettings().env.ANTHROPIC_DEFAULT_SONNET_MODEL, QWEN);
    // Kimi is back: QWEN was our default, not the user's choice, so the
    // slots follow the default order again and the fast slot keeps its own.
    await claudeAdapter.enable(enableInput({ catalog: [...withoutKimi, CATALOG[1]] }));
    const { env } = readSettings();
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, MAIN);
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST);
  });

  test("a 0.8.0 wiring on the default follows a profile model set since", async () => {
    await claudeAdapter.enable(enableInput());
    const record = JSON.parse(readFileSync(addedJsonPath(), "utf8"));
    delete record.choice;
    writeFileSync(addedJsonPath(), JSON.stringify(record));
    await claudeAdapter.enable(enableInput({ profileModel: OTHER }));
    assertOnlyModel(readSettings(), OTHER);
  });

  test("a startup model setting other than the profile's choice is warned about", async () => {
    seed({ model: FAST });
    const result = await claudeAdapter.enable(enableInput({ profileModel: OTHER }));
    assert.match(
      result.warnings.join(" "),
      /still starts on your model setting \(deepseek-ai\/deepseek-v4\.1-flash-1017\).*switch to zai-org\/glm-5\.3/,
    );
  });

  test("a fast slot the user set stays without --model, with a warning; --model replaces it", async () => {
    seed({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: FAST } });
    const result = await claudeAdapter.enable(enableInput({ profileModel: OTHER }));
    assert.equal(readSettings().env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST);
    assert.match(
      result.warnings.join(" "),
      /fast \(haiku\) model .* is deepseek.*not zai-org\/glm-5\.3/,
    );
    await claudeAdapter.enable(enableInput({ model: OTHER, pinModel: true }));
    assertOnlyModel(readSettings(), OTHER);
  });

  test("status reports a safety-check model the user set elsewhere", async () => {
    await claudeAdapter.enable(enableInput({ model: OTHER, pinModel: true }));
    const settings = readSettings();
    settings.env.CLAUDE_CODE_AUTO_MODE_MODEL = MAIN;
    seed(settings);
    const status = await claudeAdapter.modelSlots();
    const auto = status.slots.find((slot) => slot.label === "auto-mode checks");
    assert.deepEqual(auto, {
      key: "CLAUDE_CODE_AUTO_MODE_MODEL",
      label: "auto-mode checks",
      model: MAIN,
    });
    assert.match(status.warnings.join(" "), /auto-mode checks model/);
  });

  test("a re-on without --model keeps a slot already on a catalog model", async () => {
    seed({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: OTHER } });
    await claudeAdapter.enable(enableInput());
    const { env } = readSettings();
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, OTHER, "the user's catalog choice stays");
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, MAIN);
  });

  test("native writes no model keys and says so", async () => {
    const result = await claudeAdapter.enable(enableInput({ model: "native" }));
    const { env } = readSettings();
    for (const slot of [
      ...MAIN_SLOTS,
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "CLAUDE_CODE_AUTO_MODE_MODEL",
    ]) {
      assert.equal(env[slot], undefined, slot);
    }
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
    assert.match(result.warnings.join(" "), /pass --model/);
  });

  test("a concrete model ai& cannot serve is set aside; an alias stays", async () => {
    seed({ model: "claude-opus-5-5[1m]" });
    const result = await claudeAdapter.enable(enableInput());
    assert.equal(readSettings().model, undefined);
    assert.match(result.warnings.join(" "), /Set aside your model \(claude-opus-5-5\[1m\]\)/);
    await claudeAdapter.disable();
    assert.equal(readSettings().model, "claude-opus-5-5[1m]");

    seed({ model: "opus" });
    await claudeAdapter.enable(enableInput());
    assert.equal(readSettings().model, "opus");
  });

  for (const [what, settings] of [
    ["ANTHROPIC_BASE_URL", { env: { ANTHROPIC_BASE_URL: "https://proxy.example.com" } }],
    ["ANTHROPIC_AUTH_TOKEN", { env: { ANTHROPIC_AUTH_TOKEN: "their-token" } }],
    ["apiKeyHelper", { apiKeyHelper: "~/bin/key.sh" }],
    ["Bedrock", { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }],
  ]) {
    test(`refuses settings with a foreign ${what}, file untouched`, async () => {
      seed(settings);
      const before = readFileSync(settingsPath(), "utf8");
      await assert.rejects(claudeAdapter.enable(enableInput()), CliError);
      assert.equal(readFileSync(settingsPath(), "utf8"), before);
    });
  }

  test("invalid JSON is a CliError naming the file", async () => {
    seed("{ not json");
    await assert.rejects(claudeAdapter.enable(enableInput()), /settings\.json is not valid JSON/);
    assert.deepEqual(await claudeAdapter.probe(), { active: false, model: null });
  });

  test("CLAUDE_CONFIG_DIR is honoured", async () => {
    const dir = join(process.env.AIAND_HOME, "custom-claude");
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      const result = await claudeAdapter.enable(enableInput());
      assert.deepEqual(result.filesWritten, [join(dir, "settings.json")]);
      assert.equal(existsSync(settingsPath()), false);
      await claudeAdapter.disable();
      assert.equal(existsSync(join(dir, "settings.json")), false);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("status, rotation and off follow the file on wrote, whatever CLAUDE_CONFIG_DIR says now", async () => {
    await claudeAdapter.enable(enableInput());
    process.env.CLAUDE_CONFIG_DIR = join(process.env.AIAND_HOME, "other-claude");
    try {
      assert.equal((await claudeAdapter.probe()).active, true);
      assert.equal(await claudeAdapter.refreshKey({ apiKey: "sk-test-rotated" }), true);
      assert.equal(readSettings().env.ANTHROPIC_AUTH_TOKEN, "sk-test-rotated");
      assert.equal((await claudeAdapter.disable()).stripped, true);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    assert.equal(existsSync(settingsPath()), false);
  });

  test("a corrupt record does not make status read off", async () => {
    await claudeAdapter.enable(enableInput());
    writeFileSync(addedJsonPath(), "{bad");
    assert.equal((await claudeAdapter.probe()).active, true);
  });

  test("managedFiles includes the wired file, so restore works from another CLAUDE_CONFIG_DIR", async () => {
    await claudeAdapter.enable(enableInput());
    const other = join(process.env.AIAND_HOME, "other-claude");
    process.env.CLAUDE_CONFIG_DIR = other;
    try {
      assert.deepEqual(claudeAdapter.managedFiles(), [
        join(other, "settings.json"),
        settingsPath(),
      ]);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    await claudeAdapter.disable();
    assert.deepEqual(claudeAdapter.managedFiles(), [settingsPath()]);
  });

  test("on under a second CLAUDE_CONFIG_DIR is refused while the first is wired", async () => {
    await claudeAdapter.enable(enableInput());
    const other = join(process.env.AIAND_HOME, "other-claude");
    process.env.CLAUDE_CONFIG_DIR = other;
    try {
      await assert.rejects(claudeAdapter.enable(enableInput()), /already wired through/);
      assert.equal(existsSync(join(other, "settings.json")), false);
      await claudeAdapter.disable();
      await claudeAdapter.enable(enableInput());
      assert.equal(existsSync(join(other, "settings.json")), true);
      await claudeAdapter.disable();
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      rmSync(other, { recursive: true, force: true });
    }
  });
});

// every catalog entry must retain its API window when selected at startup.
describe("claude context parity", () => {
  const catalog = [
    ...CATALOG,
    ...[32768, 128000, 200000, 1000000, 1536000, 2097152].map((context_window) =>
      catalogModel(`vendor/window-${context_window}`, { context_window }),
    ),
    catalogModel("vendor/tagged[1m]", { context_window: 524288 }),
  ];

  for (const model of catalog) {
    test(`${model.id}: launcher hint equals API context_window`, async () => {
      const launch = await claudeAdapter.sessionLaunch({
        apiKey: "sk-context-parity",
        model: model.id,
        catalog,
      });
      try {
        const { env } = JSON.parse(readFileSync(launch.args[1], "utf8"));
        assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(model.context_window));
        assert.equal(env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
      } finally {
        await launch.cleanup();
      }
    });

    test(`${model.id}: permanent startup hint equals API context_window`, async () => {
      seed({ model: model.id });
      await claudeAdapter.enable(enableInput({ catalog }));
      assert.equal(readSettings().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(model.context_window));
    });
  }

  test("re-on replaces the old managed 200K cap and off removes it", async () => {
    seed({ env: { AIAND_MANAGED: "1", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000" } });
    await claudeAdapter.enable(enableInput());
    assert.equal(readSettings().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
    await claudeAdapter.disable();
    assert.equal(readSettings().env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  });

  test("off restores a user's previous context hint after repeated on", async () => {
    seed({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "64000", CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" } });
    await claudeAdapter.enable(enableInput());
    await claudeAdapter.enable(enableInput({ model: FAST, pinModel: true }));
    assert.equal(readSettings().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "262144");
    await claudeAdapter.disable();
    assert.equal(readSettings().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "64000");
    assert.equal(readSettings().env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "0");
  });

  for (const window of [undefined, null, 0, -1, NaN, Infinity, 1.5, "1000000"]) {
    test(`invalid window ${window} clears an inherited hint`, async () => {
      const invalid = [catalogModel(MAIN, { context_window: window })];
      assert.equal(contextTokens(invalid, MAIN), undefined);
      assert.equal(contextTokens(invalid, "missing"), undefined);
      const settings = buildClaudeSettings({
        apiKey: "sk-x",
        baseUrl: "",
        main: MAIN,
        fast: MAIN,
        catalog: invalid,
      });
      assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "");
      seed({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000" } });
      await claudeAdapter.enable(enableInput({ catalog: invalid }));
      assert.equal(readSettings().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "");
      await claudeAdapter.disable();
      assert.equal(readSettings().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "200000");
    });
  }

  test("an unsupported env model is removed before sizing a kept startup model", async () => {
    seed({ model: FAST, env: { ANTHROPIC_MODEL: "claude-unavailable" } });
    await claudeAdapter.enable(enableInput());
    assert.equal(readSettings().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "262144");
  });

  for (const args of [["--model", FAST], [`--model=${FAST}`], ["--model", "haiku"]]) {
    test(`Claude Code startup flag ${args.join(" ")} determines the launcher hint`, async () => {
      const launch = await claudeAdapter.sessionLaunch({ apiKey: "sk-x", catalog: CATALOG, args });
      try {
        const settings = JSON.parse(readFileSync(launch.args[1], "utf8"));
        assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "262144");
      } finally {
        await launch.cleanup();
      }
    });
  }

  // Every slot follows --model, so the budget does too; --fast-model moves
  // only background calls and safety checks, which never set the budget.
  const SMALL = "vendor/window-32768";
  const BIG = "vendor/window-2097152";
  const sized = [
    ...CATALOG,
    catalogModel(SMALL, { context_window: 32768 }),
    catalogModel(BIG, { context_window: 2097152 }),
  ];
  const launchHint = async (input) => {
    const launch = await claudeAdapter.sessionLaunch({ apiKey: "sk-x", catalog: sized, ...input });
    try {
      return JSON.parse(readFileSync(launch.args[1], "utf8")).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    } finally {
      await launch.cleanup();
    }
  };

  test("on --model with a smaller --fast-model sizes the budget for --model", async () => {
    await claudeAdapter.enable(
      enableInput({ model: OTHER, pinModel: true, fastModel: SMALL, catalog: sized }),
    );
    const { env } = readSettings();
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, SMALL);
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
  });

  test("a launch with a smaller --fast-model sizes the budget for --model", async () => {
    assert.equal(await launchHint({ model: OTHER, fastModel: SMALL }), "1048576");
  });

  test("a launch's haiku alias sizes the budget for --fast-model", async () => {
    const hint = await launchHint({ model: OTHER, fastModel: SMALL, args: ["--model", "haiku"] });
    assert.equal(hint, "32768");
  });

  test("a launch without --model sizes the budget for the model on --model chose", async () => {
    await claudeAdapter.enable(enableInput({ model: BIG, pinModel: true, catalog: sized }));
    assert.equal(await launchHint({ model: undefined }), "2097152");
  });

  test("a launch without --model sizes the budget for the profile's model", async () => {
    assert.equal(await launchHint({ model: undefined, profileModel: BIG }), "2097152");
  });

  test("a profile model sizes the budget of on", async () => {
    await claudeAdapter.enable(
      enableInput({ model: undefined, profileModel: BIG, catalog: sized }),
    );
    assert.equal(readSettings().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "2097152");
  });
});

describe("claude modelPicker", () => {
  test("on lists every catalog model in /model, replacing the built-in rows", async () => {
    await claudeAdapter.enable(enableInput());
    const { modelPicker } = readSettings();
    assert.equal(modelPicker.replaceBuiltInOptions, true);
    assert.deepEqual(
      modelPicker.options.map((row) => row.model),
      CATALOG.map((model) => model.id),
    );
    const kimi = modelPicker.options.find((row) => row.model === MAIN);
    assert.equal(kimi.description, "ai& · 1M context");
  });

  test("a re-on refreshes the list from the current catalog", async () => {
    await claudeAdapter.enable(enableInput());
    const catalog = [...CATALOG, catalogModel("qwen/qwen3.8-27b", { context_window: 262144 })];
    await claudeAdapter.enable(enableInput({ catalog }));
    const rows = readSettings().modelPicker.options;
    assert.equal(rows.length, catalog.length);
    assert.equal(rows.at(-1).description, "ai& · 256K context · text only");
  });

  test("a smaller window shows as the model's own", async () => {
    const catalog = [...CATALOG, catalogModel("qwen/qwen3.8-27b", { context_window: 131072 })];
    await claudeAdapter.enable(enableInput({ catalog }));
    assert.equal(
      readSettings().modelPicker.options.at(-1).description,
      "ai& · 128K context · text only",
    );
  });

  test("the user's own modelPicker is kept, with a warning, and off leaves it", async () => {
    const theirs = { options: [{ model: "opus", label: "Mine" }] };
    seed({ modelPicker: theirs });
    const result = await claudeAdapter.enable(enableInput());
    assert.deepEqual(readSettings().modelPicker, theirs);
    assert.ok(result.warnings.some((w) => w.includes("Kept your own modelPicker")));
    await claudeAdapter.disable();
    assert.deepEqual(readSettings().modelPicker, theirs);
  });

  test("off removes the picker on wrote, and leaves one the user edited", async () => {
    seed({ theme: "dark" });
    await claudeAdapter.enable(enableInput());
    await claudeAdapter.disable();
    assert.equal(readSettings().modelPicker, undefined);

    await claudeAdapter.enable(enableInput());
    const edited = readSettings();
    edited.modelPicker.options.pop();
    seed(edited);
    const off = await claudeAdapter.disable();
    assert.ok(off.notes.some((n) => n.includes("left modelPicker because you edited it")));
    assert.equal(readSettings().modelPicker.options.length, CATALOG.length - 1);
  });
});

describe("claude off", () => {
  test("bakedBaseUrl(): reads back the https://api.aiand.com `on` baked, and nothing once off", async () => {
    assert.equal(await claudeAdapter.bakedBaseUrl(), undefined, "nothing wired yet");
    await claudeAdapter.enable(enableInput());
    assert.equal(await claudeAdapter.bakedBaseUrl(), "https://api.aiand.com");
    await claudeAdapter.disable();
    assert.equal(await claudeAdapter.bakedBaseUrl(), undefined, "off: nothing baked");
  });

  test("on warns that running sessions switch, once; off says they switch back", async () => {
    const first = await claudeAdapter.enable(enableInput());
    assert.match(first.warnings.join(" "), /they now send requests to ai&\. .*type \/exit/);
    const again = await claudeAdapter.enable(enableInput());
    assert.doesNotMatch(again.warnings.join(" "), /send requests to ai&/);
    const off = await claudeAdapter.disable();
    assert.deepEqual(off.notes, []);
    assert.match(
      off.warnings.join(" "),
      /switch back too\. .*type \/exit, then run claude --continue/,
    );
  });

  test("off empties the keys it removes before deleting them, so running sessions leave ai&", async () => {
    await claudeAdapter.enable(enableInput());
    const seen = [];
    const watcher = watch(dirname(settingsPath()), () => {
      try {
        seen.push(JSON.parse(readFileSync(settingsPath(), "utf8")));
      } catch {}
    });
    await withEnv({ AIAND_CLAUDE_RELOAD_MS: "200" }, () => claudeAdapter.disable());
    watcher.close();
    const emptied = seen.find((s) => s.env?.ANTHROPIC_BASE_URL === "");
    assert.ok(emptied, "a write with the routing keys emptied came first");
    assert.equal(emptied.env.ANTHROPIC_AUTH_TOKEN, "");
    assert.equal(emptied.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "");
    assert.equal(
      emptied.env.AIAND_MANAGED,
      "1",
      "still marked, so a failed second write can be redone by off",
    );
    assert.equal(existsSync(settingsPath()), false, "then the file on created is gone");
  });

  test("off retried after an interrupted wait removes the emptied keys without blaming the user", async () => {
    const original = { theme: "dark", env: { FOO: "bar" } };
    seed(original);
    await claudeAdapter.enable(enableInput());
    // The first off emptied every key it was removing, then died in its wait.
    const { env } = readSettings();
    for (const key of Object.keys(env)) {
      if (key !== "AIAND_MANAGED" && key !== "FOO") env[key] = "";
    }
    seed({ theme: "dark", env });

    const off = await claudeAdapter.disable();
    assert.deepEqual(off.notes, []);
    assert.deepEqual(readSettings(), original);
    assert.deepEqual(await claudeAdapter.probe(), { active: false, model: null });
  });

  test("a file on created is removed again", async () => {
    await claudeAdapter.enable(enableInput());
    const result = await claudeAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(existsSync(settingsPath()), false);
    assert.deepEqual(await claudeAdapter.probe(), { active: false, model: null });
  });

  test("an untouched user file comes back byte-identical, with its mode", async () => {
    const original = `{
  // the user's own comment
  "theme": "dark",
  "env": {
    "FOO": "bar"
  }
}
`;
    seed(original);
    await claudeAdapter.enable(enableInput());
    await claudeAdapter.disable();
    assert.equal(readFileSync(settingsPath(), "utf8"), original);
    assertMode(settingsPath(), 0o644);
  });

  test("a client setting the user already had comes back on off", async () => {
    seed({ env: { CLAUDE_CODE_ATTRIBUTION_HEADER: "1" } });
    await claudeAdapter.enable(enableInput());
    assert.equal(readSettings().env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
    await claudeAdapter.disable();
    assert.deepEqual(readSettings().env, { CLAUDE_CODE_ATTRIBUTION_HEADER: "1" });
  });

  test("a user's own custom headers survive on and come back whole on off", async () => {
    seed({ env: { ANTHROPIC_CUSTOM_HEADERS: "X-Foo: bar" } });
    await claudeAdapter.enable(enableInput());
    assert.equal(
      readSettings().env.ANTHROPIC_CUSTOM_HEADERS,
      `X-Foo: bar${"\n"}x-aiand-agent: claude`,
    );
    await claudeAdapter.disable();
    assert.deepEqual(readSettings().env, { ANTHROPIC_CUSTOM_HEADERS: "X-Foo: bar" });
  });

  test("a re-on replaces only our pair among the user's custom headers", async () => {
    seed({ env: { ANTHROPIC_CUSTOM_HEADERS: "X-Foo: bar" } });
    await claudeAdapter.enable(enableInput());
    await claudeAdapter.enable(enableInput());
    assert.equal(
      readSettings().env.ANTHROPIC_CUSTOM_HEADERS,
      `X-Foo: bar${"\n"}x-aiand-agent: claude`,
    );
  });

  test("the user's own API key and deny entries come back; WebSearch goes", async () => {
    seed({
      env: { ANTHROPIC_API_KEY: "their-anthropic-key" },
      permissions: { deny: ["Bash(rm:*)"] },
    });
    await claudeAdapter.enable(enableInput());
    assert.deepEqual(readSettings().permissions.deny, ["Bash(rm:*)", "WebSearch"]);
    await claudeAdapter.disable();
    const after = readSettings();
    assert.deepEqual(after.env, { ANTHROPIC_API_KEY: "their-anthropic-key" });
    assert.deepEqual(after.permissions.deny, ["Bash(rm:*)"]);
  });

  test("a slot edited after on is left, with a note", async () => {
    await claudeAdapter.enable(enableInput());
    const settings = readSettings();
    settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "their-pick";
    seed(settings);
    const result = await claudeAdapter.disable();
    assert.match(result.notes.join(" "), /left env\.ANTHROPIC_DEFAULT_OPUS_MODEL/);
    const { env } = readSettings();
    assert.deepEqual(env, { ANTHROPIC_DEFAULT_OPUS_MODEL: "their-pick" });
  });

  test("an unmarked config is left alone", async () => {
    seed({ env: { ANTHROPIC_BASE_URL: "https://proxy.example.com" } });
    const before = readFileSync(settingsPath(), "utf8");
    assert.equal((await claudeAdapter.disable()).stripped, false);
    assert.equal(readFileSync(settingsPath(), "utf8"), before);
  });
});

describe("claude re-on bookkeeping", () => {
  const SEED = `{
  "theme": "dark"
}
`;

  test("on, then on --model native, then off still removes every slot", async () => {
    seed(SEED);
    await claudeAdapter.enable(enableInput());
    await claudeAdapter.enable(enableInput({ model: "native" }));
    assert.equal(readSettings().env.ANTHROPIC_DEFAULT_SONNET_MODEL, MAIN, "native leaves slots");
    await claudeAdapter.disable();
    assert.equal(readFileSync(settingsPath(), "utf8"), SEED);
  });

  test("a model set after an earlier set-aside is the one off puts back", async () => {
    seed({ model: "claude-opus-5-5" });
    await claudeAdapter.enable(enableInput());
    const settings = readSettings();
    settings.model = "claude-sonnet-5";
    seed(settings);
    const result = await claudeAdapter.enable(enableInput());
    assert.match(result.warnings.join(" "), /Set aside your model \(claude-sonnet-5\)/);
    await claudeAdapter.disable();
    assert.equal(readSettings().model, "claude-sonnet-5");
  });

  test("off on invalid JSON keeps the record, so a later off still cleans up", async () => {
    seed(SEED);
    await claudeAdapter.enable(enableInput());
    const wired = readFileSync(settingsPath(), "utf8");
    writeFileSync(settingsPath(), "{ half-edited");
    const broken = await claudeAdapter.disable();
    assert.equal(broken.stripped, false);
    assert.match(broken.notes.join(" "), /not valid JSON; fix it/);
    assert.equal(existsSync(addedJsonPath()), true, "record kept");
    writeFileSync(settingsPath(), wired);
    await claudeAdapter.disable();
    assert.equal(readFileSync(settingsPath(), "utf8"), SEED);
  });

  test("a marked file whose record is gone: re-on then off unwires it", async () => {
    seed(SEED);
    await claudeAdapter.enable(enableInput());
    rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "claude"), {
      recursive: true,
      force: true,
    });
    await claudeAdapter.enable(enableInput());
    await claudeAdapter.disable();
    // Without the record, off cannot know it created env/permissions or
    // added the WebSearch deny, so those stay; every routing key goes.
    const { env, theme } = readSettings();
    assert.equal(theme, "dark");
    assert.deepEqual(env, {});
    assert.deepEqual(await claudeAdapter.probe(), { active: false, model: null });
  });

  test("--model keeps a model setting ai& serves, and says it still wins at startup", async () => {
    seed({ model: OTHER });
    const result = await claudeAdapter.enable(enableInput({ model: MAIN, pinModel: true }));
    assert.equal(readSettings().model, OTHER);
    assert.equal(readSettings().env.ANTHROPIC_DEFAULT_SONNET_MODEL, MAIN);
    assert.match(
      result.warnings.join(" "),
      /still starts on your model setting \(zai-org\/glm-5\.3\)/,
    );
    assert.equal(result.model, OTHER);
    assert.deepEqual(await claudeAdapter.probe(), { active: true, model: OTHER });
  });

  test("a haiku alias starts Claude Code on the fast slot, which --model also moves", async () => {
    seed({ model: "haiku" });
    await claudeAdapter.enable(enableInput());
    assert.deepEqual(await claudeAdapter.probe(), { active: true, model: FAST });
    const result = await claudeAdapter.enable(enableInput({ model: MAIN, pinModel: true }));
    assert.equal(readSettings().model, "haiku");
    assert.equal(result.model, MAIN);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(await claudeAdapter.probe(), { active: true, model: MAIN });
  });

  test("env.ANTHROPIC_MODEL ai& cannot serve is set aside, and off puts it back", async () => {
    seed({ env: { ANTHROPIC_MODEL: "claude-opus-5-5" } });
    const result = await claudeAdapter.enable(enableInput());
    assert.equal(readSettings().env.ANTHROPIC_MODEL, undefined);
    assert.match(result.warnings.join(" "), /Set aside your env\.ANTHROPIC_MODEL/);
    await claudeAdapter.disable();
    assert.equal(readSettings().env.ANTHROPIC_MODEL, "claude-opus-5-5");
  });

  test("env.ANTHROPIC_MODEL on a catalog model beats the model setting in status", async () => {
    seed({ model: "haiku", env: { ANTHROPIC_MODEL: OTHER } });
    await claudeAdapter.enable(enableInput());
    assert.deepEqual(await claudeAdapter.probe(), { active: true, model: OTHER });
  });

  test("an alias reports its own slot and sizes the budget for that slot", async () => {
    const SMALL = "qwen/qwen3.8-27b";
    const catalog = [...CATALOG, catalogModel(SMALL, { context_window: 131072 })];
    seed({ model: "opus", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: SMALL } });
    await claudeAdapter.enable(enableInput({ catalog }));
    assert.deepEqual(await claudeAdapter.probe(), { active: true, model: SMALL });
    assert.equal(readSettings().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "131072");
  });

  test("--model warns when a kept env.ANTHROPIC_MODEL decides the startup model", async () => {
    seed({ env: { ANTHROPIC_MODEL: OTHER } });
    const result = await claudeAdapter.enable(enableInput({ model: MAIN, pinModel: true }));
    assert.equal(result.model, OTHER);
    assert.match(
      result.warnings.join(" "),
      /still starts on your env\.ANTHROPIC_MODEL setting \(zai-org\/glm-5\.3\)/,
    );
  });

  test("a kept startup model sizes the budget without shrinking other picker labels", async () => {
    const SMALL = "qwen/qwen3.8-27b";
    const catalog = [...CATALOG, catalogModel(SMALL, { context_window: 32768 })];
    seed({ model: SMALL });
    await claudeAdapter.enable(enableInput({ catalog }));
    assert.equal(readSettings().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "32768");
    const kimi = readSettings().modelPicker.options.find((row) => row.model === MAIN);
    assert.equal(kimi.description, "ai& · 1M context");
  });

  test("opusplan starts outside plan mode on the sonnet slot", async () => {
    seed({ model: "opusplan", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: OTHER } });
    await claudeAdapter.enable(enableInput());
    assert.deepEqual(await claudeAdapter.probe(), { active: true, model: MAIN });
  });

  test("an opus alias resolves through a main slot, so --model takes effect silently", async () => {
    seed({ model: "opus[1m]" });
    const result = await claudeAdapter.enable(enableInput({ model: MAIN, pinModel: true }));
    assert.equal(result.model, MAIN);
    assert.ok(!result.warnings.some((w) => w.includes("still starts")));
  });
});

describe("claude refreshKey", () => {
  test("swaps only the token; a rotation from another key is a no-op", async () => {
    await claudeAdapter.enable(enableInput());
    assert.equal(await claudeAdapter.refreshKey({ apiKey: "sk-new" }), true);
    assert.equal(readSettings().env.ANTHROPIC_AUTH_TOKEN, "sk-new");
    assert.equal(
      await claudeAdapter.refreshKey({ apiKey: "sk-newer", previousKey: "sk-someone-else" }),
      false,
    );
    assert.equal(readSettings().env.ANTHROPIC_AUTH_TOKEN, "sk-new");
    assertMode(settingsPath(), 0o600);
  });

  test("an unmarked config is not touched", async () => {
    seed({ env: { ANTHROPIC_AUTH_TOKEN: "their-token" } });
    assert.equal(await claudeAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.equal(readSettings().env.ANTHROPIC_AUTH_TOKEN, "their-token");
  });
});

describe("claude sessionLaunch", () => {
  test("passes a throwaway 0600 --settings file; the child env stays key-free", async () => {
    const launch = await claudeAdapter.sessionLaunch({
      apiKey: "sk-launch-1",
      model: undefined,
      catalog: CATALOG,
    });
    assert.deepEqual(launch.env, {});
    assert.equal(launch.args[0], "--settings");
    const file = launch.args[1];
    assertMode(file, 0o600);
    const settings = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(settings.model, MAIN);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-launch-1");
    assert.equal(settings.modelPicker.options.length, CATALOG.length);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.aiand.com");
    assert.equal(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
    assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, "x-aiand-agent: claude");
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
    // Beat a switch or ANTHROPIC_MODEL set in the shell or a lower settings file.
    assert.equal(settings.env.CLAUDE_CODE_USE_BEDROCK, "0");
    assert.equal(settings.env.ANTHROPIC_MODEL, MAIN);
    // Auto-mode safety checks: the fast model, on Claude Code's own requests.
    assert.equal(settings.env.CLAUDE_CODE_AUTO_MODE_MODEL, FAST);
    assert.equal(settings.env.CLAUDE_CODE_AUTO_MODE_SERVER, "0");
    await launch.cleanup();
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(settingsPath()), false, "user settings untouched");
  });

  // 0.8.0: `aiand claude --model X` left the slots on Kimi K3 and DeepSeek.
  test("--model puts every slot of the launch on it; --fast-model the fast slot", async () => {
    const launch = await claudeAdapter.sessionLaunch({
      apiKey: "sk-x",
      model: OTHER,
      catalog: CATALOG,
    });
    assertOnlyModel(JSON.parse(readFileSync(launch.args[1], "utf8")), OTHER);
    await launch.cleanup();
    const both = await claudeAdapter.sessionLaunch({
      apiKey: "sk-x",
      model: OTHER,
      fastModel: FAST,
      catalog: CATALOG,
    });
    const { env } = JSON.parse(readFileSync(both.args[1], "utf8"));
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, OTHER);
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST);
    await both.cleanup();
  });

  test("the profile's model is a choice at launch too", async () => {
    const launch = await claudeAdapter.sessionLaunch({
      apiKey: "sk-x",
      model: undefined,
      profileModel: OTHER,
      catalog: CATALOG,
    });
    assertOnlyModel(JSON.parse(readFileSync(launch.args[1], "utf8")), OTHER);
    await launch.cleanup();
  });

  test("a smaller startup window is used exactly, independently of the fast slot", () => {
    const small = "openai/gpt-oss-120b";
    const catalog = [...CATALOG, catalogModel(small, { context_window: 131072 })];
    const build = (main, fast) =>
      buildClaudeSettings({ apiKey: "sk-x", baseUrl: "https://api.aiand.com", main, fast, catalog })
        .env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    assert.equal(build(small, small), "131072");
    // --fast-model's window does not shrink the main model's budget.
    assert.equal(build(MAIN, small), "1048576");
  });

  test("buildClaudeSettings honours --model and a --base-url origin", () => {
    const settings = buildClaudeSettings({
      apiKey: "sk-x",
      baseUrl: "http://127.0.0.1:8787",
      main: OTHER,
      fast: OTHER,
      catalog: CATALOG,
    });
    assert.equal(settings.model, OTHER);
    assertOnlyModel(settings, OTHER);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787");
    assert.deepEqual(settings.permissions.deny, ["WebSearch"]);
  });
});
