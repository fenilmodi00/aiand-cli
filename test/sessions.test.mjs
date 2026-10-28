import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { withEnv, withTestEnv } from "./helpers.mjs";

// OBS-P0-3 (#66): the sessionization engine — gap-based grouping of stored
// requests per api_key, with a configurable threshold (config key
// sessionGapMinutes, flag override --session-gap), deterministic session ids,
// materialized sessions table, and the heuristic confidence annotation.

const box = withTestEnv("aiand-sessions-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
});

// -- fixtures -------------------------------------------------------------------

const BASE = Date.UTC(2026, 9, 1, 10, 0, 0);

/** A request row shaped like the store's `requests` rows, n minutes after 10:00Z. */
function req(n, overrides = {}) {
  return {
    id: `log-${String(n).padStart(4, "0")}`,
    api_key: "sk-abcd...1234",
    created_at: new Date(BASE + n * 60_000).toISOString(),
    input_tokens: 1_000,
    output_tokens: 300,
    cached_tokens: 400,
    cost: "0.0042",
    cost_value: 0.0042,
    currency: "usd",
    ...overrides,
  };
}

const sessions = () => import("../dist/store/sessions.js");

/**
 * Create + migrate store.db directly (the real store file is only created on
 * a first sync; seeding migrations + rows keeps these tests offline) and
 * insert request rows verbatim.
 */
async function seedRequests(dir, rows) {
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const { MIGRATIONS } = await import("../dist/store/migrations/index.js");
  const db = new DatabaseSync(join(dir, "store.db"));
  try {
    // Mirror the runner: record applied versions, or openStore's migrate()
    // re-applies them and the 0005 ALTER fails on the duplicate column.
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (" +
        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    // Skip versions already recorded: re-seeding an existing store.db
    // re-runs this loop, and migrations are not all idempotent SQL.
    const applied = new Set(
      db
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((r) => r.version),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    }
    const insert = db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, " +
        "latency_ms, input_tokens, output_tokens, cached_tokens, cost, cost_value, " +
        "currency, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(
        row.id,
        "test/model",
        row.api_key,
        200,
        120,
        1_400,
        row.input_tokens,
        row.output_tokens,
        row.cached_tokens,
        row.cost,
        row.cost_value,
        row.currency,
        row.created_at,
        new Date().toISOString(),
      );
    }
  } finally {
    db.close();
  }
}

/** Point the key→agent map at a masked key (agent-keys.json in the config dir). */
function plantAgentKey(dir, masked, agent) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent-keys.json"),
    `${JSON.stringify({ version: 1, keys: [{ agent, masked, fingerprint: "f".repeat(16), at: 0 }] })}\n`,
  );
}

const MINUTE = 60_000;

// -- pure grouping (sessionize) --------------------------------------------------

describe("sessionize() — gap boundaries", () => {
  test("a gap just under the threshold stays one session", async () => {
    const mod = await sessions();
    const rows = [
      req(0),
      req(0, { id: "b", created_at: new Date(BASE + 9 * MINUTE + 59_000).toISOString() }),
    ];
    const result = mod.sessionize(rows);
    assert.equal(result.length, 1);
    assert.equal(result[0].turns, 2);
  });

  test("a gap exactly at the threshold splits (#66)", async () => {
    const mod = await sessions();
    const rows = [
      req(0),
      req(1, { id: "b", created_at: new Date(BASE + 10 * MINUTE).toISOString() }),
    ];
    const result = mod.sessionize(rows);
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((s) => s.turns),
      [1, 1],
    );
  });

  test("a gap just over the threshold splits", async () => {
    const mod = await sessions();
    const rows = [
      req(0),
      req(1, { id: "b", created_at: new Date(BASE + 10 * MINUTE + 1_000).toISOString() }),
    ];
    const result = mod.sessionize(rows);
    assert.equal(result.length, 2);
  });

  test("a custom threshold moves the boundary", async () => {
    const mod = await sessions();
    // 7 minutes apart: one session at the 10-minute default, two at a 5-minute gap.
    const rows = [
      req(0),
      req(1, { id: "b", created_at: new Date(BASE + 7 * MINUTE).toISOString() }),
    ];
    assert.equal(mod.sessionize(rows).length, 1);
    assert.equal(mod.sessionize(rows, 5).length, 2);
  });
});

describe("sessionize() — determinism and edge cases", () => {
  test("identical created_at ties break by id, deterministically", async () => {
    const mod = await sessions();
    const rows = [
      req(0, { id: "log-b", created_at: new Date(BASE).toISOString() }),
      req(1, { id: "log-a", created_at: new Date(BASE).toISOString() }),
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const result = mod.sessionize(order);
      assert.equal(result.length, 1);
      assert.equal(result[0].started_at, new Date(BASE).toISOString());
      assert.equal(result[0].turns, 2);
    }
  });

  test("input order never matters — same rows in any order, same sessions", async () => {
    const mod = await sessions();
    const rows = [req(0), req(2), req(25), req(1, { id: "log-0001b" })];
    const forward = mod.sessionize(rows);
    const reversed = mod.sessionize([...rows].reverse());
    assert.deepEqual(JSON.parse(JSON.stringify(reversed)), JSON.parse(JSON.stringify(forward)));
  });

  test("rebuilding twice yields byte-identical sessions", async () => {
    const mod = await sessions();
    const rows = [req(0), req(3), req(30, { id: "log-b" })];
    const first = JSON.stringify(mod.sessionize(rows));
    const second = JSON.stringify(mod.sessionize(rows));
    assert.equal(first, second);
  });

  test("interleaved api_keys produce independent sessions", async () => {
    const mod = await sessions();
    const rows = [
      req(0, { api_key: "sk-aaaa...1111", id: "a1" }),
      req(1, { api_key: "sk-bbbb...2222", id: "b1" }),
      req(2, { api_key: "sk-aaaa...1111", id: "a2" }),
      // a big gap, then activity on both keys again — each key splits on its own.
      req(60, { api_key: "sk-aaaa...1111", id: "a3" }),
      req(61, { api_key: "sk-bbbb...2222", id: "b2" }),
    ];
    const result = mod.sessionize(rows);
    const byKey = Object.groupBy(result, (s) => s.api_key);
    assert.equal(byKey["sk-aaaa...1111"].length, 2);
    assert.equal(byKey["sk-bbbb...2222"].length, 2);
    assert.equal(byKey["sk-aaaa...1111"][0].turns, 2);
  });

  test("a lone request is a valid session with single-request confidence", async () => {
    const mod = await sessions();
    const [only] = mod.sessionize([req(0)]);
    assert.equal(only.turns, 1);
    assert.equal(only.confidence, "single-request");
    assert.equal(only.started_at, only.ended_at);
  });

  test("multi-request sessions carry gap confidence; unmapped keys stay unknown", async () => {
    const mod = await sessions();
    const result = mod.sessionize([req(0), req(1)]);
    assert.equal(result[0].confidence, "gap");
    assert.equal(result[0].agent, "unknown");
  });

  test("token totals follow the gateway convention — input INCLUDES cached", async () => {
    const mod = await sessions();
    const result = mod.sessionize([
      req(0, { input_tokens: 1_000, cached_tokens: 400 }),
      req(1, { input_tokens: 1_500, cached_tokens: 600, id: "b" }),
    ]);
    // Verbatim sums: input 2500 (never input-minus-cached 1500), cached 1000.
    assert.equal(result[0].input_tokens, 2_500);
    assert.equal(result[0].cached_tokens, 1_000);
    assert.ok(result[0].cached_tokens <= result[0].input_tokens);
  });

  test("cost sums parsed values; all-unparseable cost stays null", async () => {
    const mod = await sessions();
    const [summed] = mod.sessionize([
      req(0),
      req(1, { cost: "0.0100", cost_value: 0.01, id: "b" }),
    ]);
    assert.equal(summed.cost, 0.0142);
    const [unparseable] = mod.sessionize([
      req(0, { cost: "n/a", cost_value: null }),
      req(1, { cost: null, cost_value: null, id: "b" }),
    ]);
    assert.equal(unparseable.cost, null);
  });
});

// -- gap resolution (config default vs flag) -------------------------------------

describe("gap threshold resolution — config < flag precedence", () => {
  test("no config, no flag → 10 minutes", async () => {
    const mod = await sessions();
    assert.equal(mod.resolveGapMinutes(), 10);
    assert.equal(mod.DEFAULT_SESSION_GAP_MINUTES, 10);
  });

  test("sessionGapMinutes in config.json becomes the default", async () => {
    const dir = join(box.dir, "gap-config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), `${JSON.stringify({ sessionGapMinutes: 5 })}\n`);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const mod = await sessions();
      assert.equal(mod.resolveGapMinutes(), 5);
      assert.equal(mod.resolveGapMinutes(15), 15); // the flag wins
    });
  });

  test("an invalid config value falls back to the default; an invalid flag is an error", async () => {
    const dir = join(box.dir, "gap-bad-config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), `${JSON.stringify({ sessionGapMinutes: -3 })}\n`);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const mod = await sessions();
      assert.equal(mod.resolveGapMinutes(), 10);
      assert.throws(() => mod.resolveGapMinutes(0), /Invalid --session-gap/);
    });
  });
});

// -- the store-backed surface (listSessions) --------------------------------------

describe("listSessions()", () => {
  test("no store yet → empty, annotated, never throws", async () => {
    const dir = join(box.dir, "no-store");
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const mod = await sessions();
      const result = mod.listSessions();
      assert.deepEqual(result.sessions, []);
      assert.deepEqual(result.sessionization, {
        method: "time-gap",
        gapMinutes: 10,
        confidence: "heuristic",
        override: null,
      });
    });
  });

  test("groups stored requests, materializes the table, and rebuilds byte-identically", async () => {
    const dir = join(box.dir, "materialized");
    await seedRequests(dir, [req(0), req(2), req(40, { id: "log-b" })]);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const mod = await sessions();
      const first = mod.listSessions();
      assert.equal(first.sessions.length, 2);
      assert.equal(first.sessions[0].turns, 2);
      assert.ok(first.sessions[0].session_id.length === 16);
      const again = mod.listSessions();
      assert.equal(JSON.stringify(again.sessions), JSON.stringify(first.sessions));

      // The materialized table agrees with the query surface…
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(dir, "store.db"));
      try {
        const stored = db.prepare("SELECT COUNT(*) AS n FROM sessions").get();
        assert.equal(Number(stored.n), 2);
      } finally {
        db.close();
      }

      // …and new rows (a sync) invalidate the fingerprint and refresh the table.
      await seedRequests(dir, [req(41, { id: "log-c" })]);
      const afterSync = mod.listSessions();
      assert.equal(afterSync.sessions.length, 2);
      assert.equal(afterSync.sessions[1].turns, 2); // 40 and 41 now one session
    });
  });

  test("--session-gap override changes boundaries vs the config default", async () => {
    const dir = join(box.dir, "gap-override");
    // 7 minutes apart: one session at 10, two at 5, one again at 15.
    await seedRequests(dir, [
      req(0),
      req(1, { id: "log-b", created_at: new Date(BASE + 7 * MINUTE).toISOString() }),
    ]);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const mod = await sessions();
      assert.equal(mod.listSessions().sessions.length, 1);
      const withFlag = mod.listSessions({ gapMinutes: 5 });
      assert.equal(withFlag.sessions.length, 2);
      assert.equal(withFlag.sessionization.gapMinutes, 5);
      assert.equal(mod.listSessions({ gapMinutes: 15 }).sessions.length, 1);
    });
  });

  test("--session <id> returns exactly that session; unknown id errors clearly", async () => {
    const dir = join(box.dir, "session-scope");
    await seedRequests(dir, [req(0), req(2), req(40, { id: "log-b" })]);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const mod = await sessions();
      const all = mod.listSessions();
      const target = all.sessions[0];
      const scoped = mod.listSessions({ sessionId: target.session_id });
      assert.equal(scoped.sessions.length, 1);
      assert.equal(scoped.sessions[0].session_id, target.session_id);
      assert.equal(scoped.sessionization.override, target.session_id);
      assert.throws(
        () => mod.listSessions({ sessionId: "does-not-exist" }),
        (error) =>
          error.name === "CliError" && /No session with id "does-not-exist"/.test(error.message),
      );
    });
  });

  test("since/until filters intersect the session window; totals stay whole-session", async () => {
    const dir = join(box.dir, "window");
    // Session 1: 10:00–10:01. Session 2: 10:40.
    await seedRequests(dir, [req(0), req(1), req(40, { id: "log-b" })]);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const mod = await sessions();
      const early = mod.listSessions({ until: new Date(BASE + 10 * MINUTE).toISOString() });
      assert.equal(early.sessions.length, 1);
      assert.equal(early.sessions[0].turns, 2); // whole-session rollup, not clipped
      const late = mod.listSessions({ since: new Date(BASE + 30 * MINUTE).toISOString() });
      assert.equal(late.sessions.length, 1);
      assert.equal(late.sessions[0].turns, 1);
      // A window overlapping a session's span includes it.
      const overlapping = mod.listSessions({
        since: new Date(BASE + 39 * MINUTE).toISOString(),
        until: new Date(BASE + 41 * MINUTE).toISOString(),
      });
      assert.equal(overlapping.sessions.length, 1);
      assert.throws(
        () => mod.listSessions({ since: "not-a-date" }),
        (error) => error.name === "CliError" && /Invalid --since/.test(error.message),
      );
    });
  });

  test("sessions carry the key→agent mapping; unmapped keys stay unknown", async () => {
    const dir = join(box.dir, "agents");
    plantAgentKey(dir, "sk-abcd...1234", "codex");
    await seedRequests(dir, [req(0), req(1, { api_key: "sk-ffff...9999", id: "log-b" })]);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const mod = await sessions();
      const result = mod.listSessions();
      const byKey = Object.groupBy(result.sessions, (s) => s.api_key);
      assert.equal(byKey["sk-abcd...1234"][0].agent, "codex");
      assert.equal(byKey["sk-ffff...9999"][0].agent, "unknown");
    });
  });
});
