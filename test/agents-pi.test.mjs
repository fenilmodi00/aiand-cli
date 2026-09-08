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

import { snapshotFiles, restoreSnapshot, hasSnapshot } from "../dist/agents/snapshot.js";

let dir;
const originalEnv = { ...process.env };

const BASE_KEY = "sk-test-key-for-pi-adapter-slice-20";
const BASE_URL = "https://api.aiand.com/v1";
const DEFAULT_MODEL = "zai-org/glm-5.3";

// A fixture catalog exercising cost conversion (numbers, a zero, a missing
// cached price fallback) and reasoning/vision capability differences.
const CATALOG = [
  {
    id: "zai-org/glm-5.3",
    name: "GLM 5.3",
    object: "model",
    created: 1,
    owned_by: "zai-org",
    provider: "zai-org",
    context_window: 128000,
    capabilities: [],
    reasoning_efforts: ["low", "high"],
    reasoning_effort_default: "low",
    description: null,
    currency: "usd",
    input_per_1m: "0.60",
    output_per_1m: "2.50",
    cached_input_per_1m: "0.30",
  },
  {
    id: "moonshotai/kimi-k3",
    name: "Kimi K3",
    object: "model",
    created: 2,
    owned_by: "moonshotai",
    provider: "moonshotai",
    context_window: 262144,
    capabilities: ["vision"],
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: "0.00",
    output_per_1m: "1.00",
    cached_input_per_1m: null,
  },
];

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-pi-test-"));
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_API_KEY = BASE_KEY;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const { piAdapter } = await import("../dist/agents/pi.js");

function enableInput(overrides = {}) {
  return {
    apiKey: BASE_KEY,
    model: DEFAULT_MODEL,
    slots: {},
    catalog: CATALOG,
    home: process.env.AIAND_HOME,
    ...overrides,
  };
}

const p = {
  settings: () => join(process.env.AIAND_HOME, ".pi", "agent", "settings.json"),
  auth: () => join(process.env.AIAND_HOME, ".pi", "agent", "auth.json"),
  models: () => join(process.env.AIAND_HOME, ".pi", "agent", "models.json"),
};

describe("pi enable", () => {
  test("writes the three files with expected aiand blocks, preserving unrelated keys", async () => {
    mkdirSync(join(process.env.AIAND_HOME, ".pi", "agent"), { recursive: true });
    writeFileSync(
      p.settings(),
      JSON.stringify({ theme: "dark", model: "legacy" }, null, 2) + "\n"
    );
    writeFileSync(
      p.auth(),
      JSON.stringify({ other: { type: "api_key", key: "keep-me" } }, null, 2) + "\n"
    );
    writeFileSync(
      p.models(),
      JSON.stringify({ providers: { amazon: { baseUrl: "https://bedrock.example" } } }, null, 2) +
        "\n"
    );

    const result = await piAdapter.enable(enableInput());
    assert.deepEqual(result.model, DEFAULT_MODEL);
    assert.ok(
      result.filesWritten.includes(p.settings()),
      "settings.json in filesWritten"
    );
    assert.ok(result.filesWritten.includes(p.auth()), "auth.json in filesWritten");
    assert.ok(result.filesWritten.includes(p.models()), "models.json in filesWritten");

    const settings = JSON.parse(readFileSync(p.settings(), "utf8"));
    assert.equal(settings.defaultProvider, "aiand");
    assert.equal(settings.defaultModel, DEFAULT_MODEL);
    assert.deepEqual(settings.enabledModels, ["aiand/*"]);
    // unrelated keys survive
    assert.equal(settings.theme, "dark");
    assert.equal(settings.model, "legacy");

    const auth = JSON.parse(readFileSync(p.auth(), "utf8"));
    assert.deepEqual(auth.aiand, { type: "api_key", key: BASE_KEY, managedBy: "aiand" });
    // unrelated auth entry survives
    assert.deepEqual(auth.other, { type: "api_key", key: "keep-me" });

    const models = JSON.parse(readFileSync(p.models(), "utf8"));
    assert.ok(
      models.providers.amazon,
      "non-aiand provider survives"
    );
    assert.deepEqual(models.providers.amazon, { baseUrl: "https://bedrock.example" });
    assert.equal(models.providers.aiand.baseUrl, BASE_URL);
    assert.equal(models.providers.aiand.api, "openai-completions");
    assert.equal(models.providers.aiand.models.length, 2);
  });

  test("auth.json carries the key literal; models.json shape + cost numbers correct", async () => {
    mkdirSync(join(process.env.AIAND_HOME, ".pi", "agent"), { recursive: true });
    await piAdapter.enable(enableInput());

    const auth = JSON.parse(readFileSync(p.auth(), "utf8"));
    assert.equal(auth.aiand.key, BASE_KEY);

    const models = JSON.parse(readFileSync(p.models(), "utf8"));
    const [glm, kimi] = models.providers.aiand.models;
    // glm: reasoning true, text-only, exact cost numbers
    assert.deepEqual(glm, {
      id: "zai-org/glm-5.3",
      name: "GLM 5.3",
      reasoning: true,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.3, cacheWrite: 0 },
    });
    // kimi: no reasoning efforts, cached price falls back to input price
    assert.equal(kimi.reasoning, false);
    assert.deepEqual(kimi.cost, { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });
  });

  test("all three files are written mode 0600", async () => {
    const home = process.env.AIAND_HOME;
    const freshHome = join(home, "fresh-enable");
    process.env.AIAND_HOME = freshHome;

    await piAdapter.enable(enableInput());
    for (const path of [p.settings(), p.auth(), p.models()]) {
      assert.ok(existsSync(path), `${path} created`);
      assert.equal(statSync(path).mode & 0o777, 0o600, `${path} is 0600`);
    }

    process.env.AIAND_HOME = home;
  });

  test("invalid planted JSON in any file throws CliError", async () => {
    const home = process.env.AIAND_HOME;
    const brokenHome = join(home, "broken-settings");
    process.env.AIAND_HOME = brokenHome;
    mkdirSync(join(brokenHome, ".pi", "agent"), { recursive: true });
    writeFileSync(p.settings(), "{ not json");

    await assert.rejects(
      () => piAdapter.enable(enableInput()),
      (error) => {
        assert.equal(error.name, "CliError");
        assert.match(error.message, /is not valid JSON\./);
        assert.match(error.hint, /delete it and run aiand pi on again/);
        return true;
      }
    );

    process.env.AIAND_HOME = home;
  });
});

describe("pi probe", () => {
  test("inactive before enable (missing files)", async () => {
    const home = process.env.AIAND_HOME;
    const freshHome = join(home, "probe-before");
    process.env.AIAND_HOME = freshHome;

    const probe = await piAdapter.probe();
    assert.equal(probe.active, false);
    assert.equal(probe.model, null);

    process.env.AIAND_HOME = home;
  });

  test("active with model after enable", async () => {
    await piAdapter.enable(enableInput());

    const probe = await piAdapter.probe();
    assert.equal(probe.active, true);
    assert.equal(probe.model, DEFAULT_MODEL);
  });

  test("inactive when settings names a different provider or models.json lacks the provider", async () => {
    const home = process.env.AIAND_HOME;
    const caseA = join(home, "probe-other-provider");
    process.env.AIAND_HOME = caseA;
    mkdirSync(join(caseA, ".pi", "agent"), { recursive: true });
    writeFileSync(p.settings(), JSON.stringify({ defaultProvider: "other", defaultModel: "x" }));
    writeFileSync(p.models(), JSON.stringify({ providers: { other: {} } }));
    assert.equal((await piAdapter.probe()).active, false);

    const caseB = join(home, "probe-no-models-provider");
    process.env.AIAND_HOME = caseB;
    mkdirSync(join(caseB, ".pi", "agent"), { recursive: true });
    writeFileSync(p.settings(), JSON.stringify({ defaultProvider: "aiand", defaultModel: "x" }));
    writeFileSync(p.models(), JSON.stringify({ providers: {} }));
    assert.equal((await piAdapter.probe()).active, false);

    process.env.AIAND_HOME = home;
  });
});

describe("pi snapshot round-trip", () => {
  test("restores byte-identical originals, deleting files that did not exist", async () => {
    const home = process.env.AIAND_HOME;
    const roundtripHome = join(home, "roundtrip");
    process.env.AIAND_HOME = roundtripHome;
    mkdirSync(join(roundtripHome, ".pi", "agent"), { recursive: true });
    const originalSettings = '{"theme":"light"}\n';
    writeFileSync(p.settings(), originalSettings);
    // auth.json and models.json did NOT exist before enable
    assert.equal(existsSync(p.auth()), false);
    assert.equal(existsSync(p.models()), false);

    const files = piAdapter.managedFiles();
    await snapshotFiles("pi", files);
    assert.equal(await hasSnapshot("pi"), true);

    await piAdapter.enable(enableInput());
    assert.ok(existsSync(p.auth()), "enable wrote auth.json");
    assert.ok(existsSync(p.models()), "enable wrote models.json");

    assert.equal(await restoreSnapshot("pi"), true);
    assert.equal(readFileSync(p.settings(), "utf8"), originalSettings, "settings byte-identical");
    assert.equal(existsSync(p.auth()), false, "auth.json (created after snapshot) deleted");
    assert.equal(existsSync(p.models()), false, "models.json (created after snapshot) deleted");
    assert.equal(await hasSnapshot("pi"), false, "manifest dropped on restore");

    process.env.AIAND_HOME = home;
  });

  test("idempotent second enable keeps the first snapshot", async () => {
    const home = process.env.AIAND_HOME;
    const idemHome = join(home, "idempotent");
    process.env.AIAND_HOME = idemHome;
    mkdirSync(join(idemHome, ".pi", "agent"), { recursive: true });
    const originalSettings = '{"theme":"dark"}\n';
    writeFileSync(p.settings(), originalSettings);

    const files = piAdapter.managedFiles();
    await snapshotFiles("pi", files);
    await piAdapter.enable(enableInput());
    const firstSettings = readFileSync(p.settings(), "utf8");
    assert.ok(firstSettings.includes(`"defaultProvider": "aiand"`));

    // second enable with a different model must not re-snapshot
    await piAdapter.enable(enableInput({ model: "moonshotai/kimi-k3" }));
    assert.equal(await restoreSnapshot("pi"), true);
    assert.equal(
      readFileSync(p.settings(), "utf8"),
      originalSettings,
      "restore returns the original, not the second enable"
    );

    process.env.AIAND_HOME = home;
  });
});

describe("pi session launch", () => {
  test("returns empty env and clear (persistent wiring)", async () => {
    const launch = await piAdapter.sessionLaunch({ apiKey: BASE_KEY, model: DEFAULT_MODEL, catalog: CATALOG });
    assert.deepEqual(launch.env, {});
    assert.deepEqual(launch.clear, []);
  });

  test("returns the same empty result with no model (nothing depends on it)", async () => {
    const launch = await piAdapter.sessionLaunch({ apiKey: BASE_KEY, model: undefined, catalog: [] });
    assert.deepEqual(launch.env, {});
    assert.deepEqual(launch.clear, []);
  });
});

describe("pi managedFiles", () => {
  test("returns all three absolute paths under .pi/agent", () => {
    const files = piAdapter.managedFiles();
    assert.deepEqual(files, [p.settings(), p.auth(), p.models()]);
  });
});