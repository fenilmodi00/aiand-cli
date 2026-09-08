import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir, home, cfg;
const originalEnv = { ...process.env };

const K1 = "sk-test-sync-key-1";
const K2 = "sk-test-sync-key-2";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-sync-test-"));
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  delete process.env.AIAND_API_KEY;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const { claudeAdapter } = await import("../dist/agents/claude.js");
const { codexAdapter } = await import("../dist/agents/codex.js");
const { rebakeAgentKeys } = await import("../dist/agents/rebake.js");
const { registerAgent, AGENTS } = await import("../dist/agents/registry.js");

const claudeSettings = () => join(home, ".claude", "settings.json");

function enableClaude(key = K1, model = "m-default") {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(claudeSettings(), "{}\n");
  return claudeAdapter.enable({
    apiKey: key,
    model,
    slots: { opus: "m-opus", sonnet: "m-sonnet", haiku: "m-haiku" },
    catalog: [],
    home,
    baseUrl: "https://api.aiand.com",
  });
}

function enableCodex(key = K1, model = "codex-model") {
  mkdirSync(join(home, ".codex"), { recursive: true });
  return codexAdapter.enable({
    apiKey: key,
    model,
    slots: {},
    catalog: [],
    home,
    baseUrl: "https://api.aiand.com",
  });
}

describe("rebakeAgentKeys", () => {
  test("refreshes claude + codex literals, leaves models/slots untouched, skips active-no-refresh adapters, no notes for inactive", async () => {
    // Enable two adapters with K1, plus a fixture adapter that is active but
    // persists no refreshable key (the "re-run on" skip path).
    await enableClaude(K1, "m-default");
    await enableCodex(K1, "codex-model");

    const fixtureTag = "__sync_no_refresh__";
    const fixtureFile = join(home, ".sync-fixture", "state");
    mkdirSync(join(home, ".sync-fixture"), { recursive: true });
    writeFileSync(fixtureFile, "active\n");
    registerAgent({
      id: fixtureTag,
      label: "Sync Fixture",
      bin: fixtureTag,
      install: { command: "", url: "" },
      detect: () => ({ installed: true, path: fixtureFile }),
      managedFiles: () => [fixtureFile],
      probe: async () => ({
        // Active only when the marker lives under the CURRENT home, so the
        // fixture never leaks into tests that switch AIAND_HOME.
        active: existsSync(join(process.env.AIAND_HOME, ".sync-fixture", "state")),
        foreignTool: null,
        model: "fixture",
      }),
      enable: async () => ({ model: "fixture", filesWritten: [fixtureFile] }),
      disable: async () => undefined,
    });

    const beforeSettings = readFileSync(claudeSettings(), "utf8");
    const beforeCodex = readFileSync(join(home, ".codex", "config.toml"), "utf8");

    const notes = await rebakeAgentKeys(K2);

    // claude token swapped; models + slots + unrelated bytes untouched.
    assert.equal(readFileSync(claudeSettings(), "utf8") !== beforeSettings, true, "claude file rewritten");
    const claude = JSON.parse(readFileSync(claudeSettings(), "utf8"));
    assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, K2);
    assert.equal(claude.env.ANTHROPIC_MODEL, "m-default", "default slot untouched");
    assert.equal(claude.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "m-opus", "opus slot untouched");
    assert.equal(claude.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "m-sonnet");
    assert.equal(claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "m-haiku");

    // codex bearer token swapped; model id + provider block untouched.
    assert.notEqual(readFileSync(join(home, ".codex", "config.toml"), "utf8"), beforeCodex, "codex file rewritten");
    const codex = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    assert.match(codex, new RegExp(`experimental_bearer_token = "${K2}"`));
    assert.match(codex, /model = "codex-model"/, "codex model untouched");

    // claude + codex refreshed; fixture adapter skipped with the re-run guidance.
    const claudeNote = notes.find((n) => n.agent === "claude");
    const codexNote = notes.find((n) => n.agent === "codex");
    const skipNote = notes.find((n) => n.agent === fixtureTag);
    assert.equal(claudeNote?.state, "refreshed");
    assert.equal(codexNote?.state, "refreshed");
    assert.equal(skipNote?.state, "skipped");
    assert.match(skipNote.note, /Re-run `aiand __sync_no_refresh__ on`/);

    // No other agent produced a note: the rest of the registry is inactive here.
    for (const adapter of AGENTS) {
      if (adapter.id === "claude" || adapter.id === "codex" || adapter.id === fixtureTag) continue;
      assert.equal(notes.some((n) => n.agent === adapter.id), false, `${adapter.id} should have no note (inactive)`);
    }
  });

  test("produces no notes on a fresh home with nothing active", async () => {
    const freshHome = join(dir, "fresh");
    process.env.AIAND_HOME = freshHome;
    mkdirSync(freshHome, { recursive: true });
    const notes = await rebakeAgentKeys(K2);
    assert.deepEqual(notes, []);
  });

  test("is idempotent: a second rebake with the same key leaves files untouched", async () => {
    const freshHome = join(dir, "idempotent");
    process.env.AIAND_HOME = freshHome;
    mkdirSync(freshHome, { recursive: true });
    await enableClaude(K2, "m-default");

    const first = readFileSync(join(freshHome, ".claude", "settings.json"), "utf8");
    const notes = await rebakeAgentKeys(K2);
    assert.equal(notes.some((n) => n.agent === "claude" && n.state === "refreshed"), true);
    assert.equal(
      readFileSync(join(freshHome, ".claude", "settings.json"), "utf8"),
      first,
      "same key is a no-op"
    );

    process.env.AIAND_HOME = home;
  });
});

