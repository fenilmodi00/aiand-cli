import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { CLOSED_URL, cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

// OBS-P0-1 (#61): the local request store and its incremental /logs sync.
// A gateway-shaped LogEntry fixture drives an in-process /logs double (the
// sync engine is a black box here; each test scripts pages and counts the
// requests the engine actually sent), plus CLI runs for the fail-open and
// --no-sync paths.

const box = withTestEnv("aiand-store-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
});

// -- fixtures ----------------------------------------------------------------

const FIELD_LIST = [
  "id",
  "model",
  "api_key",
  "status_code",
  "ttft_ms",
  "latency_ms",
  "input_tokens",
  "output_tokens",
  "cached_tokens",
  "cost",
  "currency",
  "created_at",
];

/** A gateway LogEntry matching the verified field list, minute-stamped. */
function entry(n, overrides = {}) {
  const created = new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + n * 60_000).toISOString();
  return {
    id: `log-${String(n).padStart(4, "0")}`,
    model: "test/model",
    api_key: "sk-abcd...1234",
    status_code: 200,
    ttft_ms: 120,
    latency_ms: 1_400,
    // input INCLUDES cached on the gateway — the store must keep both as-is.
    input_tokens: 1_000 + n,
    output_tokens: 300,
    cached_tokens: 400,
    cost: "0.0042",
    currency: "usd",
    created_at: created,
    ...overrides,
  };
}

function entries(count, start = 1) {
  return Array.from({ length: count }, (_, i) => entry(start + i));
}

/** Fake session aimed at the in-process gateway double. */
function fakeSession(url) {
  return {
    profile: { name: "test", authUrl: url, apiUrl: url },
    token: "test-token",
    credential: null,
  };
}

// -- /logs double --------------------------------------------------------------

let server;
let baseUrl = "";
/** Requests the double served since the last reset: URL objects. */
let served = [];
/** Scripted behavior; tests replace this. */
let serveLogs = () => ({ data: [], has_more: false, next_after: null, next_after_id: null });

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/logs") {
      served.push(url);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(serveLogs(url)));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

function resetServed() {
  served = [];
}

/**
 * A /logs double over `rows` (ascending created_at): pages of `pageSize`
 * walking strictly forward by the `after` cursor, like the gateway.
 */
function forwardPager(rows, pageSize = 100) {
  return (url) => {
    const after = url.searchParams.get("after");
    const limit = Number(url.searchParams.get("limit") ?? pageSize);
    const remaining = after ? rows.filter((e) => e.created_at > after) : rows;
    const data = remaining.slice(0, limit);
    const hasMore = remaining.length > data.length;
    return {
      data,
      has_more: hasMore,
      next_after: hasMore ? data[data.length - 1].created_at : null,
      next_after_id: hasMore ? data[data.length - 1].id : null,
    };
  };
}

// -- helpers -------------------------------------------------------------------

const store = () => import("../dist/store/index.js");

async function readRows(configDirPath, sql) {
  const { DatabaseSync } = await import("node:sqlite");
  // Read-write open: a readOnly connection cannot create the -shm/-wal
  // sidecars a not-yet-checkpointed WAL needs, and the engine may have
  // only just closed.
  const db = new DatabaseSync(join(configDirPath, "store.db"));
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function row(configSubdir, id) {
  return readRows(join(box.dir, configSubdir), `SELECT * FROM requests WHERE id = '${id}'`).then(
    (rows) => rows[0],
  );
}

// -- tests ---------------------------------------------------------------------

describe("store module surface", () => {
  test("STORE_VERSION is exported and matches the latest migration", async () => {
    const mod = await store();
    const migrations = await import("../dist/store/migrations/index.js");
    assert.equal(typeof mod.STORE_VERSION, "number");
    assert.equal(mod.STORE_VERSION, migrations.MIGRATIONS.at(-1).version);
    assert.equal(mod.STORE_VERSION, 1);
  });

  test("storePath() resolves under AIAND_CONFIG_DIR", async () => {
    const mod = await store();
    assert.equal(mod.storePath(), join(box.dir, "store.db"));
  });

  test("noSyncRequested() reads AIAND_NO_SYNC", async () => {
    const mod = await store();
    await withEnv({ AIAND_NO_SYNC: undefined }, async () => {
      assert.equal(mod.noSyncRequested(), false);
      process.env.AIAND_NO_SYNC = "1";
      assert.equal(mod.noSyncRequested(), true);
    });
  });

  test("getStoreInfo() on a fresh config dir: status missing, never throws", async () => {
    const mod = await store();
    await withEnv({ AIAND_CONFIG_DIR: join(box.dir, "fresh-info") }, async () => {
      mkdirSync(join(box.dir, "fresh-info"), { recursive: true });
      const info = mod.getStoreInfo();
      assert.equal(info.status, "missing");
      assert.equal(info.rows, 0);
      assert.equal(info.migrationsCurrent, false);
      assert.equal(info.lastSyncAt, null);
    });
  });
});

describe("sync engine", () => {
  test("syncs all pages exactly once, watermark and info land", async () => {
    const mod = await store();
    const dir = join(box.dir, "sync-all");
    const rows = entries(250);
    serveLogs = forwardPager(rows);
    resetServed();

    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const result = await mod.syncStore(fakeSession(baseUrl));
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.inserted, 250);
      assert.equal(result.pages, 3);
      assert.equal(result.watermark.id, rows.at(-1).id);

      const info = mod.getStoreInfo();
      assert.equal(info.status, "ok");
      assert.equal(info.rows, 250);
      assert.equal(info.storeVersion, mod.STORE_VERSION);
      assert.equal(info.migrationsCurrent, true);
      assert.ok(info.lastSyncAt);
      assert.equal(info.newestCreatedAt, rows.at(-1).created_at);
      // Page size honored: three 100-row pages (gateway caps at 100).
      assert.ok(served.every((u) => Number(u.searchParams.get("limit")) <= 100));
      assert.ok(served.every((u) => u.searchParams.get("range") === "30days"));
    });
  });

  test("re-syncing a fully synced store inserts 0 rows", async () => {
    const mod = await store();
    const dir = join(box.dir, "sync-idempotent");
    serveLogs = forwardPager(entries(120));

    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const first = await mod.syncStore(fakeSession(baseUrl));
      assert.equal(first.ok, true);
      const second = await mod.syncStore(fakeSession(baseUrl));
      assert.equal(second.ok, true);
      if (!second.ok) return;
      assert.equal(second.inserted, 0);
      const info = mod.getStoreInfo();
      assert.equal(info.rows, 120);
    });
  });

  test("rows are stored verbatim: input INCLUDES cached, cost string kept, masked key", async () => {
    const mod = await store();
    const dir = join(box.dir, "sync-verbatim");
    serveLogs = forwardPager([
      entry(1, { cost: "0.0123", currency: "usd" }),
      entry(2, { cost: null, ttft_ms: null, latency_ms: null }),
    ]);

    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      await mod.syncStore(fakeSession(baseUrl));
      const first = await row("sync-verbatim", "log-0001");
      assert.equal(first.input_tokens, 1001); // never cached subtracted
      assert.equal(first.cached_tokens, 400);
      assert.equal(first.cost, "0.0123"); // gateway string as-is
      assert.ok(Math.abs(first.cost_value - 0.0123) < 1e-12);
      assert.equal(first.currency, "usd");
      assert.equal(first.api_key, "sk-abcd...1234");
      assert.equal(first.model, "test/model");
      assert.equal(first.status_code, 200);
      assert.equal(first.synced_at.length > 0, true);
      const second = await row("sync-verbatim", "log-0002");
      assert.equal(second.cost, null);
      assert.equal(second.cost_value, null);
      assert.equal(second.ttft_ms, null);
    });
  });

  test("schema carries metadata only: no prompt/completion content columns", async () => {
    const mod = await store();
    const dir = join(box.dir, "sync-schema");
    serveLogs = forwardPager(entries(1));

    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      await mod.syncStore(fakeSession(baseUrl));
      const columns = (await readRows(dir, "PRAGMA table_info(requests)")).map((c) => c.name);
      assert.deepEqual(columns.sort(), [...FIELD_LIST, "cost_value", "synced_at"].sort());
      const forbidden = /prompt|completion|content|message|body|text|input_text|output_text/i;
      for (const column of columns) {
        assert.doesNotMatch(column, forbidden, `content-ish column leaked: ${column}`);
      }
    });
  });

  test("watermark resume: an interrupted sync fetches only the remaining pages", async () => {
    const mod = await store();
    const dir = join(box.dir, "sync-resume");
    const rows = entries(250);
    // Page 1 succeeds, page 2 fails: syncStore reports failure but the
    // page-1 watermark must already be durable.
    const working = forwardPager(rows);
    serveLogs = (url) => {
      const after = url.searchParams.get("after");
      if (after && after >= rows[99].created_at) {
        return { error: "boom" };
      }
      return working(url);
    };

    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const failed = await mod.syncStore(fakeSession(baseUrl));
      assert.equal(failed.ok, false);
      const partial = mod.getStoreInfo();
      assert.equal(partial.rows, 100);

      // Heal the double; the resumed sync must not re-walk page 1.
      serveLogs = working;
      resetServed();
      const resumed = await mod.syncStore(fakeSession(baseUrl));
      assert.equal(resumed.ok, true);
      if (!resumed.ok) return;
      assert.equal(resumed.inserted, 150);
      // 5-minute overlap rewinds the cursor slightly (~rows 95-100 refetch),
      // so two pages cover the rest — never the three a cold start needs.
      assert.ok(served.length <= 2, `expected <=2 resumed pages, got ${served.length}`);
      assert.equal(mod.getStoreInfo().rows, 250);
    });
  });

  test("network failure returns ok:false (code network) and never throws", async () => {
    const mod = await store();
    const dir = join(box.dir, "sync-offline");
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const result = await mod.syncStore(fakeSession(CLOSED_URL));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "network");
    });
  });

  test("auth failure is classified as auth", async () => {
    const mod = await store();
    const dir = join(box.dir, "sync-auth");
    const original = serveLogs;
    serveLogs = () => ({ error: "unauthorized" });
    // The double always answers 200; drive a real 401 through fetch stubbing.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    try {
      await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
        const result = await mod.syncStore(fakeSession(baseUrl));
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, "auth");
      });
    } finally {
      globalThis.fetch = realFetch;
      serveLogs = original;
    }
  });
});

describe("store CLI", () => {
  test("store reports a missing store and exits 0", async () => {
    const dir = join(box.dir, "cli-missing");
    mkdirSync(dir, { recursive: true });
    const run = await runCli(["store", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(run.code, 0);
    const info = JSON.parse(run.stdout);
    assert.equal(info.status, "missing");
  });

  test("store sync pulls pages and reports counts; corrupt db quarantines and recovers", async () => {
    const dir = join(box.dir, "cli-sync");
    mkdirSync(dir, { recursive: true });
    serveLogs = forwardPager(entries(150));

    // Corrupt the store before it exists? Plant garbage where store.db goes
    // by syncing once, then overwriting the file with junk.
    const first = await runCli(["store", "sync", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir, AIAND_API_KEY: "sk-test", AIAND_BASE_URL: baseUrl }),
    });
    assert.equal(first.code, 0);
    const firstOut = JSON.parse(first.stdout);
    assert.equal(firstOut.result.ok, true);
    assert.equal(firstOut.store.rows, 150);

    writeFileSync(join(dir, "store.db"), "this is not a sqlite database at all");

    const second = await runCli(["store", "sync", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir, AIAND_API_KEY: "sk-test", AIAND_BASE_URL: baseUrl }),
    });
    assert.equal(second.code, 0, `exit ${second.code}: ${second.stderr}`);
    assert.match(second.stderr, /quarantined/i);
    const secondOut = JSON.parse(second.stdout);
    assert.equal(secondOut.result.ok, true);
    assert.ok(secondOut.store.rows >= 150);
    assert.ok(existsSync(secondOut.store.path));
    const quarantined = second.stderr.match(/quarantined to (\S+?);/)?.[1];
    assert.ok(quarantined && existsSync(quarantined), "quarantine file should exist");
  });

  test("--no-sync makes zero network calls", async () => {
    const dir = join(box.dir, "cli-nosync");
    mkdirSync(dir, { recursive: true });
    serveLogs = forwardPager(entries(10));
    resetServed();

    const run = await runCli(["store", "--no-sync", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir, AIAND_API_KEY: "sk-test", AIAND_BASE_URL: baseUrl }),
    });
    assert.equal(run.code, 0);
    assert.equal(JSON.parse(run.stdout).status, "missing");
    assert.equal(served.length, 0, "--no-sync must not fetch");

    // The env equivalent (AIAND_NO_SYNC=1) also stops even `store sync`.
    const envRun = await runCli(["store", "sync", "--json"], {
      env: cliEnv({
        AIAND_CONFIG_DIR: dir,
        AIAND_API_KEY: "sk-test",
        AIAND_BASE_URL: baseUrl,
        AIAND_NO_SYNC: "1",
      }),
    });
    assert.equal(envRun.code, 0);
    assert.equal(served.length, 0, "AIAND_NO_SYNC=1 must not fetch");
  });

  test("a failed sync still exits 0 with a visible warning", async () => {
    const dir = join(box.dir, "cli-fail");
    mkdirSync(dir, { recursive: true });
    const run = await runCli(["store", "sync", "--json"], {
      env: cliEnv({
        AIAND_CONFIG_DIR: dir,
        AIAND_API_KEY: "sk-test",
        AIAND_BASE_URL: CLOSED_URL,
      }),
    });
    assert.equal(run.code, 0);
    const out = JSON.parse(run.stdout);
    assert.equal(out.result.ok, false);
    assert.equal(out.result.code, "network");
    assert.match(run.stderr, /sync failed/i);
  });
});
