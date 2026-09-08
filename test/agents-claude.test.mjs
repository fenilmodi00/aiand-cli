import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { foreignMarkerFixtures } from "../dist/agents/foreign.js";
import { snapshotFiles, restoreSnapshot, hasSnapshot } from "../dist/agents/snapshot.js";

let dir;
const originalEnv = { ...process.env };

const BASE_KEY = "sk-test-key-for-claude-adapter-slice-20";
const BASE_URL = "https://api.aiand.com";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-claude-test-"));
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_API_KEY = BASE_KEY;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const { claudeAdapter } = await import("../dist/agents/claude.js");

function enableInput(overrides = {}) {
  return {
    apiKey: BASE_KEY,
    model: "zai-org/glm-5.3",
    slots: { opus: "m-opus", sonnet: "m-sonnet", haiku: "m-haiku" },
    catalog: [],
    home: process.env.AIAND_HOME,
    ...overrides,
  };
}

const settingsPath = () => join(process.env.AIAND_HOME, ".claude", "settings.json");
const claudeJsonPath = () => join(process.env.AIAND_HOME, ".claude.json");

describe("claude enable", () => {
  test("writes the env block (base url, auth token, slots) and preserves unrelated keys", async () => {
    mkdirSync(join(process.env.AIAND_HOME, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({ permissions: { allow: ["Bash*"] }, model: "legacy" }, null, 2) + "\n"
    );

    const result = await claudeAdapter.enable(enableInput());
    assert.deepEqual(result.filesWritten, [settingsPath()]);
    assert.equal(result.model, "zai-org/glm-5.3");

    const written = JSON.parse(readFileSync(settingsPath(), "utf8"));
    // unrelated top-level keys survive
    assert.deepEqual(written.model, "legacy");
    assert.deepEqual(written.permissions, { allow: ["Bash*"] });
    // env block carries our wiring
    assert.equal(written.env.ANTHROPIC_BASE_URL, BASE_URL);
    assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, BASE_KEY);
    assert.equal(written.env.ANTHROPIC_MODEL, "zai-org/glm-5.3");
    assert.equal(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "m-opus");
    assert.equal(written.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "m-sonnet");
    assert.equal(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "m-haiku");
    assert.equal(written.env.ANTHROPIC_SMALL_FAST_MODEL, "m-haiku");
  });

  test("conflicting env keys are cleared so ours win", async () => {
    mkdirSync(join(process.env.AIAND_HOME, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_API_KEY: "stale-key",
            CLAUDE_CODE_OAUTH_TOKEN: "stale-oauth",
            ANTHROPIC_DEFAULT_OPUS_MODEL: "stale-opus",
            ANTHROPIC_CUSTOM_MODEL_OPTION: "stale-custom",
            KEEP_ME: "user-value",
          },
        },
        null,
        2
      ) + "\n"
    );

    await claudeAdapter.enable(enableInput());

    const written = JSON.parse(readFileSync(settingsPath(), "utf8"));
    // ours win
    assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, BASE_KEY);
    assert.equal(written.env.ANTHROPIC_BASE_URL, BASE_URL);
    assert.equal(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "m-opus");
    // stale auth keys removed
    assert.equal(written.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(written.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(written.env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
    // unrelated env keys survive
    assert.equal(written.env.KEEP_ME, "user-value");
  });

  test("settings.json is written mode 0600 when it did not exist", async () => {
    const home = process.env.AIAND_HOME;
    const freshHome = join(home, "fresh-enable");
    process.env.AIAND_HOME = freshHome;

    await claudeAdapter.enable(enableInput());
    const path = join(freshHome, ".claude", "settings.json");
    assert.ok(existsSync(path), "settings.json created");
    assert.equal(statSync(path).mode & 0o777, 0o600);

    process.env.AIAND_HOME = home;
  });

  test("enable twice is idempotent (file content stable) and keeps mode 0600", async () => {
    mkdirSync(join(process.env.AIAND_HOME, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), "{}\n");

    await claudeAdapter.enable(enableInput());
    const first = readFileSync(settingsPath(), "utf8");
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o600);

    await claudeAdapter.enable(enableInput());
    const second = readFileSync(settingsPath(), "utf8");
    assert.equal(second, first, "second enable leaves the file untouched");
  });

  test("invalid planted JSON throws CliError with the delete hint", async () => {
    const home = process.env.AIAND_HOME;
    const brokenHome = join(home, "broken-settings");
    process.env.AIAND_HOME = brokenHome;
    mkdirSync(join(brokenHome, ".claude"), { recursive: true });
    writeFileSync(join(brokenHome, ".claude", "settings.json"), "{ not json");

    await assert.rejects(
      () => claudeAdapter.enable(enableInput()),
      (error) => {
        assert.equal(error.name, "CliError");
        assert.match(error.message, /is not valid JSON\./);
        assert.match(error.hint, /delete it and run aiand claude on again/);
        return true;
      }
    );

    process.env.AIAND_HOME = home;
  });
});

describe("claude native slot unpinning", () => {
  const settingsPathFor = (home) => join(home, ".claude", "settings.json");

  const plantAndEnable = async (overrides = {}, {
    opus = "vendor/opus",
    sonnet = "vendor/sonnet",
    haiku = "vendor/haiku",
  } = {}) => {
    const home = process.env.AIAND_HOME;
    const nativeHome = join(home, `native-${Math.random().toString(36).slice(2)}`);
    process.env.AIAND_HOME = nativeHome;
    mkdirSync(join(nativeHome, ".claude"), { recursive: true });
    // Start with managed slot vars planted so we can prove native not only
    // skips writing them but actively clears a previously-written value.
    writeFileSync(
      settingsPathFor(nativeHome),
      JSON.stringify({
        env: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: "stale-opus",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "stale-sonnet",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "stale-haiku",
          ANTHROPIC_SMALL_FAST_MODEL: "stale-small",
          ANTHROPIC_MODEL: "stale-model",
        },
      })
    );

    const result = await claudeAdapter.enable(
      enableInput({
        model: overrides.model ?? "zai-org/glm-5.3",
        slots: { opus, sonnet, haiku },
        ...overrides,
      })
    );
    const written = JSON.parse(readFileSync(settingsPathFor(nativeHome), "utf8"));
    process.env.AIAND_HOME = home;
    return { result, written };
  };

  test("a native slot flag leaves its managed var absent so Claude's own default wins", async () => {
    const { written } = await plantAndEnable({}, { opus: "native" });

    // opus unpinned: the stale managed var is gone and nothing replaces it.
    assert.equal(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
    // sibling slots still written.
    assert.equal(written.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "vendor/sonnet");
    assert.equal(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "vendor/haiku");
    assert.equal(written.env.ANTHROPIC_SMALL_FAST_MODEL, "vendor/haiku");
  });

  test("deleting any one managed slot var never leaves a sibling slot stale", async () => {
    const { written } = await plantAndEnable({}, { opus: "native", sonnet: "native" });

    assert.equal(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
    assert.equal(written.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
    assert.equal(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "vendor/haiku");
  });

  test("a native haiku also drops the mirrored ANTHROPIC_SMALL_FAST_MODEL", async () => {
    const { written } = await plantAndEnable({}, { haiku: "native" });

    assert.equal(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
    assert.equal(written.env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
    assert.equal(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "vendor/opus");
  });

  test("--model native leaves ANTHROPIC_MODEL absent", async () => {
    const { written } = await plantAndEnable({ model: "native" });

    assert.equal(written.env.ANTHROPIC_MODEL, undefined);
    // slots unaffected
    assert.equal(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "vendor/opus");
  });

  test("non-native values are still written and tagged [1m] on 1M-context models", async () => {
    const home = process.env.AIAND_HOME;
    const tagHome = join(home, `native-tag-${Math.random().toString(36).slice(2)}`);
    process.env.AIAND_HOME = tagHome;
    mkdirSync(join(tagHome, ".claude"), { recursive: true });
    writeFileSync(settingsPathFor(tagHome), "{}\n");

    const model = "vendor/million-model";
    const catalog = [modelFixture(model, 1_048_576, ["tools"])];
    await claudeAdapter.enable(enableInput({ catalog, model, slots: { opus: model, sonnet: model, haiku: model } }));

    const written = JSON.parse(readFileSync(settingsPathFor(tagHome), "utf8"));
    assert.equal(written.env.ANTHROPIC_MODEL, `${model}[1m]`);
    assert.equal(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL, `${model}[1m]`);
    assert.equal(written.env.ANTHROPIC_DEFAULT_SONNET_MODEL, `${model}[1m]`);
    assert.equal(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, `${model}[1m]`);
    assert.equal(written.env.ANTHROPIC_SMALL_FAST_MODEL, `${model}[1m]`);

    process.env.AIAND_HOME = home;
  });
});

describe("claude probe", () => {
  test("reports active when ANTHROPIC_BASE_URL matches, with its model", async () => {
    mkdirSync(join(process.env.AIAND_HOME, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_MODEL: "m-default" } })
    );

    const probe = await claudeAdapter.probe();
    assert.equal(probe.active, true);
    assert.equal(probe.model, "m-default");
    assert.equal(probe.foreignTool, null);
  });

  test("inactive on missing file, wrong base url, or invalid JSON", async () => {
    const home = process.env.AIAND_HOME;
    const cases = [
      () => {}, // settings.json absent
      () =>
        writeFileSync(
          settingsPath(),
          JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example.com" } })
        ),
      () => writeFileSync(settingsPath(), "{ broken"),
    ];
    for (const plant of cases) {
      const probeHome = join(home, `probe-${Math.random().toString(36).slice(2)}`);
      process.env.AIAND_HOME = probeHome;
      mkdirSync(join(probeHome, ".claude"), { recursive: true });
      plant();
      const probe = await claudeAdapter.probe();
      assert.equal(probe.active, false, "not active for this config");
      process.env.AIAND_HOME = home;
      rmSync(probeHome, { recursive: true, force: true });
    }
  });

  test("detects a foreign config writer via foreignMarkerFixtures", async () => {
    const home = process.env.AIAND_HOME;
    const foreignHome = join(home, "foreign-claude");
    process.env.AIAND_HOME = foreignHome;
    mkdirSync(join(foreignHome, ".claude"), { recursive: true });
    const fixtures = foreignMarkerFixtures();
    const [settingsFixture] = Object.values(fixtures);
    writeFileSync(join(foreignHome, ".claude", "settings.json"), settingsFixture);

    const probe = await claudeAdapter.probe();
    assert.equal(probe.active, false);
    assert.ok(probe.foreignTool, "a foreign tool must be reported");

    process.env.AIAND_HOME = home;
  });
});

describe("claude pre-approval", () => {
  test("adds the stray ANTHROPIC_API_KEY slice(-20) once, preserving unrelated keys", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-preapprove-some-long-key-material";
    const identifier = process.env.ANTHROPIC_API_KEY.trim().slice(-20);

    mkdirSync(join(process.env.AIAND_HOME, ".claude"), { recursive: true });
    writeFileSync(
      claudeJsonPath(),
      JSON.stringify({ installMethod: "autocomplete", customApiKeyResponses: { rejected: ["r1"] } })
    );

    await claudeAdapter.enable(enableInput());

    const first = JSON.parse(readFileSync(claudeJsonPath(), "utf8"));
    assert.deepEqual(first.installMethod, "autocomplete", "unrelated key survives");
    assert.deepEqual(first.customApiKeyResponses.rejected, ["r1"]);
    assert.deepEqual(first.customApiKeyResponses.approved, [identifier]);

    // second enable must not duplicate the approval
    await claudeAdapter.enable(enableInput());
    const second = JSON.parse(readFileSync(claudeJsonPath(), "utf8"));
    assert.deepEqual(second.customApiKeyResponses.approved, [identifier]);

    process.env.ANTHROPIC_API_KEY = key;
  });

  test("no-op when no stray key is in the env", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    if (existsSync(claudeJsonPath())) rmSync(claudeJsonPath(), { force: true });

    await claudeAdapter.enable(enableInput());

    assert.equal(existsSync(claudeJsonPath()), false, "~/.claude.json untouched");
    process.env.ANTHROPIC_API_KEY = key;
  });
});

describe("claude snapshot round-trip", () => {
  test("snapshot -> enable -> restore is byte-identical, deleting files that did not exist", async () => {
    const home = process.env.AIAND_HOME;
    const roundtripHome = join(home, "roundtrip");
    process.env.AIAND_HOME = roundtripHome;
    const settings = join(roundtripHome, ".claude", "settings.json");
    mkdirSync(join(roundtripHome, ".claude"), { recursive: true });
    const original = '{"permissions":{"allow":["Bash*"]}}\n';
    writeFileSync(settings, original);
    // ~/.claude.json did NOT exist before the enable
    assert.equal(existsSync(claudeJsonPath()), false);

    const files = claudeAdapter.managedFiles();
    await snapshotFiles("claude", files);
    assert.equal(await hasSnapshot("claude"), true);

    await claudeAdapter.enable(enableInput());
    assert.ok(existsSync(claudeJsonPath()), "pre-approval wrote ~/.claude.json");

    assert.equal(await restoreSnapshot("claude"), true);
    assert.equal(readFileSync(settings, "utf8"), original, "settings.json byte-identical");
    assert.equal(
      existsSync(claudeJsonPath()),
      false,
      "~/.claude.json (created after snapshot) is deleted on restore"
    );
    assert.equal(await hasSnapshot("claude"), false, "manifest dropped on restore");

    process.env.AIAND_HOME = home;
  });
});

describe("claude session launch", () => {
  const catalog = [{ id: "zai-org/glm-5.3" }];
  const launchInput = (model) => ({ apiKey: BASE_KEY, model, catalog });

  test("bakes base url, auth token, and model env with the managed clear list", async () => {
    const launch = await claudeAdapter.sessionLaunch(launchInput("m-run"));
    assert.equal(launch.env.ANTHROPIC_BASE_URL, BASE_URL);
    assert.equal(launch.env.ANTHROPIC_MODEL, "m-run");
    assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, BASE_KEY);
    assert.ok(launch.clear.includes("ANTHROPIC_API_KEY"));
    assert.ok(launch.clear.includes("ANTHROPIC_AUTH_TOKEN"));
    assert.ok(launch.clear.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  });

  test("resolves the model from the catalog when none is given", async () => {
    // Claude Code's own default (claude-opus-5) is not in the gateway
    // catalog, so the launch must always bake a catalog-valid model.
    const launch = await claudeAdapter.sessionLaunch(launchInput(undefined));
    assert.equal(launch.env.ANTHROPIC_MODEL, "zai-org/glm-5.3");
    assert.equal(launch.env.ANTHROPIC_BASE_URL, BASE_URL);
    assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, BASE_KEY);
  });

  test("tags a 1M-context model in the session env", async () => {
    const bigCatalog = [{ id: "vendor/million-model", context_window: 1_048_576 }];
    const launch = await claudeAdapter.sessionLaunch({
      apiKey: BASE_KEY,
      model: "vendor/million-model",
      catalog: bigCatalog,
    });
    assert.equal(launch.env.ANTHROPIC_MODEL, "vendor/million-model[1m]");
  });
});

/** A minimal catalog `Model` fixture shaped like GET /v1/models returns. */
function modelFixture(id, contextWindow, capabilities) {
  return {
    id,
    name: id,
    object: "model",
    created: 0,
    owned_by: "aiand",
    provider: "aiand",
    context_window: contextWindow,
    capabilities,
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: "1",
    output_per_1m: "1",
    cached_input_per_1m: null,
  };
}

describe("claude [1m] context tag", () => {
  const writeTagged = (catalog, model) =>
    claudeAdapter.enable(
      enableInput({
        catalog,
        model,
        slots: { opus: model, sonnet: model, haiku: model },
      })
    );

  test("a 1M-context model is written as <id>[1m] in every slot var", async () => {
    const home = process.env.AIAND_HOME;
    const tagHome = join(home, "context-tag");
    process.env.AIAND_HOME = tagHome;
    mkdirSync(join(tagHome, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), "{}\n");

    const model = "vendor/million-model";
    await writeTagged([modelFixture(model, 1_048_576, ["tools"])], model);

    const written = JSON.parse(readFileSync(settingsPath(), "utf8"));
    assert.equal(written.env.ANTHROPIC_MODEL, `${model}[1m]`);
    assert.equal(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL, `${model}[1m]`);
    assert.equal(written.env.ANTHROPIC_DEFAULT_SONNET_MODEL, `${model}[1m]`);
    assert.equal(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, `${model}[1m]`);
    assert.equal(written.env.ANTHROPIC_SMALL_FAST_MODEL, `${model}[1m]`);

    process.env.AIAND_HOME = home;
  });

  test("a 262144-context model is written bare in every slot var", async () => {
    const home = process.env.AIAND_HOME;
    const tagHome = join(home, "no-tag");
    process.env.AIAND_HOME = tagHome;
    mkdirSync(join(tagHome, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), "{}\n");

    const model = "vendor/small-model";
    await writeTagged([modelFixture(model, 262_144, ["tools"])], model);

    const written = JSON.parse(readFileSync(settingsPath(), "utf8"));
    assert.equal(written.env.ANTHROPIC_MODEL, model);
    assert.equal(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL, model);
    assert.equal(written.env.ANTHROPIC_DEFAULT_SONNET_MODEL, model);
    assert.equal(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, model);
    assert.equal(written.env.ANTHROPIC_SMALL_FAST_MODEL, model);

    process.env.AIAND_HOME = home;
  });
});

describe("claude refreshKey", () => {
  test("swaps only the baked token, preserving model ids, slots, and unrelated keys", async () => {
    const home = process.env.AIAND_HOME;
    const refreshHome = join(home, "refresh");
    process.env.AIAND_HOME = refreshHome;
    mkdirSync(join(refreshHome, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        permissions: { allow: ["Bash*"] },
        env: {
          ANTHROPIC_BASE_URL: BASE_URL,
          ANTHROPIC_AUTH_TOKEN: BASE_KEY,
          ANTHROPIC_MODEL: "m-default[1m]",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "m-opus",
          KEEP_ME: "user-value",
        },
      })
    );

    await claudeAdapter.refreshKey({ apiKey: "sk-new-refreshed-key", home: refreshHome });

    const written = JSON.parse(readFileSync(settingsPath(), "utf8"));
    assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, "sk-new-refreshed-key");
    assert.equal(written.env.ANTHROPIC_MODEL, "m-default[1m]", "model id untouched");
    assert.equal(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "m-opus", "slot untouched");
    assert.equal(written.permissions.allow[0], "Bash*", "unrelated key untouched");
    assert.equal(written.env.KEEP_ME, "user-value");

    // Idempotent: same key leaves the file untouched.
    await claudeAdapter.refreshKey({ apiKey: "sk-new-refreshed-key", home: refreshHome });
    assert.equal(
      readFileSync(settingsPath(), "utf8"),
      JSON.stringify(written, null, 2) + "\n",
      "refresh with the same key is a no-op"
    );

    process.env.AIAND_HOME = home;
  });
});

// ---------------------------------------------------------------------------
// Engine text-only warning: `agentOn` for claude emits a stderr warning naming
// every wired model (main + slots) that is text-only in the catalog. Runs the
// real engine against the real claude adapter with a stub binary for detection
// and an offline-seeded catalog cache, so nothing touches the network.
// ---------------------------------------------------------------------------
describe("claude agentOn text-only warning", () => {
  const modelFixture = (id, contextWindow, capabilities) => ({
    id,
    name: id,
    object: "model",
    created: 0,
    owned_by: "aiand",
    provider: "aiand",
    context_window: contextWindow,
    capabilities,
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: "1",
    output_per_1m: "1",
    cached_input_per_1m: null,
  });

  let engine;
  let origHome, origCfg, origKey, origPath;

  before(async () => {
    origHome = process.env.AIAND_HOME;
    origCfg = process.env.AIAND_CONFIG_DIR;
    origKey = process.env.AIAND_API_KEY;
    origPath = process.env.PATH;

    // A dedicated home + config dir so this suite owns its agents/cache.
    const winHome = join(dir, "warn-home");
    const winCfg = join(dir, "warn-cfg");
    process.env.AIAND_HOME = winHome;
    process.env.AIAND_CONFIG_DIR = winCfg;
    process.env.AIAND_API_KEY = BASE_KEY;
    mkdirSync(join(winHome, ".claude"), { recursive: true });
    mkdirSync(winCfg, { recursive: true });

    engine = await import("../dist/agents/setup.js");

    // Stub `claude` out front onto PATH so detection flags it installed.
    const stubDir = join(dir, "warn-bin");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(stubDir, "claude"), 0o755);
    process.env.PATH = `${stubDir}:${process.env.PATH}`;
  });

  after(() => {
    process.env.AIAND_HOME = origHome;
    process.env.AIAND_CONFIG_DIR = origCfg;
    if (origKey === undefined) delete process.env.AIAND_API_KEY;
    else process.env.AIAND_API_KEY = origKey;
    process.env.PATH = origPath;
  });

  const seedCatalog = (models, baseUrl = BASE_URL) => {
    // Fresh cache only matters when baseUrl matches resolveProfile().
    writeFileSync(
      join(process.env.AIAND_CONFIG_DIR, "model-catalog.json"),
      JSON.stringify({ fetchedAt: Date.now(), baseUrl, models })
    );
  };

  const runOn = (opts = {}) =>
    engine.agentOn(claudeAdapter, { baseUrl: BASE_URL, force: true, slots: {}, ...opts });

  test("a text-only wired model surfaces the exact warning line on the on result", async () => {
    // Main model vision-capable; haiku slot text-only (worst case: 2 handled,
    // 3 ids, deduped to one line).
    const vision = modelFixture("zai-org/vision-1m", 1_048_576, ["text", "vision"]);
    const textOnly = modelFixture("vendor/text-slot", 1_048_576, ["text"]);
    seedCatalog([vision, textOnly]);

    const result = await runOn({
      model: "zai-org/vision-1m",
      slots: { opus: "zai-org/vision-1m", sonnet: "vendor/text-slot", haiku: "vendor/text-slot" },
    });

    assert.equal(result.state, "on");
    assert.equal(result.warnings.length, 1);
    assert.equal(
      result.warnings[0],
      "Text-only: vendor/text-slot · Avoid images; recover with /rewind."
    );
  });

  test("no warning when every wired model is vision-capable", async () => {
    const vision = modelFixture("zai-org/vision-1m", 1_048_576, ["text", "vision"]);
    seedCatalog([vision]);

    const result = await runOn({
      model: "zai-org/vision-1m",
      slots: { opus: "zai-org/vision-1m", sonnet: "zai-org/vision-1m", haiku: "zai-org/vision-1m" },
    });

    assert.equal(result.state, "on");
    assert.deepEqual(result.warnings, []);
  });

  test("[1m]-tagged ids are stripped before the text-only lookup", async () => {
    // enable() writes [1m] for a 1M model; agentOn must strip it before the
    // catalog lookup so a text-only 1M main model still warns.
    const textOnlyMillion = modelFixture("zai-org/million-text", 1_048_576, ["text"]);
    seedCatalog([textOnlyMillion]);

    const result = await runOn({ model: "zai-org/million-text" });

    assert.equal(result.state, "on");
    assert.equal(result.warnings.length, 1);
    assert.equal(
      result.warnings[0],
      "Text-only: zai-org/million-text · Avoid images; recover with /rewind."
    );
  });

  test("the literal 'native' model and slot values bypass catalog validation", async () => {
    // Seed a catalog that does NOT contain "native" — agentOn must accept it
    // as the escape hatch instead of rejecting it as an unknown id.
    seedCatalog([modelFixture("zai-org/vision-1m", 262_144, ["vision"])]);

    const result = await runOn({
      model: "native",
      slots: { opus: "native", sonnet: "native", haiku: "native" },
    });

    assert.equal(result.state, "on");
    assert.equal(result.model, "native");
    // native names no model, so it must never surface a text-only warning.
    assert.deepEqual(result.warnings, []);
  });

  test("native never warns when mixed with a vision-capable slot", async () => {
    const vision = modelFixture("zai-org/vision-1m", 262_144, ["vision"]);
    seedCatalog([vision]);

    const result = await runOn({
      model: "native",
      slots: { opus: "native", sonnet: "native", haiku: "zai-org/vision-1m" },
    });

    assert.equal(result.state, "on");
    assert.deepEqual(result.warnings, []);
  });

  test("a non-native slot still validates against the catalog", async () => {
    seedCatalog([modelFixture("zai-org/vision-1m", 262_144, ["vision"])]);

    await assert.rejects(
      () => runOn({ model: "native", slots: { opus: "ghost/unknown" } }),
      (e) => {
        assert.equal(e.name, "CliError");
        assert.match(e.message, /--opus "ghost\/unknown" is not in the catalog/);
        return true;
      }
    );
  });
});