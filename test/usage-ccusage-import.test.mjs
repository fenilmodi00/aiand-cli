import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

// OBS-P3-3 (#73, feature catalog G4): the ccusage JSON import adapter.
// Imported rows are EXTERNAL — their own store table, their own source row in
// `usage`, EXCLUDED from gateway totals by default, folded into a combined
// grand total only on --include-imported. Re-importing identical input is a
// no-op (content-hash dedupe). All offline: no session, no gateway, no sync.

const box = withTestEnv("aiand-usage-ccusage-", () => {
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_NO_SYNC;
});

function freshDir(name) {
  const dir = join(box.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const reportEnv = (dir) =>
  cliEnv({
    AIAND_CONFIG_DIR: dir,
    AIAND_NO_SYNC: "1",
    NO_COLOR: "1",
    CI: "1",
  });

// -- fixtures (ccusage --json report shapes) ----------------------------------

/** A daily-report payload (ccusage daily --json): input EXCLUDES cache there. */
const DAILY_PAYLOAD = JSON.stringify({
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
    {
      date: "2026-10-21",
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      costUSD: 0.0456,
    },
  ],
});

const SESSION_PAYLOAD = JSON.stringify({
  sessions: [
    {
      sessionId: "sess-abc",
      inputTokens: 700,
      outputTokens: 90,
      cacheReadTokens: 10,
      costUSD: 0.02,
      mostRecentAktivity: "2026-10-20T12:00:00.000Z",
    },
  ],
});

const BLOCKS_PAYLOAD = JSON.stringify({
  blocks: [
    {
      id: "2026-10-20T00:00:00.000Z+300",
      startTime: "2026-10-20T00:00:00.000Z",
      endTime: "2026-10-20T05:00:00.000Z",
      isActive: false,
      tokenCounts: {
        inputTokens: 300,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
      },
      costUSD: 0.011,
    },
  ],
});

const BREAKDOWN_PAYLOAD = JSON.stringify({
  daily: [
    {
      date: "2026-10-22",
      inputTokens: 900,
      outputTokens: 150,
      costUSD: 0.3,
      models: [
        { modelName: "zai-org/glm-5.3", inputTokens: 600, outputTokens: 100, costUSD: 0.2 },
        { modelName: "deepseek-ai/deepseek-v4", inputTokens: 300, outputTokens: 50, costUSD: 0.1 },
      ],
    },
  ],
});

/** Seed one gateway row directly (offline, like the #60 tests). */
async function seedStore(dir, rows) {
  await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
    const store = await import("../dist/store/index.js");
    const opened = store.openStore(store.storePath());
    assert.ok(opened.ok, `store open failed: ${opened.reason ?? ""}`);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      insert.run(
        r.id,
        r.model,
        r.api_key,
        r.status_code,
        r.ttft_ms,
        r.latency_ms,
        r.input_tokens,
        r.output_tokens,
        r.cached_tokens,
        r.cost,
        r.cost_value,
        r.currency,
        r.created_at,
        new Date().toISOString(),
      );
    }
    opened.db.close();
  });
}

async function importInto(dir, payload, extraArgs = []) {
  const file = join(dir, `ccusage-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, payload);
  return runCli(["usage", "--import-ccusage", file, "--json", ...extraArgs], {
    env: reportEnv(dir),
  });
}

// -- import surface ------------------------------------------------------------

describe("usage --import-ccusage", () => {
  test("daily payload imports via file arg; tokens normalized to the gateway convention", async () => {
    const dir = freshDir("daily");
    const run = await importInto(dir, DAILY_PAYLOAD);
    assert.equal(run.code, 0, run.stderr);
    const summary = JSON.parse(run.stdout);
    assert.equal(summary.source, "imported-ccusage");
    assert.equal(summary.reportKind, "daily");
    assert.equal(summary.inserted, 2);
    assert.equal(summary.deduped, false);
    assert.match(summary.sourceLabel, /^imported\(ccusage@\d{4}-\d{2}-\d{2}\)$/);
    assert.match(summary.contentHash, /^[0-9a-f]{64}$/);

    const opened = await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const store = await import("../dist/store/index.js");
      const opened = store.openStore(store.storePath());
      assert.ok(opened.ok);
      const rows = opened.db
        .prepare("SELECT * FROM imported_usage ORDER BY period")
        .all()
        .map((r) => r);
      opened.db.close();
      return rows;
    });
    // ccusage inputTokens excludes cache; the store row means input-includes-cached.
    assert.equal(opened[0].input_tokens, 1000 + 50 + 150);
    assert.equal(opened[0].cached_tokens, 50 + 150);
    assert.equal(opened[0].output_tokens, 200);
    assert.equal(opened[0].cost_value, 0.123);
    assert.equal(opened[0].currency, "USD");
    assert.equal(opened[0].source, "imported-ccusage");
    assert.equal(opened[0].started_at, "2026-10-20T00:00:00.000Z");
    // Gateway rows are untouched by the import.
    assert.equal(
      await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
        const store = await import("../dist/store/index.js");
        const opened = store.openStore(store.storePath());
        const n = opened.db.prepare("SELECT COUNT(*) AS n FROM requests").get().n;
        opened.db.close();
        return n;
      }),
      0,
    );
  });

  test("stdin (-) works: ccusage daily --json | aiand usage --import-ccusage -", async () => {
    const dir = freshDir("stdin");
    const run = await runCli(["usage", "--import-ccusage", "-", "--json"], {
      env: reportEnv(dir),
      input: SESSION_PAYLOAD,
    });
    assert.equal(run.code, 0, run.stderr);
    const summary = JSON.parse(run.stdout);
    assert.equal(summary.reportKind, "sessions");
    assert.equal(summary.inserted, 1);
  });

  test("session and blocks shapes parse; blocks normalize the nested tokenCounts", async () => {
    const dir = freshDir("shapes");
    for (const [payload, kind, periods] of [
      [SESSION_PAYLOAD, "sessions", 1],
      [BLOCKS_PAYLOAD, "blocks", 1],
    ]) {
      const run = await importInto(dir, payload);
      assert.equal(run.code, 0, run.stderr);
      const summary = JSON.parse(run.stdout);
      assert.equal(summary.reportKind, kind);
      assert.equal(summary.inserted, periods);
    }
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const store = await import("../dist/store/index.js");
      const opened = store.openStore(store.storePath());
      const block = opened.db
        .prepare("SELECT * FROM imported_usage WHERE report_kind = 'blocks'")
        .get();
      assert.equal(block.input_tokens, 300 + 20 + 10); // nested tokenCounts, cache folded into input
      assert.equal(block.started_at, "2026-10-20T00:00:00.000Z");
      assert.equal(block.ended_at, "2026-10-20T05:00:00.000Z");
      const session = opened.db
        .prepare("SELECT * FROM imported_usage WHERE report_kind = 'sessions'")
        .get();
      assert.equal(session.started_at, "2026-10-20T12:00:00.000Z");
      opened.db.close();
    });
  });

  test("--breakdown payloads import per-model rows, never the aggregate too", async () => {
    const dir = freshDir("breakdown");
    const run = await importInto(dir, BREAKDOWN_PAYLOAD);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).inserted, 2);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const store = await import("../dist/store/index.js");
      const opened = store.openStore(store.storePath());
      const models = opened.db
        .prepare("SELECT model, input_tokens, cost_value FROM imported_usage ORDER BY model")
        .all();
      assert.deepEqual(
        models.map((m) => m.model),
        ["deepseek-ai/deepseek-v4", "zai-org/glm-5.3"],
      );
      assert.equal(models[1].input_tokens, 600);
      opened.db.close();
    });
  });

  test("re-importing identical input is a no-op (content-hash dedupe)", async () => {
    const dir = freshDir("idempotent");
    const first = await importInto(dir, DAILY_PAYLOAD);
    assert.equal(first.code, 0, first.stderr);
    const second = await importInto(dir, DAILY_PAYLOAD);
    assert.equal(second.code, 0, second.stderr);
    const summary = JSON.parse(second.stdout);
    assert.equal(summary.inserted, 0);
    assert.equal(summary.deduped, true);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const store = await import("../dist/store/index.js");
      const opened = store.openStore(store.storePath());
      const n = opened.db.prepare("SELECT COUNT(*) AS n FROM imported_usage").get().n;
      const imports = opened.db.prepare("SELECT COUNT(*) AS n FROM ccusage_imports").get().n;
      opened.db.close();
      assert.equal(n, 2);
      assert.equal(imports, 1);
    });
  });

  test("a newer payload over the same periods replaces them (no stacking)", async () => {
    const dir = freshDir("replace");
    await importInto(dir, DAILY_PAYLOAD);
    const updated = JSON.stringify({
      daily: [
        {
          date: "2026-10-20",
          inputTokens: 2000,
          outputTokens: 300,
          costUSD: 0.5,
        },
      ],
    });
    const run = await importInto(dir, updated);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).inserted, 1);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const store = await import("../dist/store/index.js");
      const opened = store.openStore(store.storePath());
      const rows = opened.db
        .prepare("SELECT input_tokens, cost_value FROM imported_usage WHERE period = '2026-10-20'")
        .all();
      opened.db.close();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].input_tokens, 2000);
      assert.equal(rows[0].cost_value, 0.5);
    });
  });

  test("unknown or malformed schemas are refused loudly, nothing imported", async () => {
    const dir = freshDir("invalid");
    for (const [name, payload] of [
      ["not json", "{oops"],
      ["unknown schema", JSON.stringify({ fortnightly: [{ date: "2026-10-20", costUSD: 1 }] })],
      ["missing fields", JSON.stringify({ daily: [{ date: "2026-10-20" }] })],
      [
        "wrong type",
        JSON.stringify({
          daily: [{ date: "2026-10-20", inputTokens: "many", outputTokens: 1, costUSD: 1 }],
        }),
      ],
      ["ambiguous", JSON.stringify({ daily: [], sessions: [] })],
      ["not an object", JSON.stringify([1, 2, 3])],
    ]) {
      const run = await importInto(dir, payload);
      assert.notEqual(run.code, 0, `${name}: expected a nonzero exit`);
      assert.match(run.stderr, /ccusage import failed/, `${name}: loud failure expected`);
    }
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const store = await import("../dist/store/index.js");
      const opened = store.openStore(store.storePath());
      const n = opened.db.prepare("SELECT COUNT(*) AS n FROM imported_usage").get().n;
      opened.db.close();
      assert.equal(n, 0, "a refused payload must import nothing");
    });
  });

  test("migration 0003 applies to an existing store and STORE_VERSION follows", async () => {
    const dir = freshDir("migration");
    await importInto(dir, DAILY_PAYLOAD);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const store = await import("../dist/store/index.js");
      // 4 = latest migration (0004 envelopes, #78); this test exercises 0003.
      assert.equal(store.STORE_VERSION, 4);
      // Simulate a pre-0003 store: drop the table + ledger, forget the migration.
      const opened = store.openStore(store.storePath());
      opened.db.exec(
        "DROP TABLE imported_usage; DROP TABLE ccusage_imports; " +
          "DELETE FROM schema_migrations WHERE version = 3;",
      );
      opened.db.close();
      // Re-opening reapplies migration 0003 cleanly (import rows are gone —
      // they were dropped — but the schema is whole again).
      const reopened = store.openStore(store.storePath());
      assert.ok(reopened.ok);
      reopened.db.exec("SELECT COUNT(*) FROM imported_usage");
      reopened.db.exec("SELECT COUNT(*) FROM ccusage_imports");
      reopened.db.close();
    });
  });
});

// -- report integration: exclusion by default, opt-in combined total ----------

describe("imported rows in the usage report (anti-double-count)", () => {
  const GATEWAY_ROWS = [
    {
      id: "g1",
      model: "zai-org/glm-5.3",
      api_key: "sk-abcd...1234",
      status_code: 200,
      ttft_ms: 100,
      latency_ms: 500,
      input_tokens: 1000,
      output_tokens: 300,
      cached_tokens: 400,
      cost: "0.0042",
      cost_value: 0.0042,
      currency: "usd",
      created_at: "2026-10-20T10:00:00.000Z",
    },
  ];

  async function mixedStore(name, payload = DAILY_PAYLOAD) {
    const dir = freshDir(name);
    await seedStore(dir, GATEWAY_ROWS);
    const run = await importInto(dir, payload);
    assert.equal(run.code, 0, run.stderr);
    return dir;
  }

  test("default: gateway totals exclude imported rows; imported shows as its own source row", async () => {
    const dir = await mixedStore("excluded");
    const run = await runCli(["usage", "--by", "day", "--json"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.meta.importedIncluded, false);
    // Gateway totals: gateway rows only.
    assert.equal(payload.sections.totals.requests, 1);
    assert.deepEqual(payload.sections.totals.costs, { usd: 0.0042 });
    // The imported lane is its own, clearly-labeled source row.
    const imported = payload.sections.imported;
    assert.ok(Array.isArray(imported) && imported.length === 1, JSON.stringify(imported));
    assert.match(imported[0].key, /^imported\(ccusage@\d{4}-\d{2}-\d{2}\)·daily$/);
    assert.equal(imported[0].requests, 2);
    assert.equal(imported[0].input_tokens, 1000 + 200 + 500);
    assert.equal(imported[0].cached_tokens, 200);
    // #89: imported "USD" casefolds into the gateway's "usd" lane.
    assert.deepEqual(imported[0].costs, { usd: 0.123 + 0.0456 });
    // No grand total unless asked for.
    assert.equal(payload.sections["grand-total"], undefined);
    // Provenance labels the imported lane as estimated, never gateway-billed.
    assert.match(payload.meta.provenance.imported, /^estimated\(/);
    assert.match(payload.meta.provenance["imported.cost"], /never gateway-billed/);
  });

  test("--include-imported folds imported rows into an explicit grand total", async () => {
    const dir = await mixedStore("included");
    const run = await runCli(["usage", "--by", "day", "--json", "--include-imported"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.meta.importedIncluded, true);
    // Gateway totals stay gateway-only even in combined mode.
    assert.equal(payload.sections.totals.requests, 1);
    const grand = payload.sections["grand-total"];
    assert.ok(grand, "grand-total section expected");
    assert.equal(grand.requests, 3);
    assert.deepEqual(grand.gateway, payload.sections.totals);
    assert.equal(grand.imported.requests, 2);
    // #89: mixed-case same currency merges into one summed key — gateway
    // "usd" + imported "USD" land in a single "usd" lane.
    assert.deepEqual(grand.costs, { usd: 0.0042 + 0.123 + 0.0456 });
  });

  test("#89 mixed-case same currency merges into one summed lane (csv + text single lane)", async () => {
    const dir = freshDir("casefold");
    await seedStore(dir, [
      { ...GATEWAY_ROWS[0], id: "g1", cost: "0.0042", cost_value: 0.0042, currency: "usd" },
      { ...GATEWAY_ROWS[0], id: "g2", cost: "0.0010", cost_value: 0.001, currency: "USD" },
    ]);
    const json = await runCli(["usage", "--by", "day", "--json"], { env: reportEnv(dir) });
    assert.equal(json.code, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    // Both rows fall into one "usd" lane, summed.
    assert.deepEqual(payload.sections.totals.costs, { usd: 0.0042 + 0.001 });
    assert.equal(payload.meta.currencyHandling, "single");
    assert.equal(payload.meta.currency, "usd");

    // CSV: one lane per real currency — a single currency row for the period.
    const csv = await runCli(["usage", "--by", "day", "--format", "csv"], {
      env: reportEnv(dir),
    });
    assert.equal(csv.code, 0, csv.stderr);
    const dataLines = csv.stdout
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "" && !l.startsWith("period,"));
    assert.equal(dataLines.length, 1, JSON.stringify(dataLines));
    assert.match(dataLines[0], /2026-10-20,2,\d+,\d+,\d+,0\.005200,usd/);

    // Text: single-currency cost cell renders one formatted value, no
    // mixed-currency warning and no duplicate lane.
    const text = await runCli(["usage", "--by", "day"], { env: reportEnv(dir) });
    assert.equal(text.code, 0, text.stderr);
    assert.doesNotMatch(text.stdout, /mixed currencies/i);
  });

  test("#89 genuinely different currencies stay separate lanes", async () => {
    const dir = freshDir("separate");
    await seedStore(dir, [
      { ...GATEWAY_ROWS[0], id: "g1", currency: "EUR", cost: "2", cost_value: 2 },
    ]);
    await importInto(dir, DAILY_PAYLOAD); // imported rows are USD
    const run = await runCli(["usage", "--by", "day", "--json", "--include-imported"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    const grand = JSON.parse(run.stdout).sections["grand-total"];
    // eur (gateway) and usd (imported) remain distinct, never summed across.
    assert.deepEqual(grand.costs, { eur: 2, usd: 0.123 + 0.0456 });
    assert.deepEqual(grand.gateway.costs, { eur: 2 });
    assert.deepEqual(grand.imported.costs, { usd: 0.123 + 0.0456 });
  });

  test("table render: imported section labeled, exclusion note, opt-in hint", async () => {
    const dir = await mixedStore("render");
    const plain = await runCli(["usage", "--by", "day"], { env: reportEnv(dir) });
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /Imported \(ccusage\) — excluded from gateway totals/);
    assert.match(plain.stdout, /imported\(ccusage@\d{4}-\d{2}-\d{2}\)·daily/);
    assert.match(plain.stdout, /price-table-derived/);
    assert.match(plain.stdout, /--include-imported/);

    const combined = await runCli(["usage", "--by", "day", "--include-imported"], {
      env: reportEnv(dir),
    });
    assert.equal(combined.code, 0, combined.stderr);
    assert.match(combined.stdout, /Grand total \(gateway \+ imported\)/);
    assert.match(combined.stdout, /mixed provenance/);
  });

  test("a store with no imports renders no imported section (payload shape unchanged)", async () => {
    const dir = freshDir("clean");
    await seedStore(dir, GATEWAY_ROWS);
    const run = await runCli(["usage", "--by", "day", "--json"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.sections.imported, undefined);
    assert.equal(payload.sections["grand-total"], undefined);
  });

  test("--audit lists the imported fields' provenance", async () => {
    const dir = freshDir("audit");
    const run = await runCli(["usage", "--audit"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir, NO_COLOR: "1", CI: "1" }),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /imported\.cost/);
    assert.match(run.stdout, /never gateway-billed/);
  });

  test("import never syncs: a broken base URL cannot block an import", async () => {
    const dir = freshDir("offline");
    const run = await runCli(["usage", "--import-ccusage", "-", "--json"], {
      env: cliEnv({
        AIAND_CONFIG_DIR: dir,
        AIAND_BASE_URL: "http://127.0.0.1:9",
        AIAND_AUTH_URL: "http://127.0.0.1:9",
        NO_COLOR: "1",
        CI: "1",
      }),
      input: DAILY_PAYLOAD,
    });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).inserted, 2);
  });
});
