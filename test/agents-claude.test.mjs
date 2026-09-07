import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
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
  test("provides base url + model env and the managed clear list", () => {
    const launch = claudeAdapter.sessionLaunch("m-run");
    assert.equal(launch.env.ANTHROPIC_BASE_URL, BASE_URL);
    assert.equal(launch.env.ANTHROPIC_MODEL, "m-run");
    // token deliberately absent — the launcher injects it
    assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.ok(launch.clear.includes("ANTHROPIC_API_KEY"));
    assert.ok(launch.clear.includes("ANTHROPIC_AUTH_TOKEN"));
    assert.ok(launch.clear.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  });

  test("omits the model key when none is resolved", () => {
    const launch = claudeAdapter.sessionLaunch(undefined);
    assert.equal(launch.env.ANTHROPIC_MODEL, undefined);
    assert.equal(launch.env.ANTHROPIC_BASE_URL, BASE_URL);
  });
});