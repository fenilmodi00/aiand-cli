import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { enableInput as baseEnableInput, catalogModel, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-claude-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { claudeAdapter } = await import("../dist/agents/claude/adapter.js");
const { buildClaudeSettings } = await import("../dist/agents/claude/settings.js");
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
    assert.equal(env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
    for (const key of ["BEDROCK", "VERTEX", "FOUNDRY"]) {
      assert.equal(env[`CLAUDE_CODE_USE_${key}`], "0", key);
    }
    for (const slot of MAIN_SLOTS) assert.equal(env[slot], MAIN, slot);
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST);
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "200000");
    assert.deepEqual(permissions.deny, ["WebSearch"]);
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o600);
    assert.equal(result.model, MAIN);
    assert.equal(result.catalogModel, MAIN);
    assert.doesNotMatch(readFileSync(addedJsonPath(), "utf8"), /sk-test-key/);

    assert.deepEqual(await claudeAdapter.probe(), { active: true, model: MAIN });
  });

  test("the profile's model wins over the Claude order", async () => {
    await claudeAdapter.enable(enableInput({ profileModel: OTHER }));
    assert.equal(readSettings().env.ANTHROPIC_DEFAULT_SONNET_MODEL, OTHER);
  });

  test("--model sets the main slots only; haiku stays fast", async () => {
    await claudeAdapter.enable(enableInput());
    await claudeAdapter.enable(enableInput({ model: OTHER, pinModel: true }));
    const { env } = readSettings();
    for (const slot of MAIN_SLOTS) assert.equal(env[slot], OTHER, slot);
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST);
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
    for (const slot of [...MAIN_SLOTS, "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) {
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
    assert.equal(kimi.description, "ai& · vision · 1M context");
  });

  test("a re-on refreshes the list from the current catalog", async () => {
    await claudeAdapter.enable(enableInput());
    const catalog = [...CATALOG, catalogModel("qwen/qwen3.8-27b", { context_window: 262144 })];
    await claudeAdapter.enable(enableInput({ catalog }));
    const rows = readSettings().modelPicker.options;
    assert.equal(rows.length, catalog.length);
    assert.equal(rows.at(-1).description, "ai& · text-only · 256K context");
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
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o644);
  });

  test("a client setting the user already had comes back on off", async () => {
    seed({ env: { CLAUDE_CODE_ATTRIBUTION_HEADER: "1" } });
    await claudeAdapter.enable(enableInput());
    assert.equal(readSettings().env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
    await claudeAdapter.disable();
    assert.deepEqual(readSettings().env, { CLAUDE_CODE_ATTRIBUTION_HEADER: "1" });
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

  test("a haiku alias starts Claude Code on the fast slot: status says so, --model warns", async () => {
    seed({ model: "haiku" });
    const result = await claudeAdapter.enable(enableInput({ model: MAIN, pinModel: true }));
    assert.equal(readSettings().model, "haiku");
    assert.equal(result.model, FAST);
    assert.match(result.warnings.join(" "), /still starts on your model setting \(haiku → /);
    assert.deepEqual(await claudeAdapter.probe(), { active: true, model: FAST });
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

  test("an alias reports its own slot, and a kept slot's smaller window lowers the cap", async () => {
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

  test("a kept startup model with a smaller window lowers the context cap", async () => {
    const SMALL = "qwen/qwen3.8-27b";
    const catalog = [...CATALOG, catalogModel(SMALL, { context_window: 32768 })];
    seed({ model: SMALL });
    await claudeAdapter.enable(enableInput({ catalog }));
    assert.equal(readSettings().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "32768");
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
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o600);
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
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const settings = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(settings.model, MAIN);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-launch-1");
    assert.equal(settings.modelPicker.options.length, CATALOG.length);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.aiand.com");
    assert.equal(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
    // Beat a switch or ANTHROPIC_MODEL set in the shell or a lower settings file.
    assert.equal(settings.env.CLAUDE_CODE_USE_BEDROCK, "0");
    assert.equal(settings.env.ANTHROPIC_MODEL, MAIN);
    await launch.cleanup();
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(settingsPath()), false, "user settings untouched");
  });

  test("a window smaller than the context cap wins over it", () => {
    const small = "openai/gpt-oss-120b";
    const settings = buildClaudeSettings({
      apiKey: "sk-x",
      baseUrl: "https://api.aiand.com",
      main: small,
      catalog: [...CATALOG, catalogModel(small, { context_window: 131072 })],
    });
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "131072");
  });

  test("buildClaudeSettings honours --model and a --base-url origin", () => {
    const settings = buildClaudeSettings({
      apiKey: "sk-x",
      baseUrl: "http://127.0.0.1:8787",
      main: OTHER,
      catalog: CATALOG,
    });
    assert.equal(settings.model, OTHER);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787");
    assert.deepEqual(settings.permissions.deny, ["WebSearch"]);
  });
});
