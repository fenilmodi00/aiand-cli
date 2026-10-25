import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  cliEnv,
  FakeInput,
  FakeOutput,
  runCli,
  waitFor,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

/**
 * Ticket #75 — dashboard (TUI + non-TTY fallback), heatmap, wrapped.
 * One file-level env; each test gets its own config subdir (see #64's notes
 * on withTestEnv's FILE-hook semantics).
 */

const env = withTestEnv("dash-heat-wrap", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const HOUR = 60 * 60 * 1000;
// 2026-10-19 is a Monday, 10:00 UTC — deterministic weekday/hour buckets.
const MONDAY_10 = Date.parse("2026-10-19T10:00:00.000Z");

function iso(offsetMs) {
  return new Date(MONDAY_10 + offsetMs).toISOString();
}

function row(overrides) {
  return {
    model: "zai-org/glm-5.3",
    api_key: "sk-test-claude...aaaa",
    created_at: iso(0),
    input_tokens: 1000,
    output_tokens: 100,
    cached_tokens: 500,
    cost_value: 0.01,
    currency: "usd",
    status_code: 200,
    ttft_ms: 300,
    latency_ms: 900,
    ...overrides,
  };
}

function seedRequests(db, rows) {
  const insert = db.prepare(
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
      r.latency_ms ?? null,
      r.input_tokens,
      r.output_tokens,
      r.cached_tokens,
      String(r.cost_value),
      r.cost_value,
      r.currency,
      r.created_at,
      r.created_at,
    );
  }
}

async function seedTwoHarnesses(cfg) {
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey, maskKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-0001");
  });
  const maskA = maskKey("sk-test-claude-super-secret-key-000");
  const maskB = maskKey("sk-test-opencode-super-secret-0001");
  const rows = [
    ...Array.from({ length: 6 }, (_, i) =>
      row({
        id: `a${i}`,
        api_key: maskA,
        created_at: iso(i * 60_000),
        cost_value: 0.02 + i * 0.01,
      }),
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      row({
        id: `b${i}`,
        api_key: maskB,
        created_at: iso(3 * HOUR + i * 60_000),
        input_tokens: 2000,
        cached_tokens: 100,
      }),
    ),
  ];
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    seedRequests(opened.db, rows);
    opened.db.close();
  });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Unit: responsive breakpoints + period windows
// ---------------------------------------------------------------------------

test("responsive breakpoints: 1 col under 60, 2 to 99, 3 from 100", async () => {
  const { columnsFor } = await import("../dist/commands/dashboard.js");
  assert.equal(columnsFor(59), 1);
  assert.equal(columnsFor(60), 2);
  assert.equal(columnsFor(99), 2);
  assert.equal(columnsFor(100), 3);
  assert.equal(columnsFor(240), 3);
});

test("period windows: today/month honor the timezone, lifetime is unbounded", async () => {
  const { windowForPeriod } = await import("../dist/commands/dashboard.js");
  const now = new Date("2026-10-19T18:30:00.000Z");
  const todayUtc = windowForPeriod("today", now, "UTC");
  assert.equal(new Date(todayUtc.sinceMs).toISOString(), "2026-10-19T00:00:00.000Z");
  // Tokyo is UTC+9: its "today" started 15:00Z the previous… no — 18:30Z in
  // Tokyo is 2026-10-20 03:30, so its day started 2026-10-19T15:00:00Z.
  const todayTokyo = windowForPeriod("today", now, "Asia/Tokyo");
  assert.equal(new Date(todayTokyo.sinceMs).toISOString(), "2026-10-19T15:00:00.000Z");
  const month = windowForPeriod("month", now, "UTC");
  assert.equal(new Date(month.sinceMs).toISOString(), "2026-10-01T00:00:00.000Z");
  const lifetime = windowForPeriod("lifetime", now, "UTC");
  assert.equal(lifetime.sinceMs, null);
  assert.equal(lifetime.untilMs, null);
});

// ---------------------------------------------------------------------------
// Unit: heatmap grid + color degradation
// ---------------------------------------------------------------------------

test("heatmap grid buckets by weekday x hour in the display timezone; peak label is right", async () => {
  const { buildHeatmapGrid, renderHeatmap } = await import("../dist/obs/heatmap.js");
  const rows = [
    { created_at: iso(0), cost_value: 1, currency: "usd" }, // Mon 10:00
    { created_at: iso(60_000), cost_value: 2, currency: "usd" }, // Mon 10:01
    { created_at: iso(5 * HOUR), cost_value: 5, currency: "usd" }, // Mon 15:00 — strictly the peak
  ];
  const grid = buildHeatmapGrid(rows, { metric: "cost", timezone: "UTC" });
  assert.equal(grid.grid[0][10], 3); // Mon hour 10
  assert.equal(grid.grid[0][15], 5);
  assert.equal(grid.max, 5);
  assert.deepEqual(grid.peak, { weekday: 0, hour: 15, value: 5 });
  const text = renderHeatmap(grid, "none");
  assert.ok(text.includes("Mon"), "weekday rows render");
  assert.ok(
    /peak: Mon 15:00/.test(text),
    `peak labels Monday 15:00 — got: ${text.split("\n").find((l) => l.startsWith("peak"))}`,
  );
  assert.ok(!text.includes("undefined"), "no undefined leak from the peak label");
});

test("color depth matrix and zero-ANSI plain rendering", async () => {
  const { colorDepth, bucketOf, buildHeatmapGrid, renderHeatmap } = await import(
    "../dist/obs/heatmap.js"
  );
  assert.equal(colorDepth({ NO_COLOR: "1", TERM: "xterm-256color" }), "none");
  assert.equal(colorDepth({ FORCE_COLOR: "3" }), "truecolor");
  assert.equal(colorDepth({ FORCE_COLOR: "2" }), "256");
  assert.equal(colorDepth({ FORCE_COLOR: "1" }), "16");
  assert.equal(colorDepth({ COLORTERM: "truecolor" }), "truecolor");
  assert.equal(colorDepth({ TERM: "xterm-256color" }), "256");
  assert.equal(colorDepth({}), "none");

  assert.equal(bucketOf(0, 5), 0);
  assert.equal(bucketOf(5, 5), 4);
  assert.equal(bucketOf(1, 5), 1);

  const grid = buildHeatmapGrid([{ created_at: iso(0), cost_value: 9, currency: "usd" }], {
    metric: "cost",
    timezone: "UTC",
  });
  const plain = renderHeatmap(grid, "none");
  assert.ok(!plain.includes("\x1b"), "plain depth emits zero escape codes");
  const truecolor = renderHeatmap(grid, "truecolor");
  assert.ok(truecolor.includes("\x1b[38;2;"), "truecolor ramp used");
});

// ---------------------------------------------------------------------------
// TUI: keyboard model over a seeded store (injected FakeInput/FakeOutput)
// ---------------------------------------------------------------------------

test("dashboard TUI: keys 1-6, p, c, scroll, and quit; top-5 stays pinned", async () => {
  const cfg = cfgDir("tui");
  await seedTwoHarnesses(cfg);
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { runDashboardUi } = await import("../dist/commands/dashboard.js");
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 110;
    output.rows = 40;
    const done = runDashboardUi({
      input,
      output,
      timezone: "UTC",
      models: [],
      initialHarness: null,
      showCost: true,
      refreshMs: 60_000,
      sync: { skipped: true },
      now: new Date(MONDAY_10 + 8 * HOUR),
    });
    try {
      await waitFor(() => output.text.includes("ai& dashboard"));
    } catch (waitError) {
      console.error("TUI-DEBUG text:", JSON.stringify(output.text.slice(0, 200)));
      throw waitError;
    }
    assert.ok(output.text.includes("Top 5 sessions (pinned)"), "pinned block present");

    input.send("3"); // 30d
    await waitFor(() => output.text.includes("[3 30d]"), 5000, "tab [3 30d] after key 3");
    input.send("\x1b[B"); // arrow down: 30d → Month
    await waitFor(() => output.text.includes("[4 Month]"), 5000, "tab [4 Month] after arrow-down");
    input.send("\x1b[A"); // arrow up: Month → 30d
    await waitFor(() => output.text.includes("[3 30d]"), 5000, "tab [3 30d] after arrow-up");
    input.send("p"); // cycle harness scope
    await waitFor(() => /· (claude|opencode) ·/.test(output.text), 5000, "harness scope after p");
    input.send("c"); // compare view
    await waitFor(() => output.text.includes("Harness compare"), 5000, "compare view after c");
    input.send("j"); // scroll the per-day list (no-op in compare, must not throw)
    // The pinned top-5 block is present in every view we passed through.
    assert.ok(output.text.includes("Top 5 sessions (pinned)"));
    input.send("q");
    await done;
    assert.ok(output.text.length > 0);
  });
});

// ---------------------------------------------------------------------------
// CLI: non-TTY fallback, heatmap, wrapped (seeded + empty stores)
// ---------------------------------------------------------------------------

test("dashboard non-TTY prints the plain-text overview and exits", async () => {
  const cfg = cfgDir("nontty");
  const rows = await seedTwoHarnesses(cfg);
  assert.ok(rows > 0);
  const { code, stdout } = await runCli(["dashboard", "--no-sync", "--last", "30d"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes("ai&"), "overview header renders");
  assert.ok(!stdout.includes("\x1b[?25"), "no TUI cursor control on a pipe");
});

test("dashboard with an empty store: overview empty-state, exit 0", async () => {
  const cfg = cfgDir("empty-dash");
  const { code, stdout } = await runCli(["dashboard", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes("ai&"));
});

test("heatmap CLI: weekday grid, requests metric, forced plain output", async () => {
  const cfg = cfgDir("heat");
  await seedTwoHarnesses(cfg);
  const { code, stdout } = await runCli(
    ["heatmap", "--no-sync", "--metric", "requests", "--last", "30d"],
    { env: cliEnv({ AIAND_CONFIG_DIR: cfg, FORCE_COLOR: "0" }) },
  );
  assert.equal(code, 0);
  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
    assert.ok(stdout.includes(day), `row ${day} renders`);
  }
  assert.ok(!stdout.includes("\x1b"), "forced plain: zero escape codes");

  const empty = cfgDir("heat-empty");
  const none = await runCli(["heatmap", "--no-sync"], { env: cliEnv({ AIAND_CONFIG_DIR: empty }) });
  assert.equal(none.code, 0);
  assert.ok(none.stdout.includes("no activity"), "empty state renders");
});

test("wrapped CLI: story elements, provenance footer, markdown, no-cost, empty store", async () => {
  const cfg = cfgDir("wrapped");
  await seedTwoHarnesses(cfg);
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  const text = await runCli(["wrapped", "--no-sync", "--last", "30d"], base);
  assert.equal(text.code, 0);
  assert.ok(text.stdout.includes("12 requests"), "request count in the story");
  assert.ok(text.stdout.includes("time-gap session"), "session count + heuristic naming");
  assert.ok(text.stdout.includes("Biggest session"), "biggest session line");
  assert.ok(text.stdout.includes("Busiest day"), "busiest day line");
  assert.ok(text.stdout.includes("gateway-billed"), "provenance footer present");

  const md = await runCli(["wrapped", "--no-sync", "--last", "30d", "--format", "markdown"], base);
  assert.equal(md.code, 0);
  assert.ok(md.stdout.includes("## ai& wrapped"), "markdown heading");

  const noCost = await runCli(["wrapped", "--no-sync", "--last", "30d", "--no-cost"], base);
  assert.equal(noCost.code, 0);
  assert.ok(!noCost.stdout.includes("Spend:"), "money masked with --no-cost");
  assert.ok(noCost.stdout.includes("requests"), "story structure kept");

  const story = await runCli(["wrapped", "--no-sync", "--last", "30d", "--json"], base);
  assert.equal(story.code, 0);
  const parsed = JSON.parse(story.stdout);
  assert.equal(parsed.requests, 12);
  assert.ok(parsed.provenance);

  const empty = cfgDir("wrapped-empty");
  const none = await runCli(["wrapped", "--no-sync"], { env: cliEnv({ AIAND_CONFIG_DIR: empty }) });
  assert.equal(none.code, 0);
  assert.ok(none.stdout.includes("No activity"), "empty state renders");
});
