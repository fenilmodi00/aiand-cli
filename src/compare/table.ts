import { choose, taskClusteredBootstrap, wilson95 } from "../obs/evidence.js";
import { type CompareRunRow, isRecordedRow } from "./run-rows.js";

/**
 * `compare table` aggregation (ticket #132, plan §1 lane B): group run rows
 * per (harness, model) cell with a Wilson 95% solve-rate CI, per-column
 * deterministic winners, and a failure-mode histogram. Pure functions — the
 * command layer owns reading rows, rendering, and export.
 *
 * Infra rows are never trials: excluded from solve rate/cost/wall and
 * reported separately. Nulls mean "not metered", never 0.
 */

/** #147: the implementation moved to the shared evidence module; unchanged. */
export { wilson95 };

/** The failure-mode taxonomy: the single source for every histogram surface. */
const FAILURE_MODES = [
  "agent_timeout",
  "verify_timeout",
  "parse_error",
  "context_exceeded",
  "integrity_violation",
] as const;

export type FailureMode = (typeof FAILURE_MODES)[number];

export type CellStats = {
  harness: string;
  model: string;
  tasks: number;
  trials: number;
  solves: number;
  /** Wilson 95% CI on the solve rate; null only when trials = 0. Clustered
   * task bootstrap when any task has > 1 trial (#152). */
  solveLo: number | null;
  solveHi: number | null;
  /** Which interval solveLo/solveHi carries: Wilson (independent trials) or
   * task-clustered bootstrap (#152). */
  solveMethod: "wilson" | "clustered";
  /** Total gateway-billed cost of trials; null when no cost was metered. */
  costUsd: number | null;
  /** Total gateway cost ÷ solves; null when 0 solves (never 0). */
  costPerSolve: number | null;
  /** Task-clustered bootstrap CI on cost/solve; null when not computable
   * (< 2 tasks or too many zero-solve resamples) (#152). */
  costPerSolveLo: number | null;
  costPerSolveHi: number | null;
  meanWallMs: number | null;
  /** Turns of successful runs ÷ solves; null when 0 solves or turns unmetered. */
  turnsPerSolve: number | null;
  /** Retries of successful runs ÷ solves; null when 0 solves or retries unmetered. */
  retryRate: number | null;
  /** Every non-infra failure mode, counted individually, never collapsed. */
  failures: Partial<Record<FailureMode, number>>;
  /** Infra rows, reported separately — never part of solve rate. */
  infra: number;
  /** Fewer than 3 trials — the result is not distinguishable yet. */
  lowN: boolean;
  /** The k pass@k/pass^k were computed for (1 when not requested) (#152). */
  k: number;
  /** Macro-averaged unbiased pass@k = 1 − C(n−c,k)/C(n,k); null when no
   * task has n ≥ k or 0 solves make it undefined (#152). */
  passAtK: number | null;
  /** Macro-averaged unbiased pass^k = C(c,k)/C(n,k); null when no task
   * qualifies (#152). */
  passPowK: number | null;
  /** Tasks with fewer trials than k, excluded from the pass@k average (#152). */
  tasksBelowK: number;
};

type Winners = {
  solve: string | null;
  costPerSolve: string | null;
  meanWallMs: string | null;
  turnsPerSolve: string | null;
  retryRate: string | null;
};

type TableResult = {
  cells: CellStats[];
  winners: Winners;
  /** True when the best solve-rate CIs overlap — no winner for that column. */
  solveTied: boolean;
  tieNote: string | null;
};

const key = (harness: string, model: string) => `${harness}\u0000${model}`;

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Group run rows per (harness, model) cell. Rows may span tasks.
 *
 * Synthetic-never-joins (spec §3): rows from the recorded simulated lane
 * (`cost_basis: "recorded"`) are excluded — they replay a fixed bench
 * scenario, not the user's workload, so they never enter an observed
 * ranking. `compare table` renders them separately.
 *
 * #152: `opts.k` (default 1) selects the pass@k / pass^k estimators — per
 * task, macro-averaged with equal weight; tasks with fewer trials than k are
 * excluded and counted. When any task has more than one trial the solve CI
 * switches from Wilson to a task-clustered bootstrap (trials of one task are
 * correlated; pooling them as independent overstates precision), and the
 * cost/solve CI is bootstrapped over tasks too.
 */
export function aggregateCells(
  rows: readonly CompareRunRow[],
  opts: { k?: number } = {},
): CellStats[] {
  const k = opts.k ?? 1;
  const groups = new Map<string, CompareRunRow[]>();
  for (const row of rows) {
    if (isRecordedRow(row)) continue;
    if (typeof row.harness !== "string" || typeof row.model !== "string") continue;
    const k2 = key(row.harness, row.model);
    const bucket = groups.get(k2);
    if (bucket) bucket.push(row);
    else groups.set(k2, [row]);
  }

  const cells: CellStats[] = [];
  for (const [k2, all] of groups) {
    const trials = all.filter((r) => r.failure_mode !== "infra");
    const infra = all.length - trials.length;
    const solves = trials.filter((r) => r.success === true);
    const solved = solves.length;

    const costs = trials.map((r) => r.cost_usd).filter(num);
    const totalCost = costs.length > 0 ? costs.reduce((s, c) => s + c, 0) : null;

    const walls = trials.map((r) => r.wall_ms).filter(num);
    const solvedTurns = solves.map((r) => r.turns).filter(num);
    const solvedRetries = solves.map((r) => r.retries).filter(num);

    const failures: Partial<Record<FailureMode, number>> = {};
    for (const r of trials) {
      const mode = r.failure_mode;
      if (mode !== null && mode !== "infra") {
        failures[mode as FailureMode] = (failures[mode as FailureMode] ?? 0) + 1;
      }
    }

    // #152: per-task grouping for the clustered CI and pass@k. Rows without a
    // task id fall back to the run id (each its own cluster) rather than
    // silently merging unknown tasks together.
    const taskGroups = new Map<string, CompareRunRow[]>();
    for (const r of trials) {
      const t = r.task || r.run_id;
      const bucket = taskGroups.get(t);
      if (bucket) bucket.push(r);
      else taskGroups.set(t, [r]);
    }

    // #152: clustered bootstrap when trials are repeated per task.
    let solveLo: number | null;
    let solveHi: number | null;
    let solveMethod: "wilson" | "clustered";
    let costLo: number | null = null;
    let costHi: number | null = null;
    const clustered = [...taskGroups.values()].some((g) => g.length > 1);
    if (clustered) {
      const boot = taskClusteredBootstrap(
        [...taskGroups.values()].map((g) => ({
          solves: g.filter((r) => r.success === true).length,
          trials: g.length,
          cost: g
            .map((r) => r.cost_usd)
            .filter(num)
            .reduce((s, c) => s + c, 0),
        })),
        { B: 2000, seed: 42 },
      );
      const fallback = wilson95(solved, trials.length);
      // A single task group can't be resampled (bootstrap returns null) — the
      // numbers shown are then Wilson's, and the label must say so.
      solveMethod = boot.solve ? "clustered" : "wilson";
      solveLo = boot.solve ? boot.solve.lo : (fallback?.lo ?? null);
      solveHi = boot.solve ? boot.solve.hi : (fallback?.hi ?? null);
      costLo = boot.costPerSolve ? boot.costPerSolve.lo : null;
      costHi = boot.costPerSolve ? boot.costPerSolve.hi : null;
    } else {
      const ci = wilson95(solved, trials.length);
      solveMethod = "wilson";
      solveLo = ci ? ci.lo : null;
      solveHi = ci ? ci.hi : null;
    }

    // #152: unbiased pass@k / pass^k, per task then macro-averaged. At k=1
    // both collapse to the cell's pooled solve rate (the ticket requires the
    // equality), so no per-task pass is needed.
    let tasksBelowK = 0;
    let passAtKSum = 0;
    let passPowKSum = 0;
    let qualifying = 0;
    if (k > 1) {
      for (const g of taskGroups.values()) {
        const n = g.length;
        const c = g.filter((r) => r.success === true).length;
        if (n < k) {
          tasksBelowK += 1;
          continue;
        }
        qualifying += 1;
        passAtKSum += 1 - choose(n - c, k) / choose(n, k);
        passPowKSum += choose(c, k) / choose(n, k);
      }
    } else if (trials.length > 0) {
      passAtKSum = solved / trials.length;
      passPowKSum = solved / trials.length;
      qualifying = 1;
    }

    const [harness, model] = k2.split("\u0000");
    cells.push({
      harness: harness ?? "",
      model: model ?? "",
      tasks: new Set(all.map((r) => r.task)).size,
      trials: trials.length,
      solves: solved,
      solveLo,
      solveHi,
      solveMethod,
      costUsd: totalCost,
      costPerSolve: solved > 0 && totalCost !== null ? totalCost / solved : null,
      costPerSolveLo: costLo,
      costPerSolveHi: costHi,
      meanWallMs: walls.length > 0 ? walls.reduce((s, w) => s + w, 0) / walls.length : null,
      turnsPerSolve:
        solved > 0 && solvedTurns.length > 0
          ? solvedTurns.reduce((s, t) => s + t, 0) / solved
          : null,
      retryRate:
        solved > 0 && solvedRetries.length > 0
          ? solvedRetries.reduce((s, t) => s + t, 0) / solved
          : null,
      failures,
      infra,
      lowN: trials.length < 3,
      k,
      passAtK: qualifying > 0 ? passAtKSum / qualifying : null,
      passPowK: qualifying > 0 ? passPowKSum / qualifying : null,
      tasksBelowK,
    });
  }
  cells.sort((a, b) => a.harness.localeCompare(b.harness) || a.model.localeCompare(b.model));
  return cells;
}

/** Deterministic best by value, nulls sink, name breaks exact ties. */
function best(
  cells: readonly CellStats[],
  value: (c: CellStats) => number | null,
  better: (a: number, b: number) => boolean,
): string | null {
  let winner: CellStats | null = null;
  let winnerValue: number | null = null;
  for (const c of cells) {
    const v = value(c);
    if (v === null) continue;
    if (
      winnerValue === null ||
      better(v, winnerValue) ||
      (v === winnerValue &&
        (c.harness < winner!.harness || (c.harness === winner!.harness && c.model < winner!.model)))
    ) {
      winner = c;
      winnerValue = v;
    }
  }
  return winner ? `${winner.harness} / ${winner.model}` : null;
}

const overlaps = (a: { lo: number; hi: number }, b: { lo: number; hi: number }) =>
  a.lo <= b.hi && b.lo <= a.hi;

/** Per-column winners; the solve winner is withheld when the top CIs overlap. */
export function tableWinners(cells: readonly CellStats[]): TableResult {
  const withCi = cells.filter((c) => c.solveLo !== null && c.solveHi !== null && c.trials > 0);
  // Anchor: the cell whose CI lower bound is highest. If its interval
  // overlaps ANY other cell's, no winner is distinguishable.
  const anchor = withCi.reduce<CellStats | null>(
    (acc, c) => (acc === null || c.solveLo! > acc.solveLo! ? c : acc),
    null,
  );
  const solveTied =
    anchor !== null &&
    withCi.some(
      (c) =>
        c !== anchor &&
        overlaps({ lo: c.solveLo!, hi: c.solveHi! }, { lo: anchor.solveLo!, hi: anchor.solveHi! }),
    );

  const tieNote = solveTied
    ? `solve rate: tied — not distinguishable yet (${anchor!.harness} / ${anchor!.model} leads at ${Math.round(anchor!.solveHi! * 100)}% CI upper; ${withCi.length} cells within overlapping 95% CIs)`
    : null;

  return {
    cells: [...cells],
    solveTied,
    tieNote,
    winners: {
      solve: solveTied ? null : anchor ? `${anchor.harness} / ${anchor.model}` : null,
      costPerSolve: best(
        cells,
        (c) => c.costPerSolve,
        (a, b) => a < b,
      ),
      meanWallMs: best(
        cells,
        (c) => c.meanWallMs,
        (a, b) => a < b,
      ),
      turnsPerSolve: best(
        cells,
        (c) => c.turnsPerSolve,
        (a, b) => a < b,
      ),
      retryRate: best(
        cells,
        (c) => c.retryRate,
        (a, b) => a < b,
      ),
    },
  };
}

/** Human histogram text: every mode counted individually, never collapsed. */
export function histogramText(c: CellStats): string {
  return FAILURE_MODES.filter((m) => (c.failures[m] ?? 0) > 0)
    .map((m) => `${m} ${c.failures[m]}`)
    .join(" · ");
}
