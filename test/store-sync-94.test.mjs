import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { describe } from "node:test";
import { cliEnv, runCli, withEnv, withMockGateway, withTestEnv } from "./helpers.mjs";

// #94 (OBS-BF-9): the gateway's /logs is newest-first and `after` is an
// exclusive floor — it can never page forward toward rows newer than the
// watermark. The store sync therefore pages from the TOP and stops when a
// page's oldest row reaches watermark − 5min. These tests drive the built
// CLI against test/mock-gateway.mjs's `logs-pinned` scenario, which
// simulates the pinned semantics: newest-first order, after-as-floor,
// after_id tie-breaking, and the paired-param 400. Rows live in a JSON file
// the double re-reads per request, so tests land new traffic between syncs
// by rewriting it.

const box = withTestEnv("aiand-store-94-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
});

// -- fixtures ----------------------------------------------------------------

function entry(n, overrides = {}) {
  const created = new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + n * 60_000).toISOString();
  return {
    id: `log-${String(n).padStart(4, "0")}`,
    model: "test/model",
    api_key: "sk-abcd...1234",
    status_code: 200,
    ttft_ms: 120,
    latency_ms: 1_400,
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

/**
 * Rewrite `created_at` into the gateway's verbatim wire format
 * (`2026-10-01 10:01:00.000000+00` — space separator, `+00` offset), the
 * shape the real gateway serves (see mock-gateway's logs-window rows).
 * Sync tests must cover this format: a bare-text comparison misorders it
 * against ISO bounds (`' ' < 'T'`), which was the early-stop bug #94 fixed.
 */
function wire(row) {
  return {
    ...row,
    created_at: row.created_at.replace("T", " ").replace(/(\.\d{3})Z$/, "$1000+00"),
  };
}

function fakeSession(url) {
  return {
    profile: { name: "test", authUrl: url, apiUrl: url },
    token: "test-token",
    credential: null,
  };
}

// -- gateway double ------------------------------------------------------------

/**
 * Run `fn(url, setRows)` against a `logs-pinned` mock gateway. `setRows`
 * rewrites the shared JSON file the double re-reads on every /logs request.
 * The returned `url` carries the /stub/logs-pinned prefix, so client URLs
 * built as baseUrl + /logs route into the pinned handler.
 */
async function withPinnedGateway(fn) {
  const rowsFile = join(mkdtempSync(join(tmpdir(), "aiand-94-")), "rows.json");
  writeFileSync(rowsFile, "[]");
  await withEnv({ AIAND_MOCK_LOG_FILE: rowsFile }, async () => {
    await withMockGateway(async ({ url }) => {
      const setRows = (rows) => writeFileSync(rowsFile, JSON.stringify(rows));
      await fn(`${url}/stub/logs-pinned`, setRows);
    });
  });
}

function envFor(dir, url) {
  return cliEnv({ AIAND_CONFIG_DIR: dir, AIAND_API_KEY: "sk-test", AIAND_BASE_URL: url });
}

async function readRows(dir, sql) {
  const db = new DatabaseSync(join(dir, "store.db"));
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

const store = () => import("../dist/store/index.js");

// -- sync engine against the pinned double -------------------------------------

describe("#94 sync engine vs pinned /logs semantics", () => {
  test("fresh sync drains newest-first pages into a complete store", async () => {
    const mod = await store();
    const rows = entries(120);
    const dir = join(box.dir, "fresh-sync");
    mkdirSync(dir, { recursive: true });

    await withPinnedGateway(async (url, setRows) => {
      setRows(rows);
      await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
        const result = await mod.syncStore(fakeSession(url));
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.inserted, 120);
        // Watermark is the NEWEST row even though pages arrive newest-first.
        assert.equal(result.watermark.id, rows.at(-1).id);
        assert.equal(mod.getStoreInfo().rows, 120);
      });
    });
  });

  test("incremental sync picks up post-watermark rows the old cursor could never see", async () => {
    const mod = await store();
    const dir = join(box.dir, "incremental");
    mkdirSync(dir, { recursive: true });
    const oldRows = entries(10); // 10:00 … 10:09
    const newRows = entries(5, 100); // 11:39 … 11:43, well above the old watermark

    await withPinnedGateway(async (url, setRows) => {
      setRows(oldRows);
      await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
        const first = await mod.syncStore(fakeSession(url));
        assert.equal(first.ok, true);
        if (!first.ok) return;
        assert.equal(first.inserted, 10);
        assert.equal(first.watermark.id, "log-0010");

        // New traffic lands on the gateway. Under the pinned semantics these
        // rows are invisible to an `after = watermark − 5min` cursor (an
        // exclusive floor on a newest-first stream) — the drain-from-top sync
        // must insert exactly them.
        setRows([...oldRows, ...newRows]);
        const second = await mod.syncStore(fakeSession(url));
        assert.equal(second.ok, true);
        if (!second.ok) return;
        assert.equal(second.inserted, 5, "all 5 post-watermark rows must be inserted");
        assert.equal(second.watermark.id, "log-0104");
        assert.equal(mod.getStoreInfo().rows, 15);
      });
    });
  });

  test("repeated no-op sync stops at the overlap window (one page, not the 30-day walk)", async () => {
    const mod = await store();
    const dir = join(box.dir, "noop");
    mkdirSync(dir, { recursive: true });
    // 250 rows a minute apart: the fresh walk needs 3 pages; a quiescent
    // no-op's first page spans ~100 minutes with its oldest row ~99 minutes
    // below the newest — far above the watermark − 5min floor — so the sync
    // must stop after exactly one page instead of walking the whole range.
    const rows = entries(250);

    await withPinnedGateway(async (url, setRows) => {
      setRows(rows);
      await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
        const first = await mod.syncStore(fakeSession(url));
        assert.equal(first.ok, true);
        if (!first.ok) return;
        assert.equal(first.inserted, 250);

        // New same-day traffic lands in WIRE format (space separator, +00),
        // newer than the watermark. Under a bare-text early-stop comparison
        // `'2026-10-01 …' <= '2026-10-01T…'` is true for every same-day row
        // (`' ' < 'T'`), so the drain would stop at page 1 and skip these —
        // this test pins the instant-based comparison.
        const burst = entries(120, 300).map(wire); // same day, 14:39 … newer
        setRows([...rows, ...burst]);
        const second = await mod.syncStore(fakeSession(url));
        assert.equal(second.ok, true);
        if (!second.ok) return;
        // The burst is 120 rows: page 1 drains the newest 100, page 2 the
        // remaining 20 (riding with the 100 re-served ISO rows, 0 net there).
        assert.equal(second.inserted, 120, "wire-format same-day burst must be fully drained");
        assert.equal(second.watermark.id, burst.at(-1).id);
        assert.equal(mod.getStoreInfo().rows, 370);

        // And back to quiescent: one page, nothing inserted.
        const again = await mod.syncStore(fakeSession(url));
        assert.equal(again.ok, true);
        if (!again.ok) return;
        assert.equal(again.inserted, 0, "quiescent sync inserts nothing");
        assert.equal(again.pages, 1, "quiescent sync must stop after one page");
      });
    });
  });

  test("burst back-to-back syncs insert no duplicates (PK dedupe holds)", async () => {
    const mod = await store();
    const dir = join(box.dir, "burst");
    mkdirSync(dir, { recursive: true });
    const rows = entries(150);

    await withPinnedGateway(async (url, setRows) => {
      setRows(rows);
      await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
        const results = await Promise.all([
          mod.syncStore(fakeSession(url)),
          mod.syncStore(fakeSession(url)),
          mod.syncStore(fakeSession(url)),
        ]);
        // The file lock serializes the writers: all succeed, and the inserted
        // counts sum to the row count exactly once.
        for (const result of results) assert.equal(result.ok, true);
        const totalInserted = results.reduce((sum, r) => sum + (r.ok ? r.inserted : -1_000_000), 0);
        assert.equal(totalInserted, 150);
        const counts = await readRows(
          dir,
          "SELECT COUNT(DISTINCT id) AS n, COUNT(*) AS total FROM requests",
        );
        assert.equal(counts[0].n, 150);
        assert.equal(counts[0].total, 150);
        assert.equal(mod.getStoreInfo().rows, 150);
      });
    });
  });

  test("after_id tie-breaking at the anchor timestamp (pinned semantics)", async () => {
    const mod = await store();
    const dir = join(box.dir, "tie-break");
    mkdirSync(dir, { recursive: true });
    // Three rows share one timestamp; ids order them log-0001 < log-0002 < log-0003.
    const tied = entries(3).map((e) => ({ ...e, created_at: "2026-10-01T10:00:00.000Z" }));
    tied[0].id = "log-0001";
    tied[1].id = "log-0002";
    tied[2].id = "log-0003";

    await withPinnedGateway(async (url, setRows) => {
      setRows(tied);
      await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
        // Ties serve newest-first by id (log-0003 first). after_id = the tie's
        // first-served (highest) id → returns the remaining siblings…
        const first = await fetch(
          `${url}/logs?after=2026-10-01T10%3A00%3A00.000Z&after_id=log-0003`,
        ).then((r) => r.json());
        assert.deepEqual(
          first.data.map((e) => e.id),
          ["log-0002", "log-0001"],
        );
        // …after_id = the tie's last-served (lowest) id → excludes all of them.
        const last = await fetch(
          `${url}/logs?after=2026-10-01T10%3A00%3A00.000Z&after_id=log-0001`,
        ).then((r) => r.json());
        assert.deepEqual(last.data, []);
      });
    });
  });

  test("paired-param 400 fires only when exactly one of after/after_id is sent", async () => {
    const dir = join(box.dir, "pair-400");
    mkdirSync(dir, { recursive: true });

    await withPinnedGateway(async (url) => {
      // Exactly one param → the real contract's 400…
      const one = await fetch(`${url}/logs?after=2026-10-01T10%3A00%3A00.000Z`);
      assert.equal(one.status, 400);
      assert.equal((await one.json()).error, "after and after_id must be sent together");
      // …both together → 200 (no row matches an empty store, but the shape holds).
      const both = await fetch(
        `${url}/logs?after=2026-10-01T10%3A00%3A00.000Z&after_id=log-0001`,
      );
      assert.equal(both.status, 200);
      const body = await both.json();
      assert.deepEqual(body, { data: [], has_more: false, next_after: null, next_after_id: null });
    });

    // The same 400 driven end-to-end through the sync engine: a lone `after`
    // cursor surfaces as ok:false + recorded last_sync_error, not a throw.
    const mod = await store();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("/logs")) {
        return new Response(
          JSON.stringify({ error: "after and after_id must be sent together" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return realFetch(input, init);
    };
    try {
      await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
        const result = await mod.syncStore(fakeSession("http://127.0.0.1:9"));
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.match(result.error, /after and after_id must be sent together/);
        const meta = await readRows(
          dir,
          "SELECT value FROM sync_meta WHERE key = 'last_sync_error'",
        );
        assert.equal(meta.length, 1);
        assert.match(meta[0].value, /after and after_id must be sent together/);
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("stuck-cursor guard still fires when the gateway re-serves the same top page", async () => {
    const mod = await store();
    const dir = join(box.dir, "stuck");
    mkdirSync(dir, { recursive: true });
    const burst = entries(150).map((e) => ({ ...e, created_at: "2026-10-01T10:00:00.000Z" }));
    // A broken double: with a cursor it re-serves the identical newest-first
    // page and claims more exist — the cursor never advances.
    const stuckPage = {
      data: burst.slice(0, 100),
      has_more: true,
      next_after: "2026-10-01T10:00:00.000Z",
      next_after_id: "log-0100",
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("/logs")) {
        return new Response(JSON.stringify(stuckPage), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return realFetch(input, init);
    };
    try {
      await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
        const result = await mod.syncStore(fakeSession("http://127.0.0.1:9"));
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.match(result.error, /stuck|re-serving|incomplete/i);
        assert.ok(result.pages < 10, `expected prompt termination, got ${result.pages} pages`);
        const meta = await readRows(
          dir,
          "SELECT value FROM sync_meta WHERE key = 'last_sync_error'",
        );
        assert.equal(meta.length, 1);
        assert.match(meta[0].value, /stuck|re-serving|incomplete/i);
        assert.equal(mod.getStoreInfo().rows, 100);
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// -- CLI surface ----------------------------------------------------------------

describe("#94 store sync CLI vs pinned /logs semantics", () => {
  test("paired-param 400 surfaces as a clean failed sync (exit 0, warning, lastSyncError), never a stack", async () => {
    const dir = join(box.dir, "cli-400");
    mkdirSync(dir, { recursive: true });

    await withMockGateway(async ({ url }) => {
      // The pinned double 400s any /logs request carrying exactly one of
      // after/after_id with the gateway's verbatim message.
      const run = await runCli(["store", "sync", "--json"], {
        env: envFor(dir, `${url}/stub/logs-400`),
      });
      // Fail-open contract: a failed sync never fails the command and never
      // prints a raw stack.
      assert.equal(run.code, 0, `exit ${run.code}: ${run.stderr}`);
      assert.doesNotMatch(run.stderr, /\n\s+at /, "stack trace leaked");
      assert.match(run.stderr, /sync failed/i);
      const out = JSON.parse(run.stdout);
      assert.equal(out.result.ok, false);
      assert.match(out.result.error, /after and after_id must be sent together/);
      assert.equal(out.result.code, "network");
      // The failure is recorded for coverage/reporting.
      const meta = await readRows(dir, "SELECT value FROM sync_meta WHERE key = 'last_sync_error'");
      assert.equal(meta.length, 1);
      assert.match(meta[0].value, /after and after_id must be sent together/);
    });
  });

  test("CLI incremental sync reflects new rows; repeated sync stays stable (no dupes)", async () => {
    const dir = join(box.dir, "cli-incremental");
    mkdirSync(dir, { recursive: true });
    const oldRows = entries(8);
    const newRows = entries(3, 50);

    await withPinnedGateway(async (url, setRows) => {
      setRows(oldRows);
      const first = await runCli(["store", "sync", "--json"], { env: envFor(dir, url) });
      assert.equal(first.code, 0, first.stderr);
      const firstOut = JSON.parse(first.stdout);
      assert.equal(firstOut.result.ok, true);
      assert.equal(firstOut.result.inserted, 8);

      setRows([...oldRows, ...newRows]);
      const second = await runCli(["store", "sync", "--json"], { env: envFor(dir, url) });
      assert.equal(second.code, 0, second.stderr);
      const secondOut = JSON.parse(second.stdout);
      assert.equal(secondOut.result.ok, true);
      assert.equal(secondOut.result.inserted, 3);
      assert.equal(secondOut.store.rows, 11);

      const third = await runCli(["store", "sync", "--json"], { env: envFor(dir, url) });
      assert.equal(third.code, 0, third.stderr);
      const thirdOut = JSON.parse(third.stdout);
      assert.equal(thirdOut.result.ok, true);
      assert.equal(thirdOut.result.inserted, 0);
      assert.equal(thirdOut.store.rows, 11, "no duplicates after repeated sync");
    });
  });
});
