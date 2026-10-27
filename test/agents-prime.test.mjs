import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { enableInput as baseEnableInput, catalogModel, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-prime-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { primeAdapter } = await import("../dist/agents/prime/adapter.js");
const { CliError } = await import("../dist/cli/errors.js");

const GLM = "zai-org/glm-5.3";
const VISION = "qwen/qwen3.8-27b";
const CATALOG = [
  catalogModel(GLM),
  catalogModel(VISION, { capabilities: ["tool_calling", "vision"] }),
];

const agentDir = () => join(process.env.AIAND_HOME, ".prime", "agent");
const modelsPath = () => join(agentDir(), "models.json");
const settingsPath = () => join(agentDir(), "settings.json");
const snapshotsDir = () => join(process.env.AIAND_CONFIG_DIR, "snapshots", "prime");

const readModels = (path = modelsPath()) => JSON.parse(readFileSync(path, "utf8"));
const readSettings = (path = settingsPath()) => JSON.parse(readFileSync(path, "utf8"));

const enableInput = (overrides = {}) =>
  baseEnableInput({
    apiKey: "sk-enable-1",
    model: GLM,
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    ...overrides,
  });

const mode = (path) => statSync(path).mode & 0o777;

beforeEach(() => {
  rmSync(agentDir(), { recursive: true, force: true });
  rmSync(snapshotsDir(), { recursive: true, force: true });
});

describe("prime install hint", () => {
  test("pins the release and never pipes the mutable installer", () => {
    const { command } = primeAdapter.install;
    // The maintainer rejected `curl ... install.sh | sh` on the sibling
    // adapters: a mutable main-branch script with no digest. The hint instead
    // downloads the pinned release asset and verifies its published sha256.
    assert.doesNotMatch(command, /install\.sh \| sh/);
    if (process.platform !== "win32") {
      assert.match(command, /releases\/download\/v0\.9\.8\//);
      assert.match(command, /sha256sum -c -|shasum -a 256 -c -/);
    }
  });
});

describe("prime probe", () => {
  test("absent config is inactive with no model", async () => {
    assert.deepEqual(await primeAdapter.probe(), { active: false, model: null });
  });

  test("garbage models.json is inactive, no throw", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(modelsPath(), "not json {{{");
    assert.deepEqual(await primeAdapter.probe(), { active: false, model: null });
  });

  test("a foreign aiand provider without the marker is inactive", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(
      modelsPath(),
      JSON.stringify({
        providers: { aiand: { baseUrl: "https://api.aiand.com/v1", apiKey: "sk-theirs" } },
      }),
    );
    assert.deepEqual(await primeAdapter.probe(), { active: false, model: null });
  });

  test("marked provider with a routable baseUrl is active; the pair reports the model", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(
      modelsPath(),
      JSON.stringify({
        providers: {
          aiand: {
            baseUrl: "https://api.aiand.com/v1",
            apiKey: "sk-enable-1",
            "x-aiand": true,
          },
        },
      }),
    );
    writeFileSync(settingsPath(), JSON.stringify({ defaultProvider: "aiand", defaultModel: GLM }));
    const result = await primeAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, `aiand/${GLM}`);
  });

  test("a marked provider pointing at a non-routable baseUrl is inactive", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(
      modelsPath(),
      JSON.stringify({
        providers: {
          aiand: { baseUrl: "http://insecure.test/v1", apiKey: "sk-x", "x-aiand": true },
        },
      }),
    );
    assert.equal((await primeAdapter.probe()).active, false);
  });
});

describe("prime on", () => {
  test("writes the marker, the /v1 route, the key, and keeps unrelated keys", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(
      modelsPath(),
      `${JSON.stringify({ theme: "dark", providers: { other: { baseUrl: "https://o" } } }, null, 2)}\n`,
    );
    const result = await primeAdapter.enable(enableInput());
    assert.deepEqual(
      result.filesWritten,
      [modelsPath(), settingsPath()],
      "models.json and the settings pair both land",
    );
    const config = readModels();
    assert.equal(config.theme, "dark");
    assert.deepEqual(config.providers.other, { baseUrl: "https://o" });
    const aiand = config.providers.aiand;
    assert.equal(aiand["x-aiand"], true, "ownership marker");
    assert.equal(aiand.apiKey, "sk-enable-1", "baked session key");
    assert.equal(aiand.baseUrl, "https://api.aiand.com/v1", "the gateway /v1 route");
    assert.equal(aiand.api, "openai-completions");
    assert.equal(aiand.models.length, CATALOG.length, "every catalog model");
    const entry = aiand.models.find((model) => model.id === VISION);
    assert.deepEqual(entry.input, ["text", "image"], "vision capability maps to image input");
    assert.deepEqual(entry.cost, { input: 0.6, output: 2.2, cacheRead: 0, cacheWrite: 0 });
    assert.equal(entry.contextWindow, 128000);
    assert.equal(entry.maxTokens, 128000);
    assert.deepEqual(readSettings(), { defaultProvider: "aiand", defaultModel: GLM });
    assert.equal(result.model, `aiand/${GLM}`);
    assert.equal(result.catalogModel, GLM);
  });

  test("models.json is written 0600 (it holds the key)", async () => {
    const enabled = await primeAdapter.enable(enableInput());
    assert.deepEqual(enabled.filesWritten, [modelsPath(), settingsPath()]);
    assert.equal(mode(modelsPath()), 0o600);
    assert.equal(mode(settingsPath()), 0o644, "settings.json holds no key");
  });

  test("a --base-url routes <base>/v1 (the binary appends /chat/completions)", async () => {
    await primeAdapter.enable(enableInput({ baseUrl: "http://127.0.0.1:9/" }));
    assert.equal(readModels().providers.aiand.baseUrl, "http://127.0.0.1:9/v1");
  });

  test("on refuses a foreign aiand provider and leaves it untouched", async () => {
    mkdirSync(agentDir(), { recursive: true });
    const foreign = { providers: { aiand: { baseUrl: "https://theirs.test/v1", apiKey: "k" } } };
    writeFileSync(modelsPath(), JSON.stringify(foreign));
    await assert.rejects(() => primeAdapter.enable(enableInput()), CliError);
    assert.deepEqual(readModels(), foreign);
  });

  test("an existing model pair is kept without --model; --model switches and set-asides", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({ defaultProvider: "openrouter", defaultModel: "x/y" }),
    );
    const kept = await primeAdapter.enable(enableInput());
    assert.deepEqual(readSettings(), { defaultProvider: "openrouter", defaultModel: "x/y" });
    assert.match(kept.warnings.join(" "), /Left your existing model \(openrouter\/x\/y\)/);

    const pinned = await primeAdapter.enable(enableInput({ model: VISION, pinModel: true }));
    assert.deepEqual(readSettings(), { defaultProvider: "aiand", defaultModel: VISION });
    assert.match(pinned.warnings.join(" "), /Set aside your model \(openrouter\/x\/y\)/);
    assert.equal(pinned.catalogModel, VISION);
  });

  test("native leaves the model unpinned and writes no pair", async () => {
    const result = await primeAdapter.enable(enableInput({ model: "native" }));
    assert.equal(result.model, "native");
    assert.equal(result.catalogModel, undefined);
    assert.equal(existsSync(settingsPath()), false, "no pair written");
    assert.equal(readModels().providers.aiand["x-aiand"], true, "the route still lands");
  });

  test("re-on keeps the first set-aside target", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({ defaultProvider: "openrouter", defaultModel: "x/y" }),
    );
    await primeAdapter.enable(enableInput({ pinModel: true }));
    await primeAdapter.enable(enableInput({ model: VISION, pinModel: true }));
    await primeAdapter.disable();
    assert.deepEqual(readSettings(), { defaultProvider: "openrouter", defaultModel: "x/y" });
  });
});

describe("prime off", () => {
  test("keeps the record and leaves settings alone when settings.json will not parse", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(modelsPath(), '{"theme":"dark"}\n');
    await primeAdapter.enable(enableInput());
    writeFileSync(settingsPath(), "{ broken");
    // off no longer throws (the old ordering stripped models.json and then died
    // on settings.json, leaving the retry to read the wreckage as a user edit).
    const first = await primeAdapter.disable();
    assert.equal(first.stripped, true, "the models block is still removed");
    assert.match(first.notes.join(" "), /settings\.json is not valid JSON/);
    // The block is gone but the pair on wrote is untouched, ready for a retry.
    assert.deepEqual(readModels(), { theme: "dark" });

    // Fix the file: a retry restores the pair and clears the record.
    writeFileSync(settingsPath(), JSON.stringify({ defaultProvider: "aiand", defaultModel: GLM }));
    await primeAdapter.disable();
    assert.equal(existsSync(settingsPath()), false, "the pair on wrote is removed then");
    const { getAddedStateSync } = await import("../dist/agents/snapshot.js");
    assert.equal(getAddedStateSync("prime"), null, "record cleared only once off finished");
  });
  test("a models.json Prime left mid-write keeps the pair and the record for a retry", async () => {
    await primeAdapter.enable(enableInput());
    const raw = readFileSync(modelsPath(), "utf8");
    writeFileSync(modelsPath(), raw.slice(0, raw.length - 40), "utf8");
    const first = await primeAdapter.disable();
    assert.equal(first.stripped, false, "nothing readable was stripped");
    assert.match(first.notes.join(" "), /models\.json is not valid JSON/);
    const { getAddedStateSync } = await import("../dist/agents/snapshot.js");
    assert.notEqual(getAddedStateSync("prime"), null, "record kept for the retry");
    // The pair on wrote is still there, so off is not half-applied.
    assert.equal(readSettings().defaultProvider, "aiand");

    writeFileSync(modelsPath(), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
    await primeAdapter.disable();
    assert.equal(existsSync(settingsPath()), false, "the retry finishes the pair");
    assert.equal(getAddedStateSync("prime"), null, "and only then clears the record");
  });

  test("is byte-identical when the user changed nothing", async () => {
    mkdirSync(agentDir(), { recursive: true });
    const modelsBefore = `${JSON.stringify({ theme: "dark" }, null, 2)}\n`;
    const settingsBefore = `${JSON.stringify({ keep: true }, null, 2)}\n`;
    writeFileSync(modelsPath(), modelsBefore);
    writeFileSync(settingsPath(), settingsBefore);
    await primeAdapter.enable(enableInput());
    const result = await primeAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(readFileSync(modelsPath(), "utf8"), modelsBefore);
    assert.equal(readFileSync(settingsPath(), "utf8"), settingsBefore);
  });

  test("removes files on created, leaves the ones that had other content", async () => {
    await primeAdapter.enable(enableInput());
    await primeAdapter.disable();
    assert.equal(existsSync(modelsPath()), false, "fresh models.json removed");
    assert.equal(existsSync(settingsPath()), false, "fresh settings.json removed");

    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(modelsPath(), '{"theme":"dark"}');
    await primeAdapter.enable(enableInput());
    await primeAdapter.disable();
    assert.deepEqual(readModels(), { theme: "dark" });
  });

  test("keeps edits made while on, but strips key and marker", async () => {
    await primeAdapter.enable(enableInput());
    const edited = readModels();
    edited.providers.aiand.name = "mine";
    writeFileSync(modelsPath(), JSON.stringify(edited, null, 2));
    const result = await primeAdapter.disable();
    assert.match(result.notes.join(" "), /left providers\.aiand because you edited it/);
    const after = readModels();
    assert.equal(after.providers.aiand.name, "mine");
    assert.equal(after.providers.aiand.apiKey, undefined);
    assert.equal(after.providers.aiand["x-aiand"], undefined);
  });

  test("a pair the user re-set while on is left as their edit", async () => {
    await primeAdapter.enable(enableInput());
    writeFileSync(
      settingsPath(),
      JSON.stringify({ defaultProvider: "aiand", defaultModel: VISION }),
    );
    const result = await primeAdapter.disable();
    assert.match(result.notes.join(" "), /left the default model because you edited it/);
    assert.equal(readSettings().defaultModel, VISION);
  });

  test("puts back the pair on set aside", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(
      settingsPath(),
      `${JSON.stringify({ defaultProvider: "openrouter", defaultModel: "x/y" }, null, 2)}\n`,
    );
    const settingsBefore = readFileSync(settingsPath(), "utf8");
    await primeAdapter.enable(enableInput({ pinModel: true }));
    await primeAdapter.disable();
    assert.equal(readFileSync(settingsPath(), "utf8"), settingsBefore);
  });

  test("restores the mode a models.json the user already had", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(modelsPath(), '{"theme":"dark"}');
    chmodSync(modelsPath(), 0o640);
    await primeAdapter.enable(enableInput());
    assert.equal(mode(modelsPath()), 0o600);
    await primeAdapter.disable();
    assert.equal(mode(modelsPath()), 0o640, "the pre-existing mode comes back");
  });

  test("an already-unmanaged file says nothing to turn off", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(modelsPath(), JSON.stringify({ theme: "dark" }));
    const result = await primeAdapter.disable();
    assert.equal(result.stripped, false);
  });
});

describe("prime PRIME_AGENT_CODING_AGENT_DIR", () => {
  test("moves the managed files, and off strips the paths on recorded", async () => {
    const other = join(process.env.AIAND_HOME, "prime-b");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "models.json"), '{"theme":"light"}\n');
    process.env.PRIME_AGENT_CODING_AGENT_DIR = other;
    try {
      const result = await primeAdapter.enable(enableInput());
      assert.deepEqual(result.filesWritten, [
        join(other, "models.json"),
        join(other, "settings.json"),
      ]);
      assert.equal(existsSync(modelsPath()), false, "the default dir stays untouched");
    } finally {
      delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
    }
    const moved = await primeAdapter.disable();
    assert.equal(moved.stripped, true, "off finds the wired dir without the env");
    assert.equal(readFileSync(join(other, "models.json"), "utf8"), '{"theme":"light"}\n');
  });

  test("managedFiles includes the wired paths", async () => {
    const other = join(process.env.AIAND_HOME, "prime-c");
    mkdirSync(other, { recursive: true });
    process.env.PRIME_AGENT_CODING_AGENT_DIR = other;
    try {
      await primeAdapter.enable(enableInput());
      assert.deepEqual(
        primeAdapter.managedFiles().sort(),
        [join(other, "models.json"), join(other, "settings.json")].sort(),
      );
    } finally {
      delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
    }
  });
});

describe("prime refreshKey", () => {
  test("swaps only the key, and only when previousKey matches", async () => {
    await primeAdapter.enable(enableInput());
    const before = readModels();
    assert.equal(await primeAdapter.refreshKey({ apiKey: "sk-rotate-2" }), true);
    const after = readModels();
    assert.equal(after.providers.aiand.apiKey, "sk-rotate-2");
    assert.deepEqual(
      { ...after.providers.aiand, apiKey: before.providers.aiand.apiKey },
      before.providers.aiand,
      "everything but the key literal is byte-stable",
    );
    assert.deepEqual(readSettings(), { defaultProvider: "aiand", defaultModel: GLM });

    assert.equal(
      await primeAdapter.refreshKey({ apiKey: "sk-rotate-3", previousKey: "sk-nope" }),
      true,
      "found a marked config, but the mismatched rotation swaps nothing",
    );
    assert.equal(readModels().providers.aiand.apiKey, "sk-rotate-2");

    assert.equal(
      await primeAdapter.refreshKey({ apiKey: "sk-rotate-2" }),
      true,
      "same key is touched",
    );
    assert.equal(
      await primeAdapter.refreshKey({ apiKey: "sk-rotate-4", previousKey: "sk-rotate-2" }),
      true,
    );
    assert.equal(readModels().providers.aiand.apiKey, "sk-rotate-4");
  });

  test("a foreign aiand provider is never touched", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(
      modelsPath(),
      JSON.stringify({
        providers: { aiand: { baseUrl: "https://x.test/v1", apiKey: "sk-theirs" } },
      }),
    );
    assert.equal(await primeAdapter.refreshKey({ apiKey: "sk-mine" }), false);
    assert.equal(readModels().providers.aiand.apiKey, "sk-theirs");
  });

  test("absent config reports not found", async () => {
    assert.equal(await primeAdapter.refreshKey({ apiKey: "sk-any" }), false);
  });

  test("a loosened models.json is re-tightened to 0600 on a same-key rebake", async () => {
    await primeAdapter.enable(enableInput());
    chmodSync(modelsPath(), 0o644);
    assert.equal(await primeAdapter.refreshKey({ apiKey: "sk-enable-1" }), true, "touched");
    assert.equal(mode(modelsPath()), 0o600, "the key never stays world-readable");
  });
});

describe("prime sessionLaunch", () => {
  test("a throwaway agent dir carries the route; the key stays out of the child env", async () => {
    const launch = await primeAdapter.sessionLaunch({
      apiKey: "sk-session-1",
      model: GLM,
      profileName: "default",
      catalog: CATALOG,
      baseUrl: "https://api.aiand.com",
    });
    const dir = launch.env.PRIME_AGENT_CODING_AGENT_DIR;
    try {
      assert.ok(dir.startsWith(join(tmpdir(), "aiand-prime-")), "a throwaway overlay dir");
      assert.equal(launch.env.AIAND_API_KEY, undefined, "the launcher never hands back the key");
      assert.equal(mode(join(dir, "models.json")), 0o600);
      const config = readModels(join(dir, "models.json"));
      assert.equal(config.providers.aiand.apiKey, "sk-session-1");
      assert.equal(config.providers.aiand.baseUrl, "https://api.aiand.com/v1");
      assert.deepEqual(readSettings(join(dir, "settings.json")), {
        defaultProvider: "aiand",
        defaultModel: GLM,
      });
      assert.equal(existsSync(modelsPath()), false, "user files untouched");
    } finally {
      await launch.cleanup();
    }
    assert.equal(existsSync(dir), false, "overlay removed after the child exits");
  });

  test("an omitted model resolves through the profile default", async () => {
    const launch = await primeAdapter.sessionLaunch({
      apiKey: "sk-session-1",
      model: undefined,
      profileModel: VISION,
      profileName: "default",
      catalog: CATALOG,
    });
    try {
      const settingsFile = join(launch.env.PRIME_AGENT_CODING_AGENT_DIR, "settings.json");
      assert.equal(readSettings(settingsFile).defaultModel, VISION);
    } finally {
      await launch.cleanup();
    }
  });
});
