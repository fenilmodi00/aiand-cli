import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { wilson95, aggregateCells, tableWinners, histogramText } = await import(
  "../dist/compare/table.js"
);
const { parseRunRows } = await import("../dist/compare/run-rows.js");

/** One run row, spread-over-defaults (test fixture convention). */
function row(overrides = {}) {
  return {
    run_id: "r",
    ts: "2026-10-29T00:00:00Z",
    harness: "claude",
    harness_version: "1.0",
    model: "m1",
    task: "t1",
    success: false,
    score: null,
    failure_mode: null,
    completed: true,
    wall_ms: 1000,
    turns: 3,
    retries: 0,
    tokens_in: 100,
    tokens_cached: 0,
    tokens_out: 50,
    cost_usd: 0.01,
    token_basis: "gateway",
    cost_basis: "gateway",
    request_ids: [],
    verify_exit: 1,
    ...overrides,
  };
}

describe("wilson95 (Wilson score interval, 95%)", () => {
  test("known values: 8/10 → [0.49, 0.943]", () => {
    const ci = wilson95(8, 10);
    assert.ok(ci);
    assert.ok(Math.abs(ci.lo - 0.4901) < 0.005, `lo=${ci.lo}`);
    assert.ok(Math.abs(ci.hi - 0.9433) < 0.005, `hi=${ci.hi}`);
  });
  test("0 successes: lower bound at 0, upper well below 1", () => {
    const ci = wilson95(0, 3);
    assert.ok(ci);
    assert.equal(ci.lo, 0);
    assert.ok(ci.hi < 0.8 && ci.hi > 0.4);
  });
  test("all successes: upper bound at 1, lower well above 0", () => {
    const ci = wilson95(5, 5);
    assert.ok(ci);
    assert.equal(ci.hi, 1);
    assert.ok(ci.lo > 0.5);
  });
  test("zero trials → null", () => {
    assert.equal(wilson95(0, 0), null);
  });
});

describe("aggregateCells", () => {
  test("groups per (harness, model) with solve x/n and Wilson CI", () => {
    const rows = [
      row({ success: true, cost_usd: 0.1, wall_ms: 1000, turns: 4, retries: 1 }),
      row({ success: true, cost_usd: 0.2, wall_ms: 2000, turns: 6, retries: 0 }),
      row({ success: false, failure_mode: "agent_timeout", cost_usd: 0.05 }),
    ];
    const cells = aggregateCells(rows);
    assert.equal(cells.length, 1);
    const c = cells[0];
    assert.equal(c.harness, "claude");
    assert.equal(c.model, "m1");
    assert.equal(c.trials, 3);
    assert.equal(c.solves, 2);
    assert.ok(c.solveLo > 0.17 && c.solveHi < 0.94);
    assert.ok(Math.abs(c.costUsd - 0.35) < 1e-9);
    assert.ok(Math.abs(c.costPerSolve - 0.175) < 1e-9);
    assert.ok(Math.abs(c.meanWallMs - 4000 / 3) < 1e-9); // mean over all 3 trials
    assert.ok(Math.abs(c.turnsPerSolve - 5) < 1e-9);
    assert.ok(Math.abs(c.retryRate - 0.5) < 1e-9);
    assert.equal(c.lowN, false);
  });

  test("infra rows excluded from solve rate and cost, reported separately", () => {
    const rows = [
      row({ success: true }),
      row({ success: true }),
      row({ success: true }),
      row({
        success: null,
        failure_mode: "infra",
        cost_usd: 999,
        wall_ms: 999_999,
        completed: false,
      }),
    ];
    const [c] = aggregateCells(rows);
    assert.equal(c.trials, 3);
    assert.equal(c.solves, 3);
    assert.equal(c.costUsd, 0.03);
    assert.equal(c.infra, 1);
    assert.equal(c.lowN, false);
  });

  test("0-solve cell: costPerSolve/turns/retryRate are null, never 0", () => {
    const rows = [
      row({ success: false, failure_mode: "parse_error" }),
      row({ success: false, failure_mode: "parse_error" }),
      row({ success: false, failure_mode: "context_exceeded" }),
    ];
    const [c] = aggregateCells(rows);
    assert.equal(c.solves, 0);
    assert.equal(c.costPerSolve, null);
    assert.equal(c.turnsPerSolve, null);
    assert.equal(c.retryRate, null);
    assert.equal(c.costUsd, 0.03);
    assert.deepEqual(c.failures, { parse_error: 2, context_exceeded: 1 });
  });

  test("unmetered cost stays null", () => {
    const rows = [...Array.from({ length: 3 }, () => row({ success: true, cost_usd: null }))];
    const [c] = aggregateCells(rows);
    assert.equal(c.solves, 3);
    assert.equal(c.costUsd, null);
    assert.equal(c.costPerSolve, null);
  });

  test("low-n flag under 3 trials", () => {
    const cells = aggregateCells([row(), row()]);
    assert.equal(cells[0].lowN, true);
  });

  test("cells sorted by harness then model", () => {
    const cells = aggregateCells([
      row({ harness: "codex", model: "m2" }),
      row({ harness: "claude", model: "m2" }),
      row({ harness: "claude", model: "m1" }),
    ]);
    assert.deepEqual(
      cells.map((c) => `${c.harness}/${c.model}`),
      ["claude/m1", "claude/m2", "codex/m2"],
    );
  });
});

describe("tableWinners", () => {
  const mk = (harness, solves, trials) =>
    aggregateCells(
      Array.from({ length: trials }, (_, i) =>
        row({ harness, model: "m", success: i < solves, cost_usd: 0.01 * trials }),
      ),
    )[0];

  test("disjoint CIs → solve winner", () => {
    // 30/30 vs 0/30: Wilson intervals far apart.
    const cells = [mk("claude", 30, 30), mk("codex", 0, 30)];
    const w = tableWinners(cells);
    assert.equal(w.solveTied, false);
    assert.equal(w.winners.solve, "claude / m");
  });

  test("overlapping CIs → tied, no winner, tie note", () => {
    // 2/3 vs 3/4: overlapping Wilson intervals at these tiny n.
    const cells = [mk("claude", 2, 3), mk("codex", 3, 4)];
    const w = tableWinners(cells);
    assert.equal(w.solveTied, true);
    assert.equal(w.winners.solve, null);
    assert.match(w.tieNote, /tied — not distinguishable yet/);
  });

  test("identical cells tie (overlapping by construction)", () => {
    const cells = [mk("claude", 2, 3), mk("codex", 2, 3)];
    const w = tableWinners(cells);
    assert.equal(w.solveTied, true);
    assert.equal(w.winners.solve, null);
  });

  test("per-column deterministic winners for cost, wall, turns, retries", () => {
    const rows = [
      ...Array.from({ length: 30 }, () =>
        row({
          harness: "claude",
          model: "m",
          success: true,
          cost_usd: 0.3,
          wall_ms: 3000,
          turns: 6,
          retries: 2,
        }),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        row({
          harness: "codex",
          model: "m",
          success: i < 10,
          failure_mode: i < 10 ? null : "parse_error",
          cost_usd: 0.05,
          wall_ms: 1000,
          turns: 2,
          retries: 0,
        }),
      ),
    ];
    const w = tableWinners(aggregateCells(rows));
    assert.equal(w.solveTied, false);
    assert.equal(w.winners.costPerSolve, "codex / m");
    assert.equal(w.winners.meanWallMs, "codex / m");
    assert.equal(w.winners.turnsPerSolve, "codex / m");
    assert.equal(w.winners.retryRate, "codex / m");
  });

  test("null metric never wins (0-solve cell cannot take cost column)", () => {
    const rows = [
      ...Array.from({ length: 3 }, () =>
        row({ harness: "claude", model: "m", success: true, cost_usd: 0.3 }),
      ),
      ...Array.from({ length: 3 }, () =>
        row({
          harness: "codex",
          model: "m",
          success: false,
          failure_mode: "parse_error",
          cost_usd: 0.1,
        }),
      ),
    ];
    const w = tableWinners(aggregateCells(rows));
    assert.equal(w.winners.costPerSolve, "claude / m");
  });
});

describe("histogramText", () => {
  test("every mode counted, never collapsed", () => {
    const [c] = aggregateCells([
      row({ failure_mode: "parse_error" }),
      row({ failure_mode: "parse_error" }),
      row({ failure_mode: "agent_timeout" }),
    ]);
    assert.equal(histogramText(c), "agent_timeout 1 · parse_error 2");
  });
  test("empty histogram renders empty string", () => {
    const [c] = aggregateCells([row({ success: true }), row(), row()]);
    assert.equal(histogramText(c), "");
  });
});

describe("--json shape via parseRunRows + aggregateCells", () => {
  test("end-to-end payload fields present", () => {
    const jsonl = [
      JSON.stringify(row({ success: true })),
      JSON.stringify(row({ success: true })),
      JSON.stringify(row({ success: false, failure_mode: "agent_timeout" })),
    ].join("\n");
    const cells = aggregateCells(parseRunRows(jsonl));
    const payload = { cells, solveTied: tableWinners(cells).solveTied };
    assert.equal(payload.cells.length, 1);
    const c = payload.cells[0];
    assert.equal(typeof c.solves, "number");
    assert.equal(typeof c.solveLo, "number");
    assert.equal(typeof c.solveHi, "number");
    assert.equal(typeof c.trials, "number");
    assert.equal(payload.solveTied, false);
  });
});

// ---------------------------------------------------------------------------
// #152 — task-clustered bootstrap and pass@k / pass^k
// ---------------------------------------------------------------------------

describe("aggregateCells k option (#152)", () => {
  /** Two tasks × 3 trials: t1 solves 2/3, t2 solves 3/3 (pooled 5/6). */
  function twoTaskRows(harness = "claude", model = "m1") {
    return [
      row({ task: "t1", run_id: "r1", harness, model, success: true }),
      row({ task: "t1", run_id: "r2", harness, model, success: true }),
      row({ task: "t1", run_id: "r3", harness, model, success: false }),
      row({ task: "t2", run_id: "r4", harness, model, success: true }),
      row({ task: "t2", run_id: "r4b", harness, model, success: true }),
      row({ task: "t2", run_id: "r4c", harness, model, success: true }),
    ];
  }

  test("k=1: pass@k and pass^k both equal the pooled solve rate", () => {
    const [c] = aggregateCells(twoTaskRows());
    assert.equal(c.k, 1);
    assert.equal(c.solveMethod, "clustered", "repeated trials per task → clustered");
    assert.equal(c.tasksBelowK, 0);
    assert.equal(c.passAtK, c.solves / c.trials);
    assert.equal(c.passPowK, c.solves / c.trials);
  });

  test("k=1 single-trial cells stay Wilson with exact Wilson bounds", () => {
    const [c] = aggregateCells([
      row({ success: true }),
      row({ success: true }),
      row({ success: false, failure_mode: "agent_timeout" }),
    ]);
    assert.equal(c.solveMethod, "wilson");
    const w = wilson95(2, 3);
    assert.equal(c.solveLo, w.lo);
    assert.equal(c.solveHi, w.hi);
  });

  test("k=3: both estimators, clustered CI differs from naive Wilson width", () => {
    const naive = aggregateCells(Array.from({ length: 6 }, (_, i) => row({ success: i < 5 })))[0];
    const [clustered] = aggregateCells(twoTaskRows(), { k: 3 });
    assert.equal(clustered.solveMethod, "clustered");
    assert.equal(naive.solveMethod, "wilson", "no task repeats → Wilson even with 6 trials");
    // Different bounds entirely: 2 effective task clusters vs 6 independent
    // trials — the ticket requires the clustered CI to differ from naive
    // Wilson on the same pooled 5/6.
    assert.notEqual(clustered.solveLo, naive.solveLo);
    assert.notEqual(clustered.solveHi, naive.solveHi);
    // Unbiased estimators: t1 (n=3,c=2) → pass@3=1, pass^3=0; t2 (n=3,c=3) →
    // pass@3=1, pass^3=1. Macro = (1+1)/2 and (0+1)/2.
    assert.equal(clustered.k, 3);
    assert.equal(clustered.passAtK, 1);
    assert.equal(clustered.passPowK, 0.5);
    assert.equal(clustered.tasksBelowK, 0);
  });

  test("pass@k rises with k, pass^k falls, and pass^k never exceeds pass@k", () => {
    // t1: 2/6 solves; t2: 7/9 solves.
    const rows = [
      ...[1, 1, 0, 0, 0, 0].map((s, i) => row({ task: "t1", run_id: `a${i}`, success: !!s })),
      ...[1, 1, 1, 1, 1, 1, 1, 0, 0].map((s, i) =>
        row({ task: "t2", run_id: `b${i}`, success: !!s }),
      ),
    ];
    let prevAt = 0;
    let prevPow = 1;
    for (const k of [1, 2, 3, 4, 5, 6]) {
      const [c] = aggregateCells(rows, { k });
      assert.ok(c.passAtK > 0 && c.passAtK <= 1, `pass@${k} in (0,1]: ${c.passAtK}`);
      assert.ok(c.passPowK >= 0 && c.passPowK <= 1, `pass^${k} in [0,1]: ${c.passPowK}`);
      assert.ok(c.passAtK >= c.passPowK, `pass^${k} ≤ pass@${k}`);
      assert.ok(c.passAtK >= prevAt - 1e-12, `pass@k monotone nondecreasing at k=${k}`);
      assert.ok(c.passPowK <= prevPow + 1e-12, `pass^k monotone nonincreasing at k=${k}`);
      prevAt = c.passAtK;
      prevPow = c.passPowK;
    }
  });

  test("task with n < k is excluded from the average and counted", () => {
    const rows = [
      row({ task: "short", run_id: "s1", success: true }),
      row({ task: "short", run_id: "s2", success: true }),
      row({ task: "full", run_id: "f1", success: true }),
      row({ task: "full", run_id: "f2", success: true }),
      row({ task: "full", run_id: "f3", success: true }),
    ];
    const [c] = aggregateCells(rows, { k: 3 });
    assert.equal(c.tasksBelowK, 1);
    // Only "full" qualifies: n=3, c=3 → pass@3 = 1, pass^3 = 1.
    assert.equal(c.passAtK, 1);
    assert.equal(c.passPowK, 1);
  });

  test("zero qualifying tasks → null, never 0", () => {
    const rows = [row({ success: true }), row({ success: false })];
    const [c] = aggregateCells(rows, { k: 3 });
    assert.equal(c.passAtK, null);
    assert.equal(c.passPowK, null);
    assert.equal(c.tasksBelowK, 1);
  });

  test("missing task id falls back to run id as the cluster", () => {
    const rows = [
      row({ task: "", run_id: "x1", success: true }),
      row({ task: "", run_id: "x2", success: true }),
      row({ task: "", run_id: "x3", success: false }),
    ];
    const [c] = aggregateCells(rows, { k: 3 });
    // Three run-id clusters of 1 trial each → all below k=3, and each row is
    // its own task so the pooled solve rate is still 2/3.
    assert.equal(c.tasksBelowK, 3);
    assert.equal(c.passAtK, null);
    assert.equal(c.solveMethod, "wilson");
  });

  test("clustered bootstrap is deterministic (same rows, same seed)", () => {
    const a = aggregateCells(twoTaskRows(), { k: 3 });
    const b = aggregateCells(twoTaskRows(), { k: 3 });
    assert.deepEqual(a, b);
  });

  test("recorded rows never enter aggregation, with or without k", () => {
    const rows = [
      ...twoTaskRows(),
      row({ task: "t1", run_id: "rec1", success: true, cost_basis: "recorded" }),
      row({ task: "t2", run_id: "rec2", success: true, cost_basis: "recorded" }),
    ];
    const [live] = aggregateCells(rows, { k: 3 });
    const [bare] = aggregateCells(twoTaskRows(), { k: 3 });
    assert.deepEqual(live, bare);
  });

  test("clustered CI bounds are exact known values for the 2×3 fixture", () => {
    const [c] = aggregateCells(twoTaskRows());
    // Resampling 2 tasks {2/3, 3/3}: pooled rates ∈ {2/3 (p=1/4), 5/6 (p=1/2),
    // 1 (p=1/4)} → percentile 2.5/97.5 of 2000 draws picks the min/max rates.
    assert.equal(c.solveLo, 2 / 3);
    assert.equal(c.solveHi, 1);
  });
});
