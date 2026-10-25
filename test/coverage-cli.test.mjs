import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FAKE_API_KEY, runCli, withEnv, withTestEnv } from "./helpers.mjs";

// `aiand cache` coverage-gap honesty + sync-failure visibility (ticket #68):
// the report must state what the local store does NOT cover and whether the
// pre-command sync succeeded, never silently serve stale data.

const box = withTestEnv("aiand-coverage-cli-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_HOME = join(dir, "home");
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
});

const { openStore, storePath } = await import("../dist/store/index.js");

const MODELS = {
  object: "list",
  data: [
    {
      id: "zai-org/glm-5.3",
      name: "GLM 5.3",
      object: "model",
      created: 0,
      owned_by: "zai-org",
      provider: "zai-org",
      context_window: 1000000,
      capabilities: ["tool_calling"],
      reasoning_efforts: null,
      reasoning_effort_default: null,
      description: null,
      currency: "usd",
      input_per_1m: "1.000000",
      output_per_1m: "4.000000",
      cached_input_per_1m: "0.300000",
    },
  ],
};

function logEntry(overrides = {}) {
  return {
    id: "log-1",
    model: "zai-org/glm-5.3",
    api_key: "sk-aaaa...1111",
    status_code: 200,
    ttft_ms: 10,
    latency_ms: 100,
    input_tokens: 1000,
    output_tokens: 20,
    cached_tokens: 800,
    cost: "0.0004",
    currency: "usd",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

let server;
let baseUrl = "";
// Behavior per /logs range: the sync pulls 30days; the report pulls what the
// flag asked for. The failure test fails ONLY the sync pull.
let logsFor = () => ({ data: [], has_more: false, next_after: null, next_after_id: null });

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/logs") {
      const outcome = logsFor(url);
      if (outcome.error) {
        res.writeHead(outcome.error.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: outcome.error.message } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(outcome));
      return;
    }
    if (url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MODELS));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

/** Plant store rows directly (created_at = offset days before now). */
function plant(dir, dayOffsets) {
  return withEnv({ AIAND_CONFIG_DIR: dir }, () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    const db = opened.db;
    try {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO requests " +
          "(id, model, api_key, status_code, input_tokens, output_tokens, cached_tokens, " +
          "cost, cost_value, currency, created_at, synced_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      dayOffsets.forEach((offset, i) => {
        const created = new Date(Date.now() - offset * 86_400_000).toISOString();
        insert.run(
          `planted-${offset}-${i}`,
          "zai-org/glm-5.3",
          "sk-aaaa...1111",
          200,
          100,
          10,
          0,
          "0.01",
          0.01,
          "usd",
          created,
          created,
        );
      });
      db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_sync_at', ?)").run(
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
  });
}

describe("aiand cache coverage (ticket #68)", () => {
  test("--json carries coverage with the missing day, and sync status", async () => {
    const dir = join(box.dir, "gap-json");
    plant(dir, [0, 2]); // rows today and 2 days ago; yesterday missing
    logsFor = () => ({
      data: [logEntry()],
      has_more: false,
      next_after: null,
      next_after_id: null,
    });
    const { code, stdout } = await runCli(["cache", "--range", "7days", "--json", "--no-sync"], {
      env: {
        ...process.env,
        AIAND_CONFIG_DIR: dir,
        AIAND_HOME: join(box.dir, "home"),
        AIAND_API_KEY: FAKE_API_KEY,
        AIAND_BASE_URL: baseUrl,
        NO_COLOR: "1",
        CI: "1",
      },
      stdin: "ignore",
    });
    assert.equal(code, 0);
    const payload = JSON.parse(stdout);
    assert.equal(payload.sync.status, "skipped");
    assert.equal(payload.coverage.sync.status, "skipped");
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    assert.ok(
      payload.coverage.missingDays.includes(yesterday),
      `expected ${yesterday} in ${JSON.stringify(payload.coverage.missingDays)}`,
    );
    assert.ok(payload.coverage.lastSyncAt);
    // Provenance travels with the payload too.
    assert.equal(payload.provenance.totals.costUsd.kind, "gateway-billed");
    assert.ok(payload.unattributed.count >= 0);
  });

  test("human output lists the missing day instead of folding it away", async () => {
    const dir = join(box.dir, "gap-human");
    plant(dir, [0, 2]);
    logsFor = () => ({
      data: [logEntry()],
      has_more: false,
      next_after: null,
      next_after_id: null,
    });
    const { code, stdout } = await runCli(["cache", "--range", "7days", "--no-sync"], {
      env: {
        ...process.env,
        AIAND_CONFIG_DIR: dir,
        AIAND_HOME: join(box.dir, "home"),
        AIAND_API_KEY: FAKE_API_KEY,
        AIAND_BASE_URL: baseUrl,
        NO_COLOR: "1",
        CI: "1",
      },
      stdin: "ignore",
    });
    assert.equal(code, 0);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    assert.match(stdout, new RegExp(yesterday));
    assert.match(stdout, /coverage: last sync/);
    assert.match(stdout, /not averaged over|absent from local aggregates/);
  });

  test("a failed pre-command sync warns but the report still renders (exit 0)", async () => {
    const dir = join(box.dir, "sync-fail");
    plant(dir, [0]);
    logsFor = (url) =>
      url.searchParams.get("range") === "30days"
        ? { error: { status: 503, message: "gateway unavailable" } }
        : { data: [logEntry()], has_more: false, next_after: null, next_after_id: null };
    const { code, stdout, stderr } = await runCli(["cache", "--range", "24h", "--json"], {
      env: {
        ...process.env,
        AIAND_CONFIG_DIR: dir,
        AIAND_HOME: join(box.dir, "home"),
        AIAND_API_KEY: FAKE_API_KEY,
        AIAND_BASE_URL: baseUrl,
        NO_COLOR: "1",
        CI: "1",
      },
      stdin: "ignore",
    });
    assert.equal(code, 0);
    const payload = JSON.parse(stdout);
    assert.equal(payload.sync.status, "failed");
    assert.match(payload.sync.error, /unavailable/);
    // The report itself still rendered from the live window.
    assert.equal(payload.totals.requests, 1);
    assert.match(stderr, /sync failed/);
  });

  test("an unattributed key shows the --attribute hint in human output", async () => {
    const dir = join(box.dir, "hint");
    logsFor = () => ({
      data: [logEntry({ api_key: "sk-zzzz...9999" })],
      has_more: false,
      next_after: null,
      next_after_id: null,
    });
    const { code, stdout } = await runCli(["cache", "--range", "24h", "--no-sync"], {
      env: {
        ...process.env,
        AIAND_CONFIG_DIR: dir,
        AIAND_HOME: join(box.dir, "home"),
        AIAND_API_KEY: FAKE_API_KEY,
        AIAND_BASE_URL: baseUrl,
        NO_COLOR: "1",
        CI: "1",
      },
      stdin: "ignore",
    });
    assert.equal(code, 0);
    assert.match(stdout, /could not be attributed/);
    assert.match(stdout, /--attribute/);
  });

  test("a corrupt agent-keys.json degrades to unknown, never crashes", async () => {
    const dir = join(box.dir, "corrupt-map");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-keys.json"), "{not json at all", "utf8");
    logsFor = () => ({
      data: [logEntry({ api_key: "sk-zzzz...9999" })],
      has_more: false,
      next_after: null,
      next_after_id: null,
    });
    const { code, stdout } = await runCli(["cache", "--range", "24h", "--json", "--no-sync"], {
      env: {
        ...process.env,
        AIAND_CONFIG_DIR: dir,
        AIAND_HOME: join(box.dir, "home"),
        AIAND_API_KEY: FAKE_API_KEY,
        AIAND_BASE_URL: baseUrl,
        NO_COLOR: "1",
        CI: "1",
      },
      stdin: "ignore",
    });
    assert.equal(code, 0);
    const payload = JSON.parse(stdout);
    // The unreadable map degrades to an empty one: the key is unattributed
    // and labeled unknown — a corrupt file must not guess.
    assert.equal(payload.unattributed.count, 1);
    assert.deepEqual(
      payload.byAgent.map((g) => g.key),
      ["unknown"],
    );
  });
});
