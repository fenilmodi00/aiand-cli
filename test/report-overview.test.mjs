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
    // savings = all input priced at the full rate (no-cache counterfactual):
    // (in*1.0 + out*2.0)/1e6 - billed cost — cache reads are NOT discounted
    // because the gateway already bills them cheap; savings measure what a
    // cold cache would have cost.
    const inAll = 8000 + 9000 + 7000;
    const out = 300 + 300 + 200;
    const expected = (inAll * 1.0 + out * 2.0) / 1e6 - 0.0126;
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
        "ai& overview — 2026-10-19 to 2026-10-21 (UTC) · 3 requests",
        "cost: gateway-billed · savings: estimated (catalog prices)",
        "",
        "Totals",
        "  requests                3",
        "  tokens in          24,000  (cached 11,000)",
        "  tokens out            800",
        "  cost usd          $0.0126",
        "  savings           $0.0130",
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
        "  2026-10-20         2    17,600       $0.0084       $0.0098",
        "  2026-10-21         1     7,200       $0.0042       $0.0032",
        "",
        "--------------------------------------------------------------------------------",
        "note: sync skipped (--no-sync) — showing local data as-is",
        "note: sessions are time-gap groups (10 min), not confirmed agent sessions",
        // Correlation caveat (v6 refinement): the fixture seeds no local
        // agent stores, so every row keeps its key/endpoint label.
        "note: harness refinement also reads the agents' own local usage records",
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
    // #97: meta.range stays the requested window — the month-start row is in
    // range here because --since asks for it; the budget's own month-span
    // load only kicks in when the requested window starts after the month.
    const result = await runCli(["overview", "--since", monthPrefix], { env: reportEnv(dir) });
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes("Budget"));
    assert.ok(result.stdout.includes("$0.00 of $150.00") || result.stdout.includes("150.00"));
  });

  // #97: `--last 1d` with a budget must not project a month from 24h of
  // rows — the budget section loads its own month-span rows while
  // meta.range (and every other section) keeps the requested window.
  test("budget derives month-to-date even when the requested window is narrower (#97)", async () => {
    const dir = freshDir("budget-narrow");
    const now = new Date();
    const monthPrefix = `${now.toISOString().slice(0, 7)}-01`;
    await seedStore(dir, [
      row(`${monthPrefix}T10:00:00.000Z`, { id: "m1", cost_value: 0.5, cost: "0.5" }),
      row(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), {
        id: "r1",
        cost_value: 0.25,
        cost: "0.25",
      }),
    ]);
    seedKeysAndCatalog(dir);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ budget: { monthly: 150, currency: "usd" } }),
    );
    const result = await runCli(["overview", "--last", "1d", "--json"], { env: reportEnv(dir) });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    // meta.range stays the requested window, never the widened month start.
    if (now.getUTCDate() !== 1) {
      const sinceMs = Date.parse(payload.meta.range.since);
      assert.ok(sinceMs > Date.parse(monthPrefix), "range must be the requested window");
    }
    // Month-to-date covers both rows (0.5 + 0.25), not just the window's 0.25.
    assert.ok(
      Math.abs(payload.budget.currentSpend - 0.75) < 1e-9,
      `expected month-to-date 0.75, got ${payload.budget.currentSpend}`,
    );
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
    assert.match(html, /range\s+2026-10-19\s+to\s+2026-10-21/);
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
    // #97: the window is honored verbatim — no silent month-start widening.
    const result = await runCli(["report", "--since", day, "--out", outPath], {
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

// #97 (OBS-BF-12): report and overview honor the exact requested window —
// no silent month-start widening. The three surfaces (report, overview,
// usage) must agree on the same flags.
describe("requested window honored (#97)", () => {
  test("--last 1d covers exactly the trailing 24h, agreeing with usage", async () => {
    const dir = freshDir("last-1d");
    const now = new Date();
    const inWindow = new Date(now.getTime() - 2 * 3_600_000).toISOString();
    const outside = new Date(now.getTime() - 25 * 3_600_000).toISOString();
    await seedStore(dir, [
      row(inWindow, { id: "in", cost_value: 0.01, cost: "0.01" }),
      row(outside, { id: "out", cost_value: 0.02, cost: "0.02" }),
    ]);
    const overview = await runCli(["overview", "--last", "1d", "--json"], {
      env: reportEnv(dir),
    });
    assert.equal(overview.code, 0, overview.stderr);
    const payload = JSON.parse(overview.stdout);
    assert.equal(payload.totals.requests, 1);
    assert.ok(payload.meta.range.since, "range.since present");
    const sinceMs = Date.parse(payload.meta.range.since);
    assert.ok(
      Math.abs(now.getTime() - 24 * 3_600_000 - sinceMs) < 120_000,
      `range.since ${payload.meta.range.since} is the trailing 24h`,
    );

    // Cross-surface: usage --last 1d sees the same single request. The two
    // invocations resolve `now` a second or two apart — compare with slack.
    const usage = await runCli(["usage", "--last", "1d", "--json"], { env: reportEnv(dir) });
    assert.equal(usage.code, 0, usage.stderr);
    const usagePayload = JSON.parse(usage.stdout);
    assert.equal(usagePayload.sections.totals.requests, 1);
    assert.ok(
      Math.abs(Date.parse(usagePayload.meta.range.since) - sinceMs) < 120_000,
      `usage range.since ${usagePayload.meta.range.since} agrees with overview`,
    );
  });

  test("report --last 1d JSON range metadata equals the requested window", async () => {
    const dir = freshDir("report-1d");
    const now = new Date();
    await seedStore(dir, [row(new Date(now.getTime() - 3_600_000).toISOString(), { id: "r1" })]);
    const outPath = join(dir, "r.html");
    const result = await runCli(["report", "--last", "1d", "--out", outPath, "--json"], {
      env: reportEnv(dir),
    });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const sinceMs = Date.parse(payload.meta.range.since);
    assert.ok(
      Math.abs(now.getTime() - 24 * 3_600_000 - sinceMs) < 120_000,
      `meta.range.since ${payload.meta.range.since} is the trailing 24h, not month-start`,
    );
    // The HTML footer's range label matches the requested window too.
    const html = readFileSync(outPath, "utf8");
    assert.ok(!html.includes(`range ${now.toISOString().slice(0, 7)}-01 to`));
  });

  test("explicit --since inside the month is honored verbatim on every surface", async () => {
    const dir = freshDir("since-inside");
    const now = new Date();
    const monthPrefix = now.toISOString().slice(0, 7);
    const inside = new Date(now.getTime() - 3 * 24 * 3_600_000).toISOString().slice(0, 10);
    await seedStore(dir, [
      row(new Date(now.getTime() - 3_600_000).toISOString(), {
        id: "recent",
        cost_value: 0.01,
        cost: "0.01",
      }),
      row(`${monthPrefix}-05T10:00:00.000Z`, { id: "old", cost_value: 0.02, cost: "0.02" }),
    ]);
    const expectedSince = `${inside}T00:00:00.000Z`;
    for (const [cmd, args, read] of [
      ["overview", ["overview", "--since", inside, "--json"], (p) => p],
      ["usage", ["usage", "--since", inside, "--json"], (p) => p.sections],
    ]) {
      const r = await runCli(args, { env: reportEnv(dir) });
      assert.equal(r.code, 0, `${cmd}: ${r.stderr}`);
      const payload = JSON.parse(r.stdout);
      assert.equal(payload.meta.range.since, expectedSince, `${cmd} --since verbatim`);
      assert.equal(read(payload).totals.requests, 1, `${cmd} sees only in-window rows`);
    }
    const report = await runCli(
      ["report", "--since", inside, "--out", join(dir, "r.html"), "--json"],
      { env: reportEnv(dir) },
    );
    assert.equal(report.code, 0, report.stderr);
    assert.equal(JSON.parse(report.stdout).meta.range.since, expectedSince);
  });

  test("a window crossing the month boundary still works (no regression)", async () => {
    const dir = freshDir("cross-boundary");
    await seedStore(dir, FIXTURE_ROWS); // 2026-10-20..21, pinned store rows
    const overview = await runCli(
      ["overview", "--since", "2026-09-25", "--until", "2026-10-22", "--json"],
      { env: reportEnv(dir) },
    );
    assert.equal(overview.code, 0, overview.stderr);
    const payload = JSON.parse(overview.stdout);
    assert.equal(payload.meta.range.since, "2026-09-25T00:00:00.000Z");
    assert.equal(payload.totals.requests, 3);
    assert.ok(payload.meta.range.since < "2026-10-01");
  });
});

// ---------------------------------------------------------------------------
// Shared-key attribution: `aiand init` bakes one sign-in key into several
// agents, so one masked key maps to many harnesses. By-harness must label
// that traffic "shared" — not silently credit whichever agent happened to be
// recorded first (claude) or last (codex), which is how claude's spend looked
// inflated while its By-harness row vanished entirely.
// ---------------------------------------------------------------------------
describe("shared-key attribution", () => {
  test("a masked key held by several agents buckets as shared, never claude", async () => {
    const dir = freshDir("shared-keys");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "s1" }),
      row("2026-10-20T15:00:00.000Z", { id: "s2", api_key: "sk-effg...5678" }),
    ]);
    writeFileSync(
      join(dir, "agent-keys.json"),
      JSON.stringify({
        version: 1,
        keys: [
          { agent: "claude", masked: "sk-abcd...1234", fingerprint: "f1", at: 1 },
          { agent: "codex", masked: "sk-abcd...1234", fingerprint: "f2", at: 2 },
          { agent: "opencode", masked: "sk-effg...5678", fingerprint: "f3", at: 3 },
        ],
      }),
    );
    const result = await runCli(
      ["overview", "--since", "2026-10-19", "--until", "2026-10-22", "--json"],
      { env: reportEnv(dir) },
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const harnesses = payload.byHarness.map((h) => h.harness);
    assert.ok(harnesses.includes("shared"), `by-harness rows: ${harnesses.join(", ")}`);
    assert.ok(!harnesses.includes("claude"), "shared-key rows must not credit claude");
    assert.ok(harnesses.includes("opencode"), "unambiguous keys still resolve");
    assert.equal(payload.byHarness.find((h) => h.harness === "shared").requests, 1);
  });
});

// ---------------------------------------------------------------------------
// Harness attribution must read agent-keys.json once per build, not per row.
// The dashboard's refresh() is synchronous; a per-row file read made every
// period/arrow/refresh keypress block for seconds on real stores (~2.7s for
// 2799 rows on Windows), so only the keys that skip refresh (c, q) looked
// alive. Attribution still resolves every masked key.
// ---------------------------------------------------------------------------
describe("agent-key map read once per build", () => {
  test("harness attribution scales: one file read, correct labels", async () => {
    const dir = freshDir("key-index");
    // A masked key file with one mapping; many rows hitting the same key is
    // the pathological case the dashboard hits on a real store.
    writeFileSync(
      join(dir, "agent-keys.json"),
      JSON.stringify({
        version: 1,
        keys: [{ agent: "claude", masked: "sk-abcd...1234", fingerprint: "f1", at: 1 }],
      }),
    );
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `k${i}`,
      model: "zai-org/glm-5.3",
      api_key: i % 2 === 0 ? "sk-abcd...1234" : "sk-unknown...beef",
      created_at: "2026-10-20T10:00:00.000Z",
      latency_ms: 500,
      input_tokens: 100,
      output_tokens: 10,
      cached_tokens: 0,
      cost_value: 0.001,
      currency: "usd",
    }));
    const { buildReportData } = await import("../dist/report/data.js");
    const data = await withEnv({ AIAND_CONFIG_DIR: dir }, async () =>
      buildReportData(
        {
          timezone: "UTC",
          sinceMs: Date.parse("2026-10-19T00:00:00Z"),
          untilMs: null,
          harnesses: [],
          models: [],
          sections: ["totals", "by-harness"],
          top: 5,
          sync: { skipped: true },
          now: PINNED_NOW,
        },
        () => rows,
      ),
    );
    const byHarness = Object.fromEntries(data.byHarness.map((r) => [r.harness, r.requests]));
    assert.equal(byHarness.claude, 250, "mapped rows attributed to claude");
    assert.equal(byHarness.unknown, 250, "unmapped rows attributed to unknown");
    // The build stays fast with a big store: the per-row file read is gone.
    // A generous ceiling that a per-row read of 500 entries blows past.
    const load = () => rows;
    const t0 = performance.now();
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      buildReportData(
        {
          timezone: "UTC",
          sinceMs: Date.parse("2026-10-19T00:00:00Z"),
          untilMs: null,
          harnesses: [],
          models: [],
          sections: ["totals", "by-harness"],
          top: 5,
          sync: { skipped: true },
          now: PINNED_NOW,
        },
        load,
      );
    });
    const elapsed = performance.now() - t0;
    assert.ok(
      elapsed < 500,
      `500-row build took ${Math.round(elapsed)}ms; per-row file read is back`,
    );
  });
});
