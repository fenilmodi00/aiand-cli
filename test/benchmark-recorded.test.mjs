import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const { runRecordedBenchmark, diffReports, PINNED_MODEL, PINNED_PRICES } = await import(
  "../dist/benchmark/recorded.js"
);
const { BENCH_SCENARIOS } = await import("../dist/benchmark/scenarios.js");
const { HARNESS_LAYOUTS } = await import("../dist/benchmark/harness-layouts.js");

// #67 — the deterministic regression gate: an offline replay of the whole
// scenario pack costed at pinned prices, compared against committed goldens.

const GOLDEN_URL = new URL("./golden/benchmark-recorded.json", import.meta.url);
const golden = JSON.parse(readFileSync(GOLDEN_URL, "utf8"));

describe("benchmark recorded gate", () => {
  test("every scenario x layout row is in the golden file", () => {
    const expected = BENCH_SCENARIOS.length * HARNESS_LAYOUTS.length;
    assert.equal(golden.rows.length, expected);
    const seen = new Set(golden.rows.map((row) => `${row.scenario} x ${row.layout}`));
    for (const scenario of BENCH_SCENARIOS) {
      for (const layout of HARNESS_LAYOUTS) {
        assert.ok(seen.has(`${scenario.id} x ${layout.id}`), `${scenario.id} x ${layout.id}`);
      }
    }
  });

  test("the fresh replay matches the committed goldens (the CI gate)", async () => {
    const report = await runRecordedBenchmark();
    const diffs = diffReports(report, golden);
    assert.deepEqual(diffs, [], diffs.join("\n"));
  });

  test("the four CacheLane metrics are present per row", () => {
    for (const row of golden.rows) {
      for (const field of [
        "baseline_cost_units",
        "effective_cost_units",
        "cache_hit_ratio",
        "savings_ratio",
      ]) {
        assert.ok(Number.isFinite(row[field]), `${row.scenario} x ${row.layout}.${field}`);
      }
    }
  });

  test("behavioral fields are present per row and simulated-labeled", () => {
    // Every row carries the scripted counters; only the error-retry
    // scenario's are nonzero.
    for (const row of golden.rows) {
      assert.ok(Number.isInteger(row.toolErrors), `${row.scenario} x ${row.layout}.toolErrors`);
      assert.ok(Number.isInteger(row.retries), `${row.scenario} x ${row.layout}.retries`);
    }
    assert.equal(golden.provenance.toolOutcomes, "simulated(scripted tool outcomes)");
    const plain = golden.rows.filter((row) => row.scenario !== "tool-error-retry");
    assert.ok(plain.length > 0);
    for (const row of plain) {
      assert.equal(row.toolErrors, 0, `${row.scenario} x ${row.layout} has no scripted errors`);
      assert.equal(row.retries, 0, `${row.scenario} x ${row.layout} has no scripted retries`);
    }
  });

  test("the error-retry scenario walks error, then retry, then success", async () => {
    const report = await runRecordedBenchmark({ scenarios: ["tool-error-retry"] });
    assert.equal(report.rows.length, HARNESS_LAYOUTS.length);
    for (const row of report.rows) {
      // call_2 fails exactly once; every layout re-issues it once.
      assert.equal(row.toolErrors, 1, `${row.layout}: one scripted tool error`);
      assert.equal(row.retries, 1, `${row.layout}: one error-then-retry chain`);
    }
  });

  test("two consecutive replays are byte-identical", async () => {
    const first = JSON.stringify(await runRecordedBenchmark());
    const second = JSON.stringify(await runRecordedBenchmark());
    assert.equal(second, first);
  });

  test("the report carries metrics and metadata, never fixture text", async () => {
    const report = JSON.stringify(await runRecordedBenchmark());
    for (const scenario of BENCH_SCENARIOS) {
      assert.ok(!report.includes(scenario.file.content), scenario.id);
      assert.ok(!report.includes(scenario.file.path), scenario.id);
      for (const turn of scenario.turns) {
        assert.ok(!report.includes(turn), `${scenario.id}: ${turn}`);
      }
    }
  });

  test("a deliberate pinned-price bump flips the gate red", async () => {
    const bumped = {
      [PINNED_MODEL]: { ...PINNED_PRICES[PINNED_MODEL], inputPer1m: 1.1 },
    };
    const report = await runRecordedBenchmark({ prices: bumped });
    const diffs = diffReports(report, golden);
    assert.ok(diffs.length > 0, "the golden comparison must notice the price change");
    assert.ok(
      diffs.some((d) => d.includes("baseline_cost_units")),
      "baseline moves with prices",
    );
    assert.ok(
      diffs.some((d) => d.includes("effective_cost_units")),
      "effective cost moves with prices",
    );
  });

  test("a changed cost math path is visible in the diff", async () => {
    // Simulate a reconciler bug that bills every token as uncached: the
    // goldens must catch it, not normalize it away. Aim at a row that
    // actually hits the cache, where the two metrics differ.
    const report = await runRecordedBenchmark();
    const target = report.rows.find((row) => row.cachedTokens > 0);
    assert.ok(target, "at least one golden row hits the cache");
    const corrupted = {
      ...report,
      rows: report.rows.map((row) =>
        row === target ? { ...row, effective_cost_units: row.baseline_cost_units } : row,
      ),
    };
    const diffs = diffReports(corrupted, golden);
    assert.ok(
      diffs.some((diff) =>
        diff.startsWith(`${target.scenario} x ${target.layout}.effective_cost_units`),
      ),
      diffs.join("\n"),
    );
  });

  test("the runs directory is gitignored", () => {
    const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
    assert.match(gitignore, /^\/?runs\/$/m, "runs/ must be gitignored");
  });
});
