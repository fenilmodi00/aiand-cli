// Pi adapter: the on/off/status wiring the ai& gateway needs for a Pi session.
// The launcher tests live in test/run-agent.test.mjs.
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
import { join, matchesGlob, resolve } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { enableInput as baseEnableInput, catalogModel, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-pi-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(join(process.env.AIAND_HOME, ".pi", "agent"), { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { piAdapter } = await import("../dist/agents/pi/adapter.js");
const { buildPiProvider, piModelEntry } = await import("../dist/agents/pi/provider.js");
const { snapshotFiles, restoreSnapshot } = await import("../dist/agents/snapshot.js");
const { CliError } = await import("../dist/cli/errors.js");

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
const addedRecord = () => join(process.env.AIAND_CONFIG_DIR, "snapshots", "pi", "added.json");

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

/** Pi's per-cwd session dir: <agent dir>/sessions/--<encoded cwd>--. */
const perCwdSessionDir = () =>
  join(
    agentDir(),
    "sessions",
    `--${resolve(process.cwd())
      .replace(/^[/\\]/, "")
      .replace(/[/\\:]/g, "-")}--`,
  );

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

  test("GLM-5.3 publishes low, high, and max for Pi", () => {
    const glm = catalogModel("zai-org/glm-5.3", {
      reasoning_efforts: ["low", "high", "max"],
    });
    const entry = piModelEntry(glm);
    assert.deepEqual(entry.thinkingLevelMap, {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
    assert.equal(entry.compat.supportsReasoningEffort, true);
    const provider = buildPiProvider({ baseUrl: "https://gw.example/v1", catalog: [glm] });
    assert.equal(provider.compat, undefined);
    const plain = piModelEntry(catalogModel("qwen/qwen3.8-27b"));
    assert.equal(plain.thinkingLevelMap, undefined);
    assert.equal(plain.compat, undefined);
  });

  test("buildPiProvider renders the catalog with live-gateway compat", () => {
    const provider = buildPiProvider({ baseUrl: "https://gw.example/v1", catalog: CATALOG });
    assert.equal(provider.name, "ai&");
    assert.equal(provider.api, "openai-completions");
    assert.equal(provider.compat, undefined);
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

  test("re-on keeps the first capture: off lands byte-identical", async () => {
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

  // relocated config dir orphaned the baked key
  test("off: strips the recorded files when the pi config dir moved", async () => {
    const seed = seedUserFiles();
    await piAdapter.enable(enableInput());
    // The user relocated Pi's agent dir between `on` and `off`; the moved
    // dir need not exist — off must still honor the recorded paths.
    process.env.PI_CODING_AGENT_DIR = join(process.env.AIAND_HOME, "moved", "agent");
    try {
      const result = await piAdapter.disable();
      assert.equal(result.stripped, true);
      assert.equal(readFileSync(modelsPath()).equals(seed.models), true);
      assert.equal(readFileSync(settingsPath()).equals(seed.settings), true);
      // auth.json: our credential gone, the user's own key back byte-wise.
      assert.equal(readFileSync(authPath()).equals(seed.auth), true);
      assert.ok(result.notes.some((n) => n.includes("config dir moved")));
      assert.equal(existsSync(addedRecord()), false);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  test("off: unparseable relocated auth.json keeps the record for retry", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    // Capture our wired auth.json so the retry can restore a readable file.
    const wiredAuth = readFileSync(authPath());
    process.env.PI_CODING_AGENT_DIR = join(process.env.AIAND_HOME, "moved", "agent");
    try {
      // auth.json is the first stale file off reads, and it is unreadable:
      // nothing was stripped yet, so stripped stays false and the record
      // survives for the retry.
      writeFileSync(authPath(), "{broken");
      const result = await piAdapter.disable();
      assert.equal(result.stripped, false);
      assert.ok(
        result.notes.some((n) => n.includes("is not valid JSON") && n.includes(authPath())),
      );
      assert.equal(existsSync(addedRecord()), true);

      // The user fixes the old auth.json; the retry strips and clears it.
      writeFileSync(authPath(), wiredAuth);
      const retry = await piAdapter.disable();
      assert.equal(retry.stripped, true);
      assert.equal(existsSync(addedRecord()), false);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  // The moved dir's models.json was stripped with no
  // ownership proof, deleting a block the user repointed
  test("off: a repointed providers.aiand in the moved dir survives with a note", async () => {
    const seed = seedUserFiles();
    await piAdapter.enable(enableInput());
    // The user hand-writes their own routing over our block after `on`.
    const models = readJson(modelsPath());
    models.providers.aiand.baseUrl = "https://foreign.example.com/v1";
    writeJson(modelsPath(), models);
    const staleModels = readFileSync(modelsPath());
    // Retarget the env: the moved dir's models.json gets the same
    // proof as the current dir (the baseUrl `on` wrote), and a
    // repointed block is the user's.
    process.env.PI_CODING_AGENT_DIR = join(process.env.AIAND_HOME, "moved", "agent");
    try {
      const result = await piAdapter.disable();
      assert.equal(result.stripped, true);
      assert.ok(
        result.notes.some((n) => n.includes("left providers.aiand in") && n.includes(modelsPath())),
      );
      // The repointed block is the user's: byte-identical, openai intact.
      assert.equal(readFileSync(modelsPath()).equals(staleModels), true);
      assert.equal(
        readJson(modelsPath()).providers.aiand.baseUrl,
        "https://foreign.example.com/v1",
      );
      assert.equal(readJson(modelsPath()).providers.openai.baseUrl, "https://api.openai.com/v1");
      // What is provably ours still stripped from the moved dir.
      assert.equal(readFileSync(authPath()).equals(seed.auth), true);
      assert.equal(readFileSync(settingsPath()).equals(seed.settings), true);
      assert.equal(existsSync(addedRecord()), false);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  // restore --force refused the relocated paths the
  // manifest still holds once the relocation env was unset
  test("managedFiles(): the recorded paths survive a config-dir move for restore", async () => {
    const relocated = join(process.env.AIAND_HOME, "relocated", "agent");
    mkdirSync(relocated, { recursive: true });
    const relocatedModels = join(relocated, "models.json");
    const relocatedAuth = join(relocated, "auth.json");
    const relocatedSettings = join(relocated, "settings.json");
    // The user's pre-on config at A, snapshotted the way `on` does.
    writeJson(relocatedModels, {
      providers: { openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1" } },
    });
    writeJson(relocatedAuth, { openai: { type: "api_key", key: "sk-user-openai" } });
    writeJson(relocatedSettings, { theme: "dark", defaultProvider: "openai" });
    const before = {
      models: readFileSync(relocatedModels),
      auth: readFileSync(relocatedAuth),
      settings: readFileSync(relocatedSettings),
    };
    process.env.PI_CODING_AGENT_DIR = relocated;
    try {
      await snapshotFiles("pi", piAdapter.managedFiles());
      await piAdapter.enable(enableInput());
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    // The env is gone: the current dir is the default one, but the
    // manifest still holds A's paths, so managedFiles must list both.
    const managed = piAdapter.managedFiles();
    for (const path of [modelsPath(), authPath(), settingsPath()]) {
      assert.ok(managed.includes(path), `${path} missing from managedFiles()`);
    }
    for (const path of [relocatedModels, relocatedAuth, relocatedSettings]) {
      assert.ok(managed.includes(path), `${path} missing from managedFiles()`);
    }
    assert.equal(new Set(managed).size, managed.length);
    // restore --force accepts the recorded paths and puts the user's
    // pre-on bytes back at A.
    assert.equal(await restoreSnapshot("pi", piAdapter.managedFiles()), true);
    assert.equal(readFileSync(relocatedModels).equals(before.models), true);
    assert.equal(readFileSync(relocatedAuth).equals(before.auth), true);
    assert.equal(readFileSync(relocatedSettings).equals(before.settings), true);
  });

  test("off: parses all three files before any write; a broken one keeps the record", async () => {
    // Stripping auth.json (the marker) and then failing on models.json
    // or settings.json exits 70 with a raw SyntaxError, auth.json
    // already stripped: providers.aiand and defaultProvider: "aiand"
    // stay behind with no key, and `on` refuses them as foreign.
    // Parse everything first; keep the record for the retry.
    for (const broken of ["models", "settings"]) {
      seedUserFiles();
      await piAdapter.enable(enableInput());
      const wiredAuth = readFileSync(authPath());
      const brokenPath = broken === "models" ? modelsPath() : settingsPath();
      const wiredText = readFileSync(brokenPath);
      writeFileSync(brokenPath, "{broken");

      const result = await piAdapter.disable();
      assert.equal(result.stripped, false);
      assert.ok(
        result.notes.some((n) => n.includes("is not valid JSON") && n.includes(brokenPath)),
      );
      // Nothing was written: auth.json (the marker) is untouched, and
      // the record survives so the retry can still strip everything.
      assert.equal(readFileSync(authPath()).equals(wiredAuth), true);
      assert.equal(existsSync(addedRecord()), true);

      // The user fixes the file; the retry strips all three and clears
      // the record, handing the user's routing back.
      writeFileSync(brokenPath, wiredText);
      const retry = await piAdapter.disable();
      assert.equal(retry.stripped, true);
      assert.equal(existsSync(addedRecord()), false);
      assert.equal(readJson(modelsPath()).providers?.aiand, undefined);
      assert.equal(readJson(authPath()).aiand, undefined);
      assert.deepEqual(readJson(settingsPath()), {
        theme: "dark",
        defaultProvider: "openai",
      });
    }
  });

  test("off restores the file's pre-on mode; a file on created stays private", async () => {
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

  test("sessionLaunch: session dir honors the inherited env, settings, and per-cwd default", async () => {
    const launch = await piAdapter.sessionLaunch(sessionInput());
    try {
      // No settings.json sessionDir: Pi's per-cwd default under the
      // real agent dir.
      assert.equal(launch.env.PI_CODING_AGENT_SESSION_DIR, perCwdSessionDir());
      // Pi treats an empty PI_CODING_AGENT_SESSION_DIR as unset, so
      // the computed dir wins there too.
      process.env.PI_CODING_AGENT_SESSION_DIR = "";
      const empty = await piAdapter.sessionLaunch(sessionInput());
      try {
        assert.equal(empty.env.PI_CODING_AGENT_SESSION_DIR, perCwdSessionDir());
      } finally {
        await empty.cleanup();
      }
      process.env.PI_CODING_AGENT_SESSION_DIR = "/elsewhere/history";
      const inherited = await piAdapter.sessionLaunch(sessionInput());
      assert.equal(inherited.env.PI_CODING_AGENT_SESSION_DIR, "/elsewhere/history");
      await inherited.cleanup();
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      // A settings.json sessionDir wins over the per-cwd default, with
      // ~ expanded against the agent home.
      writeJson(settingsPath(), { sessionDir: "~/pi-sessions" });
      const fromSettings = await piAdapter.sessionLaunch(sessionInput());
      try {
        assert.equal(
          fromSettings.env.PI_CODING_AGENT_SESSION_DIR,
          join(process.env.AIAND_HOME, "pi-sessions"),
        );
      } finally {
        await fromSettings.cleanup();
      }
      // A project-level <cwd>/.pi/settings.json overrides the global file,
      // exactly as Pi merges it for a plain launch.
      const projectCwd = join(process.env.AIAND_HOME, "proj");
      mkdirSync(join(projectCwd, ".pi"), { recursive: true });
      writeJson(join(projectCwd, ".pi", "settings.json"), { sessionDir: "~/project-sessions" });
      const cwd = process.cwd();
      process.chdir(projectCwd);
      try {
        const fromProject = await piAdapter.sessionLaunch(sessionInput());
        try {
          assert.equal(
            fromProject.env.PI_CODING_AGENT_SESSION_DIR,
            join(process.env.AIAND_HOME, "project-sessions"),
          );
        } finally {
          await fromProject.cleanup();
        }
      } finally {
        process.chdir(cwd);
      }
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

describe("pi ownership proof", () => {
  const dropStamp = () => {
    const auth = readJson(authPath());
    delete auth.aiand.managedBy;
    writeJson(authPath(), auth);
  };

  test("probe(): a dropped stamp still reads active while the record proof holds", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    dropStamp();
    assert.deepEqual(await piAdapter.probe(), { active: true, model: "zai-org/glm-5.3" });
  });

  test("probe(): a repointed block reads inactive even with a live record", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    dropStamp();
    const models = readJson(modelsPath());
    models.providers.aiand.baseUrl = "https://foreign.example.com/v1";
    writeJson(modelsPath(), models);
    assert.deepEqual(await piAdapter.probe(), { active: false, model: null });
  });

  test("probe(): a record alone (defaultProvider edited) reads inactive", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    dropStamp();
    const settings = readJson(settingsPath());
    settings.defaultProvider = "openai";
    writeJson(settingsPath(), settings);
    assert.deepEqual(await piAdapter.probe(), { active: false, model: null });
  });

  test("off: strips when the stamp is gone but the record proof holds", async () => {
    const seed = seedUserFiles();
    await piAdapter.enable(enableInput());
    dropStamp();
    const result = await piAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(readFileSync(modelsPath()).equals(seed.models), true);
    assert.equal(readFileSync(authPath()).equals(seed.auth), true);
    assert.equal(readFileSync(settingsPath()).equals(seed.settings), true);
    assert.equal(existsSync(addedRecord()), false);
  });

  test("off: a repointed block with a live record is left, noted, byte-identical", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    dropStamp();
    const models = readJson(modelsPath());
    models.providers.aiand.baseUrl = "https://foreign.example.com/v1";
    writeJson(modelsPath(), models);
    const before = {
      models: readFileSync(modelsPath()),
      auth: readFileSync(authPath()),
      settings: readFileSync(settingsPath()),
    };
    const result = await piAdapter.disable();
    assert.equal(result.stripped, false);
    assert.ok(result.notes.includes("left the aiand credential because you edited it"));
    assert.equal(readFileSync(modelsPath()).equals(before.models), true);
    assert.equal(readFileSync(authPath()).equals(before.auth), true);
    assert.equal(readFileSync(settingsPath()).equals(before.settings), true);
  });

  test("refreshKey: a dropped stamp still swaps while the record proof holds", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    dropStamp();
    const modelsBefore = readFileSync(modelsPath());
    const touched = await piAdapter.refreshKey({
      apiKey: "sk-new-1",
      previousKey: "sk-enable-1",
    });
    assert.equal(touched, true);
    assert.equal(readJson(authPath()).aiand.key, "sk-new-1");
    assert.equal(readJson(authPath()).aiand.managedBy, undefined);
    assert.equal(readFileSync(modelsPath()).equals(modelsBefore), true);
  });

  test("refreshKey: a repointed block returns false, byte-identical", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    dropStamp();
    const models = readJson(modelsPath());
    models.providers.aiand.baseUrl = "https://foreign.example.com/v1";
    writeJson(modelsPath(), models);
    const before = readFileSync(authPath());
    assert.equal(await piAdapter.refreshKey({ apiKey: "sk-new-1" }), false);
    assert.equal(readFileSync(authPath()).equals(before), true);
  });

  test("refreshKey: malformed auth.json returns false, never throws", async () => {
    writeFileSync(authPath(), "{broken");
    assert.equal(await piAdapter.refreshKey({ apiKey: "sk-new-1" }), false);
  });

  test("enable(): an unmarked aiand credential refuses with a CliError", async () => {
    seedUserFiles();
    const auth = readJson(authPath());
    auth.aiand = { type: "api_key", key: "sk-user-hand-baked" };
    writeJson(authPath(), auth);
    const before = {
      models: readFileSync(modelsPath()),
      auth: readFileSync(authPath()),
      settings: readFileSync(settingsPath()),
    };
    await assert.rejects(
      () => piAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readFileSync(modelsPath()).equals(before.models), true);
    assert.equal(readFileSync(authPath()).equals(before.auth), true);
    assert.equal(readFileSync(settingsPath()).equals(before.settings), true);
  });

  test("enable(): a dropped stamp with a live record proof re-bakes", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    dropStamp();
    const result = await piAdapter.enable(enableInput({ apiKey: "sk-enable-2" }));
    assert.equal(readJson(authPath()).aiand.key, "sk-enable-2");
    assert.equal(readJson(authPath()).aiand.managedBy, "aiand");
    assert.equal(result.model, "zai-org/glm-5.3");
  });

  test("enable(): a dropped stamp carries the prior record so off restores the user's defaults", async () => {
    // The repro: the user's own routing, an on, a Pi /login rewrite
    // that drops the stamp, a second on, then off. The second on must
    // carry the first on's record forward (the routing still proves
    // ours) instead of recomputing hand-back values from a file that
    // already says aiand — which would strand the user's provider and
    // model.
    writeJson(modelsPath(), {
      providers: { openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1" } },
    });
    writeJson(authPath(), { openai: { type: "api_key", key: "sk-user-openai" } });
    writeJson(settingsPath(), {
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-8",
    });
    await piAdapter.enable(enableInput());
    dropStamp();
    await piAdapter.enable(enableInput());
    await piAdapter.disable();
    assert.deepEqual(readJson(settingsPath()), {
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-8",
    });
  });
});

describe("pi hand-edit detection", () => {
  test("off: a hand-edited providers.aiand survives with a note; auth/settings still strip", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    const models = readJson(modelsPath());
    models.providers.aiand.baseUrl = "https://user.example.com/v1";
    writeJson(modelsPath(), models);
    const result = await piAdapter.disable();
    assert.equal(result.stripped, true);
    assert.ok(result.notes.includes("left providers.aiand because you edited it"));
    // The edited block is the user's now and stays.
    assert.equal(readJson(modelsPath()).providers.aiand.baseUrl, "https://user.example.com/v1");
    assert.equal(readJson(modelsPath()).providers.openai.baseUrl, "https://api.openai.com/v1");
    // The auth and settings strips still happened.
    assert.equal(readJson(authPath()).aiand, undefined);
    assert.equal(readJson(settingsPath()).defaultProvider, "openai");
    assert.equal(readJson(settingsPath()).defaultModel, undefined);
  });

  test("off: a hand-edited defaultProvider is left with a note", async () => {
    seedUserFiles();
    await piAdapter.enable(enableInput());
    const settings = readJson(settingsPath());
    settings.defaultProvider = "anthropic";
    writeJson(settingsPath(), settings);
    const result = await piAdapter.disable();
    assert.ok(result.notes.includes("left defaultProvider because you edited it"));
    assert.equal(readJson(settingsPath()).defaultProvider, "anthropic");
    assert.equal(readJson(settingsPath()).defaultModel, undefined);
  });

  test("off: an emptied providers map is dropped with our block", async () => {
    // A user's models.json with no providers: our block is the
    // only one, so off drops the emptied map too — the file
    // itself is the user's and stays.
    writeJson(modelsPath(), {});
    writeJson(authPath(), {});
    writeJson(settingsPath(), { theme: "dark" });
    await piAdapter.enable(enableInput());
    assert.deepEqual(Object.keys(readJson(modelsPath()).providers), ["aiand"]);
    await piAdapter.disable();
    assert.equal(existsSync(modelsPath()), true);
    assert.equal(readJson(modelsPath()).providers, undefined);
  });
});

describe("pi sessionLaunch native", () => {
  const launchInput = () => ({
    apiKey: "sk-session-1",
    model: "zai-org/glm-5.3",
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
  });

  test("allowUnpinnedModel: --model native skips catalog validation", () => {
    assert.equal(piAdapter.allowUnpinnedModel, true);
  });

  test("native drops --model and scopes Pi's default pick to the aiand provider", async () => {
    const launch = await piAdapter.sessionLaunch({ ...launchInput(), model: "native" });
    try {
      assert.equal(launch.args[0], "--provider");
      assert.equal(launch.args[1], "aiand");
      // Pi reads --provider only alongside --model, so native scopes
      // its own default pick with --models instead of leaving --provider
      // dangling. `**` so catalog ids with a slash still match.
      assert.deepEqual(launch.args.slice(2, 4), ["--models", "aiand/**"]);
      assert.equal(launch.args.includes("--model"), false);
      // Prove the glob really matches every aiand catalog id, not just
      // that the string is spelled right: `aiand/*` (the round-1 bug)
      // passes a literal check but matches no id, since Pi matches with
      // minimatch and `*` does not cross `/`. Pi resolves a model with
      // `minimatch(fullId, pattern, { nocase: true })` (pi 0.87.1,
      // core/model-resolver); node:path.matchesGlob is the same matcher
      // vendored, so this holds without importing Pi's dependency. The
      // ids and the `aiand/` prefix are lowercase, so nocase is moot.
      const pattern = launch.args[3];
      for (const { id } of CATALOG) {
        assert.equal(
          matchesGlob(`aiand/${id}`, pattern),
          true,
          `--models ${pattern} does not match catalog id aiand/${id}`,
        );
        assert.equal(
          matchesGlob(`aiand/${id}`, "aiand/*"),
          false,
          `aiand/* unexpectedly matches aiand/${id}`,
        );
      }
      // And a glob with no path separator still reaches ids under `aiand/`.
      assert.equal(matchesGlob("aiand/zai-org/glm-5.3", "aiand/**"), true);
      // The overlay still carries the provider routing.
      const models = JSON.parse(
        readFileSync(join(launch.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"),
      );
      assert.equal(models.providers.aiand.api, "openai-completions");
      assert.equal(models.providers.aiand.baseUrl, "https://api.aiand.com/v1");
    } finally {
      await launch.cleanup();
    }
  });

  test("an undefined model resolves through the catalog", async () => {
    const launch = await piAdapter.sessionLaunch({ ...launchInput(), model: undefined });
    try {
      assert.ok(launch.args.includes("--model"));
      assert.equal(launch.args[launch.args.indexOf("--model") + 1], "zai-org/glm-5.3");
    } finally {
      await launch.cleanup();
    }
  });
});
