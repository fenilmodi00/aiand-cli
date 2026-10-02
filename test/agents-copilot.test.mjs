// Copilot CLI adapter: providers.json BYOK wiring, settings.json model pin,
// and the throwaway COPILOT_HOME overlay the launcher injects.
// run-agent's launcher tests live in test/run-agent.test.mjs.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { enableInput as baseEnableInput, catalogModel, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-copilot-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(join(process.env.AIAND_HOME, ".copilot"), { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { copilotAdapter, copilotProvidersPath, copilotSettingsPath } = await import(
  "../dist/agents/copilot/adapter.js"
);
const { buildCopilotProvider, buildCopilotModelEntries } = await import(
  "../dist/agents/copilot/provider.js"
);
const { restoreSnapshot, snapshotFiles } = await import("../dist/agents/snapshot.js");

beforeEach(() => {
  rmSync(join(process.env.AIAND_HOME, ".copilot"), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "copilot"), {
    recursive: true,
    force: true,
  });
  mkdirSync(join(process.env.AIAND_HOME, ".copilot"), { recursive: true });
});

const CATALOG = [
  catalogModel("zai-org/glm-5.3", { capabilities: ["tools", "vision"] }),
  catalogModel("qwen/qwen3.8-27b", { reasoning_efforts: ["low", "high"] }),
];

const addedRecord = () => join(process.env.AIAND_CONFIG_DIR, "snapshots", "copilot", "added.json");

const enableInput = (overrides = {}) =>
  baseEnableInput({
    apiKey: "sk-enable-1",
    model: "zai-org/glm-5.3",
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    ...overrides,
  });

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Seed the two files the way a user's Copilot CLI would have them. */
function seedUserFiles() {
  writeJson(copilotProvidersPath(), {
    providers: [
      { name: "fireworks", type: "openai", baseUrl: "https://api.fireworks.ai/inference/v1" },
    ],
    models: [{ id: "kimi", provider: "fireworks", wireModel: "kimi-k2", name: "Kimi" }],
  });
  writeJson(copilotSettingsPath(), { theme: "dark", model: "gpt-5.1" });
  return {
    providers: readFileSync(copilotProvidersPath()),
    settings: readFileSync(copilotSettingsPath()),
  };
}

describe("copilot adapter", () => {
  test("id/label/bin/install/managedFiles", () => {
    assert.equal(copilotAdapter.id, "copilot");
    assert.equal(copilotAdapter.label, "GitHub Copilot");
    assert.equal(copilotAdapter.bin, "copilot");
    assert.equal(copilotAdapter.install.command, "npm install -g @github/copilot@1.0.89");
    assert.equal(
      copilotAdapter.install.url,
      "https://docs.github.com/en/copilot/get-started/cli-quickstart",
    );
    assert.deepEqual(copilotAdapter.managedFiles(), [
      copilotProvidersPath(),
      copilotSettingsPath(),
    ]);
  });

  test("COPILOT_HOME relocates both files; COPILOT_PROVIDERS_CONFIG wins for providers", () => {
    const elsewhere = join(process.env.AIAND_HOME, "elsewhere");
    process.env.COPILOT_HOME = elsewhere;
    try {
      assert.deepEqual(copilotAdapter.managedFiles(), [
        join(elsewhere, "providers.json"),
        join(elsewhere, "settings.json"),
      ]);
      const explicit = join(elsewhere, "custom-providers.json");
      process.env.COPILOT_PROVIDERS_CONFIG = explicit;
      assert.deepEqual(copilotAdapter.managedFiles(), [explicit, join(elsewhere, "settings.json")]);
    } finally {
      delete process.env.COPILOT_HOME;
      delete process.env.COPILOT_PROVIDERS_CONFIG;
    }
  });

  // PR #18 review: restore --force after a config-dir move —
  // managedFiles() must cover the recorded paths, not just the
  // current env's, or restoreSnapshot refuses them.
  test("managedFiles(): includes the recorded paths after the config dir moved", async () => {
    const elsewhere = join(process.env.AIAND_HOME, "elsewhere");
    process.env.COPILOT_HOME = elsewhere;
    try {
      mkdirSync(elsewhere, { recursive: true });
      seedUserFiles();
      await snapshotFiles("copilot", copilotAdapter.managedFiles());
      await copilotAdapter.enable(enableInput());
    } finally {
      delete process.env.COPILOT_HOME;
    }

    // Back in a shell without the relocation env: the widened list
    // still names both dirs' files, with no duplicates.
    assert.deepEqual(copilotAdapter.managedFiles(), [
      copilotProvidersPath(),
      copilotSettingsPath(),
      join(elsewhere, "providers.json"),
      join(elsewhere, "settings.json"),
    ]);

    // The manifest names the old dir's files; restore must accept
    // them instead of throwing "not a managed file".
    assert.equal(await restoreSnapshot("copilot", copilotAdapter.managedFiles()), true);
  });

  test("buildCopilotProvider: exact fields, nothing else", () => {
    assert.deepEqual(
      buildCopilotProvider({ apiKey: "sk-x", baseUrl: "https://api.aiand.com/v1" }),
      {
        name: "aiand",
        type: "openai",
        wireApi: "completions",
        baseUrl: "https://api.aiand.com/v1",
        apiKey: "sk-x",
      },
    );
  });

  test("buildCopilotModelEntries: catalog rows with the aiand provider", () => {
    const [first, second] = buildCopilotModelEntries(CATALOG);
    assert.deepEqual(first, {
      id: "zai-org/glm-5.3",
      provider: "aiand",
      wireModel: "zai-org/glm-5.3",
      name: "zai-org/glm-5.3",
      maxPromptTokens: 128000,
      maxContextWindowTokens: 128000,
    });
    assert.deepEqual(second.capabilities, { supports: { reasoningEffort: true } });
    assert.equal(second.maxPromptTokens, 128000);
  });

  test("enable(): wires provider + models + settings pin; keeps foreign rows", async () => {
    seedUserFiles();
    const result = await copilotAdapter.enable(enableInput());
    assert.deepEqual(result.filesWritten, [copilotProvidersPath(), copilotSettingsPath()]);
    assert.equal(result.model, "aiand/zai-org/glm-5.3");
    assert.equal(result.catalogModel, "zai-org/glm-5.3");

    const wired = readJson(copilotProvidersPath());
    assert.deepEqual(wired.providers[0], {
      name: "fireworks",
      type: "openai",
      baseUrl: "https://api.fireworks.ai/inference/v1",
    });
    assert.deepEqual(wired.providers[1], {
      name: "aiand",
      type: "openai",
      wireApi: "completions",
      baseUrl: "https://api.aiand.com/v1",
      apiKey: "sk-enable-1",
    });
    assert.equal(wired.models.length, 3);
    assert.equal(wired.models[0].provider, "fireworks");
    assert.equal(wired.models[1].id, "zai-org/glm-5.3");
    assert.equal(wired.models[1].provider, "aiand");
    assert.equal(readJson(copilotSettingsPath()).model, "aiand/zai-org/glm-5.3");
    assert.equal(readJson(copilotSettingsPath()).theme, "dark");

    if (process.platform !== "win32") {
      assert.equal(statSync(copilotProvidersPath()).mode & 0o777, 0o600);
    }
  });

  test("enable(): a file that did not exist is created private", async () => {
    await copilotAdapter.enable(enableInput());
    if (process.platform !== "win32") {
      assert.equal(statSync(copilotProvidersPath()).mode & 0o777, 0o600);
    }
  });

  test("enable(): --base-url maps to <url>/v1 (OpenAI-chat dialect)", async () => {
    await copilotAdapter.enable(enableInput({ baseUrl: "http://127.0.0.1:9/" }));
    assert.equal(readJson(copilotProvidersPath()).providers[0].baseUrl, "http://127.0.0.1:9/v1");
  });

  test("enable(): re-on replaces only our rows; foreign rows byte-stable in content", async () => {
    seedUserFiles();
    await copilotAdapter.enable(enableInput());
    const firstProviders = readJson(copilotProvidersPath()).providers.length;
    await copilotAdapter.enable(enableInput({ apiKey: "sk-enable-2" }));
    const wired = readJson(copilotProvidersPath());
    assert.equal(wired.providers.length, firstProviders);
    assert.equal(wired.providers[1].apiKey, "sk-enable-2");
    assert.equal(wired.models.length, 3);
  });

  test("enable(): re-on without --model keeps a servable aiand/ pick", async () => {
    seedUserFiles();
    await copilotAdapter.enable(enableInput());
    // The user switched to the other catalog model inside Copilot.
    writeJson(copilotSettingsPath(), {
      theme: "dark",
      model: "aiand/qwen/qwen3.8-27b",
    });
    const before = readFileSync(copilotSettingsPath());
    const result = await copilotAdapter.enable(enableInput());
    // The pick stays: settings.json is not rewritten, and the
    // record names no write of its own — off still restores the
    // first pre-aiand model, never the kept pick.
    assert.equal(readFileSync(copilotSettingsPath()).equals(before), true);
    assert.deepEqual(result.filesWritten, [copilotProvidersPath()]);
    assert.equal(readJson(copilotSettingsPath()).model, "aiand/qwen/qwen3.8-27b");
    assert.deepEqual(result.warnings, []);
    assert.equal(result.model, "aiand/qwen/qwen3.8-27b");
    assert.equal(result.catalogModel, "qwen/qwen3.8-27b");
    const added = readJson(addedRecord());
    assert.equal(added.wroteModelSelection, undefined);
    assert.equal(added.previousModelSelection, "gpt-5.1");
  });

  test("enable(): without --model a non-aiand model is set aside with a warning", async () => {
    seedUserFiles();
    const result = await copilotAdapter.enable(enableInput());
    assert.equal(readJson(copilotSettingsPath()).model, "aiand/zai-org/glm-5.3");
    assert.deepEqual(result.warnings, [
      "Set aside your model (gpt-5.1); aiand copilot off puts it back.",
    ]);
  });

  test("enable(): malformed providers.json errors with the fix-by-hand hint", async () => {
    writeFileSync(copilotProvidersPath(), "{ not json");
    await assert.rejects(
      copilotAdapter.enable(enableInput()),
      (error) =>
        error.message.includes("is not valid JSON") &&
        error.hint.includes("Fix it by hand") &&
        error.hint.includes("aiand copilot on again"),
    );
  });

  test("enable(): refuses a foreign unroutable provider named aiand", async () => {
    writeJson(copilotProvidersPath(), {
      providers: [{ name: "aiand", type: "openai", baseUrl: "ftp://elsewhere.invalid" }],
    });
    await assert.rejects(
      copilotAdapter.enable(enableInput()),
      (error) =>
        error.message.includes("named aiand that ai& does not manage") &&
        error.hint.includes("aiand copilot on again"),
    );
    assert.equal(readJson(copilotProvidersPath()).providers.length, 1);
  });

  test("enable(): native leaves settings.json untouched and warns", async () => {
    const seed = seedUserFiles();
    const result = await copilotAdapter.enable(enableInput({ model: "native" }));
    assert.equal(result.model, "native");
    assert.equal(result.catalogModel, undefined);
    assert.deepEqual(result.warnings, [
      "Copilot CLI has no built-in BYOK default: it uses whatever model its settings already name.",
    ]);
    assert.equal(readFileSync(copilotSettingsPath()).equals(seed.settings), true);
    assert.equal(readJson(copilotSettingsPath()).model, "gpt-5.1");
  });

  test("enable(): native with no settings.json creates no empty file", async () => {
    // The command layer snapshots before the first write; seed that here so
    // the manifest records providers.json did not exist and off can unlink it.
    await snapshotFiles("copilot", copilotAdapter.managedFiles());
    const result = await copilotAdapter.enable(enableInput({ model: "native" }));
    assert.deepEqual(result.filesWritten, [copilotProvidersPath()]);
    assert.equal(existsSync(copilotSettingsPath()), false);
    await copilotAdapter.disable();
    assert.equal(existsSync(copilotProvidersPath()), false);
  });

  test("probe(): absent config is inactive with no model", async () => {
    const result = await copilotAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): enabled config reads active with the bare catalog model", async () => {
    await copilotAdapter.enable(enableInput());
    const result = await copilotAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, "zai-org/glm-5.3");
  });

  test("probe(): foreign aiand-named row and malformed files never read active", async () => {
    writeJson(copilotProvidersPath(), {
      providers: [{ name: "aiand", baseUrl: "ftp://elsewhere.invalid", apiKey: "k" }],
    });
    assert.equal((await copilotAdapter.probe()).active, false);
    writeJson(copilotProvidersPath(), {
      providers: [{ name: "aiand", baseUrl: "https://api.aiand.com/v1" }],
    });
    assert.equal((await copilotAdapter.probe()).active, false, "no string apiKey");
    writeFileSync(copilotProvidersPath(), "{ broken");
    assert.deepEqual(await copilotAdapter.probe(), { active: false, model: null });
  });

  test("probe(): a foreign settings model reports no model", async () => {
    await copilotAdapter.enable(enableInput());
    writeJson(copilotSettingsPath(), { theme: "dark", model: "gpt-5.1" });
    const result = await copilotAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, null);
  });

  test("disable(): strips exactly our rows and hands back the edited-away model", async () => {
    const seed = seedUserFiles();
    await copilotAdapter.enable(enableInput());
    const result = await copilotAdapter.disable();
    assert.equal(result.stripped, true);
    // Byte-identity against the seed pins both halves at once: our rows
    // are gone and the user's rows kept (the pi precedent asserts bytes
    // only).
    assert.equal(readFileSync(copilotProvidersPath()).equals(seed.providers), true);
    assert.equal(readFileSync(copilotSettingsPath()).equals(seed.settings), true);
  });

  test("disable(): a file on created is unlinked when nothing is left", async () => {
    await snapshotFiles("copilot", copilotAdapter.managedFiles());
    await copilotAdapter.enable(enableInput());
    await copilotAdapter.disable();
    assert.equal(existsSync(copilotProvidersPath()), false);
    assert.equal(existsSync(copilotSettingsPath()), false);
  });

  test("disable(): user-edited settings model is left with a note", async () => {
    seedUserFiles();
    await copilotAdapter.enable(enableInput());
    writeJson(copilotSettingsPath(), { theme: "dark", model: "gpt-5.1" });
    const result = await copilotAdapter.disable();
    assert.deepEqual(result.notes, ["left model because you edited it"]);
    assert.equal(readJson(copilotSettingsPath()).model, "gpt-5.1");
  });

  test("disable(): a dangling aiand/ pick made after on is still undone", async () => {
    // The user switched models inside Copilot: a different aiand/ ref than
    // the one on wrote. off deletes every row that could serve it, so the
    // value is ours to undo — a bare launch must not dangle on a dead
    // provider.
    const seed = seedUserFiles();
    await copilotAdapter.enable(enableInput());
    writeJson(copilotSettingsPath(), { theme: "dark", model: "aiand/qwen/qwen3.8-27b" });
    const result = await copilotAdapter.disable();
    assert.equal(result.stripped, true);
    assert.deepEqual(result.notes, []);
    assert.equal(readFileSync(copilotSettingsPath()).equals(seed.settings), true);
  });

  test("disable(): foreign unroutable aiand row stays untouched", async () => {
    writeJson(copilotProvidersPath(), {
      providers: [{ name: "aiand", type: "openai", baseUrl: "ftp://elsewhere.invalid" }],
      models: [{ id: "x", provider: "aiand" }],
    });
    const result = await copilotAdapter.disable();
    assert.equal(result.stripped, false);
    assert.equal(readJson(copilotProvidersPath()).providers.length, 1);
    assert.equal(readJson(copilotProvidersPath()).models.length, 1);
  });

  test("disable(): a malformed settings.json blocks before providers is touched", async () => {
    await copilotAdapter.enable(enableInput());
    writeFileSync(copilotSettingsPath(), "{ broken");
    const providersBefore = readFileSync(copilotProvidersPath());
    const result = await copilotAdapter.disable();
    assert.equal(result.stripped, false);
    assert.match(
      result.notes[0],
      /settings\.json is not valid JSON; fix it, then run aiand copilot off again/,
    );
    assert.equal(readFileSync(copilotProvidersPath()).equals(providersBefore), true);
  });

  test("disable(): malformed providers.json keeps the record and notes", async () => {
    await copilotAdapter.enable(enableInput());
    writeFileSync(copilotProvidersPath(), "{ broken");
    const result = await copilotAdapter.disable();
    assert.equal(result.stripped, false);
    assert.match(result.notes[0], /not valid JSON; fix it, then run aiand copilot off again/);
  });

  test("off restores the file's pre-on mode; a file on created stays private", async () => {
    seedUserFiles();
    chmodSync(copilotProvidersPath(), 0o640);
    await copilotAdapter.enable(enableInput());
    await copilotAdapter.disable();
    if (process.platform !== "win32") {
      assert.equal(statSync(copilotProvidersPath()).mode & 0o777, 0o640);
    }
  });

  test("refreshKey: swaps only the apiKey literal; previousKey gates", async () => {
    seedUserFiles();
    await copilotAdapter.enable(enableInput());
    const settingsBefore = readFileSync(copilotSettingsPath());
    const providersBefore = readJson(copilotProvidersPath());

    assert.equal(await copilotAdapter.refreshKey({ apiKey: "sk-enable-1" }), true);
    assert.equal(
      await copilotAdapter.refreshKey({ apiKey: "sk-new", previousKey: "sk-other" }),
      false,
    );
    assert.equal(
      await copilotAdapter.refreshKey({ apiKey: "sk-new", previousKey: "sk-enable-1" }),
      true,
    );

    const wired = readJson(copilotProvidersPath());
    assert.equal(wired.providers[1].apiKey, "sk-new");
    assert.deepEqual(wired.providers[0], providersBefore.providers[0]);
    assert.deepEqual(Object.keys(wired.providers[1]), Object.keys(providersBefore.providers[1]));
    assert.equal(readFileSync(copilotSettingsPath()).equals(settingsBefore), true);
  });

  test("refreshKey: no file, foreign row, or missing key returns false", async () => {
    assert.equal(await copilotAdapter.refreshKey({ apiKey: "sk-new" }), false);
    writeJson(copilotProvidersPath(), {
      providers: [{ name: "aiand", baseUrl: "ftp://elsewhere.invalid", apiKey: "sk-foreign" }],
    });
    assert.equal(await copilotAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.equal(readJson(copilotProvidersPath()).providers[0].apiKey, "sk-foreign");
  });

  // PR #18 review: a hand-broken providers.json rides every
  // rebake path (login, config use, rotation) — refreshKey must
  // report untouched, not throw the shared invalid-JSON error
  // out of rebakeAgentKeys.
  test("refreshKey(): a malformed providers.json is false, not a throw", async () => {
    writeFileSync(copilotProvidersPath(), "{broken");
    assert.equal(await copilotAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.equal(readFileSync(copilotProvidersPath(), "utf8"), "{broken");
  });

  // PR #18 review: routability alone is not ownership
  // (P18-cop-1). A user-repointed routable `aiand` row —
  // no record names its baseUrl — is the user's: status
  // reads inactive, on refuses, off leaves it with a
  // note, and refresh-key never touches its key.
  test("a routable aiand row no record proves is the user's", async () => {
    writeJson(copilotProvidersPath(), {
      providers: [{ name: "aiand", baseUrl: "https://my-proxy.example/v1", apiKey: "sk-user" }],
    });
    writeJson(copilotSettingsPath(), { model: "aiand/zai-org/glm-5.3" });

    assert.equal((await copilotAdapter.probe()).active, false);
    await assert.rejects(
      copilotAdapter.enable(enableInput()),
      (error) =>
        error.message.includes("named aiand that ai& does not manage") &&
        error.hint.includes("aiand copilot on again"),
    );

    const providersBefore = readFileSync(copilotProvidersPath());
    const settingsBefore = readFileSync(copilotSettingsPath());
    const off = await copilotAdapter.disable();
    assert.equal(off.stripped, false);
    assert.deepEqual(off.notes, ["left the aiand provider because you edited it"]);
    assert.equal(readFileSync(copilotProvidersPath()).equals(providersBefore), true);
    assert.equal(readFileSync(copilotSettingsPath()).equals(settingsBefore), true);

    assert.equal(await copilotAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.equal(readFileSync(copilotProvidersPath()).equals(providersBefore), true);
  });

  // PR #18 review: the settings hand-back runs whenever a
  // record is live, even when the user hand-deleted the
  // provider row — the `aiand/<id>` pin must not dangle
  // once the record is cleared (P18-cop-3).
  test("disable(): hands back the settings pin after the user deleted the row", async () => {
    const seed = seedUserFiles();
    await copilotAdapter.enable(enableInput());
    // The user hand-deleted our provider row (and its model
    // rows) but kept the selection pin on our model.
    writeJson(copilotProvidersPath(), {
      providers: [
        { name: "fireworks", type: "openai", baseUrl: "https://api.fireworks.ai/inference/v1" },
      ],
      models: [{ id: "kimi", provider: "fireworks", wireModel: "kimi-k2", name: "Kimi" }],
    });
    const result = await copilotAdapter.disable();
    assert.equal(result.stripped, true);
    assert.deepEqual(result.notes, []);
    assert.equal(readFileSync(copilotProvidersPath()).equals(seed.providers), true);
    assert.equal(readFileSync(copilotSettingsPath()).equals(seed.settings), true);
  });

  // PR #18 review: a state-dir wipe (no record) leaves our
  // own baked row provable by shape alone: on re-claims it
  // and off strips it, like hermes' marked-without-record
  // path (P18-cop-1).
  test("disable(): a baked-shaped row with no record still strips", async () => {
    const seed = seedUserFiles();
    await copilotAdapter.enable(enableInput());
    // Wipe the record the way a lost state dir would.
    rmSync(addedRecord(), { force: true });
    const result = await copilotAdapter.disable();
    assert.equal(result.stripped, true);
    assert.deepEqual(result.notes, []);
    assert.equal(readFileSync(copilotProvidersPath()).equals(seed.providers), true);
    // No record: the pre-on selection is unknown, so the
    // pin is deleted rather than restored.
    assert.deepEqual(readJson(copilotSettingsPath()), { theme: "dark" });
  });

  // PR #18 review: relocated config dir orphaned the baked key
  test("disable(): strips the recorded files when COPILOT_HOME moved", async () => {
    // Capture the pre-move paths: copilotProvidersPath() is env-dependent,
    // so the asserts below must read the OLD dir the recorded paths name.
    const oldProviders = copilotProvidersPath();
    const oldSettings = copilotSettingsPath();
    const seed = seedUserFiles();
    await copilotAdapter.enable(enableInput());
    // The user relocated the Copilot config dir between `on` and `off`; the
    // moved dir need not exist — off must still honor the recorded paths.
    process.env.COPILOT_HOME = join(process.env.AIAND_HOME, "moved");
    try {
      const result = await copilotAdapter.disable();
      assert.equal(result.stripped, true);
      assert.equal(readFileSync(oldProviders).equals(seed.providers), true);
      assert.equal(readFileSync(oldSettings).equals(seed.settings), true);
      assert.ok(result.notes.some((n) => n.includes("config dir moved")));
      assert.equal(existsSync(addedRecord()), false);
    } finally {
      delete process.env.COPILOT_HOME;
    }
  });

  test("disable(): unparseable relocated providers.json keeps the record for retry", async () => {
    const oldProviders = copilotProvidersPath();
    seedUserFiles();
    await copilotAdapter.enable(enableInput());
    // Capture our wired providers.json so the retry can restore a readable file.
    const wiredProviders = readFileSync(oldProviders);
    process.env.COPILOT_HOME = join(process.env.AIAND_HOME, "moved");
    try {
      // providers.json is the first stale file off reads, and it is
      // unreadable: nothing was stripped yet, so stripped stays false and
      // the record survives for the retry.
      writeFileSync(oldProviders, "{broken");
      const result = await copilotAdapter.disable();
      assert.equal(result.stripped, false);
      assert.ok(
        result.notes.some((n) => n.includes("is not valid JSON") && n.includes(oldProviders)),
      );
      assert.equal(existsSync(addedRecord()), true);

      // The user fixes the old providers.json; the retry strips and clears it.
      writeFileSync(oldProviders, wiredProviders);
      const retry = await copilotAdapter.disable();
      assert.equal(retry.stripped, true);
      assert.equal(existsSync(addedRecord()), false);
    } finally {
      delete process.env.COPILOT_HOME;
    }
  });

  test("added state never stores the key", async () => {
    await copilotAdapter.enable(enableInput());
    const added = readFileSync(
      join(process.env.AIAND_CONFIG_DIR, "snapshots", "copilot", "added.json"),
      "utf8",
    );
    assert.doesNotMatch(added, /sk-enable-1/);
  });

  const sessionInput = () => ({
    apiKey: "sk-session-1",
    model: "zai-org/glm-5.3",
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
  });

  test("sessionLaunch: overlay dirs + qualified model env, key only in the overlay file", async () => {
    const launch = await copilotAdapter.sessionLaunch(sessionInput());
    try {
      assert.match(launch.env.COPILOT_HOME, /aiand-copilot-/);
      assert.equal(launch.env.COPILOT_MODEL, "aiand/zai-org/glm-5.3");
      assert.equal(launch.env.COPILOT_OFFLINE, "true");
      assert.deepEqual(launch.args, ["--no-auto-update"]);
      assert.equal(
        launch.env.COPILOT_PROVIDERS_CONFIG,
        join(launch.env.COPILOT_HOME, "providers.json"),
        "an inherited COPILOT_PROVIDERS_CONFIG cannot outrank the overlay",
      );

      const overlayProviders = readJson(join(launch.env.COPILOT_HOME, "providers.json"));
      assert.equal(overlayProviders.providers[0].apiKey, "sk-session-1");
      assert.equal(overlayProviders.models.length, CATALOG.length);
      assert.equal(
        readJson(join(launch.env.COPILOT_HOME, "settings.json")).model,
        "aiand/zai-org/glm-5.3",
      );
      if (process.platform !== "win32") {
        assert.equal(statSync(join(launch.env.COPILOT_HOME, "providers.json")).mode & 0o777, 0o600);
      }
    } finally {
      await launch.cleanup();
    }
    assert.equal(existsSync(launch.env.COPILOT_HOME), false);
  });

  test("sessionLaunch: omitted model resolves from the catalog", async () => {
    const launch = await copilotAdapter.sessionLaunch({ ...sessionInput(), model: undefined });
    try {
      assert.equal(launch.env.COPILOT_MODEL, "aiand/zai-org/glm-5.3");
    } finally {
      await launch.cleanup();
    }
  });

  test("adapter surface: the proven shadowEnv", () => {
    // Literal list, each name proven against the installed
    // binary (see the comment on copilotAdapter.shadowEnv).
    assert.deepEqual(copilotAdapter.shadowEnv, [
      "COPILOT_PROVIDER_API_KEY",
      "COPILOT_PROVIDER_API_KEY_COMMAND",
      "COPILOT_PROVIDER_AZURE_API_VERSION",
      "COPILOT_PROVIDER_BASE_URL",
      "COPILOT_PROVIDER_BEARER_TOKEN",
      "COPILOT_PROVIDER_GHES_HOST",
      "COPILOT_PROVIDER_GHES_TOKEN",
      "COPILOT_PROVIDER_HEADERS",
      "COPILOT_PROVIDER_MAX_OUTPUT_TOKENS",
      "COPILOT_PROVIDER_MAX_PROMPT_TOKENS",
      "COPILOT_PROVIDER_MODEL_ID",
      "COPILOT_PROVIDER_TRANSPORT",
      "COPILOT_PROVIDER_TYPE",
      "COPILOT_PROVIDER_WIRE_API",
      "COPILOT_PROVIDER_WIRE_MODEL",
    ]);
  });

  test("sessionLaunch: a failed overlay write removes the throwaway dir", async () => {
    const sandboxTmp = join(process.env.AIAND_HOME, "tmp");
    mkdirSync(sandboxTmp, { recursive: true });
    process.env.TMPDIR = sandboxTmp;
    try {
      const boom = [
        {
          get id() {
            throw new Error("catalog render failed");
          },
        },
      ];
      await assert.rejects(copilotAdapter.sessionLaunch({ ...sessionInput(), catalog: boom }));
      assert.deepEqual(
        readdirSync(sandboxTmp).filter((name) => name.startsWith("aiand-copilot-")),
        [],
      );
    } finally {
      delete process.env.TMPDIR;
    }
  });
});
