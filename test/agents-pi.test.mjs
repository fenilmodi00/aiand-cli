// Pi adapter: the on/off/status wiring the ai& gateway needs for a Pi session. #31
// #32's launcher tests live in test/run-agent.test.mjs.
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

withTestEnv("aiand-pi-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(join(process.env.AIAND_HOME, ".pi", "agent"), { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { piAdapter, buildPiProvider, piModelEntry } = await import("../dist/agents/pi/adapter.js");
const { snapshotFiles } = await import("../dist/agents/snapshot.js");

beforeEach(() => {
  rmSync(join(process.env.AIAND_HOME, ".pi"), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "pi"), {
    recursive: true,
    force: true,
  });
  mkdirSync(join(process.env.AIAND_HOME, ".pi", "agent"), { recursive: true });
});

const agentDir = () => join(process.env.AIAND_HOME, ".pi", "agent");
const modelsPath = () => join(agentDir(), "models.json");
const authPath = () => join(agentDir(), "auth.json");
const settingsPath = () => join(agentDir(), "settings.json");

const CATALOG = [
  catalogModel("zai-org/glm-5.3", { capabilities: ["tools", "vision"] }),
  catalogModel("qwen/qwen3.8-27b"),
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

/** Seed all three files the way a user's Pi would have them. */
function seedUserFiles() {
  writeJson(modelsPath(), {
    providers: { openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1" } },
  });
  writeJson(authPath(), { openai: { type: "api_key", key: "sk-user-openai" } });
  writeJson(settingsPath(), { theme: "dark", defaultProvider: "openai" });
  return {
    models: readFileSync(modelsPath()),
    auth: readFileSync(authPath()),
    settings: readFileSync(settingsPath()),
  };
}

describe("pi adapter", () => {
  test("id/label/bin/install/managedFiles", () => {
    assert.equal(piAdapter.id, "pi");
    assert.equal(piAdapter.label, "Pi");
    assert.equal(piAdapter.bin, "pi");
    assert.match(piAdapter.install.command, /pi-coding-agent/);
    assert.equal(piAdapter.install.url, "https://pi.dev");
    assert.deepEqual(piAdapter.managedFiles(), [modelsPath(), authPath(), settingsPath()]);
  });

  test("probe(): absent config is inactive with no model", async () => {
    const result = await piAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): foreign aiand credential without the marker is never active", async () => {
    writeJson(authPath(), { aiand: { type: "api_key", key: "sk-foreign" } });
    writeJson(modelsPath(), {
      providers: { aiand: { baseUrl: "https://api.aiand.com/v1", api: "openai-completions" } },
    });
    const result = await piAdapter.probe();
    assert.equal(result.active, false);
  });

  test("probe(): marked credential with a non-routable baseUrl is inactive", async () => {
    writeJson(authPath(), { aiand: { type: "api_key", key: "sk-x", managedBy: "aiand" } });
    writeJson(modelsPath(), { providers: { aiand: { baseUrl: "ftp://example.com" } } });
    assert.equal((await piAdapter.probe()).active, false);
  });

  test("enable(): wires provider, credential, and defaults; keeps unrelated keys", async () => {
    seedUserFiles();
    const result = await piAdapter.enable(enableInput());
    assert.deepEqual(result.filesWritten, [modelsPath(), authPath(), settingsPath()]);

    const models = readJson(modelsPath());
    assert.equal(models.providers.openai.baseUrl, "https://api.openai.com/v1");
    assert.equal(models.providers.aiand.api, "openai-completions");
    assert.equal(models.providers.aiand.baseUrl, "https://api.aiand.com/v1");
    assert.ok(models.providers.aiand.models.length === CATALOG.length);
    assert.equal(result.model, "zai-org/glm-5.3");

    const auth = readJson(authPath());
    assert.equal(auth.openai.key, "sk-user-openai");
    assert.equal(auth.aiand.type, "api_key");
    assert.equal(auth.aiand.key, "sk-enable-1");
    assert.equal(auth.aiand.managedBy, "aiand");

    const settings = readJson(settingsPath());
    assert.equal(settings.theme, "dark");
    assert.equal(settings.defaultProvider, "aiand");
    assert.equal(settings.defaultModel, "zai-org/glm-5.3");

    // probe reads the real files back.
    const probe = await piAdapter.probe();
    assert.deepEqual(probe, { active: true, model: "zai-org/glm-5.3" });

    // The added-state record must not carry the baked key.
    const record = readJson(join(process.env.AIAND_CONFIG_DIR, "snapshots", "pi", "added.json"));
    assert.ok(!JSON.stringify(record).includes("sk-enable-1"));
    assert.equal(record.previousDefaultProvider, "openai");
  });

  test("auth.json is written 0600", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    const mode = statSync(authPath()).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  test("model entry shape: vision maps to image input, reasoning, cost", () => {
    const entry = piModelEntry(CATALOG[0]);
    assert.equal(entry.id, "zai-org/glm-5.3");
    assert.deepEqual(entry.input, ["text", "image"]);
    assert.equal(entry.reasoning, false);
    assert.equal(entry.contextWindow, 128000);
    assert.equal(entry.maxTokens, 128000);
    assert.deepEqual(entry.cost, { input: 0.6, output: 2.2, cacheRead: 0, cacheWrite: 0 });
    const textOnly = piModelEntry(CATALOG[1]);
    assert.deepEqual(textOnly.input, ["text"]);
  });

  test("buildPiProvider renders the catalog with live-gateway compat", () => {
    const provider = buildPiProvider({ baseUrl: "https://gw.example/v1", catalog: CATALOG });
    assert.equal(provider.name, "ai&");
    assert.equal(provider.api, "openai-completions");
    // The gateway rejects a reasoning_effort the model does not publish
    // (live 400 on glm-5.3 + pi's default "medium"), so the provider
    // suppresses the param and lets the gateway apply model defaults.
    assert.deepEqual(provider.compat, { supportsReasoningEffort: false });
    assert.equal(provider.models.length, 2);
  });

  test("off: byte-identical when untouched, keeps user files", async () => {
    const seed = seedUserFiles();
    await piAdapter.enable(enableInput());
    const result = await piAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(readFileSync(modelsPath()).equals(seed.models), true);
    assert.equal(readFileSync(authPath()).equals(seed.auth), true);
    assert.equal(readFileSync(settingsPath()).equals(seed.settings), true);
    // Idempotent: a second off is a no-op.
    const again = await piAdapter.disable();
    assert.equal(again.stripped, false);
  });

  test("off: unlinks files it created, keeps ones the user had", async () => {
    // Only settings.json pre-exists; on creates models.json and auth.json.
    // The command layer snapshots before the first write; seed that here so
    // the manifest records which files did not exist.
    writeJson(settingsPath(), { theme: "dark" });
    await snapshotFiles("pi", piAdapter.managedFiles());
    await piAdapter.enable(enableInput());
    await piAdapter.disable();
    assert.equal(existsSync(modelsPath()), false);
    assert.equal(existsSync(authPath()), false);
    assert.deepEqual(readJson(settingsPath()), { theme: "dark" });
  });

  test("off: keeps user edits made while on, strips our keys", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    const settings = readJson(settingsPath());
    settings.autoUpdater = true;
    settings.defaultModel = "qwen/qwen3.8-27b";
    writeJson(settingsPath(), settings);
    const models = readJson(modelsPath());
    models.providers.openai.tag = "mine";
    writeJson(modelsPath(), models);

    const result = await piAdapter.disable();
    assert.equal(result.stripped, true);

    const afterModels = readJson(modelsPath());
    assert.equal(afterModels.providers.aiand, undefined);
    assert.equal(afterModels.providers.openai.tag, "mine");
    const afterSettings = readJson(settingsPath());
    assert.equal(afterSettings.autoUpdater, true);
    // The user's mid-wire defaultModel stays (they set it after our write).
    assert.equal(afterSettings.defaultModel, "qwen/qwen3.8-27b");
    // defaultProvider back to the user's original.
    assert.equal(afterSettings.defaultProvider, "openai");
  });

  test("off: foreign aiand credential is never stripped", async () => {
    seedUserFiles();
    writeJson(authPath(), { aiand: { type: "api_key", key: "sk-foreign" } });
    const result = await piAdapter.disable();
    assert.equal(result.stripped, false);
    assert.equal(readJson(authPath()).aiand.key, "sk-foreign");
  });

  test("enable(): foreign provider named aiand refuses with a CliError", async () => {
    seedUserFiles();
    const models = readJson(modelsPath());
    models.providers.aiand = { baseUrl: "https://foreign.example" };
    writeJson(modelsPath(), models);
    await assert.rejects(piAdapter.enable(enableInput()), /does not manage/);
  });

  test("--model native leaves the model unpinned with a warning", async () => {
    seedUserFiles();
    const result = await piAdapter.enable(enableInput({ model: "native" }));
    const settings = readJson(settingsPath());
    assert.equal(settings.defaultModel, undefined);
    assert.equal(settings.defaultProvider, "openai");
    assert.ok(result.warnings.some((w) => /pass --model to pick one/.test(w)));
    // The provider + credential are still wired.
    assert.ok(readJson(modelsPath()).providers.aiand);
    assert.equal(readJson(authPath()).aiand.managedBy, "aiand");
  });

  test("user-set servable defaultModel is kept unless --model passed", async () => {
    seedUserFiles();
    writeJson(settingsPath(), {
      theme: "dark",
      defaultProvider: "openai",
      defaultModel: "qwen/qwen3.8-27b",
    });
    const result = await piAdapter.enable(enableInput());
    const settings = readJson(settingsPath());
    assert.equal(settings.defaultModel, "qwen/qwen3.8-27b");
    assert.equal(settings.defaultProvider, "aiand");
    assert.equal(result.model, "qwen/qwen3.8-27b");
    // The kept model is the user's, not ours: off leaves it, so a re-on
    // cycle still holds their pick.
    await piAdapter.enable(enableInput());
    await piAdapter.disable();
    assert.equal(readJson(settingsPath()).defaultModel, "qwen/qwen3.8-27b");
  });

  test("unservable defaultModel is set aside with a warning and restored by off", async () => {
    seedUserFiles();
    writeJson(settingsPath(), {
      theme: "dark",
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });
    const result = await piAdapter.enable(enableInput());
    assert.ok(result.warnings.some((w) => /Set aside your defaultModel \(gpt-4o\)/.test(w)));
    const settings = readJson(settingsPath());
    assert.equal(settings.defaultModel, "zai-org/glm-5.3");
    await piAdapter.disable();
    const after = readJson(settingsPath());
    assert.equal(after.defaultModel, "gpt-4o");
    assert.equal(after.defaultProvider, "openai");
  });

  test("re-on keeps the first capture: off lands byte-identical (#31)", async () => {
    // The live sandbox caught this: on → re-on → off must still hand back
    // the pre-aiand file exactly, including when a re-`on` switches models.
    const seed = seedUserFiles();
    await piAdapter.enable(enableInput());
    const wired = readFileSync(settingsPath());
    await piAdapter.enable(enableInput({ model: "qwen/qwen3.8-27b", pinModel: true }));
    assert.equal(readJson(settingsPath()).defaultModel, "qwen/qwen3.8-27b");
    await piAdapter.enable(enableInput());
    await piAdapter.disable();
    assert.equal(readFileSync(settingsPath()).equals(seed.settings), true, String(wired));
  });

  test("a model written by on with nothing to restore is simply removed", async () => {
    writeJson(settingsPath(), { theme: "dark" });
    await piAdapter.enable(enableInput());
    await piAdapter.disable();
    assert.deepEqual(readJson(settingsPath()), { theme: "dark" });
  });

  test("off after a mid-wire switch back to the user's own model keeps it", async () => {
    seedUserFiles();
    writeJson(settingsPath(), { theme: "dark", defaultProvider: "openai" });
    await piAdapter.enable(enableInput());
    const settings = readJson(settingsPath());
    settings.defaultModel = "qwen/qwen3.8-27b";
    writeJson(settingsPath(), settings);
    const result = await piAdapter.disable();
    assert.equal(readJson(settingsPath()).defaultModel, "qwen/qwen3.8-27b");
    assert.ok(result.notes.some((n) => /left defaultModel because you edited it/.test(n)));
    assert.equal(readJson(settingsPath()).defaultProvider, "openai");
  });

  test("--model pin overwrites the user's defaultModel and off restores it", async () => {
    seedUserFiles();
    writeJson(settingsPath(), {
      theme: "dark",
      defaultProvider: "openai",
      defaultModel: "qwen/qwen3.8-27b",
    });
    await piAdapter.enable(enableInput({ pinModel: true }));
    assert.equal(readJson(settingsPath()).defaultModel, "zai-org/glm-5.3");
    await piAdapter.disable();
    // The user's servable pick was replaced by --model, so it is on's to
    // undo: off hands it back together with the provider.
    assert.equal(readJson(settingsPath()).defaultModel, "qwen/qwen3.8-27b");
    assert.equal(readJson(settingsPath()).defaultProvider, "openai");
  });

  test("refreshKey: swaps the key literal only; previousKey gates", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    const modelsBefore = readFileSync(modelsPath());

    const same = await piAdapter.refreshKey({ apiKey: "sk-enable-1" });
    assert.equal(same, true);

    const wrongPrevious = await piAdapter.refreshKey({
      apiKey: "sk-new",
      previousKey: "sk-other",
    });
    assert.equal(wrongPrevious, false);

    const rotated = await piAdapter.refreshKey({
      apiKey: "sk-new",
      previousKey: "sk-enable-1",
    });
    assert.equal(rotated, true);
    const auth = readJson(authPath());
    assert.equal(auth.aiand.key, "sk-new");
    assert.equal(auth.openai.key, "sk-user-openai");
    assert.equal(readFileSync(modelsPath()).equals(modelsBefore), true);
  });

  test("refreshKey: foreign credential returns false untouched", async () => {
    writeJson(authPath(), { aiand: { type: "api_key", key: "sk-foreign" } });
    const touched = await piAdapter.refreshKey({ apiKey: "sk-new" });
    assert.equal(touched, false);
    assert.equal(readJson(authPath()).aiand.key, "sk-foreign");
  });

  test("PI_CODING_AGENT_DIR relocates the config root", async () => {
    const elsewhere = join(process.env.AIAND_HOME, "elsewhere", "agent");
    process.env.PI_CODING_AGENT_DIR = elsewhere;
    try {
      assert.deepEqual(piAdapter.managedFiles(), [
        join(elsewhere, "models.json"),
        join(elsewhere, "auth.json"),
        join(elsewhere, "settings.json"),
      ]);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  test("off restores the file's pre-on mode; a file on created stays private (#31)", async () => {
    // A user's auth.json normally holds their own credentials at 0600; off
    // must not widen it back to the umask default when dropping our key.
    const seed = seedUserFiles();
    chmodSync(authPath(), 0o600);
    await piAdapter.enable(enableInput());
    await piAdapter.disable();
    assert.equal(statSync(authPath()).mode & 0o777, 0o600);
    assert.equal(readFileSync(authPath()).equals(seed.auth), true);
  });

  test("off keeps a file on created private when the user added a credential", async () => {
    // on created auth.json (no prior mode to restore); the user adds their
    // own key mid-wire; off hands that file back at 0600, never 0644.
    writeJson(settingsPath(), { theme: "dark" });
    await snapshotFiles("pi", piAdapter.managedFiles());
    await piAdapter.enable(enableInput());
    writeJson(authPath(), {
      aiand: { type: "api_key", key: "sk-enable-1", managedBy: "aiand" },
      openai: { type: "api_key", key: "sk-user-openai" },
    });
    await piAdapter.disable();
    assert.equal(statSync(authPath()).mode & 0o777, 0o600);
    assert.deepEqual(readJson(authPath()), { openai: { type: "api_key", key: "sk-user-openai" } });
  });

  const sessionInput = () => ({
    apiKey: "sk-session-1",
    model: "zai-org/glm-5.3",
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
  });

  test("sessionLaunch: session dir honors the inherited env and the agent dir", async () => {
    const launch = await piAdapter.sessionLaunch(sessionInput());
    try {
      assert.equal(
        launch.env.PI_CODING_AGENT_SESSION_DIR,
        join(process.env.AIAND_HOME, ".pi", "agent", "sessions"),
      );
      process.env.PI_CODING_AGENT_SESSION_DIR = "/elsewhere/history";
      const inherited = await piAdapter.sessionLaunch(sessionInput());
      assert.equal(inherited.env.PI_CODING_AGENT_SESSION_DIR, "/elsewhere/history");
      await inherited.cleanup();
    } finally {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
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
      await assert.rejects(piAdapter.sessionLaunch({ ...sessionInput(), catalog: boom }));
      assert.deepEqual(
        readdirSync(sandboxTmp).filter((name) => name.startsWith("aiand-pi-")),
        [],
      );
    } finally {
      delete process.env.TMPDIR;
    }
  });
});
