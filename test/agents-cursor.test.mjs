import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

let dir;
const originalEnv = { ...process.env };

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-cursor-test-"));
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_HOME = join(dir, "home");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const {
  readItemTableValue,
  writeItemTableValue,
  deleteItemTableValue,
  applyItemTableWrites,
  ensureItemTable,
} = await import("../dist/agents/vscdb.js");
const {
  aesEncrypt,
  aesDecrypt,
  encryptSecret,
  decryptSecret,
  plaintextMode,
  isSecretEncryptionAvailable,
  resetLinuxSafeStorageDetectionForTests,
} = await import("../dist/agents/safestorage.js");
const {
  cursorAdapter,
  cursorStateDbPath,
  cursorLocalStatePath,
  APPLICATION_USER_KEY,
  CURSOR_AUTH_OPENAI_KEY,
  CURSOR_AUTH_OPENAI_KEY_SECRET,
  CURSOR_BASE_URL,
  EMPTY_SAFE_STORAGE_CIPHERTEXT,
  readCursorState,
  readCursorOpenAiKey,
  cursorHasAiandMarkers,
} = await import("../dist/agents/cursor.js");
const { foreignMarkerFixtures } = await import("../dist/agents/foreign.js");
const { detectForeign } = await import("../dist/agents/foreign.js");

const home = () => process.env.AIAND_HOME;

const MODEL = "zai-org/glm-5.3";
const KEY = "sk-cursor-test-key-1";

let dbPath;
function makeDb() {
  const p = cursorStateDbPath({ home: home() });
  mkdirSync(join(p, ".."), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec(
    "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);"
  );
  db.close();
  dbPath = p;
  return p;
}

/** Write a pre-existing applicationUser blob with unrelated aiSettings + rows. */
function plantDb(p, { aiSettings = {}, extraRows = {} } = {}) {
  const blob = JSON.stringify({
    someOtherField: 42,
    ...(Object.keys(aiSettings).length ? { aiSettings } : {}),
  });
  const db = new DatabaseSync(p);
  if (!dbPath) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);"
    );
  }
  db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(
    APPLICATION_USER_KEY,
    blob
  );
  for (const [k, v] of Object.entries(extraRows)) {
    db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(k, v);
  }
  db.close();
}

function enableInput(overrides = {}) {
  return {
    apiKey: KEY,
    model: MODEL,
    slots: {},
    catalog: [],
    home: home(),
    ...overrides,
  };
}

async function readBlob(p) {
  const raw = await readItemTableValue(p, APPLICATION_USER_KEY);
  return raw ? JSON.parse(raw) : {};
}

describe("vscdb ItemTable helpers", () => {
  test("write/read/delete round-trip via node:sqlite", async () => {
    const p = join(dir, "vscdb-roundtrip", "state.vscdb");
    await ensureItemTable(p);
    await writeItemTableValue(p, "k1", "a value");
    assert.equal(await readItemTableValue(p, "k1"), "a value");
    await writeItemTableValue(p, "k1", "updated");
    assert.equal(await readItemTableValue(p, "k1"), "updated");
    await deleteItemTableValue(p, "k1");
    assert.equal(await readItemTableValue(p, "k1"), "");
    // Missing file → ""
    assert.equal(await readItemTableValue(join(dir, "nope.vscdb"), "x"), "");
  });

  test("applyItemTableWrites applies multiple mutations", async () => {
    const p = join(dir, "vscdb-multi", "state.vscdb");
    await ensureItemTable(p);
    await applyItemTableWrites(p, [
      { op: "set", key: "a", value: "1" },
      { op: "set", key: "b", value: "2" },
      { op: "del", key: "a" },
    ]);
    assert.equal(await readItemTableValue(p, "a"), "");
    assert.equal(await readItemTableValue(p, "b"), "2");
  });

  test("applyItemTableWrites rolls back the whole batch on a failing mutation", async () => {
    // applyItemTableWrites uses INSERT OR REPLACE, so a duplicate key never
    // conflicts. Enforce a value CHECK constraint instead: the second write
    // exceeds it and throws, proving the first (already applied) write is
    // rolled back rather than partially persisted.
    const p = join(dir, "vscdb-rollback", "state.vscdb");
    mkdirSync(join(p, ".."), { recursive: true });
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB CHECK (length(value) <= 4));");
    db.close();

    await assert.rejects(
      applyItemTableWrites(p, [
        { op: "set", key: "first", value: "ok" },
        { op: "set", key: "second", value: "toolong" },
      ]),
      /CHECK/i
    );
    // The first write must NOT have persisted — the transaction rolled back.
    assert.equal(await readItemTableValue(p, "first"), "");
  });
});

describe("safestorage encrypt/decrypt", () => {
  test("aesEncrypt/aesDecrypt round-trip on the linux basic backend (peanuts)", () => {
    const ct = aesEncrypt("hello secret", "peanuts", "v10", 1);
    assert.equal(ct.subarray(0, 3).toString("latin1"), "v10");
    assert.equal(aesDecrypt(ct, "peanuts", 1), "hello secret");
  });

  test("decryptSecret of the empty-buffer JSON shape is ''", () => {
    assert.equal(decryptSecret(EMPTY_SAFE_STORAGE_CIPHERTEXT, { variant: "cursor" }), "");
    assert.equal(decryptSecret("", { variant: "cursor" }), "");
  });

  test("encryptSecret/decryptSecret round-trip without the plaintext seam (linux path)", () => {
    // Deterministic: no Secret Service on this host → v10/peanuts basic backend.
    resetLinuxSafeStorageDetectionForTests();
    const enc = encryptSecret("roundtrip-key", { variant: "cursor" });
    assert.ok(enc.startsWith("{\"type\":\"Buffer\",\"data\""));
    assert.equal(decryptSecret(enc, { variant: "cursor" }), "roundtrip-key");
  });

  test("AIAND_IDE_SECRET_PLAINTEXT seam round-trips verbatim", () => {
    const prev = process.env.AIAND_IDE_SECRET_PLAINTEXT;
    process.env.AIAND_IDE_SECRET_PLAINTEXT = "1";
    try {
      assert.equal(plaintextMode(), true);
      assert.equal(isSecretEncryptionAvailable({ variant: "cursor" }), true);
      const enc = encryptSecret("plain-secret", { variant: "cursor" });
      assert.equal(enc, "plain-secret");
      assert.equal(decryptSecret(enc, { variant: "cursor" }), "plain-secret");
    } finally {
      if (prev === undefined) delete process.env.AIAND_IDE_SECRET_PLAINTEXT;
      else process.env.AIAND_IDE_SECRET_PLAINTEXT = prev;
    }
  });

  test("plaintextMode is strict === 1", () => {
    const prev = process.env.AIAND_IDE_SECRET_PLAINTEXT;
    process.env.AIAND_IDE_SECRET_PLAINTEXT = "0";
    try {
      assert.equal(plaintextMode(), false);
    } finally {
      if (prev === undefined) delete process.env.AIAND_IDE_SECRET_PLAINTEXT;
      else process.env.AIAND_IDE_SECRET_PLAINTEXT = prev;
    }
  });
});

describe("cursor adapter path helpers", () => {
  test("localStatePath is three dirs above the db", () => {
    const db = cursorStateDbPath({ home: join(dir, "home") });
    assert.equal(
      cursorLocalStatePath(db),
      join(dir, "home", ".config", "Cursor", "Local State")
    );
  });

  test("managedFiles is the state.vscdb path", () => {
    assert.deepEqual(cursorAdapter.managedFiles(), [cursorStateDbPath()]);
  });
});

describe("cursor enable", () => {
  test("enable wires base url/model/key, leaves unrelated rows and fields, tracks markers", async () => {
    const p = makeDb();
    // Pre-existing blob with an unrelated aiSettings field + unrelated rows.
    plantDb(p, {
      aiSettings: { modelConfig: { "cmd-k": { maxMode: true } } },
      extraRows: { "some/other": "keepme" },
    });

    const input = enableInput();
    const result = await cursorAdapter.enable(input);
    assert.equal(result.model, MODEL);
    assert.deepEqual(result.filesWritten, [p]);

    const blob = await readBlob(p);
    assert.equal(blob.openAIBaseUrl, CURSOR_BASE_URL);
    assert.equal(blob.useOpenAIKey, true);
    assert.equal(blob.someOtherField, 42, "unrelated root field survives");

    const ai = blob.aiSettings;
    assert.ok(ai.userAddedModels.includes(MODEL));
    assert.ok(ai.modelOverrideEnabled.includes(MODEL));
    assert.ok(ai.aiandAddedModels.includes(MODEL));
    // A pre-existing cmd-k mode gets the model; composer is not created when
    // any mode already exists (fresh DBs get the composer default instead).
    assert.equal(ai.modelConfig["cmd-k"].modelName, MODEL);
    assert.ok(!ai.modelConfig.composer, "composer not created when cmd-k already exists");
    assert.ok(ai.aiandTouchedModes.includes("cmd-k"));
    assert.ok(!ai.aiandTouchedModes.includes("composer"));

    // Unrelated rows untouched.
    assert.equal(await readItemTableValue(p, "some/other"), "keepme");

    // Key cells: secret cell decrypts (or plaintext seam / linux real path).
    assert.equal(await readCursorOpenAiKey(p), KEY);

    // Model selection is live for default mode.
    const cs = await readCursorState(p);
    assert.ok(cursorHasAiandMarkers(cs.blob));
  });

  test("probe() is active with the model after enable", async () => {
    // Fresh DB (no existing modes) → enable sets the composer default, which
    // probe() reports as the active model.
    const p = makeDb();
    plantDb(p, {});
    await cursorAdapter.enable(enableInput());
    const probe = await cursorAdapter.probe();
    assert.equal(probe.active, true);
    assert.equal(probe.model, MODEL);
  });

  test("re-enable is idempotent: aiandAddedModels not duplicated", async () => {
    const p = makeDb();
    plantDb(p, {});
    const input = enableInput();
    await cursorAdapter.enable(input);
    await cursorAdapter.enable(input);
    const blob = await readBlob(p);
    const added = blob.aiSettings.aiandAddedModels;
    assert.ok(added.length >= 1, `expected our model tracked, got ${JSON.stringify(added)}`);
    assert.equal(
      added.filter((x) => x === MODEL).length,
      1,
      `model should appear exactly once, got ${JSON.stringify(added)}`
    );
    assert.equal(blob.aiSettings.userAddedModels.filter((x) => x === MODEL).length, 1);
  });
});

describe("cursor disable (strip path)", () => {
  test("no manifest: markers present → built-ins restored, no-backup strip", async () => {
    const p = makeDb();
    // Some unrelated rows must survive; plant a real existing mode too.
    plantDb(p, {
      aiSettings: { modelConfig: { "cmd-k": { maxMode: true } } },
      extraRows: { "keep/row": "keep" },
    });
    await cursorAdapter.enable(enableInput());
    assert.equal(await readItemTableValue(p, "keep/row"), "keep");

    await cursorAdapter.disable();

    const blob = await readBlob(p);
    assert.equal(blob.openAIBaseUrl, null);
    assert.equal(blob.useOpenAIKey, false);
    assert.equal(blob.someOtherField, 42, "unrelated root field survives");

    const ai = blob.aiSettings;
    assert.deepEqual(ai.userAddedModels, []);
    assert.deepEqual(ai.aiandAddedModels, []);
    assert.deepEqual(ai.aiandTouchedModes, []);
    // Touched modes reset to "default".
    assert.equal(ai.modelConfig["cmd-k"].modelName, "default", "touched mode not reset");

    // Key cells: secret cell = empty-buffer shape, legacy plaintext deleted.
    assert.equal(
      await readItemTableValue(p, CURSOR_AUTH_OPENAI_KEY_SECRET),
      EMPTY_SAFE_STORAGE_CIPHERTEXT
    );
    assert.equal(await readItemTableValue(p, CURSOR_AUTH_OPENAI_KEY), "");

    // Unrelated rows untouched.
    assert.equal(await readItemTableValue(p, "keep/row"), "keep");
  });

  test("marker-free blob → disable is a no-op (byte-identical blob)", async () => {
    const p = makeDb();
    const cleanBlob = JSON.stringify({ openAIBaseUrl: "https://api.elsewhere.example/v1", aiSettings: { userAddedModels: ["my-own-model"] } });
    const db = new DatabaseSync(p);
    db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(
      APPLICATION_USER_KEY,
      cleanBlob
    );
    db.close();
    const before = await readItemTableValue(p, APPLICATION_USER_KEY);

    await cursorAdapter.disable();
    assert.equal(await readItemTableValue(p, APPLICATION_USER_KEY), before);
    const blob = await readBlob(p);
    assert.ok(!blob.aiSettings.aiandAddedModels, "no marker created by a no-op disable");
  });
});

describe("cursor foreign detection", () => {
  test("detectForeign on a raw binary state.vscdb may not trip; probe reports truth", async () => {
    const p = makeDb();
    // Plant the setup-tool-shaped settings fixture as the ItemTable value, so
    // the DB's raw bytes literally contain the foreign fragment. Whether
    // detectForeign's file-read (binary bytes) trips is an empirical fact —
    // this test asserts whatever holds, without weakening foreign.ts.
    const [settingsFixture] = Object.values(foreignMarkerFixtures());
    const db = new DatabaseSync(p);
    db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(
      APPLICATION_USER_KEY,
      settingsFixture
    );
    db.close();

    const detected = await detectForeign([p]);
    const probe = await cursorAdapter.probe();
    // Honest assertion: probe.foreignTool matches the direct detectForeign
    // result on the same bytes — never a stronger claim.
    assert.equal(probe.foreignTool, detected);
  });
});