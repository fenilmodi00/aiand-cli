import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { withTestEnv } from "./helpers.mjs";

// OBS-P2-2 (#74): budgets + burn-rate forecast v1 + pacing verdicts.
// Unit tests pin the v1 math (attributed spend with proportional overlap,
// burn rate, projection, exceed date, P90 suggestion), the verdict
// vocabulary, the warn-threshold copy, and the budget config persistence.

const box = withTestEnv("aiand-forecast-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  delete process.env.AIAND_NO_WARN;
});

const forecastMod = () => import("../dist/obs/forecast.js");
const budgetMod = () => import("../dist/obs/budget.js");

/** Pinned "now": 2026-10-15T12:00Z — mid-month, mid-UTC-day. */
const NOW_MS = Date.UTC(2026, 9, 15, 12, 0, 0);
const HOUR_MS = 3_600_000;

let seq = 0;
/** A forecast row `hoursAgo` before NOW, in USD unless overridden. */
function row(hoursAgo, cost, overrides = {}) {
  seq += 1;
  return {
    id: `r-${String(seq).padStart(4, "0")}`,
    api_key: "sk-abcd...1234",
    created_at: new Date(NOW_MS - hoursAgo * HOUR_MS).toISOString(),
    latency_ms: null,
    cost: String(cost),
    cost_value: cost,
    currency: "usd",
    ...overrides,
  };
}

// -- pure math -----------------------------------------------------------------

describe("attributedSpend", () => {
  test("counts point rows fully inside the window, excludes those outside", async () => {
    const { attributedSpend } = await forecastMod();
    const rows = [row(1, 0.01), row(2, 0.02), row(30, 0.5), row(0.5, 0.04)];
    const spend = attributedSpend(rows, NOW_MS - 24 * HOUR_MS, NOW_MS);
    assert.equal(spend, 0.07); // 1h, 2h, 0.5h ago; 30h ago excluded
  });

  test("#74 proportional overlap attribution: a boundary-spanning request contributes its fraction", async () => {
    const { attributedSpend } = await forecastMod();
    const windowStart = NOW_MS - 24 * HOUR_MS;
    // Created 25h ago, executed for 2h: half its execution is inside the window.
    const spanning = row(25, 0.02, { latency_ms: 2 * HOUR_MS });
    assert.equal(attributedSpend([spanning], windowStart, NOW_MS), 0.01);
    // A 30-minute latency starting right at the boundary is fully inside.
    const atBoundary = row(24, 0.02, { latency_ms: 30 * 60_000 });
    assert.equal(attributedSpend([atBoundary], windowStart, NOW_MS), 0.02);
    // Ending exactly at the window start contributes nothing.
    const justBefore = row(24.5, 0.02, { latency_ms: 30 * 60_000 });
    assert.equal(attributedSpend([justBefore], windowStart, NOW_MS), 0);
  });

  test("rows with unparsable cost contribute nothing", async () => {
    const { attributedSpend } = await forecastMod();
    const rows = [row(1, 0.01), row(2, null, { cost: null, cost_value: null }), row(3, "junk")];
    assert.equal(attributedSpend(rows, NOW_MS - 24 * HOUR_MS, NOW_MS), 0.01);
  });
});

describe("burnRate", () => {
  test("rate = attributed spend / window hours once >= 2h of data exist", async () => {
    const { burnRate } = await forecastMod();
    const rows = [row(1, 0.01), row(2, 0.02), row(3, 0.03)];
    const rate = burnRate(rows, 24 * HOUR_MS, NOW_MS, 2 * HOUR_MS);
    assert.ok(rate.ok);
    assert.equal(rate.value.value, 0.06 / 24);
    assert.equal(rate.value.provenance.kind, "heuristic");
  });

  test("#74 fewer than 2 hours of data is indeterminate — never a fabricated rate", async () => {
    const { burnRate } = await forecastMod();
    const rate = burnRate([row(1, 0.5)], 24 * HOUR_MS, NOW_MS, 2 * HOUR_MS);
    assert.equal(rate.ok, false);
    assert.equal(rate.reason, "insufficient-data");
    // No data at all in the window either.
    assert.equal(burnRate([row(30, 1)], 24 * HOUR_MS, NOW_MS, 2 * HOUR_MS).ok, false);
  });

  test("overlap attribution feeds the rate: a half-included request counts half", async () => {
    const { burnRate } = await forecastMod();
    const spanning = row(25, 0.024, { latency_ms: 2 * HOUR_MS }); // 0.012 in-window
    const rate = burnRate([spanning, row(2, 0.012)], 24 * HOUR_MS, NOW_MS, 2 * HOUR_MS);
    assert.ok(rate.ok);
    assert.equal(rate.value.value, 0.024 / 24);
  });
});

describe("forecast verdicts", () => {
  const BUDGET = 150;

  test("empty row set → no-data, no projection", async () => {
    const { forecast } = await forecastMod();
    const result = forecast({ rows: [], now: new Date(NOW_MS), budget: BUDGET, currency: "usd" });
    assert.equal(result.verdict, "no-data");
    assert.equal(result.projectedMonthEnd, null);
    assert.equal(result.pacing, null);
  });

  test("thin data → indeterminate, never a fabricated projection", async () => {
    const { forecast } = await forecastMod();
    const result = forecast({
      rows: [row(1, 5)],
      now: new Date(NOW_MS),
      budget: BUDGET,
      currency: "usd",
    });
    assert.equal(result.verdict, "indeterminate");
    assert.equal(result.projectedMonthEnd, null);
  });

  test("no budget → no-budget verdict, projection still computed", async () => {
    const { forecast } = await forecastMod();
    const result = forecast({
      rows: [row(1, 5), row(3, 5)],
      now: new Date(NOW_MS),
      budget: null,
      currency: "usd",
    });
    assert.equal(result.verdict, "no-budget");
    assert.ok(result.projectedMonthEnd);
    assert.equal(result.budgetRemaining, null);
  });

  test("on-pace: projected = current + rate(24h) × hours remaining, exact formula", async () => {
    const { forecast, monthWindow } = await forecastMod();
    const rows = [row(1, 10), row(2, 20), row(24 * 20, 500)]; // 20d ago is last month
    const result = forecast({ rows, now: new Date(NOW_MS), budget: 100000, currency: "usd" });
    assert.equal(result.verdict, "on-pace");
    const hoursRemaining = (monthWindow(new Date(NOW_MS)).endMs - NOW_MS) / HOUR_MS;
    assert.equal(result.rate24h.ok && result.rate24h.value.value, 30 / 24);
    assert.ok(result.projectedMonthEnd);
    // rate × hoursRemaining + current, within float tolerance
    assert.ok(
      Math.abs(result.projectedMonthEnd.value - (30 + (30 / 24) * hoursRemaining)) < 1e-9,
      `projected ${result.projectedMonthEnd.value}`,
    );
    assert.equal(result.projectedMonthEnd.provenance.kind, "estimated");
    assert.equal(result.exceedDate, null);
    assert.equal(result.budgetRemaining, 100000 - 30);
  });

  test("exceeding: projected figure + date + the ticket's exact pacing copy", async () => {
    const { forecast } = await forecastMod();
    const rows = [row(1, 10), row(2, 20)]; // rate 30/24 per hour
    const result = forecast({ rows, now: new Date(NOW_MS), budget: 1, currency: "usd" });
    assert.equal(result.verdict, "exceeding");
    assert.ok(result.exceedDate && /^\d{4}-\d{2}-\d{2}$/.test(result.exceedDate));
    assert.match(
      result.pacing,
      /^On pace to exceed budget: projected \$[\d.]+ by \d{4}-\d{2}-\d{2} \(budget \$1\.00\)$/,
    );
  });

  test("#74 the 7d rate backs the headline when the 24h window is thin", async () => {
    const { forecast } = await forecastMod();
    // Nothing in the last 24h; 4 days of history in the 7d window.
    const rows = [row(30, 24), row(24 + 24, 24), row(24 + 48, 24), row(24 + 72, 24)];
    const result = forecast({ rows, now: new Date(NOW_MS), budget: 1, currency: "usd" });
    assert.ok(result.rate7d.ok);
    assert.ok(result.headlineRate.ok);
    assert.equal(result.verdict, "exceeding");
  });

  test("already over budget → exceed date is today", async () => {
    const { forecast } = await forecastMod();
    const rows = [row(1, 100), row(3, 100)];
    const result = forecast({ rows, now: new Date(NOW_MS), budget: 50, currency: "usd" });
    assert.equal(result.verdict, "exceeding");
    assert.equal(result.exceedDate, "2026-10-15");
  });

  test("exceedDate: hours to cross the budget at the given rate", async () => {
    const { exceedDate } = await forecastMod();
    // 50 spent of a 150 budget at 10/h → 10h to cross → still the same UTC day.
    assert.equal(exceedDate(50, 150, 10, NOW_MS), "2026-10-15");
    // 50 spent at 1/h → 100h → 2026-10-19.
    assert.equal(exceedDate(50, 150, 1, NOW_MS), "2026-10-19");
    assert.equal(exceedDate(200, 150, 10, NOW_MS), "2026-10-15");
    assert.equal(exceedDate(50, 150, 0, NOW_MS), null);
  });
});

describe("P90 auto-budget", () => {
  test("nearest-rank P90", async () => {
    const { p90 } = await forecastMod();
    assert.equal(p90([]), null);
    assert.equal(p90([100]), 100);
    assert.equal(p90([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]), 900);
    assert.equal(p90([10, 90]), 90);
  });

  test("#74 fewer than 2 completed windows refuses with the count", async () => {
    const { suggestBudget } = await forecastMod();
    const refused = suggestBudget([{ month: "2026-09", spend: 120 }]);
    assert.equal(refused.ok, false);
    assert.equal(refused.windows, 1);
    assert.equal(suggestBudget([]).windows, 0);
  });

  test("two completed windows → P90 with provenance", async () => {
    const { suggestBudget } = await forecastMod();
    const ok = suggestBudget([
      { month: "2026-08", spend: 100 },
      { month: "2026-09", spend: 200 },
    ]);
    assert.ok(ok.ok);
    assert.equal(ok.value.value, 200);
    assert.equal(ok.value.provenance.kind, "heuristic");
    assert.equal(ok.value.provenance.source, "P90 of monthly totals");
  });
});

// -- warn threshold + suppression ---------------------------------------------

describe("budget warning", () => {
  test("exact ticket copy at 84% of $150", async () => {
    const { warnThresholdLine } = await budgetMod();
    assert.equal(
      warnThresholdLine(126, 150, 80, "usd"),
      "⚠ 84% of monthly budget used ($126.00 / $150.00)",
    );
  });

  test("below the threshold prints nothing", async () => {
    const { warnThresholdLine } = await budgetMod();
    assert.equal(warnThresholdLine(100, 150, 80, "usd"), null);
    // A custom warn-pct shifts the line.
    assert.ok(warnThresholdLine(100, 150, 60, "usd"));
  });

  test("warnSuppressed: AIAND_NO_WARN=1", async () => {
    const { warnSuppressed } = await budgetMod();
    assert.equal(warnSuppressed(false), false);
    process.env.AIAND_NO_WARN = "1";
    try {
      assert.equal(warnSuppressed(false), true);
      assert.equal(warnSuppressed(true), true);
    } finally {
      delete process.env.AIAND_NO_WARN;
    }
  });
});

// -- budget config persistence -------------------------------------------------

describe("budget config", () => {
  test("set/get/unset monthly, harness, warn-pct; currency recorded once known", async () => {
    const budget = await budgetMod();
    assert.equal(budget.loadBudget().monthly, null);
    assert.equal(budget.loadBudget().warnPct, 80);

    await budget.setBudgetMonthly(150, "usd");
    assert.equal(budget.loadBudget().monthly, 150);
    assert.equal(budget.loadBudget().currency, "usd");

    await budget.setBudgetHarness("claude", 50);
    await budget.setBudgetWarnPct(90);
    const loaded = budget.loadBudget();
    assert.equal(loaded.harness.claude, 50);
    assert.equal(loaded.warnPct, 90);
    assert.equal(budget.budgetFor(loaded, "claude"), 50);
    assert.equal(budget.budgetFor(loaded, "codex"), 150);
    assert.equal(budget.budgetFor(loaded), 150);

    await budget.unsetBudgetKey("budget.monthly");
    assert.equal(budget.loadBudget().monthly, null);
    // The recorded currency survives until the store says otherwise.
    assert.equal(budget.loadBudget().currency, "usd");

    await budget.unsetBudgetKey("budget.harness.claude");
    assert.deepEqual(budget.loadBudget().harness, {});
    await budget.unsetBudgetKey("budget.warn-pct");
    assert.equal(budget.loadBudget().warnPct, 80);
    // Idempotent unset.
    await budget.unsetBudgetKey("budget.warn-pct");
  });

  test("non-positive and invalid values are rejected", async () => {
    const budget = await budgetMod();
    await assert.rejects(budget.setBudgetMonthly(0, null));
    await assert.rejects(budget.setBudgetMonthly(-5, null));
    await assert.rejects(budget.setBudgetWarnPct(0));
    await assert.rejects(budget.setBudgetWarnPct(101));
    await assert.rejects(budget.setBudgetHarness("bad name!", 5));
    const { CliError } = await import("../dist/cli/errors.js");
    await assert.rejects(budget.unsetBudgetKey("model"), CliError);
  });
});

// -- store-backed reads ---------------------------------------------------------

/**
 * Create + migrate store.db directly (the real file is only created on a
 * first sync) and insert request rows verbatim — same fixture style as
 * test/sessions.test.mjs.
 */
async function seedRequests(dir, rows) {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(join(dir, `store.db${suffix}`), { force: true });
  }
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const { MIGRATIONS } = await import("../dist/store/migrations/index.js");
  const db = new DatabaseSync(join(dir, "store.db"));
  try {
    // Mirror the runner: record applied versions, or openStore's migrate()
    // re-applies them and the 0005 ALTER fails on the duplicate column.
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (" +
        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    // re-applies them and the 0005 ALTER fails on the duplicate column.
    for (const migration of MIGRATIONS) {
      db.exec(migration.sql);
      db.prepare(
        "INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, new Date().toISOString());
    }
    const insert = db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, " +
        "latency_ms, input_tokens, output_tokens, cached_tokens, cost, cost_value, " +
        "currency, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      insert.run(
        r.id,
        "test/model",
        r.api_key,
        200,
        120,
        r.latency_ms,
        1000,
        300,
        400,
        r.cost,
        r.cost_value,
        r.currency,
        r.created_at,
        new Date().toISOString(),
      );
    }
  } finally {
    db.close();
  }
}

describe("store-backed forecast", () => {
  test("readForecastRows reads the month, scopes by harness, reports the currency", async () => {
    const mod = await forecastMod();
    const { agentForMaskedKey } = await import("../dist/api/agent-keys.js");
    // Plant the key map so one row's masked key resolves to a harness.
    writeFileSync(
      join(box.dir, "agent-keys.json"),
      JSON.stringify({
        version: 1,
        keys: [{ agent: "claude", masked: "sk-claude...9999", fingerprint: "f".repeat(16), at: 1 }],
      }),
    );
    assert.equal(agentForMaskedKey("sk-claude...9999"), "claude");

    const rows = [
      row(1, 0.01),
      row(2, 0.02),
      row(24 * 20, 9),
      row(0.5, 0.04, { api_key: "sk-claude...9999" }),
    ];
    await seedRequests(box.dir, rows);

    const read = mod.readForecastRows({ now: new Date(NOW_MS) });
    assert.equal(read.currency, "usd");
    // 20 days ago was Sept 25 — outside the October window the read covers
    // (min(month start, now-7d) = Oct 1); the other three rows are in.
    assert.equal(read.rows.length, 3);

    const scoped = mod.readForecastRows({ now: new Date(NOW_MS), harness: "claude" });
    assert.equal(scoped.rows.length, 1);
    assert.equal(scoped.rows[0].api_key, "sk-claude...9999");
    assert.equal(mod.readForecastRows({ now: new Date(NOW_MS), harness: "codex" }).rows.length, 0);
  });

  test("mixed currencies in the store are an explicit doctor-style error", async () => {
    const mod = await forecastMod();
    await seedRequests(box.dir, [row(50, 1), row(51, 1, { currency: "eur" })]);
    assert.throws(() => mod.readForecastRows({ now: new Date(NOW_MS) }), /Mixed currencies/);
    assert.throws(() => mod.storeCurrency(), /Mixed currencies/);
  });

  test("storePacingSummary: verdict + pacing from the store against budget.monthly", async () => {
    const mod = await forecastMod();
    const budget = await budgetMod();
    // Clean slate for this case: reseed a known-good single-currency month.
    await seedRequests(box.dir, [row(1, 100), row(3, 100)]);
    await budget.setBudgetMonthly(1, "usd");

    const summary = mod.storePacingSummary({ now: new Date(NOW_MS) });
    assert.ok(summary);
    assert.equal(summary.verdict, "exceeding");
    assert.match(
      summary.pacing,
      /^On pace to exceed budget: projected \$[\d.]+ by \d{4}-\d{2}-\d{2} \(budget \$1\.00\)$/,
    );
  });

  test("storePacingSummary: no budget → null; no store → null", async () => {
    const mod = await forecastMod();
    const budget = await budgetMod();
    await budget.unsetBudgetKey("budget.monthly");
    assert.equal(mod.storePacingSummary({ now: new Date(NOW_MS) }), null);
    // A missing store never throws.
    rmSync(join(box.dir, "store.db"), { force: true });
    assert.equal(mod.storePacingSummary({ now: new Date(NOW_MS) }), null);
    assert.deepEqual(mod.readMonthTotals(new Date(NOW_MS)), []);
  });

  test("readMonthTotals + suggest: P90 of completed months from the store", async () => {
    const mod = await forecastMod();
    // Sept 2026 (complete) and Aug 2026, plus current-month rows that must be
    // excluded from the completed-window totals.
    await seedRequests(box.dir, [
      {
        id: "a1",
        api_key: "k",
        created_at: "2026-08-10T00:00:00.000Z",
        cost: "100",
        cost_value: 100,
        currency: "usd",
        latency_ms: null,
      },
      {
        id: "a2",
        api_key: "k",
        created_at: "2026-09-10T00:00:00.000Z",
        cost: "40",
        cost_value: 40,
        currency: "usd",
        latency_ms: null,
      },
      {
        id: "a3",
        api_key: "k",
        created_at: "2026-09-11T00:00:00.000Z",
        cost: "60",
        cost_value: 60,
        currency: "usd",
        latency_ms: null,
      },
      {
        id: "a4",
        api_key: "k",
        created_at: "2026-10-10T00:00:00.000Z",
        cost: "9999",
        cost_value: 9999,
        currency: "usd",
        latency_ms: null,
      },
    ]);
    const totals = mod.readMonthTotals(new Date(NOW_MS));
    assert.deepEqual(totals, [
      { month: "2026-08", spend: 100 },
      { month: "2026-09", spend: 100 },
    ]);
    const suggestion = mod.suggestBudget(totals);
    assert.ok(suggestion.ok);
    assert.equal(suggestion.value.value, 100);
  });
});
