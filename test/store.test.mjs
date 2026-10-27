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
 * walking forward by the (after, after_id) cursor pair, like the gateway.
 * Given only `after` (no after_id) it re-serves the boundary timestamp's
 * rows from the start — the behavior that strands a created_at-only cursor.
 */
function forwardPager(rows, pageSize = 100) {
  return (url) => {
    const after = url.searchParams.get("after");
    const afterId = url.searchParams.get("after_id"); // #85
    const limit = Number(url.searchParams.get("limit") ?? pageSize);
    let remaining;
    if (!after) remaining = rows;
    else if (afterId)
      remaining = rows.filter(
        (e) => e.created_at > after || (e.created_at === after && e.id > afterId),
      );
    else remaining = rows.filter((e) => e.created_at >= after);
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
    // 3 = migration 0003 (imported usage, #73); 4 = migration 0004
    // (envelopes table, #78 — renumbered at merge; #78 was cut before #73).
    assert.equal(mod.STORE_VERSION, 4);
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

  test("#85: same-timestamp bursts across pages — 150 rows sharing one created_at + 100 sharing another, all 250 ingested", async () => {
    const mod = await store();
    const dir = join(box.dir, "sync-burst");
    // 150 rows at one timestamp, then 100 at another: page 1 cannot hold
    // the first burst, so the outer loop must advance by (created_at, id).
    const burstA = entries(150).map((e) => ({ ...e, created_at: "2026-10-01T10:00:00.000Z" }));
    const burstB = entries(100, 200).map((e) => ({ ...e, created_at: "2026-10-01T11:00:00.000Z" }));
    const rows = [...burstA, ...burstB];
    serveLogs = forwardPager(rows);
    resetServed();

    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const result = await mod.syncStore(fakeSession(baseUrl));
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.inserted, 250);
      assert.equal(result.pages, 3);
      assert.equal(result.watermark.id, rows.at(-1).id);
      assert.equal(mod.getStoreInfo().rows, 250);
      // Bounded rounds: no identical page ever re-fetched.
      const urls = served.map((u) => u.search);
      assert.equal(new Set(urls).size, urls.length, "repeated identical request detected");
      // #92: id-uniqueness — the 250 ingested rows are 250 distinct logs.
      const distinct = await readRows(
        dir,
        "SELECT COUNT(DISTINCT id) AS n, COUNT(*) AS total FROM requests",
      );
      assert.equal(distinct[0].n, 250);
      assert.equal(distinct[0].total, 250);
    });
  });

  test("#85: stuck-cursor pager (ignores after_id, re-serves the same page) terminates ok:false with error + last_sync_error meta", async () => {
    const mod = await store();
    const dir = join(box.dir, "sync-stuck");
    // A broken gateway double: honors plain `after`, but whenever after_id
    // accompanies it, re-serves the identical first page — the cursor can
    // never get past the burst.
    const burst = entries(150).map((e) => ({ ...e, created_at: "2026-10-01T10:00:00.000Z" }));
    serveLogs = (url) => {
      const after = url.searchParams.get("after");
      const afterId = url.searchParams.get("after_id");
      if (after && afterId) {
        return {
          data: burst.slice(0, 100),
          has_more: true,
          next_after: "2026-10-01T10:00:00.000Z",
          next_after_id: "log-0100",
        };
      }
      if (after) return { data: [], has_more: false, next_after: null, next_after_id: null };
      return {
        data: burst.slice(0, 100),
        has_more: true,
        next_after: "2026-10-01T10:00:00.000Z",
        next_after_id: "log-0100",
      };
    };
    resetServed();

    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const result = await mod.syncStore(fakeSession(baseUrl));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /stuck|re-serving|incomplete/i);
      assert.ok(served.length < 10, `expected prompt termination, got ${served.length} rounds`);
      const meta = await readRows(
        dir,
        "SELECT key, value FROM sync_meta WHERE key = 'last_sync_error'",
      );
      assert.equal(meta.length, 1);
      assert.match(meta[0].value, /stuck|re-serving|incomplete/i);
      // The 100 rows of the served page are still stored, but nothing more.
      assert.equal(mod.getStoreInfo().rows, 100);
    });
  });

  test("#85: CLI store sync --json reports { result, store } with ok/inserted/pages", async () => {
    const dir = join(box.dir, "cli-sync-json");
    mkdirSync(dir, { recursive: true });
    serveLogs = forwardPager(entries(150));

    const run = await runCli(["store", "sync", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir, AIAND_API_KEY: "sk-test", AIAND_BASE_URL: baseUrl }),
    });
    assert.equal(run.code, 0, `exit ${run.code}: ${run.stderr}`);
    const out = JSON.parse(run.stdout);
    assert.ok(out.result, "missing result object");
    assert.ok(out.store, "missing store object");
    assert.equal(out.result.ok, true);
    assert.equal(out.result.inserted, 150);
    assert.equal(out.result.pages, 2);
    assert.equal(out.store.rows, 150);
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

  test("#92: CLI store sync --json on a stuck cursor: result ok:false carries error, warning on stderr, exit 0", async () => {
    const dir = join(box.dir, "cli-sync-stuck");
    mkdirSync(dir, { recursive: true });
    // Same broken double as the engine-level stuck test: after+after_id
    // re-serves the identical first page forever.
    const burst = entries(150).map((e) => ({ ...e, created_at: "2026-10-01T10:00:00.000Z" }));
    const stuckPage = {
      data: burst.slice(0, 100),
      has_more: true,
      next_after: "2026-10-01T10:00:00.000Z",
      next_after_id: "log-0100",
    };
    serveLogs = (url) => {
      const after = url.searchParams.get("after");
      const afterId = url.searchParams.get("after_id");
      if (after && afterId) return stuckPage;
      if (after) return { data: [], has_more: false, next_after: null, next_after_id: null };
      return stuckPage;
    };
    resetServed();

    const run = await runCli(["store", "sync", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir, AIAND_API_KEY: "sk-test", AIAND_BASE_URL: baseUrl }),
    });
    // Fail-open contract: a partial sync never fails the command.
    assert.equal(run.code, 0, `exit ${run.code}: ${run.stderr}`);
    assert.match(run.stderr, /sync failed|stuck|incomplete/i, "warning must be visible");
    const out = JSON.parse(run.stdout);
    assert.ok(out.result, "result object always present");
    assert.equal(out.result.ok, false);
    assert.equal(typeof out.result.inserted, "number");
    assert.equal(typeof out.result.pages, "number");
    assert.match(out.result.error, /stuck|re-serving|incomplete/i);
    assert.equal(out.store.rows, 100);
    // Bounded rounds even through the CLI path.
    assert.ok(served.length < 10, `expected prompt termination, got ${served.length} rounds`);
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
