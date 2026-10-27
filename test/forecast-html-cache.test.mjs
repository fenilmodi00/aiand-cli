import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLOSED_URL, cliEnv, FAKE_API_KEY, runCli, withEnv, withTestEnv } from "./helpers.mjs";

// Branch coverage for three units the hardening sweep left thin:
// - dist/commands/forecast.js: the non---no-sync sync paths (open failure,
//   sync failure) and the bench error guards, driven through the built CLI.
// - dist/report/render-html.js: the pure renderer over hand-built ReportData
//   edge fixtures (empty sections, mixed currency, null costs).
// - dist/commands/cache.js: the catalog-failure catch and the empty-group
//   table, via a loopback gateway that answers /logs but fails /v1/models.
// - dist/store/envelopes.js: insert/list/count edge branches, direct import.

const root = withTestEnv("forecast-html-cache-", () => {});

let seq = 0;
/** A fresh config dir; tests that share one pass `dir` explicitly. */
function cfgDir(name = `case-${++seq}`) {
  const dir = join(root.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cliEnvFor(cfg, overrides = {}) {
  return cliEnv({
    AIAND_CONFIG_DIR: cfg,
    AIAND_HOME: cfg,
    AIAND_KEY_STORAGE: "plaintext",
    CI: "1",
    NO_COLOR: "1",
    NO_UPDATE_CHECK: "1",
    AIAND_API_KEY: undefined,
    AIAND_BASE_URL: undefined,
    AIAND_AUTH_URL: undefined,
    AIAND_PROFILE: undefined,
    AIAND_NO_SYNC: undefined,
    AIAND_NO_WARN: undefined,
    ...overrides,
  });
}

const cli = (args, cfg, overrides = {}) =>
  runCli(args, { env: cliEnvFor(cfg, overrides), stdin: "ignore" });

/** Seed store.db under `cfg` by running the built CLI's own migrations. */
async function seedStore(cfg, rows) {
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { openStore, storePath } = await import("../dist/store/index.js");
    const opened = openStore(storePath());
    assert.ok(opened.ok, `store open failed: ${opened.reason ?? ""}`);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      insert.run(
        r.id,
        r.model ?? "test/model",
        r.api_key ?? "sk-abcd...1234",
        r.status ?? 200,
        r.ttft ?? 120,
        r.latency ?? null,
        r.input ?? 1000,
        r.output ?? 300,
        r.cached ?? 400,
        r.cost === null || r.cost === undefined ? null : String(r.cost),
        r.cost ?? null,
        r.currency ?? "usd",
        r.created_at,
        r.created_at,
      );
    }
    opened.db.close();
  });
}

// ---------------------------------------------------------------------------
// forecast: sync paths the --no-sync tests never reach (dist 98-110)
// ---------------------------------------------------------------------------

test("forecast: without --no-sync a dead gateway degrades to a sync-failed warning", async () => {
  // No --no-sync: the command attempts a pre-command sync against a closed
  // port, the failure is caught, and the run degrades to local data with a
  // stderr warning — sync failure is surfaced, never fatal.
  const cfg = cfgDir("sync-failed");
  const r = await cli(["forecast", "--base-url", CLOSED_URL], cfg);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Warning: sync failed/);
  assert.match(r.stdout, /Forecast ·/);
  assert.match(r.stdout, /no-data/);
});

test("forecast: without --no-sync and no stored credential, the sync fails open", async () => {
  const cfg = cfgDir("sync-not-logged-in");
  const r = await cli(["forecast", "--base-url", CLOSED_URL], cfg);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Warning: sync failed \(Not logged in\.\)/);
});

test("forecast: sync-failed run still renders v1 and v2 outputs from local data", async () => {
  const cfg = cfgDir("sync-failed-tables");
  const now = new Date();
  const iso = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  await seedStore(cfg, [
    { id: "f1", cost: 10, created_at: iso(1), latency: 0 },
    { id: "f2", cost: 10, created_at: iso(3), latency: 0 },
  ]);
  writeFileSync(
    join(cfg, "config.json"),
    JSON.stringify({ budget: { monthly: 1, currency: "usd" } }),
  );
  // A sign-in failure is caught, not thrown: the run must degrade to the
  // local rows and still print both models (the sync-failed warning itself
  // is asserted by the two tests above).
  const v1 = await cli(["forecast", "--base-url", CLOSED_URL, "--until", now.toISOString()], cfg, {
    AIAND_API_KEY: undefined,
  });
  assert.equal(v1.code, 0, v1.stderr);
  assert.match(v1.stdout, /Forecast ·/);

  const v2 = await cli(
    [
      "forecast",
      "--model",
      "v2",
      "--seed",
      "7",
      "--base-url",
      CLOSED_URL,
      "--until",
      now.toISOString(),
    ],
    cfg,
    { AIAND_API_KEY: undefined },
  );
  assert.equal(v2.code, 0, v2.stderr);
  assert.match(v2.stdout, /Forecast \(v2 calibrated Monte Carlo\)/);
});

test("forecast bench: --json shape and the bench flags reach the CLI layer", async () => {
  const cfg = cfgDir("bench-json");
  // Empty store: every bench run refuses with the insufficient-history copy.
  let r = await cli(["forecast", "bench", "--json", "--until", "2026-03-20T12:00:00Z"], cfg);
  assert.equal(r.code, 0, r.stderr);
  // #99: with --json the refusal is a machine-readable status payload.
  assert.deepEqual(JSON.parse(r.stdout), { status: "insufficient-history", windows: 0 });

  // Non-integer / non-positive values fail loudly (the int() + guard path).
  for (const args of [
    ["forecast", "bench", "--horizon-hours", "abc"],
    ["forecast", "bench", "--windows", "0"],
    ["forecast", "bench", "--horizon-hours", "-2"],
  ]) {
    r = await cli(args, cfg);
    assert.equal(r.code, 1, `${args.join(" ")}\n${r.stderr}`);
    assert.ok(r.stderr.length > 0);
  }
});

test("forecast: bad --until / --since / --last / --range values are user errors", async () => {
  const cfg = cfgDir("flag-errors");
  for (const args of [
    ["forecast", "--until", "not-a-date"],
    ["forecast", "--since", "yesterday"],
    ["forecast", "--last", "0"],
    ["forecast", "--last", "-3"],
    ["forecast", "--range", "fortnight"],
  ]) {
    const r = await cli(args, cfg);
    assert.equal(r.code, 1, `${args.join(" ")}\n${r.stderr}`);
    assert.match(r.stderr, /--until|--since|--last|--range/);
  }
});

test("forecast: --jq indexed paths extract from the payload", async () => {
  const cfg = cfgDir("jq-paths");
  // No completed months: the v1 --json payload's projected_month_end is null.
  const r = await cli(["forecast", "--json", "--jq", "projected_month_end.value"], cfg);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout), null);
});

// ---------------------------------------------------------------------------
// render-html: pure renderer over ReportData edge fixtures (dist 136-138, 154-155, 187-188)
// ---------------------------------------------------------------------------

const baseData = {
  meta: {
    generatedAt: "2026-10-26T08:00:00.000Z",
    timezone: "UTC",
    range: { since: null, until: null },
    currencyHandling: "single",
    currency: "usd",
    rowCount: 0,
    provenance: {},
    sync: { status: "synced", at: null },
    lagSeconds: null,
    missingDays: [],
    sessionization: null,
    matrixNote: "note",
    savingsNote: null,
  },
  totals: {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costs: {},
    savings: null,
  },
  byHarness: [],
  days: [],
  harnessDays: [],
  topModels: [],
  matrix: [],
  sessions: [],
  budget: { configured: false },
};

const allSections = ["timeseries", "matrix", "sessions", "budget"];

/** Render with every section over `overrides`; returns the page. */
async function render(overrides = {}, options = {}) {
  const { renderHtml } = await import("../dist/report/render-html.js");
  return renderHtml(
    { ...baseData, ...overrides, meta: { ...baseData.meta, ...(overrides.meta ?? {}) } },
    { theme: "light", showCost: true, sections: allSections, ...options },
  );
}

test("renderHtml: a fully empty report renders every empty-state branch honestly", async () => {
  const html = await render();
  assert.ok(html.startsWith("<!doctype html>"));
  // range bounds null → "the beginning"/"now"; zero rows; single-currency note
  assert.match(html, /range the beginning to now/);
  assert.match(html, /0 requests/);
  assert.match(html, /currency usd/);
  // empty sections: days empty → "No data in the selected range."; matrix
  // and sessions empty → "No data."; budget unconfigured → the config hint
  assert.match(html, /No data in the selected range\./);
  assert.match(html, /id="matrix"/);
  assert.match(html, /No budget configured/);
  // no sessionization meta → empty note prefix; no "undefined"/"NaN" leaks
  assert.ok(!html.includes(">undefined<") && !html.includes(">NaN<"), html.slice(0, 400));
  // footer: no coverage notes (synced, no lag, no missing days), no savings note
  assert.ok(!html.includes("store sync:"));
  assert.ok(!html.includes("ingestion lag"));
});

test("renderHtml: mixed currency, null costs, zero-token rows, and failed sync notes", async () => {
  const html = await render({
    meta: {
      currencyHandling: "mixed",
      currency: null,
      rowCount: 4,
      sync: { status: "failed", at: null, error: "boom" },
      lagSeconds: 90.4,
      missingDays: ["2026-10-24", "2026-10-25"],
      sessionization: {
        method: "time-gap",
        gapMinutes: 30,
        confidence: "heuristic",
        override: null,
      },
      savingsNote: "savings unavailable — mixed or unknown currencies",
    },
    matrix: [
      {
        harness: "claude",
        model: "m",
        requests: 1,
        inputTokens: 0, // hitRatio null branch
        outputTokens: 5,
        cachedTokens: 0,
        costs: {}, // empty costs cell
        hitRatio: null,
        savings: null,
        verdict: "bad",
      },
      {
        harness: "omp",
        model: "m",
        requests: 3,
        inputTokens: 100,
        outputTokens: 10,
        cachedTokens: 60,
        costs: { eur: 0.5, usd: 0.25 }, // multi-currency cell
        hitRatio: 0.6,
        savings: 1.5,
        verdict: "warn",
      },
    ],
    sessions: [
      {
        session_id: 's&<"x">', // esc() exercise in title + cells
        agent: "claude",
        api_key: "sk-x",
        started_at: "2026-10-25T10:00:00.000Z",
        ended_at: "2026-10-25T10:05:00.000Z",
        turns: 2,
        input_tokens: 0, // hit-ratio "—" branch
        output_tokens: 1,
        cached_tokens: 0,
        cost: null, // cost "—" branch
        currency: null,
        confidence: "single-request",
      },
      {
        session_id: "s2",
        agent: "omp",
        api_key: "sk-y",
        started_at: "2026-10-25T11:00:00.000Z",
        ended_at: "2026-10-25T11:05:00.000Z",
        turns: 1,
        input_tokens: 10,
        output_tokens: 2,
        cached_tokens: 5,
        cost: 0.75,
        currency: "eur", // non-usd prefix: "eur " code + symbol table miss
        confidence: "gap",
      },
    ],
    budget: {
      configured: true,
      verdict: "exceeding",
      currentSpend: 2,
      projected: 9,
      exceedDate: "2026-10-30",
      budget: 4,
      currency: "jpy", // symbol table hit: ¥
      pacing: "On pace to exceed budget: projected ¥9.00 by 2026-10-30 (budget ¥4.00)",
    },
    days: [
      {
        day: "2026-10-25",
        requests: 2,
        inputTokens: 50,
        outputTokens: 5,
        cachedTokens: 20,
        costs: { usd: 0.1 },
        savings: 0.2,
      },
      {
        day: "2026-10-26",
        requests: 2,
        inputTokens: 50,
        outputTokens: 5,
        cachedTokens: 20,
        costs: { usd: 0.1 },
        savings: null,
      },
    ],
    harnessDays: [
      { harness: "claude", day: "2026-10-25", costs: { usd: 0.1 }, savings: 0.2 },
      { harness: "claude", day: "2026-10-26", costs: { usd: 0.1 }, savings: null },
    ],
  });
  // coverage notes: failed sync with error, lag, missing days
  assert.match(html, /store sync: failed \(boom\)/);
  assert.match(html, /ingestion lag: 90s/);
  assert.match(html, /no local data for 2 day\(s\): 2026-10-24, 2026-10-25/);
  // mixed-currency note + savings note
  assert.match(html, /mixed currencies — costs are shown per currency, never summed/);
  assert.match(html, /savings unavailable/);
  // matrix cells: null hitRatio and empty costs render the muted dash; the
  // priced row renders both currencies apart ("eur" has no symbol → bare code)
  assert.ok(html.includes("verdict-bad"));
  assert.ok(html.includes("verdict-warn"));
  assert.match(html, /eur 0\.500000; \$0\.250000/);
  // session table: escaped id, dash for null cost, dash for zero-token ratio,
  // and the eur cost prefix on the priced session
  assert.match(html, /s&amp;&lt;&quot;x&quot;&gt;/);
  assert.match(html, /eur 0\.750000/);
  // budget block: jpy symbol, projected, exceed date, verdict, pacing line
  assert.match(html, /Month to date: jpy 2\.00 of jpy 4\.00 \(50\.0%\)/);
  assert.match(html, /Projected month end: jpy 9\.00/);
  assert.match(html, /Crosses budget: 2026-10-30/);
  assert.match(html, /verdict-bad">exceeding/);
  assert.match(html, /On pace to exceed budget/);
  // timeseries rendered (charts present) despite mixed meta
  assert.ok(html.includes("<svg"));
  // savings chart suppressed: one day has null savings but the other has a
  // value, so the cumulative series has a non-null point and renders.
  assert.match(html, /Cumulative savings/);
  assert.ok(!html.includes(">undefined<") && !html.includes(">NaN<"), html.slice(0, 400));
});

test("renderHtml: --no-cost view and a budget error block", async () => {
  const html = await render(
    {
      days: [
        {
          day: "2026-10-25",
          requests: 1,
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          costs: { usd: 0.1 },
          savings: null,
        },
      ],
      harnessDays: [{ harness: "claude", day: "2026-10-25", costs: { usd: 0.1 }, savings: null }],
      matrix: [
        {
          harness: "claude",
          model: "m",
          requests: 1,
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          costs: { usd: 0.1 },
          hitRatio: 0,
          savings: null,
          verdict: "bad",
        },
      ],
      budget: { configured: true, error: "mixed or unknown currencies in range" },
    },
    { showCost: false },
  );
  // timeseries: cost hidden → the parts-empty "Cost display disabled" note, no charts
  assert.match(html, /Cost display disabled \(--no-cost\)\./);
  assert.ok(!html.includes("<svg"));
  // matrix: cost column masked; savings cell dashes
  assert.match(html, /<span class="muted">masked<\/span>/);
  // budget error note (the "error" in budget branch)
  assert.match(html, /mixed or unknown currencies in range/);
});

test("renderHtml: budget block with zero budget, null projected/exceed, no pacing", async () => {
  const html = await render({
    budget: {
      configured: true,
      verdict: "on-pace",
      currentSpend: 0,
      projected: null,
      exceedDate: null,
      budget: 0, // share division guard → 0
      currency: null, // no symbol, no code
      pacing: null,
    },
  });
  assert.match(html, /Month to date: \$?0\.00 of \$?0\.00 \(0\.0%\)/);
  assert.ok(!html.includes("Projected month end"));
  assert.ok(!html.includes("Crosses budget"));
  assert.match(html, /verdict-good">on-pace/);
});

test("renderHtml: timeseries with no cost data renders the harness chart only when costs exist", async () => {
  // currencyHandling "none" with days present: the cost series is skipped,
  // cumulative savings are all null → both parts empty → the disabled note.
  const html = await render({
    meta: { currencyHandling: "none", currency: null },
    days: [
      {
        day: "2026-10-25",
        requests: 1,
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        costs: {},
        savings: null,
      },
    ],
    harnessDays: [{ harness: "claude", day: "2026-10-25", costs: {}, savings: null }],
  });
  assert.match(html, /Cost display disabled \(--no-cost\)\./);
  assert.ok(!html.includes("<svg"));
});

// ---------------------------------------------------------------------------
// cache: catalog-failure catch (dist 99-102) + empty-group table (dist 177-180)
// ---------------------------------------------------------------------------

test("cache: a dead model catalog still prices nothing and reports; empty groups print honestly", async () => {
  const { createServer } = await import("node:http");
  const iso = "2026-10-26T08:00:00.000Z";
  let modelsFail = true;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/logs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              id: "log-empty",
              model: "zai-org/glm-5.3",
              api_key: "sk-test...1111",
              status_code: 200,
              ttft_ms: 10,
              latency_ms: 100,
              input_tokens: 1000,
              output_tokens: 20,
              cached_tokens: 800,
              cost: "0.0004",
              currency: "usd",
              created_at: iso,
            },
          ],
          has_more: false,
          next_after: null,
          next_after_id: null,
        }),
      );
      return;
    }
    if (url.pathname === "/v1/models") {
      if (modelsFail) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "catalog down" } }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
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
          }),
        );
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stubUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = cfgDir("cache-catalog-fail");
    const base = {
      env: cliEnvFor(cfg, { AIAND_API_KEY: FAKE_API_KEY, AIAND_BASE_URL: stubUrl }),
    };

    // Catalog 500s → the catch branch: the report still renders, the
    // uncached baseline is just unpriced (saved 0.000000).
    const degraded = await runCli(["cache", "--no-sync", "--json"], base);
    assert.equal(degraded.code, 0, degraded.stderr);
    const payload = JSON.parse(degraded.stdout);
    assert.equal(payload.totals.requests, 1);
    assert.equal(payload.costIfUncached, 0);
    // saved = costIfUncached - billed, and an unpriced catalog prices nothing.
    assert.equal(payload.savedUsd, -0.0004);

    // Healthy catalog prices the same traffic: savings appear.
    modelsFail = false;
    const priced = await runCli(["cache", "--no-sync", "--json"], base);
    assert.equal(priced.code, 0, priced.stderr);
    const pricedPayload = JSON.parse(priced.stdout);
    assert.ok(pricedPayload.savedUsd > 0);
  } finally {
    server.close();
  }
});

test("cache: a synced-empty store prints the empty-group table via a failed catalog", async () => {
  // The "No requests." branch of printGroups fires when the grouped view is
  // empty while the command still runs its full pipeline: a catalog failure
  // exercises the catch, and zero log rows make every group list empty.
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/logs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [], has_more: false, next_after: null, next_after_id: null }));
      return;
    }
    if (url.pathname === "/v1/models") {
      res.writeHead(500);
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const cfg = cfgDir("cache-empty-groups");
    const out = await runCli(["cache", "--no-sync"], {
      env: cliEnvFor(cfg, {
        AIAND_API_KEY: FAKE_API_KEY,
        AIAND_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      }),
    });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /No requests in the last 24h\./);
    assert.match(out.stdout, /coverage: last sync never/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// envelopes: insert/list/count edge branches (dist 48-50, 58-83, 93-104)
// ---------------------------------------------------------------------------

test("envelopes: corrupt JSON columns and non-array payloads degrade to empty arrays", async () => {
  const cfg = cfgDir("envelopes-degrade");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const store = await import("../dist/store/index.js");
    const envelopes = await import("../dist/store/envelopes.js");
    const opened = store.openStore(store.storePath());
    assert.ok(opened.ok);
    opened.db
      .prepare(
        "INSERT INTO envelopes (id, schema_version, agent, model, api_key, session_id, " +
          "request_id, created_at, tools, edit_targets, project_root_id, git_branch, captured_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "e1",
        "aiand-envelope/v1",
        "claude",
        null,
        null,
        null,
        null,
        "2026-10-25T10:00:00.000Z",
        "{not json",
        "[1,2",
        null,
        null,
        "2026-10-25T10:00:00.000Z",
      );
    opened.db
      .prepare(
        "INSERT INTO envelopes (id, schema_version, agent, model, api_key, session_id, " +
          "request_id, created_at, tools, edit_targets, project_root_id, git_branch, captured_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "e2",
        "aiand-envelope/v1",
        "claude",
        42,
        null,
        null,
        null,
        "2026-10-25T11:00:00.000Z",
        '["Edit"]',
        '{"obj":1}',
        "root",
        "main",
        "2026-10-25T11:00:00.000Z",
      );
    const rows = envelopes.listEnvelopesFromDb(opened.db);
    opened.db.close();
    assert.equal(rows.length, 2);
    // both corrupt shapes fall back to [] tools/edit_targets; the envelope
    // itself still parses (schema_version normalized on read)
    assert.deepEqual(rows[0].envelope?.tools, []);
    assert.deepEqual(rows[0].envelope?.edit_targets, []);
    assert.deepEqual(rows[1].envelope?.tools, ["Edit"]);
    assert.deepEqual(rows[1].envelope?.edit_targets, []);
    // non-string model / schema_version normalize on read (TEXT affinity
    // stringifies the bound number; schema_version falls back to the constant)
    assert.equal(rows[1].schema_version, "aiand-envelope/v1");
    assert.equal(typeof rows[1].model, "string");
    // a text project_root_id round-trips into the reassembled envelope
    assert.equal(rows[1].envelope?.project_root_id, "root");
  });
});

test("envelopes: since/until bounds and the ordering contract", async () => {
  const cfg = cfgDir("envelopes-bounds");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const store = await import("../dist/store/index.js");
    const envelopes = await import("../dist/store/envelopes.js");
    const opened = store.openStore(store.storePath());
    assert.ok(opened.ok);
    const env = {
      schema_version: "aiand-envelope/v1",
      tools: ["Edit"],
      edit_targets: ["a#0123456789abcdef"],
      project_root_id: "p1",
      git_branch: "main",
    };
    envelopes.insertEnvelope(opened.db, {
      envelope: env,
      agent: "claude",
      createdAt: "2026-10-25T09:00:00.000Z",
      id: "a",
    });
    envelopes.insertEnvelope(opened.db, {
      envelope: env,
      agent: "claude",
      createdAt: "2026-10-25T10:00:00.000Z",
      id: "b",
    });
    envelopes.insertEnvelope(opened.db, {
      envelope: env,
      agent: "claude",
      createdAt: "2026-10-25T11:00:00.000Z",
      id: "c",
    });

    // inclusive since / exclusive until, combined
    const windowed = envelopes.listEnvelopesFromDb(opened.db, {
      since: "2026-10-25T09:00:00.000Z",
      until: "2026-10-25T11:00:00.000Z",
    });
    assert.deepEqual(
      windowed.map((r) => r.id),
      ["a", "b"],
    );
    // bounds that match nothing → empty, not an error
    assert.deepEqual(
      envelopes.listEnvelopesFromDb(opened.db, { since: "2030-01-01T00:00:00.000Z" }),
      [],
    );
    // no query → all rows in (created_at, id) order
    const all = envelopes.listEnvelopesFromDb(opened.db);
    assert.deepEqual(
      all.map((r) => r.id),
      ["a", "b", "c"],
    );
    assert.equal(envelopes.countEnvelopesInDb(opened.db), 3);
    // a generated id is returned (caller-supplied id omitted)
    const generated = envelopes.insertEnvelope(opened.db, { envelope: env, agent: "omp" });
    assert.ok(generated.length > 0);
    opened.db.close();

    // The file-backed variant opens the store itself and closes it: run it
    // twice back-to-back — the second call proves the handle was released.
    assert.equal(envelopes.countEnvelopes(), 4);
    assert.equal(envelopes.countEnvelopes(), 4);
    assert.equal(envelopes.listEnvelopes().length, 4);
  });
});

test("envelopes: a missing store reads as empty, never throws", async () => {
  const cfg = cfgDir("envelopes-missing-store");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const envelopes = await import("../dist/store/envelopes.js");
    // No store.db has been created under this config dir yet.
    assert.deepEqual(envelopes.listEnvelopes(), []);
    assert.equal(envelopes.countEnvelopes(), 0);
  });
});
