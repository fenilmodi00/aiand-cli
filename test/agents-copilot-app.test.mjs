// Copilot desktop app adapter: the app's SQLite provider store
// (data.db model_providers / provider_models), plus the quit-guard process
// matcher. The schema is undocumented and reverse-engineered upstream, so
// every assertion here pins the exact columns ai& writes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { beforeEach, describe } from "node:test";
import {
  enableInput as baseEnableInput,
  catalogModel,
  plantStub,
  withTestEnv,
} from "./helpers.mjs";

withTestEnv("aiand-copilot-app-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(join(process.env.AIAND_HOME, ".copilot"), { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { copilotAppAdapter, copilotDataDbPath, copilotAppProcessSpec, copilotAppProcessMatches } =
  await import("../dist/agents/copilot-app/adapter.js");

const dbPath = () => join(process.env.AIAND_HOME, ".copilot", "data.db");

beforeEach(() => {
  rmSync(join(process.env.AIAND_HOME, ".copilot"), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "copilot-app"), {
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

/** Create the app's BYOK tables exactly as the live app (v1.1.x) has them. */
function createAppDb(path = dbPath()) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS "accounts" (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS "model_providers" (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      type TEXT NOT NULL DEFAULT 'openai',
      settings_json TEXT NOT NULL DEFAULT '{}',
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS "provider_models" (
      id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL REFERENCES "model_providers"(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      wire_model TEXT,
      display_name TEXT NOT NULL,
      max_prompt_tokens INTEGER,
      max_output_tokens INTEGER,
      wire_api_override TEXT CHECK (wire_api_override IS NULL OR wire_api_override IN ('completions','responses')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      supported_reasoning_efforts TEXT,
      UNIQUE (provider_id, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_models_provider ON provider_models(provider_id);
  `);
  db.close();
  return path;
}

/** Plant a foreign provider row with two models, as the app's own GUI would. */
function seedForeignProvider(path = dbPath()) {
  const db = new DatabaseSync(path);
  db.exec(`
    INSERT INTO model_providers (id, name, type, settings_json) VALUES ('user-1', 'Fireworks', 'openai', '{"baseUrl":"https://api.fireworks.ai/inference/v1"}');
    INSERT INTO provider_models (id, provider_id, model_id, wire_model, display_name) VALUES ('pm-user-1', 'user-1', 'kimi-k2', 'kimi-k2', 'Kimi K2');
  `);
  db.close();
}

function rows(sql) {
  const db = new DatabaseSync(dbPath(), { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

const ourProviders = () => rows("SELECT * FROM model_providers WHERE id LIKE 'aiand-%'");
const ourModels = () =>
  rows("SELECT * FROM provider_models WHERE provider_id LIKE 'aiand-%' ORDER BY model_id");

describe("copilot-app adapter", () => {
  test("id/label/bin/managedFiles/detect", () => {
    assert.equal(copilotAppAdapter.id, "copilot-app");
    assert.equal(copilotAppAdapter.label, "GitHub Copilot app");
    assert.deepEqual(copilotAppAdapter.managedFiles(), []);
    assert.equal(copilotDataDbPath(), dbPath());
    assert.equal(copilotAppAdapter.detect().installed, false);
    createAppDb();
    const detected = copilotAppAdapter.detect();
    assert.equal(detected.installed, true);
    assert.equal(detected.path, dbPath());
  });

  test("COPILOT_HOME relocates data.db", () => {
    const elsewhere = join(process.env.AIAND_HOME, "elsewhere");
    process.env.COPILOT_HOME = elsewhere;
    try {
      assert.equal(copilotDataDbPath(), join(elsewhere, "data.db"));
      assert.deepEqual(copilotAppAdapter.managedFiles(), []);
    } finally {
      delete process.env.COPILOT_HOME;
    }
  });

  test("enable(): refuses when the app never ran (no data.db)", async () => {
    await assert.rejects(
      copilotAppAdapter.enable(enableInput()),
      (error) =>
        error.message.includes("has not created its config database") &&
        error.hint.includes("Open the GitHub Copilot app once"),
    );
    assert.equal(existsSync(dbPath()), false, "never create the app's db shell");
  });

  test("enable(): inserts the provider row and every catalog model", async () => {
    createAppDb();
    seedForeignProvider();
    const result = await copilotAppAdapter.enable(enableInput());
    assert.deepEqual(result.filesWritten, [dbPath()]);
    assert.equal(result.model, "zai-org/glm-5.3");

    const providers = ourProviders();
    assert.equal(providers.length, 1);
    const provider = providers[0];
    assert.match(provider.id, /^aiand-/);
    assert.equal(provider.name, "ai&");
    assert.equal(provider.type, "openai");
    assert.equal(provider.account_id, null);
    const settings = JSON.parse(provider.settings_json);
    assert.equal(settings.authKind, "none");
    assert.equal(settings.baseUrl, "https://api.aiand.com/v1");
    assert.equal(settings.wireApi, "completions");
    assert.deepEqual(JSON.parse(settings.headersJson), {
      Authorization: "Bearer sk-enable-1",
    });

    const models = ourModels();
    assert.deepEqual(
      models.map((row) => row.model_id),
      ["qwen/qwen3.8-27b", "zai-org/glm-5.3"],
    );
    const glm = models.find((row) => row.model_id === "zai-org/glm-5.3");
    assert.equal(glm.wire_model, "zai-org/glm-5.3");
    assert.equal(glm.display_name, "zai-org/glm-5.3");
    assert.equal(glm.max_prompt_tokens, 128000);
    assert.equal(glm.max_output_tokens, 128000);
    assert.equal(glm.wire_api_override, "completions");
    assert.deepEqual(JSON.parse(glm.supported_reasoning_efforts), []);
    const qwen = models.find((row) => row.model_id === "qwen/qwen3.8-27b");
    assert.deepEqual(JSON.parse(qwen.supported_reasoning_efforts), ["low", "high"]);

    assert.equal(rows("SELECT * FROM model_providers").length, 2, "foreign provider survives");
  });

  test("enable(): --model warns the app keeps its own pick; native stays quiet", async () => {
    createAppDb();
    const pinned = await copilotAppAdapter.enable(enableInput({ pinModel: true }));
    assert.ok(
      pinned.warnings.some((w) =>
        /The app keeps its own model pick: choose zai-org\/glm-5\.3 in its model menu\./.test(w),
      ),
    );
    assert.equal(pinned.warnings.length, 2, "the sign-in warning always rides along");
    const native = await copilotAppAdapter.enable(enableInput({ model: "native" }));
    assert.equal(native.warnings.length, 1);
  });

  test("enable(): a re-on reuses the provider id and replaces model rows", async () => {
    createAppDb();
    await copilotAppAdapter.enable(enableInput());
    const firstId = ourProviders()[0].id;
    await copilotAppAdapter.enable(enableInput({ apiKey: "sk-enable-2" }));
    const providers = ourProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, firstId, "stored sessions keep resolving");
    assert.deepEqual(
      JSON.parse(providers[0].settings_json).headersJson &&
        JSON.parse(JSON.parse(providers[0].settings_json).headersJson),
      { Authorization: "Bearer sk-enable-2" },
    );
    assert.equal(ourModels().length, CATALOG.length, "no duplicate model rows");
  });

  test("probe(): our row reads active with no model; absent reads inactive", async () => {
    assert.deepEqual(await copilotAppAdapter.probe(), { active: false, model: null });
    createAppDb();
    await copilotAppAdapter.enable(enableInput());
    assert.deepEqual(await copilotAppAdapter.probe(), { active: true, model: null });
  });

  test("probe(): a foreign or unroutable aiand- row never reads active", async () => {
    createAppDb();
    const db = new DatabaseSync(dbPath());
    db.exec(
      `INSERT INTO model_providers (id, name, type, settings_json) VALUES ('aiand-x', 'ai&', 'openai', '{"baseUrl":"ftp://elsewhere.invalid"}')`,
    );
    db.close();
    assert.equal((await copilotAppAdapter.probe()).active, false);
  });

  test("disable(): deletes exactly our rows and keeps the user's", async () => {
    createAppDb();
    seedForeignProvider();
    await copilotAppAdapter.enable(enableInput());
    const result = await copilotAppAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(ourProviders().length, 0);
    assert.equal(ourModels().length, 0);
    assert.equal(rows("SELECT * FROM model_providers WHERE id = 'user-1'").length, 1);
    assert.equal(rows("SELECT * FROM provider_models WHERE id = 'pm-user-1'").length, 1);
    assert.deepEqual(await copilotAppAdapter.probe(), { active: false, model: null });
  });

  test("disable(): with no row of ours strips nothing", async () => {
    createAppDb();
    seedForeignProvider();
    const result = await copilotAppAdapter.disable();
    assert.equal(result.stripped, false);
    assert.equal(rows("SELECT * FROM model_providers").length, 1);
  });

  test("disable(): a missing db is a clean no-op", async () => {
    const result = await copilotAppAdapter.disable();
    assert.equal(result.stripped, false);
  });

  // PR #18 review: the `aiand-` prefix is a naming convention,
  // not an ownership proof (P18-cop-7). off deletes exactly the
  // row `on` created — the recorded row id — so a user-made
  // `aiand-` row and its models are never collateral damage.
  test("disable(): leaves a user-made aiand- row and deletes only ours", async () => {
    createAppDb();
    await copilotAppAdapter.enable(enableInput());
    const ourId = ourProviders()[0].id;
    const db = new DatabaseSync(dbPath());
    db.exec(`
      INSERT INTO model_providers (id, name, type, settings_json) VALUES ('aiand-custom', 'ai&', 'openai', '{"baseUrl":"https://api.user.example/v1"}');
      INSERT INTO provider_models (id, provider_id, model_id, wire_model, display_name) VALUES ('pm-aiand-custom', 'aiand-custom', 'user-model', 'user-model', 'User Model');
    `);
    db.close();

    const result = await copilotAppAdapter.disable();

    assert.equal(result.stripped, true);
    assert.equal(rows(`SELECT * FROM model_providers WHERE id = '${ourId}'`).length, 0);
    assert.equal(rows(`SELECT * FROM provider_models WHERE provider_id = '${ourId}'`).length, 0);
    assert.equal(rows("SELECT * FROM model_providers WHERE id = 'aiand-custom'").length, 1);
    assert.equal(
      rows("SELECT * FROM provider_models WHERE provider_id = 'aiand-custom'").length,
      1,
    );
  });

  // PR #18 review: no enable() ran, so no added-state record
  // names either row. Two unclaimed `aiand-` rows are ambiguous,
  // and the ambiguity resolves in the user's favour (P18-cop-7).
  test("disable(): two unclaimed aiand- rows with no record strips nothing", async () => {
    createAppDb();
    const db = new DatabaseSync(dbPath());
    db.exec(`
      INSERT INTO model_providers (id, name, type, settings_json) VALUES ('aiand-one', 'ai&', 'openai', '{"baseUrl":"https://api.one.example/v1"}');
      INSERT INTO model_providers (id, name, type, settings_json) VALUES ('aiand-two', 'ai&', 'openai', '{"baseUrl":"https://api.two.example/v1"}');
      INSERT INTO provider_models (id, provider_id, model_id, wire_model, display_name) VALUES ('pm-one', 'aiand-one', 'm1', 'm1', 'M1');
      INSERT INTO provider_models (id, provider_id, model_id, wire_model, display_name) VALUES ('pm-two', 'aiand-two', 'm2', 'm2', 'M2');
    `);
    db.close();

    const result = await copilotAppAdapter.disable();

    // With no record naming one row, the ours-shape check would delete
    // both shaped rows; ambiguity between two of ours still resolves in
    // the user's favour (P18-cop-7), so nothing is stripped.
    assert.equal(result.stripped, false);
    assert.equal(ourProviders().length, 2);
    assert.equal(ourModels().length, 2);
  });

  test("refreshKey(): rotates only the bearer inside settings_json", async () => {
    createAppDb();
    seedForeignProvider();
    await copilotAppAdapter.enable(enableInput());
    const before = ourProviders()[0];

    assert.equal(await copilotAppAdapter.refreshKey({ apiKey: "sk-enable-1" }), true);
    assert.equal(
      await copilotAppAdapter.refreshKey({ apiKey: "sk-new", previousKey: "sk-other" }),
      false,
    );
    assert.equal(
      await copilotAppAdapter.refreshKey({ apiKey: "sk-new", previousKey: "sk-enable-1" }),
      true,
    );

    const after = ourProviders()[0];
    assert.equal(after.id, before.id);
    assert.deepEqual(JSON.parse(JSON.parse(after.settings_json).headersJson), {
      Authorization: "Bearer sk-new",
    });
    assert.equal(JSON.parse(after.settings_json).baseUrl, "https://api.aiand.com/v1");
    assert.equal(rows("SELECT * FROM model_providers WHERE id = 'user-1'").length, 1);
  });

  // PR #18 review: refreshKey writes data.db, so it
  // runs under the same quit-guard as on/off
  // (P18-cop-2): while the app is "running" (a
  // pgrep/tasklist stub that finds a process) the
  // rotation refuses and the db stays byte-identical.
  test("refreshKey(): refuses while the app is running", async () => {
    createAppDb();
    seedForeignProvider();
    await copilotAppAdapter.enable(enableInput());
    const stubBin = join(process.env.AIAND_HOME, "stub-bin");
    plantStub(stubBin, "pgrep", `printf '%s\\n' "/opt/GitHub Copilot/GitHub Copilot"\nexit 0`);
    plantStub(stubBin, "tasklist", `printf '%s\\n' "github.exe"\nexit 0`);
    const before = readFileSync(dbPath());
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = [stubBin, originalPath].join(delimiter);
      await assert.rejects(copilotAppAdapter.refreshKey({ apiKey: "sk-new" }), (error) =>
        error.message.includes("Quit the GitHub Copilot app first"),
      );
    } finally {
      process.env.PATH = originalPath;
    }
    assert.equal(readFileSync(dbPath()).equals(before), true);
  });

  // PR #18 review: rebakeAgentKeys calls refreshKey on
  // every adapter, wired or not. With the app running
  // but no aiand- row, the lookup misses and returns
  // false before the quit-guard ever runs — login,
  // config use and token rotation must not demand a
  // quit from a user who never ran `copilot-app on`.
  test("refreshKey(): running app without our row is a silent false", async () => {
    createAppDb();
    seedForeignProvider();
    const stubBin = join(process.env.AIAND_HOME, "stub-bin");
    plantStub(stubBin, "pgrep", `printf '%s\\n' "/opt/GitHub Copilot/GitHub Copilot"\nexit 0`);
    plantStub(stubBin, "tasklist", `printf '%s\\n' "github.exe"\nexit 0`);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = [stubBin, originalPath].join(delimiter);
      assert.equal(await copilotAppAdapter.refreshKey({ apiKey: "sk-new" }), false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  // PR #18 review: a corrupt settings_json must fail
  // loud, not mint a second row beside it (P18-cop-4).
  test("enable(): a corrupt ai& provider row fails loud instead of adding a second", async () => {
    createAppDb();
    await copilotAppAdapter.enable(enableInput());
    const id = ourProviders()[0].id;
    const db = new DatabaseSync(dbPath());
    db.exec(`UPDATE model_providers SET settings_json = '{not json' WHERE id = '${id}'`);
    db.close();
    await assert.rejects(copilotAppAdapter.enable(enableInput()), (error) =>
      error.message.includes("provider row is corrupt"),
    );
    assert.equal(ourProviders().length, 1, "no second row was minted");
  });

  test("refreshKey(): no row is false", async () => {
    createAppDb();
    assert.equal(await copilotAppAdapter.refreshKey({ apiKey: "sk-new" }), false);
  });

  test("schema drift surfaces as a CliError pointing at the GUI", async () => {
    writeFileSync(dbPath(), "not a sqlite file at all");
    await assert.rejects(
      copilotAppAdapter.enable(enableInput()),
      (error) =>
        error.message.includes("provider database") && error.hint.includes("Model providers"),
    );
  });

  // The app's real process names, verified upstream. The guard must match
  // the desktop app only: its bundled CLI child copilot.exe is
  // image-name-identical to the standalone Copilot CLI binary and must
  // never be blocked for, and /usr/local/bin/copilot is the CLI itself.
  const APP_PROCESSES = {
    darwin: [
      "/Applications/GitHub Copilot.app/Contents/MacOS/GitHub Copilot",
      "/tmp/GitHub Copilot.app/Contents/MacOS/github-copilot-helper",
    ],
    linux: ["/opt/GitHub Copilot/GitHub Copilot --ozone", "/tmp/GitHub Copilot"],
    win32: ["github.exe"],
  };
  const NOT_APP_PROCESSES = {
    darwin: ["/usr/local/bin/copilot -p hi -s", "pgrep -fi GitHub Copilot"],
    linux: ["/usr/bin/copilot", "GitHub Copilot"],
    win32: [
      "C:\\Users\\someone\\.copilot\\sdk\\cli\\1.2.3\\copilot.exe --server --stdio",
      "copilot.exe",
      "github-desktop.exe",
    ],
  };

  test("process guard: matches the app, never the CLI", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      for (const line of APP_PROCESSES[platform]) {
        assert.equal(
          copilotAppProcessMatches(copilotAppProcessSpec, platform, line),
          true,
          `${platform}: ${line}`,
        );
      }
      for (const line of NOT_APP_PROCESSES[platform]) {
        assert.equal(
          copilotAppProcessMatches(copilotAppProcessSpec, platform, line),
          false,
          `${platform}: ${line}`,
        );
      }
    }
  });
});
