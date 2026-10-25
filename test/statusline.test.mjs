import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { withTestEnv } from "./helpers.mjs";

// OBS-P2-1 (#71): the statusline computation, line render, verdict→exit-code
// contract, and staleness — unit-level, against a seeded local store.

const box = withTestEnv("aiand-statusline-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  delete process.env.AIAND_NO_SYNC;
});

const mod = () => import("../dist/obs/statusline.js");
const budgetMod = () => import("../dist/obs/budget.js");

/** Pinned "now": 2026-10-15T12:00Z — mid-month, mid-UTC-day. */
const NOW_MS = Date.UTC(2026, 9, 15, 12, 0, 0);
const HOUR_MS = 3_600_000;

async function seedRequests(rows) {
  mkdirSync(box.dir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const { MIGRATIONS } = await import("../dist/store/migrations/index.js");
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(join(box.dir, `store.db${suffix}`), { force: true });
  }
  const db = new DatabaseSync(join(box.dir, "store.db"));
  try {
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, " +
        "latency_ms, input_tokens, output_tokens, cached_tokens, cost, cost_value, " +
        "currency, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    rows.forEach((r, i) => {
      insert.run(
        r.id ?? `sl-${i}`,
        "test/model",
        r.api_key ?? "sk-abcd...1234",
        200,
        r.ttft_ms ?? 120,
        r.latency_ms ?? null,
        1000,
        300,
        400,
        String(r.cost),
        r.cost,
        r.currency ?? "usd",
        r.created_at,
        new Date(NOW_MS).toISOString(),
      );
    });
  } finally {
    db.close();
  }
}

/** A store row `hoursAgo` before NOW. */
const row = (hoursAgo, cost, overrides = {}) => ({
  created_at: new Date(NOW_MS - hoursAgo * HOUR_MS).toISOString(),
  cost,
  ...overrides,
});

// -- pure pieces ----------------------------------------------------------------

describe("statusline pure pieces", () => {
  test("p50 is the nearest-rank median; empty sample is null", async () => {
    const { p50 } = await mod();
    assert.equal(p50([]), null);
    assert.equal(p50([5]), 5);
    assert.equal(p50([4, 1, 3, 2]), 2); // ceil(0.5*4)-1 = index 1 of sorted [1,2,3,4]
    assert.equal(p50([10, 20]), 10); // ceil(0.5*2)-1 = index 0
  });

  test("statusExitCode maps the G5 contract", async () => {
    const { statusExitCode } = await mod();
    assert.equal(statusExitCode("ok"), 0);
    assert.equal(statusExitCode("near-limit"), 10);
    assert.equal(statusExitCode("limit-hit"), 11);
    assert.equal(statusExitCode("indeterminate"), 20);
    assert.equal(statusExitCode("no-data"), 30);
  });

  test("renderLine: no-data renders one plain, actionable line", async () => {
    const { renderLine } = await mod();
    const { SCHEMA_VERSION } = await mod();
    assert.equal(SCHEMA_VERSION, 1);
    const line = renderLine({
      schema_version: 1,
      generated_at: "",
      source: "aiand status",
      spend: { session: null, today: null, currency: null },
      burn: { per_hour: null, currency: null },
      budget: null,
      verdict: "no-data",
      ttft: { p50_ms: null },
      stale: false,
      provenance: {
        spend: "",
        session: "",
        burn: "",
        budget_projected_pct: "",
        ttft: "",
      },
    });
    assert.match(line, /no data yet/);
    assert.ok(!line.includes("\n"));
  });

  test("renderLine: spend/rate/pacing/ttft segments, stale suffix when stale", async () => {
    const { renderLine } = await mod();
    const base = {
      schema_version: 1,
      generated_at: "",
      source: "aiand status",
      spend: { session: 2.1, today: 8.4, currency: "usd" },
      burn: { per_hour: 1.85, currency: "usd" },
      budget: { monthly: 150, used: 8.4, remaining: 141.6, projected_pct: 72.4 },
      verdict: "ok",
      ttft: { p50_ms: 320.4 },
      stale: false,
      provenance: {
        spend: "gateway-billed",
        session: "heuristic(time-gap sessionization (session boundary only))",
        burn: "heuristic(burn-rate v1)",
        budget_projected_pct: "heuristic(burn-rate v1)",
        ttft: "gateway-billed",
      },
    };
    const line = renderLine(base);
    assert.ok(
      line.startsWith(
        "💰 $2.10 session / $8.40 today | 🔥 $1.85/hr 🟢 | 5%→72% of budget | ttft p50 320ms",
      ),
      line,
    );
    const staleLine = renderLine(
      { ...base, stale: true },
      new Date(Date.UTC(2026, 9, 15, 11, 30, 0)),
    );
    assert.match(staleLine, / · stale \d\d:\d\d$/);
  });

  test("renderLine: verdict glyphs and no pacing without a budget", async () => {
    const { renderLine, verdictGlyph } = await mod();
    const base = {
      schema_version: 1,
      generated_at: "",
      source: "aiand status",
      spend: { session: null, today: 1, currency: "usd" },
      burn: { per_hour: null, currency: "usd" },
      budget: null,
      verdict: "ok",
      ttft: { p50_ms: null },
      stale: false,
      provenance: { spend: "", session: "", burn: "", budget_projected_pct: "", ttft: "" },
    };
    const line = renderLine(base);
    assert.equal(line, "💰 – session / $1.00 today | 🔥 indeterminate 🟢");
    assert.equal(verdictGlyph("near-limit"), "🟡");
    assert.equal(verdictGlyph("limit-hit"), "🔴");
  });
});

// -- computed from the store ------------------------------------------------------

describe("computeStatusline", () => {
  test("empty (missing) store → no-data verdict, exit 30, spend nulls", async () => {
    const { computeStatusline } = await mod();
    rmSync(join(box.dir, "store.db"), { force: true });
    const result = computeStatusline({ now: new Date(NOW_MS) });
    assert.equal(result.snapshot.verdict, "no-data");
    assert.equal(result.exitCode, 30);
    assert.equal(result.snapshot.spend.today, null);
    assert.equal(result.snapshot.budget, null);
    assert.match(result.line, /no data yet/);
  });

  test("spend, session, burn rate, ttft p50, provenance — no budget → ok / exit 0", async () => {
    const { computeStatusline } = await mod();
    // Two rows 1min apart: one session, both in today's UTC window.
    await seedRequests([row(1, 1.0, { ttft_ms: 100 }), row(1 + 1 / 60, 2.0, { ttft_ms: 300 })]);
    const result = computeStatusline({
      now: new Date(NOW_MS),
      staleThresholdMs: 365 * 24 * HOUR_MS,
    });
    assert.equal(result.snapshot.verdict, "ok");
    assert.equal(result.exitCode, 0);
    assert.equal(result.snapshot.spend.session, 3.0); // one gap session, gateway-billed sum
    assert.equal(result.snapshot.spend.today, 3.0);
    assert.equal(result.snapshot.spend.currency, "usd");
    // 1h+1min of span is under the 2h floor: no rate is fabricated.
    assert.equal(result.snapshot.burn.per_hour, null);
    assert.match(result.snapshot.provenance.burn, /^heuristic\(burn-rate v1\)$/);
    assert.equal(result.snapshot.ttft.p50_ms, 100); // nearest-rank p50 of [100, 300]
    // Seeded rows carry no sync watermark → stale regardless of the threshold
    // (the dedicated staleness test below pins both sides of that rule).
    assert.equal(result.snapshot.stale, true);
    assert.equal(result.snapshot.provenance.spend, "gateway-billed");
    assert.match(result.snapshot.provenance.session, /^heuristic\(time-gap/);
    assert.ok(result.snapshot.budget === null);
    assert.match(result.line, /💰 \$3\.00 session \/ \$3\.00 today/);
    assert.match(result.line, /🔥 indeterminate/);
    assert.ok(!result.line.includes("of budget"));
    assert.match(result.line, /ttft p50 100ms/);
  });

  test("burn rate = attributed spend over the full 24h window once 2h+ of span exist", async () => {
    const { computeStatusline } = await mod();
    await seedRequests([row(1, 1.0), row(3, 2.0)]);
    const result = computeStatusline({
      now: new Date(NOW_MS),
      staleThresholdMs: 365 * 24 * HOUR_MS,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.snapshot.burn.per_hour, 3.0 / 24);
    assert.match(result.line, /🔥 \$0\.13\/hr 🟢/);
  });

  test("budget set, spend under the threshold → ok / exit 0, pacing segment present", async () => {
    const { computeStatusline } = await mod();
    const budget = await budgetMod();
    await budget.setBudgetMonthly(150, "usd");
    await seedRequests([row(1, 1.0), row(3, 2.0)]);
    const result = computeStatusline({
      now: new Date(NOW_MS),
      staleThresholdMs: 365 * 24 * HOUR_MS,
    });
    assert.equal(result.snapshot.verdict, "ok");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.snapshot.budget, {
      monthly: 150,
      used: 3,
      remaining: 147,
      projected_pct: result.snapshot.budget.projected_pct,
    });
    assert.match(result.line, /\d+%→\d+% of budget/);
    await budget.unsetBudgetKey("budget.monthly");
  });

  test("budget 80–99% used → near-limit / exit 10", async () => {
    const { computeStatusline } = await mod();
    const budget = await budgetMod();
    await budget.setBudgetMonthly(10, "usd");
    // $8.70 of $10 = 87%, with enough span (3h) for a trustworthy rate.
    await seedRequests([row(1, 6.7), row(3, 2.0)]);
    const result = computeStatusline({
      now: new Date(NOW_MS),
      staleThresholdMs: 365 * 24 * HOUR_MS,
    });
    assert.equal(result.snapshot.verdict, "near-limit");
    assert.equal(result.exitCode, 10);
    await budget.unsetBudgetKey("budget.monthly");
  });

  test("projected to exceed → near-limit / exit 10 even under 80% today", async () => {
    const { computeStatusline } = await mod();
    const budget = await budgetMod();
    // $3 spent, rate $1/h projected to $279 by month end (31d × 24h − elapsed),
    // far past $10: near-limit despite only 30% used.
    await budget.setBudgetMonthly(10, "usd");
    await seedRequests([row(1, 1.0), row(3, 2.0)]);
    const result = computeStatusline({
      now: new Date(NOW_MS),
      staleThresholdMs: 365 * 24 * HOUR_MS,
    });
    assert.equal(result.snapshot.verdict, "near-limit");
    assert.equal(result.exitCode, 10);
    await budget.unsetBudgetKey("budget.monthly");
  });

  test("budget ≥100% used → limit-hit / exit 11", async () => {
    const { computeStatusline } = await mod();
    const budget = await budgetMod();
    await budget.setBudgetMonthly(1, "usd");
    await seedRequests([row(1, 100), row(3, 100)]);
    const result = computeStatusline({
      now: new Date(NOW_MS),
      staleThresholdMs: 365 * 24 * HOUR_MS,
    });
    assert.equal(result.snapshot.verdict, "limit-hit");
    assert.equal(result.exitCode, 11);
    await budget.unsetBudgetKey("budget.monthly");
  });

  test("budget set but too little history for a rate → indeterminate / exit 20", async () => {
    const { computeStatusline } = await mod();
    const budget = await budgetMod();
    await budget.setBudgetMonthly(150, "usd");
    // A single point 30min ago: < 2h of span, no trustworthy rate.
    await seedRequests([row(0.5, 1.0)]);
    const result = computeStatusline({
      now: new Date(NOW_MS),
      staleThresholdMs: 365 * 24 * HOUR_MS,
    });
    assert.equal(result.snapshot.verdict, "indeterminate");
    assert.equal(result.exitCode, 20);
    await budget.unsetBudgetKey("budget.monthly");
  });

  test("mixed currencies with a budget → indeterminate / exit 20, spend nulls", async () => {
    const { computeStatusline } = await mod();
    const budget = await budgetMod();
    await budget.setBudgetMonthly(150, "usd");
    await seedRequests([row(1, 1.0), row(3, 1.0, { currency: "eur" })]);
    const result = computeStatusline({
      now: new Date(NOW_MS),
      staleThresholdMs: 365 * 24 * HOUR_MS,
    });
    assert.equal(result.snapshot.verdict, "indeterminate");
    assert.equal(result.exitCode, 20);
    assert.equal(result.snapshot.spend.today, null);
    await budget.unsetBudgetKey("budget.monthly");
  });

  test("never-synced store with rows is stale; fresh watermark is not", async () => {
    const { computeStatusline } = await mod();
    await seedRequests([row(1, 1.0)]);
    // Seeded rows carry no sync_meta watermark → stale despite the threshold.
    const stale = computeStatusline({
      now: new Date(NOW_MS),
      staleThresholdMs: 365 * 24 * HOUR_MS,
    });
    assert.equal(stale.snapshot.stale, true);
    // Plant a fresh last_sync_at via the store command's own meta table.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(box.dir, "store.db"));
    try {
      db.prepare("INSERT INTO sync_meta (key, value) VALUES ('last_sync_at', ?)").run(
        new Date(NOW_MS).toISOString(),
      );
    } finally {
      db.close();
    }
    const fresh = computeStatusline({
      now: new Date(NOW_MS),
      staleThresholdMs: 365 * 24 * HOUR_MS,
    });
    assert.equal(fresh.snapshot.stale, false);
  });

  test("the snapshot shape is exactly the G5 schema (versioned, provenance-carrying)", async () => {
    const { computeStatusline } = await mod();
    await seedRequests([row(1, 1.0)]);
    const { snapshot } = computeStatusline({ now: new Date(NOW_MS) });
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "budget",
      "burn",
      "generated_at",
      "provenance",
      "schema_version",
      "source",
      "spend",
      "stale",
      "ttft",
      "verdict",
    ]);
    assert.equal(snapshot.schema_version, 1);
    assert.equal(snapshot.source, "aiand status");
    assert.ok(!Number.isNaN(Date.parse(snapshot.generated_at)));
    assert.deepEqual(Object.keys(snapshot.spend).sort(), ["currency", "session", "today"]);
    assert.deepEqual(Object.keys(snapshot.burn).sort(), ["currency", "per_hour"]);
    assert.deepEqual(Object.keys(snapshot.ttft), ["p50_ms"]);
    for (const key of ["spend", "session", "burn", "budget_projected_pct", "ttft"]) {
      assert.ok(typeof snapshot.provenance[key] === "string" && snapshot.provenance[key] !== "");
    }
  });
});
