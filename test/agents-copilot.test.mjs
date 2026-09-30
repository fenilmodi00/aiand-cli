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

const {
  copilotAdapter,
  copilotProvidersPath,
  copilotSettingsPath,
  buildCopilotProvider,
  buildCopilotModelEntries,
} = await import("../dist/agents/copilot/adapter.js");
const { snapshotFiles } = await import("../dist/agents/snapshot.js");

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
      assert.deepEqual(launch.stripPassthroughFlags, ["--model"]);

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
