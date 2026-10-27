import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

// OBS-P2-3 (#76): the offline HTML report (`aiand report`) and the plain-text
// `aiand overview`. Golden text/HTML snapshots run against a directly-seeded
// local store with a pinned clock; CLI tests assert the output contracts
// (zero ANSI on pipe, no external URLs in the HTML, section selection,
// budget omission, --open best-effort) without any network.

const box = withTestEnv("aiand-report-overview-", () => {
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

// -- fixtures -----------------------------------------------------------------

let rowSeq = 0;
/** A verbatim store row at a fixed UTC instant (deterministic day buckets). */
function row(createdAt, overrides = {}) {
  rowSeq += 1;
  return {
    id: `row-${String(rowSeq).padStart(3, "0")}`,
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
    created_at: createdAt,
    ...overrides,
  };
}

/** Seed the store directly (offline — no sync engine, no gateway). */
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

/** Map masked keys to harnesses and cache a model catalog (for savings). */
function seedKeysAndCatalog(dir) {
  writeFileSync(
    join(dir, "agent-keys.json"),
    JSON.stringify({
      version: 1,
      keys: [
        { agent: "claude", masked: "sk-abcd...1234", fingerprint: "f1", at: 1 },
        { agent: "opencode", masked: "sk-effg...5678", fingerprint: "f2", at: 2 },
      ],
    }),
  );
  writeFileSync(
    join(dir, "model-catalog.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://api.aiand.com",
      models: [
        {
          id: "zai-org/glm-5.3",
          currency: "usd",
          input_per_1m: "1.0",
          output_per_1m: "2.0",
          cached_input_per_1m: "0.1",
          capabilities: [],
        },
      ],
    }),
  );
}

/** Two days, two harnesses, one model — the golden-fixture store. */
const FIXTURE_ROWS = [
  row("2026-10-20T10:00:00.000Z", {
    id: "c1",
    input_tokens: 8000,
    output_tokens: 300,
    cached_tokens: 4000,
  }),
  row("2026-10-20T15:00:00.000Z", {
    id: "c2",
    input_tokens: 9000,
    output_tokens: 300,
    cached_tokens: 4000,
  }),
  row("2026-10-21T09:00:00.000Z", {
    id: "o1",
    api_key: "sk-effg...5678",
    input_tokens: 7000,
    output_tokens: 200,
    cached_tokens: 3000,
  }),
];

const PINNED_NOW = new Date("2026-10-22T12:00:00.000Z");

const reportEnv = (dir) =>
  cliEnv({
    AIAND_CONFIG_DIR: dir,
    AIAND_NO_SYNC: "1",
    NO_COLOR: "1",
    CI: "1",
  });

// -- shared data build (direct import, pinned clock) ---------------------------

async function buildFixtureData(dir, overrides = {}) {
  const { buildReportData } = await import("../dist/report/data.js");
  const load = () =>
    FIXTURE_ROWS.map((r) => ({
      id: r.id,
      model: r.model,
      api_key: r.api_key,
      created_at: r.created_at,
      latency_ms: r.latency_ms,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cached_tokens: r.cached_tokens,
      cost_value: r.cost_value,
      currency: r.currency,
    }));
  seedKeysAndCatalog(dir);
  return withEnv({ AIAND_CONFIG_DIR: dir }, async () =>
    buildReportData(
      {
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: [
          "timeseries",
          "matrix",
          "sessions",
          "budget",
          "totals",
          "by-harness",
          "models",
          "busiest",
          "daily",
        ],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
        ...overrides,
      },
      load,
    ),
  );
}

describe("report data (one load, many sections)", () => {
  test("a single store load feeds every section", async () => {
    const { buildReportData } = await import("../dist/report/data.js");
    let calls = 0;
    const countingLoad = (window) => {
      calls += 1;
      assert.equal(window.sinceMs, Date.parse("2026-10-19T00:00:00Z"));
      return [];
    };
    const data = buildReportData(
      {
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: null,
        harnesses: [],
        models: [],
        sections: ["timeseries", "matrix", "sessions"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      },
      countingLoad,
    );
    assert.equal(calls, 1);
    assert.equal(data.meta.rowCount, 0);
  });

  test("aggregations are per-currency, savings estimated, sessions heuristic", async () => {
    const dir = freshDir("agg");
    const data = await buildFixtureData(dir);
    assert.equal(data.meta.rowCount, 3);
    assert.equal(data.meta.currencyHandling, "single");
    assert.equal(data.meta.currency, "usd");
    assert.equal(data.totals.requests, 3);
    assert.deepEqual(data.totals.costs, { usd: 0.0126 });
    // savings = (uncached*1.0 + cached*0.1 + out*2.0)/1e6 - billed cost
    const uncachedIn = 8000 - 4000 + (9000 - 4000) + (7000 - 3000);
    const cached = 4000 + 4000 + 3000;
    const out = 300 + 300 + 200;
    const expected = (uncachedIn * 1.0 + cached * 0.1 + out * 2.0) / 1e6 - 0.0126;
    assert.ok(Math.abs(data.totals.savings - expected) < 1e-9);
    assert.match(data.meta.provenance.savings, /^estimated\(/);
    assert.match(data.meta.provenance.sessions, /^heuristic\(/);
    // by harness: claude 2 rows, opencode 1
    const claude = data.byHarness.find((h) => h.harness === "claude");
    const opencode = data.byHarness.find((h) => h.harness === "opencode");
    assert.equal(claude.requests, 2);
    assert.equal(opencode.requests, 1);
    assert.ok(Math.abs(claude.share - 2 / 3) < 1e-9);
    // matrix verdicts + hit ratios
    assert.equal(data.matrix.length, 2);
    for (const entry of data.matrix) {
      assert.equal(entry.verdict, "warn"); // < 5 requests
      assert.ok(entry.hitRatio > 0 && entry.hitRatio < 1);
    }
    // sessions from the #66 sessionizer, ranked by cost (2 claude groups + 1 opencode)
    assert.equal(data.sessions.length, 3);
    for (let i = 1; i < data.sessions.length; i++) {
      assert.ok((data.sessions[i - 1].cost ?? 0) >= (data.sessions[i].cost ?? 0));
    }
  });

  test("mixed currencies are never summed; savings refuse to compute", async () => {
    const dir = freshDir("mixed");
    seedKeysAndCatalog(dir);
    const { buildReportData } = await import("../dist/report/data.js");
    const load = () => [
      row("2026-10-20T10:00:00.000Z", { id: "a", currency: "usd", cost_value: 0.01 }),
      row("2026-10-20T11:00:00.000Z", { id: "b", currency: "jpy", cost_value: 1 }),
    ];
    const data = await withEnv({ AIAND_CONFIG_DIR: dir }, () =>
      buildReportData(
        {
          timezone: "UTC",
          sinceMs: null,
          untilMs: null,
          harnesses: [],
          models: [],
          sections: ["totals", "timeseries"],
          top: 20,
          sync: null,
          now: PINNED_NOW,
        },
        load,
      ),
    );
    assert.equal(data.meta.currencyHandling, "mixed");
    assert.equal(data.meta.currency, null);
    assert.equal(data.totals.savings, null);
    assert.match(data.meta.savingsNote, /never summed/);
  });

  test("missing cached catalog drops savings with a note, never guesses", async () => {
    const dir = freshDir("no-catalog");
    const { buildReportData } = await import("../dist/report/data.js");
    const load = () => [row("2026-10-20T10:00:00.000Z", { id: "a" })];
    const data = await withEnv({ AIAND_CONFIG_DIR: dir }, () =>
      buildReportData(
        {
          timezone: "UTC",
          sinceMs: null,
          untilMs: null,
          harnesses: [],
          models: [],
          sections: ["totals"],
          top: 20,
          sync: null,
          now: PINNED_NOW,
        },
        load,
      ),
    );
    assert.equal(data.totals.savings, null);
    assert.match(data.meta.savingsNote, /no cached model catalog/);
  });
});

describe("overview text", () => {
  test("golden snapshot on the seeded fixture", async () => {
    const dir = freshDir("golden-overview");
    const data = await buildFixtureData(dir);
    const { renderOverviewText } = await import("../dist/report/overview.js");
    const text = renderOverviewText(data, {
      showCost: true,
      sections: ["totals", "by-harness", "models", "busiest", "daily", "budget"],
    });
    assert.equal(
      text,
      [
        "ai& overview — 2026-10-01 to 2026-10-21 (UTC) · 3 requests",
        "cost: gateway-billed · savings: estimated (catalog prices)",
        "",
        "Totals",
        "  requests                3",
        "  tokens in          24,000  (cached 11,000)",
        "  tokens out            800",
        "  cost usd          $0.0126",
        "  savings           $0.0031",
        "",
        "By harness",
        "  claude       █████████████·······  67%  $0.0084",
        "  opencode     ███████·············  33%  $0.0042",
        "",
        "Top models (by cost, top 5)",
        "  zai-org/glm-5.3                   3  $0.0126",
        "",
        "Busiest days (by cost)",
        "  2026-10-20       2  $0.0084",
        "  2026-10-21       1  $0.0042",
        "",
        "Per day (last 2 of 2 day(s))",
        "  date        requests    tokens          cost       savings",
        "  2026-10-20         2    17,600       $0.0084       $0.0026",
        "  2026-10-21         1     7,200       $0.0042       $0.0005",
        "",
        "--------------------------------------------------------------------------------",
        "note: sync skipped (--no-sync) — showing local data as-is",
        "note: sessions are time-gap groups (10 min), not confirmed agent sessions",
      ].join("\n"),
    );
    for (const line of text.split("\n")) {
      assert.ok(line.length <= 80, `line over 80 cols: ${line}`);
    }
  });

  test("piped CLI output has zero ANSI escapes and the full layout", async () => {
    const dir = freshDir("pipe");
    await seedStore(dir, FIXTURE_ROWS);
    seedKeysAndCatalog(dir);
    const result = await runCli(["overview", "--since", "2026-10-19", "--until", "2026-10-22"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir, AIAND_NO_SYNC: "1", CI: "1" }),
    });
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.includes("\x1b"), "piped overview must contain no ANSI escapes");
    for (const marker of ["Totals", "By harness", "Top models", "Busiest days", "Per day"]) {
      assert.ok(result.stdout.includes(marker), `missing section: ${marker}`);
    }
  });

  test("--no-cost masks monetary figures", async () => {
    const dir = freshDir("no-cost");
    await seedStore(dir, FIXTURE_ROWS);
    seedKeysAndCatalog(dir);
    const result = await runCli(
      ["overview", "--since", "2026-10-19", "--until", "2026-10-22", "--no-cost"],
      {
        env: reportEnv(dir),
      },
    );
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.includes("$"), "no monetary figures expected");
  });

  test("--sections selects subsets and --json is machine-readable", async () => {
    const dir = freshDir("sections");
    await seedStore(dir, FIXTURE_ROWS);
    seedKeysAndCatalog(dir);
    const subset = await runCli(
      ["overview", "--since", "2026-10-19", "--until", "2026-10-22", "--sections", "totals,budget"],
      { env: reportEnv(dir) },
    );
    assert.equal(subset.code, 0);
    assert.ok(subset.stdout.includes("Totals"));
    assert.ok(!subset.stdout.includes("By harness"));

    const js = await runCli(
      ["overview", "--since", "2026-10-19", "--until", "2026-10-22", "--json"],
      {
        env: reportEnv(dir),
      },
    );
    assert.equal(js.code, 0);
    const payload = JSON.parse(js.stdout);
    assert.ok(payload.meta.provenance.cost);
    assert.equal(payload.totals.requests, 3);
    assert.ok(Array.isArray(payload.byHarness));
    assert.ok(Array.isArray(payload.topModels));
    assert.ok(Array.isArray(payload.busiestDays));
    assert.ok(Array.isArray(payload.daily));
    assert.equal(payload.budget.configured, false);
  });

  // #99: report --json carries a totals block matching the HTML's numbers.
  test("report --json includes totals matching the HTML (#99)", async () => {
    const dir = freshDir("report-json-totals");
    await seedStore(dir, FIXTURE_ROWS);
    seedKeysAndCatalog(dir);
    const outPath = join(dir, "report.html");
    const result = await runCli(
      ["report", "--since", "2026-10-19", "--until", "2026-10-22", "--out", outPath, "--json"],
      { env: reportEnv(dir) },
    );
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.totals);
    assert.equal(payload.totals.requests, 3);
    assert.equal(payload.totals.inputTokens, 24000);
    assert.equal(payload.totals.outputTokens, 800);
    assert.equal(payload.totals.cachedTokens, 11000);
    assert.deepEqual(payload.totals.costs, { usd: 0.0126 });
    assert.ok(typeof payload.totals.savings === "number" && payload.totals.savings > 0);

    // --no-cost masks monetary fields in the totals block too.
    const masked = await runCli(
      ["report", "--since", "2026-10-19", "--until", "2026-10-22", "--no-cost", "--json"],
      { env: reportEnv(dir) },
    );
    const maskedPayload = JSON.parse(masked.stdout);
    assert.equal(maskedPayload.totals.requests, 3);
    assert.ok(!("costs" in maskedPayload.totals));
    assert.ok(!("savings" in maskedPayload.totals));
  });

  test("budget section renders pacing when configured", async () => {
    const dir = freshDir("budget");
    const now = new Date();
    const monthPrefix = `${now.toISOString().slice(0, 7)}-01`;
    await seedStore(dir, [
      row(`${monthPrefix}T10:00:00.000Z`, { id: "m1", cost_value: 0.0042, cost: "0.0042" }),
    ]);
    seedKeysAndCatalog(dir);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ budget: { monthly: 150, currency: "usd" } }),
    );
    const result = await runCli(["overview", "--last", "1d"], { env: reportEnv(dir) });
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes("Budget"));
    assert.ok(result.stdout.includes("$0.00 of $150.00") || result.stdout.includes("150.00"));
  });
});

describe("offline HTML report", () => {
  test("one self-contained file: sections render, no external URLs", async () => {
    const dir = freshDir("html");
    await seedStore(dir, FIXTURE_ROWS);
    seedKeysAndCatalog(dir);
    const outPath = join(dir, "report.html");
    const result = await runCli(
      ["report", "--since", "2026-10-19", "--until", "2026-10-22", "--out", outPath],
      { env: reportEnv(dir) },
    );
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes(outPath));
    const html = readFileSync(outPath, "utf8");
    assert.ok(html.startsWith("<!doctype html>"));
    // zero external requests: no http(s):// anywhere, no script tags, one style block
    assert.ok(!html.includes("http://") && !html.includes("https://"));
    assert.ok(!html.includes("<script"));
    assert.equal(html.split("<style>").length, 2);
    for (const id of ["timeseries", "matrix", "sessions"]) {
      assert.ok(html.includes(`id="${id}"`), `missing section ${id}`);
    }
    // provenance badges on monetary figures + footer legend
    assert.ok(html.includes("badge"));
    assert.ok(html.includes("gateway-billed"));
    // inline SVG charts with axes and legend
    assert.ok(html.includes("<svg"));
    assert.ok(html.includes("legend"));
    // budget section: present with a clean no-config note
    assert.ok(html.includes('id="budget"'));
    assert.ok(html.includes("No budget configured"));
  });

  test("golden structural snapshot on the seeded fixture", async () => {
    const dir = freshDir("html-golden");
    const data = await buildFixtureData(dir);
    const { renderHtml } = await import("../dist/report/render-html.js");
    const html = renderHtml(data, {
      theme: "light",
      showCost: true,
      sections: ["timeseries", "matrix", "sessions", "budget"],
    });
    assert.ok(html.includes('class="theme-light"'));
    assert.ok(html.includes("Generated 2026-10-22 12:00:00Z"));
    assert.match(html, /range\s+2026-10-01\s+to\s+2026-10-21/);
    assert.ok(html.includes("3 requests"));
    // chart series: one per harness cost line + cumulative savings
    assert.ok(html.includes("claude</span>"));
    assert.ok(html.includes("opencode</span>"));
    assert.ok(html.includes("Cumulative savings"));
    // matrix rows carry verdicts, sessions table carries the #66 note
    assert.ok(html.includes("verdict-warn"));
    assert.ok(html.includes("inactivity gap"));
    assert.ok(html.includes("heuristic"));
    // theme auto rides prefers-color-scheme
    const auto = renderHtml(data, { theme: "auto", showCost: true, sections: ["timeseries"] });
    assert.ok(auto.includes("prefers-color-scheme"));
  });

  test("--sections selects subsets; --theme dark switches the body class", async () => {
    const dir = freshDir("html-sections");
    await seedStore(dir, FIXTURE_ROWS);
    seedKeysAndCatalog(dir);
    const outPath = join(dir, "matrix-only.html");
    const result = await runCli(
      [
        "report",
        "--since",
        "2026-10-19",
        "--until",
        "2026-10-22",
        "--sections",
        "matrix",
        "--theme",
        "dark",
        "--out",
        outPath,
      ],
      { env: reportEnv(dir) },
    );
    assert.equal(result.code, 0);
    const html = readFileSync(outPath, "utf8");
    assert.ok(html.includes('id="matrix"'));
    assert.ok(!html.includes('id="timeseries"'));
    assert.ok(!html.includes('id="sessions"'));
    assert.ok(html.includes('class="theme-dark"'));
  });

  test("budget section shows pacing when a budget is configured", async () => {
    const dir = freshDir("html-budget");
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    await seedStore(dir, [row(`${day}T10:00:00.000Z`, { id: "m1" })]);
    seedKeysAndCatalog(dir);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ budget: { monthly: 150, currency: "usd" } }),
    );
    const outPath = join(dir, "budget.html");
    const result = await runCli(["report", "--last", "1d", "--out", outPath], {
      env: reportEnv(dir),
    });
    assert.equal(result.code, 0);
    const html = readFileSync(outPath, "utf8");
    assert.ok(html.includes("Month to date"));
    assert.ok(html.includes("$150.00"));
  });

  test("--open best-effort: no browser under AIAND_NO_BROWSER, command still succeeds", async () => {
    const dir = freshDir("open");
    await seedStore(dir, FIXTURE_ROWS);
    seedKeysAndCatalog(dir);
    const outPath = join(dir, "opened.html");
    // test/setup.mjs sets AIAND_NO_BROWSER=1: openBrowser resolves false, prints the path
    const result = await runCli(
      ["report", "--since", "2026-10-19", "--until", "2026-10-22", "--out", outPath, "--open"],
      {
        env: reportEnv(dir),
      },
    );
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes(outPath));
    assert.ok(readFileSync(outPath, "utf8").startsWith("<!doctype html>"));
  });

  test("default output name lands in --out-dir with a timestamped name", async () => {
    const dir = freshDir("outdir");
    await seedStore(dir, FIXTURE_ROWS);
    seedKeysAndCatalog(dir);
    const outDir = freshDir("outdir-target");
    const result = await runCli(
      ["report", "--since", "2026-10-19", "--until", "2026-10-22", "--out-dir", outDir],
      {
        env: reportEnv(dir),
      },
    );
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes(outDir));
    assert.match(result.stdout, /aiand-report-\d{8}-\d{6}\.html/);
  });

  test("sync failure is surfaced on stderr, never blocks the report", async () => {
    const dir = freshDir("sync-fail");
    await seedStore(dir, FIXTURE_ROWS);
    seedKeysAndCatalog(dir);
    const result = await runCli(
      ["report", "--since", "2026-10-19", "--until", "2026-10-22", "--out", join(dir, "r.html")],
      {
        env: cliEnv({
          AIAND_CONFIG_DIR: dir,
          AIAND_BASE_URL: "http://127.0.0.1:9",
          AIAND_API_KEY: "sk-test",
          NO_COLOR: "1",
          CI: "1",
        }),
      },
    );
    assert.equal(result.code, 0);
    assert.ok(result.stderr.includes("sync failed"));
    assert.ok(readFileSync(join(dir, "r.html"), "utf8").includes("store sync: failed"));
  });

  // #91: overview's pre-read sync arms — a dead gateway warns and the
  // summary still renders local rows (the sync arm its tests never hit).
  test("overview: dead-gateway sync warns and the summary still renders (#91)", async () => {
    const dir = freshDir("overview-sync-fail");
    await seedStore(dir, FIXTURE_ROWS);
    seedKeysAndCatalog(dir);
    const result = await runCli(["overview", "--since", "2026-10-19", "--until", "2026-10-22"], {
      env: cliEnv({
        AIAND_CONFIG_DIR: dir,
        AIAND_BASE_URL: "http://127.0.0.1:9",
        AIAND_API_KEY: "sk-test",
        NO_COLOR: "1",
        CI: "1",
      }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stderr.includes("sync failed"));
    assert.ok(result.stdout.includes("Totals"), "local summary still renders");
  });
});
