import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { withEnv, withTestEnv } from "./helpers.mjs";

// Coverage-gap honesty (feature catalog H4, ticket #68): computeCoverage
// enumerates what the local store does NOT cover instead of averaging over it.

const box = withTestEnv("aiand-coverage-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_HOME = join(dir, "home");
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
});

const { computeCoverage, rangeDurationMs } = await import("../dist/store/coverage.js");
const { openStore, storePath } = await import("../dist/store/index.js");

// `now` is pinned so windows and day math are deterministic.
const NOW = new Date("2026-10-25T12:00:00.000Z");
const DAY = (offset) => new Date(NOW.getTime() - offset * 86_400_000).toISOString().slice(0, 10); // YYYY-MM-DD

let n = 0;
function plant(dir, rows, { lastSyncAt = "2026-10-25T11:00:00.000Z", syncError = null } = {}) {
  mkdirSync(dir, { recursive: true });
  return withEnv({ AIAND_CONFIG_DIR: dir }, () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok, opened.ok ? "" : opened.reason);
    const db = opened.db;
    try {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO requests " +
          "(id, model, api_key, status_code, ttft_ms, latency_ms, input_tokens, " +
          "output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const r of rows) {
        insert.run(
          r.id ?? `row-${++n}`,
          r.model ?? "zai-org/glm-5.3",
          r.api_key ?? "sk-aaaa...1111",
          200,
          10,
          100,
          r.input_tokens ?? 100,
          r.output_tokens ?? 10,
          r.cached_tokens ?? 0,
          r.cost ?? "0.01",
          0.01,
          "usd",
          r.created_at,
          r.synced_at ?? "2026-10-25T11:00:00.000Z",
        );
      }
      if (lastSyncAt) {
        db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_sync_at', ?)").run(
          lastSyncAt,
        );
      }
      if (syncError) {
        db.prepare(
          "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_sync_error', ?)",
        ).run(syncError);
      }
    } finally {
      db.close();
    }
  });
}

describe("rangeDurationMs", () => {
  test("parses the LOG_RANGES vocabulary", () => {
    assert.equal(rangeDurationMs("15m"), 15 * 60_000);
    assert.equal(rangeDurationMs("1h"), 3_600_000);
    assert.equal(rangeDurationMs("24h"), 86_400_000);
    assert.equal(rangeDurationMs("7days"), 7 * 86_400_000);
    assert.equal(rangeDurationMs("30days"), 30 * 86_400_000);
  });

  test("rejects an unknown range instead of guessing", () => {
    assert.throws(() => rangeDurationMs("fortnight"), /Unknown range/);
  });
});

describe("computeCoverage", () => {
  test("a missing day inside the window is listed, not averaged over", () => {
    const dir = join(box.dir, "gap");
    // Rows today and two days ago; yesterday has none.
    plant(dir, [
      { created_at: `${DAY(0)}T10:00:00.000Z` },
      { created_at: `${DAY(2)}T10:00:00.000Z` },
    ]);
    return withEnv({ AIAND_CONFIG_DIR: dir }, () => {
      const coverage = computeCoverage("7days", { now: NOW });
      assert.deepEqual(coverage.missingDays, [DAY(1)]);
      assert.equal(coverage.localRange.since, `${DAY(2)}T10:00:00.000Z`);
      assert.equal(coverage.localRange.until, `${DAY(0)}T10:00:00.000Z`);
      // Lag: now minus the newest stored row (2 hours).
      assert.ok(coverage.lagSeconds > 7_000 && coverage.lagSeconds < 7_300);
      assert.equal(coverage.sync.status, "synced");
      assert.equal(coverage.lastSyncAt, "2026-10-25T11:00:00.000Z");
    });
  });

  test("days before the archive began are a stated boundary, not 'missing'", () => {
    const dir = join(box.dir, "young-archive");
    // The store has exactly one day of data; a 30day window asks for far more.
    plant(dir, [{ created_at: `${DAY(0)}T08:00:00.000Z` }]);
    return withEnv({ AIAND_CONFIG_DIR: dir }, () => {
      const coverage = computeCoverage("30days", { now: NOW });
      // Nothing before the oldest row is called missing — the 30-day gateway
      // window vs the local archive boundary is explicit in localRange.
      for (const day of coverage.missingDays) {
        assert.ok(day >= DAY(0), `${day} predates the archive`);
      }
      assert.equal(coverage.localRange.since, `${DAY(0)}T08:00:00.000Z`);
    });
  });

  test("an empty store: never synced, no lag, no missing days claimed", () => {
    const dir = join(box.dir, "empty");
    plant(dir, [], { lastSyncAt: null });
    return withEnv({ AIAND_CONFIG_DIR: dir }, () => {
      const coverage = computeCoverage("7days", { now: NOW });
      assert.deepEqual(coverage.missingDays, []);
      assert.equal(coverage.lagSeconds, null);
      assert.equal(coverage.sync.status, "never");
      assert.equal(coverage.localRange.since, null);
    });
  });

  test("a skipped or failed pre-command sync is reported verbatim", () => {
    const dir = join(box.dir, "sync-outcomes");
    plant(dir, [{ created_at: `${DAY(0)}T08:00:00.000Z` }]);
    return withEnv({ AIAND_CONFIG_DIR: dir }, () => {
      const skipped = computeCoverage("24h", { now: NOW, sync: { skipped: true } });
      assert.equal(skipped.sync.status, "skipped");
      assert.equal(skipped.sync.at, "2026-10-25T11:00:00.000Z");

      const failed = computeCoverage("24h", {
        now: NOW,
        sync: { ok: false, error: "gateway 503" },
      });
      assert.equal(failed.sync.status, "failed");
      assert.equal(failed.sync.error, "gateway 503");

      const synced = computeCoverage("24h", { now: NOW, sync: { ok: true } });
      assert.equal(synced.sync.status, "synced");
    });
  });

  test("a failure recorded by a previous sync surfaces even without a caller outcome", () => {
    const dir = join(box.dir, "recorded-failure");
    plant(dir, [{ created_at: `${DAY(0)}T08:00:00.000Z` }], {
      syncError: "ECONNRESET while paging /logs",
    });
    return withEnv({ AIAND_CONFIG_DIR: dir }, () => {
      const coverage = computeCoverage("24h", { now: NOW });
      assert.equal(coverage.sync.status, "failed");
      assert.match(coverage.sync.error, /ECONNRESET/);
    });
  });

  test("sub-day ranges list no missing days (no whole day fits inside)", () => {
    const dir = join(box.dir, "subday");
    plant(dir, [{ created_at: `${DAY(0)}T08:00:00.000Z` }]);
    return withEnv({ AIAND_CONFIG_DIR: dir }, () => {
      const coverage = computeCoverage("6h", { now: NOW });
      assert.deepEqual(coverage.missingDays, []);
    });
  });
});
