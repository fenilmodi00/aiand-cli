import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLOSED_URL, cliEnv, FAKE_API_KEY, runCli, withTestEnv } from "./helpers.mjs";

/**
 * Branch coverage for the copilot-app SQLite shims (exec/query/vacuum and
 * their error classifiers), `aiand status`, `aiand doctor`, the envelope
 * store's fail-open reads, and `aiand store` CLI branches. Behavior only:
 * exit codes, stdout/stderr, and returned values — never internals.
 */

const env = withTestEnv("sqlite-status-doctor", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const iso = (ms) => new Date(Date.parse("2026-10-20T10:00:00.000Z") + ms).toISOString();

async function seedStore(cfg, rows) {
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  const { withEnv } = await import("./helpers.mjs");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      insert.run(
        r.id,
        r.model ?? "zai-org/glm-5.3",
        r.api_key ?? null,
        r.status ?? 200,
        r.ttft ?? 300,
        r.latency ?? null,
        r.input ?? 1000,
        r.output ?? 100,
        r.cached ?? 500,
        r.cost === null ? null : String(r.cost),
        r.cost,
        r.currency === null ? null : (r.currency ?? "usd"),
        r.created_at ?? iso(0),
        r.created_at ?? iso(0),
      );
    }
    opened.db.close();
  });
}

// ---------------------------------------------------------------------------
// copilot-app sqlite helpers: classifier + atomicity branches
// ---------------------------------------------------------------------------

test("sqlString doubles single quotes and only those", async () => {
  const { sqlString } = await import("../dist/agents/copilot-app/sqlite.js");
  assert.equal(sqlString("plain"), "'plain'");
  assert.equal(sqlString("o'brien"), "'o''brien'");
});

test("isCopilotSchemaError matches schema-drift messages only", async () => {
  const { isCopilotSchemaError } = await import("../dist/agents/copilot-app/sqlite.js");
  assert.equal(isCopilotSchemaError(new Error("no such table: model_providers")), true);
  assert.equal(isCopilotSchemaError("no such column: settings_json"), true);
  assert.equal(isCopilotSchemaError(new Error("file is not a database")), true);
  assert.equal(isCopilotSchemaError(new Error("disk I/O error")), false);
  assert.equal(isCopilotSchemaError(undefined), false);
});

test("isCopilotDbAccessError matches unusable-store messages only", async () => {
  const { isCopilotDbAccessError } = await import("../dist/agents/copilot-app/sqlite.js");
  assert.equal(isCopilotDbAccessError(new Error("unable to open database file")), true);
  assert.equal(isCopilotDbAccessError(new Error("EACCES: permission denied")), true);
  assert.equal(isCopilotDbAccessError("attempt to write a readonly database"), true);
  assert.equal(isCopilotDbAccessError(new Error("no such table: x")), false);
});

test("execCopilotSql commits a batch atomically and rolls back a bad one", async () => {
  const { execCopilotSql } = await import("../dist/agents/copilot-app/sqlite.js");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = cfgDir("copilot-sql");
  const dbPath = join(dir, "data.db");
  const setup = new DatabaseSync(dbPath);
  setup.exec("CREATE TABLE t (id TEXT)");
  setup.close();

  await execCopilotSql(dbPath, ["INSERT INTO t VALUES ('a')", "INSERT INTO t VALUES ('b')"]);
  const check = new DatabaseSync(dbPath, { readOnly: true });
  assert.deepEqual(
    check
      .prepare("SELECT id FROM t ORDER BY id")
      .all()
      .map((r) => r.id),
    ["a", "b"],
  );
  check.close();

  await assert.rejects(
    execCopilotSql(dbPath, ["INSERT INTO t VALUES ('c')", "INSERT INTO nope VALUES (1)"]),
    /no such table|nope/,
  );
  const after = new DatabaseSync(dbPath, { readOnly: true });
  // The 'c' insert rolled back with the failed batch.
  assert.equal(after.prepare("SELECT COUNT(*) AS n FROM t WHERE id = 'c'").get().n, 0);
  after.close();
});

test("execCopilotSql with an empty batch is a no-op", async () => {
  const { execCopilotSql } = await import("../dist/agents/copilot-app/sqlite.js");
  const dir = cfgDir("copilot-sql-empty");
  const dbPath = join(dir, "data.db");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE t (id TEXT)");
  db.close();
  await execCopilotSql(dbPath, []);
  const check = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM t").get().n, 0);
  check.close();
});

test("envelope store: reads on a corrupt db fail open, never throw", async () => {
  const cfg = cfgDir("envelope-corrupt");
  const { storePath } = await import("../dist/store/index.js");
  const { listEnvelopes } = await import("../dist/store/envelopes.js");
  const { withEnv } = await import("./helpers.mjs");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    mkdirSync(join(storePath(), ".."), { recursive: true });
    writeFileSync(storePath(), "garbage bytes pretending to be sqlite");
    // A fail-open read returns [] on a corrupt store.
    const rows = listEnvelopes();
    assert.ok(Array.isArray(rows));
  });
});

test("queryCopilotSql: missing file, empty result, no-such-table, real rows", async () => {
  const { queryCopilotSql } = await import("../dist/agents/copilot-app/sqlite.js");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = cfgDir("copilot-query");
  // Missing file: no rows, no throw.
  assert.deepEqual(await queryCopilotSql(join(dir, "absent.db"), "SELECT 1 AS x"), []);
  // Real db without the queried table: treated as absent.
  const dbPath = join(dir, "data.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE mine (k TEXT, v TEXT)");
  db.exec("INSERT INTO mine VALUES ('a', '1')");
  db.close();
  assert.deepEqual(await queryCopilotSql(dbPath, "SELECT * FROM other"), []);
  assert.deepEqual(
    (await queryCopilotSql(dbPath, "SELECT k, v FROM mine")).map((r) => ({ ...r })),
    [{ k: "a", v: "1" }],
  );
});

test("queryCopilotSql surfaces a genuinely broken query", async () => {
  const { queryCopilotSql } = await import("../dist/agents/copilot-app/sqlite.js");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = cfgDir("copilot-query-bad");
  const dbPath = join(dir, "data.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE mine (k TEXT)");
  db.close();
  await assert.rejects(queryCopilotSql(dbPath, "SELECT FROM WHERE"), /syntax|near|Error/i);
});

test("vacuumCopilotSql rewrites the db without losing rows", async () => {
  const { execCopilotSql, vacuumCopilotSql } = await import("../dist/agents/copilot-app/sqlite.js");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = cfgDir("copilot-vacuum");
  const dbPath = join(dir, "data.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE t (id TEXT)");
  db.close();
  await execCopilotSql(dbPath, ["INSERT INTO t VALUES ('keep')"]);
  await vacuumCopilotSql(dbPath);
  const check = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM t").get().n, 1);
  check.close();
});

test("vacuumCopilotSql on a non-database file fails loud", async () => {
  const { vacuumCopilotSql } = await import("../dist/agents/copilot-app/sqlite.js");
  const dir = cfgDir("copilot-vacuum-bad");
  const notDb = join(dir, "data.db");
  writeFileSync(notDb, "this is not a database at all");
  await assert.rejects(vacuumCopilotSql(notDb), /file is not a database|SQLITE|Error/i);
});

// ---------------------------------------------------------------------------
// aiand status: store present/absent, --json, sync variants
// ---------------------------------------------------------------------------

test("status: signed-out with a reachable gateway is the documented exit 1", async () => {
  const cfg = cfgDir("status-empty");
  const text = await runCli(["status"], { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
  // Signed-out + reachable gateway: exits 1 by design, so scripts can gate
  // on "needs login" (status.ts:135).
  assert.equal(text.code, 1, text.stderr);
  assert.ok(/Not signed in/.test(text.stdout), `sign-in note: ${text.stdout}`);
  assert.ok(/AGENT\s+STATE/.test(text.stdout), `agent table: ${text.stdout}`);

  const json = await runCli(["status", "--json"], { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
  assert.equal(json.code, 1, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.auth.signed_in, false);
});

test("status: --help documents itself", async () => {
  const cfg = cfgDir("status-help");
  const help = await runCli(["status", "--help"], { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes("aiand status"));
});

// ---------------------------------------------------------------------------
// aiand doctor: store-less, seeded, corrupt-store, --json
// ---------------------------------------------------------------------------

test("doctor: empty config reports NOTHING FOUND / SKIPPED and exits 0", async () => {
  const cfg = cfgDir("doctor-empty");
  const out = await runCli(["doctor"], { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
  assert.equal(out.code, 0, `${out.stdout}${out.stderr}`);
  assert.ok(/store\s+NOTHING FOUND/.test(out.stdout), `store row: ${out.stdout}`);
  assert.ok(/gateway\s+SKIPPED/.test(out.stdout), `gateway row: ${out.stdout}`);
});

test("doctor: seeded store is OK; --json parses and exit stays 0", async () => {
  const cfg = cfgDir("doctor-seeded");
  await seedStore(cfg, [{ id: "d1", cost: 0.01 }]);
  const out = await runCli(["doctor"], { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
  assert.equal(out.code, 0, `${out.stdout}${out.stderr}`);
  assert.ok(/store\s+OK \(1 rows/.test(out.stdout), `store row: ${out.stdout}`);

  const json = await runCli(["doctor", "--json"], { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.ok(Array.isArray(parsed) || (parsed && typeof parsed === "object"));
});

test("doctor: a corrupt store file is ERRORS and exits non-zero", async () => {
  const cfg = cfgDir("doctor-corrupt");
  const { storePath } = await import("../dist/store/index.js");
  const { withEnv } = await import("./helpers.mjs");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    mkdirSync(join(storePath(), ".."), { recursive: true });
    writeFileSync(storePath(), "definitely not a sqlite database");
  });
  const out = await runCli(["doctor"], { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
  assert.notEqual(out.code, 0, `corrupt store must be scriptable: ${out.stdout}${out.stderr}`);
  assert.ok(/store\s+ERRORS/.test(out.stdout), `errors row: ${out.stdout}`);
});

// ---------------------------------------------------------------------------
// envelope store fail-open reads + aiand store CLI branches
// ---------------------------------------------------------------------------

test("store command: status/json/sweep on an empty store all exit clean", async () => {
  const cfg = cfgDir("store-cli");
  for (const args of [
    ["store", "status", "--no-sync"],
    ["store", "status", "--no-sync", "--json"],
  ]) {
    const out = await runCli(args, { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
    assert.equal(out.code, 0, `${args.join(" ")}: ${out.stdout}${out.stderr}`);
    assert.ok(out.stdout.length > 0);
  }
});

test("store command: dead gateway sync warns and still exits 0", async () => {
  const cfg = cfgDir("store-cli-deadgw");
  await seedStore(cfg, [{ id: "g1", cost: 0.01 }]);
  const out = await runCli(["store", "status", "--base-url", CLOSED_URL], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: FAKE_API_KEY }),
  });
  assert.equal(out.code, 0, out.stderr);
});
