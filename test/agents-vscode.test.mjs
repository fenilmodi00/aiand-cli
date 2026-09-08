import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { CliError } from "../dist/cli/errors.js";
import { setIdeProbeForTests } from "../dist/agents/quit-guard.js";
import { foreignMarkerFixtures } from "../dist/agents/foreign.js";

let dir;
const originalEnv = { ...process.env };

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-vscode-test-"));
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_IDE_SECRET_PLAINTEXT = "1";
  setIdeProbeForTests(() => false);
});

after(() => {
  setIdeProbeForTests(null);
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const {
  vscodeAdapter,
  chatLanguageModelsPath,
  vscodeStateDbPath,
  VSCODE_MODEL_URL,
  VSCODE_SECRET_PREFIX,
  aiandSecretId,
  findAiandProvider,
  aiandSecretIds,
  addAiandProvider,
  buildModelEntry,
} = await import("../dist/agents/vscode.js");
const {
  readItemTableValue,
  writeItemTableValue,
  ensureItemTable,
  applyItemTableWrites,
} = await import("../dist/agents/vscdb.js");

const KEY = "sk-vscode-test-key-1";
const CATALOG = [
  {
    id: "zai-org/glm-5.3",
    name: "GLM 5.3",
    object: "model",
    created: 1,
    owned_by: "zai-org",
    provider: "zai-org",
    context_window: 200000,
    capabilities: ["text", "vision", "tool_calling"],
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: "0.60",
    output_per_1m: "2.40",
    cached_input_per_1m: "0.10",
  },
  {
    id: "moonshotai/kimi-k3",
    name: "Kimi K3",
    object: "model",
    created: 1,
    owned_by: "moonshotai",
    provider: "moonshotai",
    context_window: 400000,
    capabilities: ["text", "tool_calling"],
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: "0.30",
    output_per_1m: "0.30",
    cached_input_per_1m: "0.05",
  },
];

const home = () => process.env.AIAND_HOME;
const jsonPath = () => chatLanguageModelsPath({ home: home() });
const dbPath = () => vscodeStateDbPath({ home: home() });

function enableInput(overrides = {}) {
  return {
    apiKey: KEY,
    model: CATALOG[0].id,
    catalog: CATALOG,
    home: home(),
    ...overrides,
  };
}

/** Write a pre-existing chatLanguageModels.json with an unrelated provider. */
function plantJson(providers) {
  mkdirSync(join(jsonPath(), ".."), { recursive: true });
  writeFileSync(jsonPath(), `${JSON.stringify(providers, null, "\t")}\n`);
}

/** Plant the ItemTable row a pre-existing (non-aiand) secret would use. */
function plantRow(key, value) {
  mkdirSync(join(dbPath(), ".."), { recursive: true });
  const db = new DatabaseSync(dbPath());
  db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);");
  db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(key, value);
  db.close();
}

async function readJson() {
  return JSON.parse(readFileSync(jsonPath(), "utf8"));
}

async function readRow(secretId) {
  return readItemTableValue(dbPath(), `secret://${secretId}`);
}

describe("vscode path helpers", () => {
  test("chatLanguageModelsPath + state.vscdb resolve under the agent home", () => {
    const json = jsonPath();
    assert.ok(json.startsWith(join(home(), ".config", "Code", "User")) || json.includes("ChatLanguageModels"));
    assert.equal(
      dbPath(),
      join(dirname(json), "globalStorage", "state.vscdb")
    );
  });

  test("managedFiles is chatLanguageModels.json only (never the binary DB)", () => {
    assert.deepEqual(vscodeAdapter.managedFiles(), [jsonPath()]);
  });
});

describe("vscode pure transforms", () => {
  test("buildModelEntry maps catalog fields (vision from capabilities)", () => {
    const entry = buildModelEntry(CATALOG[0]);
    assert.equal(entry.url, VSCODE_MODEL_URL);
    assert.equal(entry.toolCalling, true);
    assert.equal(entry.vision, true);
    assert.equal(entry.maxInputTokens, 200000);
    assert.equal(entry.maxOutputTokens, 16384);

    const noVision = buildModelEntry(CATALOG[1]);
    assert.equal(noVision.vision, false);
  });

  test("aiandSecretId extracts only aiand-prefixed ids", () => {
    assert.equal(aiandSecretId("${input:chat.lm.secret.aiand-abc123}"), "chat.lm.secret.aiand-abc123");
    assert.equal(aiandSecretId("${input:chat.lm.secret.fw-abc}"), null);
    assert.equal(aiandSecretId("plain"), null);
  });

  test("addAiandProvider replaces in place / appends, preserving others", () => {
    const foreign = { name: "user", vendor: "customendpoint", apiKey: "user-key" };
    let arr = addAiandProvider([foreign], { secretId: "chat.lm.secret.aiand-1", models: [{ id: "m" }] });
    assert.equal(arr.length, 2);
    assert.equal(arr[1].apiKey, "${input:chat.lm.secret.aiand-1}");

    arr = addAiandProvider(arr, { secretId: "chat.lm.secret.aiand-2", models: [{ id: "m2" }] });
    assert.equal(arr.length, 2, "re-add must not duplicate the provider");
    assert.equal(arr[0].name, "user", "foreign provider untouched");
    assert.equal(findAiandProvider(arr).apiKey, "${input:chat.lm.secret.aiand-2}");
  });

  test("aiandSecretIds collects aiand-owned ids only", () => {
    const ids = aiandSecretIds([
      { apiKey: "${input:chat.lm.secret.aiand-1}" },
      { apiKey: "user-key" },
      { apiKey: "${input:chat.lm.secret.aiand-2}" },
    ]);
    assert.deepEqual(ids, ["chat.lm.secret.aiand-1", "chat.lm.secret.aiand-2"]);
  });
});

describe("vscode enable", () => {
  test("enable writes a provider entry (tab indent), a secret row, preserves a foreign provider", async () => {
    // Plant a foreign (user) provider with its own VS Code-generated secret id.
    const foreignProvider = {
      name: "user-provider",
      vendor: "customendpoint",
      apiType: "chat-completions",
      apiKey: "${input:chat.lm.secret.1234}",
      models: [{ id: "user-model", url: "https://user.example/v1" }],
    };
    plantJson([foreignProvider]);

    const result = await vscodeAdapter.enable(enableInput());
    assert.equal(result.model, CATALOG[0].id);

    const raw = readFileSync(jsonPath(), "utf8");
    assert.match(raw, /^\t\t"name": "ai&",$/m, "provider written with tab indentation");

    const arr = await readJson();
    assert.equal(arr.length, 2, "foreign provider preserved, one aiand provider added");
    assert.equal(arr[0].name, "user-provider");

    const aiand = findAiandProvider(arr);
    assert.equal(aiand.name, "ai&");
    assert.equal(aiand.vendor, "customendpoint");
    assert.equal(aiand.apiType, "chat-completions");
    const secretId = aiandSecretId(aiand.apiKey);
    assert.ok(secretId && secretId.startsWith(VSCODE_SECRET_PREFIX));
    assert.equal(aiand.models.length, 2, "both catalog models registered");
    assert.equal(aiand.models[0].url, VSCODE_MODEL_URL);
    assert.equal(aiand.models[0].vision, true);

    // Secret row present in state.vscdb.
    assert.equal(await readRow(secretId), KEY, "plaintext seam stores the literal key");
  });

  test("re-on reuses the same secret id and does not duplicate the provider", async () => {
    plantJson([]);
    const input = enableInput();
    await vscodeAdapter.enable(input);
    const first = await readJson();
    const firstId = aiandSecretId(findAiandProvider(first).apiKey);

    await vscodeAdapter.enable(input);
    const second = await readJson();
    const aiand = findAiandProvider(second);
    const secondId = aiandSecretId(aiand.apiKey);

    assert.equal(secondId, firstId, "secret id reused across re-on");
    assert.equal(second.filter((p) => p.name === "ai&").length, 1, "aiand provider not duplicated");
  });

  test("probe() is active with the model after enable; inactive on a clean tree", async () => {
    plantJson([]);
    const before = await vscodeAdapter.probe();
    assert.equal(before.active, false);

    await vscodeAdapter.enable(enableInput());
    const after = await vscodeAdapter.probe();
    assert.equal(after.active, true);
    assert.equal(after.model, CATALOG[0].id);
  });

  test("probe returns the first aiand model id", async () => {
    plantJson([]);
    await vscodeAdapter.enable(enableInput({ model: CATALOG[1].id, catalog: [CATALOG[1]] }));
    const p = await vscodeAdapter.probe();
    assert.equal(p.model, CATALOG[1].id);
  });
});

describe("vscode disable", () => {
  test("disable deletes our secret rows, strips our provider, leaves foreign entries", async () => {
    const foreignProvider = {
      name: "user-provider",
      vendor: "customendpoint",
      apiType: "chat-completions",
      apiKey: "${input:chat.lm.secret.1234}",
      models: [{ id: "user-model", url: "https://user.example/v1" }],
    };
    plantJson([foreignProvider]);
    plantRow("secret://chat.lm.secret.1234", "foreign-value");
    await vscodeAdapter.enable(enableInput());

    const arr = await readJson();
    const ourId = aiandSecretId(findAiandProvider(arr).apiKey);
    assert.equal(await readRow(ourId), KEY);

    await vscodeAdapter.disable();

    assert.equal(await readRow(ourId), "");
    assert.equal(await readRow("chat.lm.secret.1234"), "foreign-value");

    const after = await readJson();
    assert.equal(after.length, 1, "foreign provider preserved");
    assert.equal(after[0].name, "user-provider");
    assert.equal(findAiandProvider(after), undefined, "aiand provider stripped");
    assert.equal((await vscodeAdapter.probe()).active, false, "forced-off leaves inactive probe");

    const sidecar = join(dir, "cfg", "agents", "vscode", "secrets.json");
    let sidecarGone = true;
    try {
      readFileSync(sidecar);
      sidecarGone = false;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    assert.equal(sidecarGone, true, "sidecar removed on disable");
  });

  test("disable with only our provider removes the JSON file", async () => {
    plantJson([]);
    await vscodeAdapter.enable(enableInput());
    assert.equal(existsSync(jsonPath()), true);
    await vscodeAdapter.disable();
    assert.equal(existsSync(jsonPath()), false);
    assert.equal((await vscodeAdapter.probe()).active, false);
  });
});

describe("vscode enableGuard", () => {
  test("refuses with a CliError (--force hint) when the probe says running", async () => {
    await assert.rejects(
      vscodeAdapter.enableGuard({ force: false, isRunning: () => true }),
      (error) => error instanceof CliError && /--force/.test(error.hint ?? "")
    );
  });

  test("--force escapes the guard", async () => {
    // force warn-and-proceeds; must not throw.
    await vscodeAdapter.enableGuard({ force: true, isRunning: () => true });
  });

  test("no running app → guard is a no-op", async () => {
    await vscodeAdapter.enableGuard({ force: false, isRunning: () => false });
  });
});

describe("vscode foreign detection", () => {
  test("probe reports a foreign config writer's markers in the managed file", async () => {
    const [settingsFixture] = Object.values(foreignMarkerFixtures());
    plantJson([]);
    writeFileSync(jsonPath(), settingsFixture);
    const p = await vscodeAdapter.probe();
    assert.equal(p.active, false);
    assert.ok(p.foreignTool, "foreign markers detected in the managed file");
  });
});