import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { cliEnv, runCli, withTestEnv } from "./helpers.mjs";

// #95 (OBS-BF-10): `aiand store reset` — cheap self-heal without deleting
// store.db. Reset clears request/session/envelope rows, keeps schema +
// migrations + the ccusage import dedupe ledger, and the next `store sync`
// full re-pulls (the watermark is derived from the newest request row).

const box = withTestEnv("aiand-store-reset-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  // Deliberately no AIAND_NO_SYNC here: `store sync` must actually sync.
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
});

// -- /logs double ------------------------------------------------------------

let server;
let baseUrl = "";
let serveLogs = () => ({ data: [], has_more: false, next_after: null, next_after_id: null });

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/logs") {
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

function entry(n) {
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
    created_at: new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + n * 60_000).toISOString(),
  };
}

function forwardPager(rows) {
  return (url) => {
    const after = url.searchParams.get("after");
    const afterId = url.searchParams.get("after_id");
    const limit = Number(url.searchParams.get("limit") ?? 100);
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

function freshDir(name) {
  const dir = join(box.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const resetEnv = (dir) =>
  cliEnv({
    AIAND_CONFIG_DIR: dir,
    AIAND_NO_SYNC: "1",
    NO_COLOR: "1",
    CI: "1",
  });

async function openDb(dir) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(join(dir, "store.db"));
}

/** Seed the ccusage dedupe ledger by importing a payload through the CLI. */
async function importCcusage(dir) {
  const payload = JSON.stringify({
    daily: [
      {
        date: "2026-10-20",
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationTokens: 50,
        cacheReadTokens: 150,
        totalTokens: 1400,
        costUSD: 0.123,
      },
    ],
  });
  const file = join(dir, "ccusage.json");
  writeFileSync(file, payload);
  return runCli(["usage", "--import-ccusage", file, "--json"], { env: resetEnv(dir) });
}

// -- tests ---------------------------------------------------------------------

describe("store reset", () => {
  test("--force clears rows, keeps schema + ledger; next sync full re-pulls", async () => {
    const dir = freshDir("force");
    const rows = [entry(1), entry(2), entry(3)];
    serveLogs = forwardPager(rows);

    // Populate: sync + import (ledger seed) + session rebuild.
    const syncEnv = cliEnv({
      AIAND_CONFIG_DIR: dir,
      AIAND_API_KEY: "sk-test",
      AIAND_BASE_URL: baseUrl,
      NO_COLOR: "1",
      CI: "1",
    });
    const synced = await runCli(["store", "sync", "--json"], { env: syncEnv });
    assert.equal(synced.code, 0, synced.stderr);
    const imported = await importCcusage(dir);
    assert.equal(imported.code, 0, imported.stderr);

    // The sessions table is materialized lazily by listSessions() (#66) —
    // reached through `aiand status`; materialize so reset has rows to clear.
    const st = await runCli(["status", "--format", "line"], { env: syncEnv });
    assert.equal(st.code, 0, st.stderr);
    const db = await openDb(dir);
    const beforeSessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
    db.close();
    assert.ok(beforeSessions > 0, "sync should materialize sessions");

    const reset = await runCli(["store", "reset", "--force", "--json"], { env: resetEnv(dir) });
    assert.equal(reset.code, 0, reset.stderr);
    const result = JSON.parse(reset.stdout);
    assert.equal(result.reset, true);
    assert.equal(result.requests, rows.length);
    assert.equal(result.sessions, beforeSessions);
    assert.equal(result.importedUsageKept, 1);
    assert.equal(typeof result.storeVersion, "number");
    assert.ok(result.storeVersion >= 4);

    // Ledger survives; data rows are gone.
    const after = await openDb(dir);
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM requests").get().n, 0);
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM imported_usage").get().n, 1);
    const version = after.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
    after.close();
    assert.equal(version, result.storeVersion);

    // Re-importing the same fixture still dedupes: the ledger survived.
    const again = await importCcusage(dir);
    assert.equal(again.code, 0, again.stderr);
    const dedupe = JSON.parse(again.stdout);
    assert.equal(dedupe.deduped, true, `expected dedupe, got ${again.stdout}`);

    // The next sync is a full re-pull: all rows come back.
    const resync = await runCli(["store", "sync", "--json"], { env: syncEnv });
    assert.equal(resync.code, 0, resync.stderr);
    const syncResult = JSON.parse(resync.stdout);
    assert.equal(syncResult.result.inserted, rows.length);
    const repopulated = await openDb(dir);
    assert.equal(repopulated.prepare("SELECT COUNT(*) AS n FROM requests").get().n, rows.length);
    repopulated.close();
  });

  test("confirmation decline: exit 0, store untouched", async () => {
    const dir = freshDir("decline");
    serveLogs = forwardPager([entry(1)]);
    const syncEnv = cliEnv({
      AIAND_CONFIG_DIR: dir,
      AIAND_API_KEY: "sk-test",
      AIAND_BASE_URL: baseUrl,
      NO_COLOR: "1",
      CI: "1",
    });
    const synced = await runCli(["store", "sync", "--json"], { env: syncEnv });
    assert.equal(synced.code, 0, synced.stderr);

    // Non-TTY confirm() returns its default (false) — a declined prompt.
    const declined = await runCli(["store", "reset"], { env: resetEnv(dir) });
    assert.equal(declined.code, 0, declined.stderr);
    assert.match(declined.stdout, /Cancelled|unchanged/i);

    const db = await openDb(dir);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM requests").get().n, 1);
    db.close();

    // --force is the escape hatch for the same non-interactive session.
    const forced = await runCli(["store", "reset", "--force"], { env: resetEnv(dir) });
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(forced.stdout, /Store reset/);
  });

  test("reset with no store yet: clean failure message, exit nonzero", async () => {
    const dir = freshDir("missing");
    const run = await runCli(["store", "reset", "--force", "--json"], { env: resetEnv(dir) });
    assert.notEqual(run.code, 0);
    // CliErrors render on stderr; --json just means the success payload is JSON.
    assert.match(run.stderr, /nothing to reset/i);
  });
});
