import { existsSync, writeFileSync } from "node:fs";
import { bool, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { currencySymbol, err, heading, json, out, style, table } from "../cli/output.js";
import { auditTask } from "../compare/audit.js";
import { runCompareRun } from "../compare/run.js";
import {
  hasRuns,
  readTaskRuns,
  taskTags,
  validateTags,
  writeTaskMeta,
} from "../compare/run-rows.js";
import { aggregateCells, type CellStats, tableWinners } from "../compare/table.js";
import { inferExportFormat, toCsvRows, toMarkdownTable } from "../compare/table-export.js";
import type { TaskVerdict } from "../compare/tasks.js";
import {
  listTaskIds,
  scaffoldTask,
  taskPath,
  taskStatus,
  tasksPath,
  validateTask,
} from "../compare/tasks.js";
import { TASK_CATEGORIES, type TaskCategory } from "../obs/classifier.js";
import { WINNER_MARKER } from "../obs/harness-stats.js";

export const help = `${style.bold("aiand compare")} -- replay your own tasks across harnesses

Usage
  aiand compare add <id> --verify "<cmd>"   scaffold tasks/<id>/ with a verify wrapper
  aiand compare tasks                       list task packs and their validation status
  aiand compare validate [--golden <dir>]   fail-before check + optional golden replay
  aiand compare run  --task <id>            replay across harnesses (--dry-run = free)
  aiand compare audit [--task <id>]         rubric audit of suspicious successes (advisory)
  aiand compare table [--task <id>] [--json] [--out <file>] [--format md|csv|json]

Options
  --verify "<cmd>"    command the verify wrapper runs (scaffolded)
  --tags "<a, b>"     optional classifier categories for cohort grouping
                      (e.g. "Debugging, Testing"); also editable as task.json
  --golden <dir>      recorded solution's file changes, replayed after fail-before
  --json              machine-readable output
  --out <file>        export the table to a file (implies --format by extension)
  --format <fmt>      export format: md (default), csv, json

A task pack is tasks/<id>/{instruction.md, workspace/, verify.sh} under the
config dir. Verify discipline: on an untouched workspace verify must FAIL
(fail-before — also the built-in null-harness control, scoring 0); after a
golden replay it must PASS. A checker may print \`SCORE: <0..1>\` for
partial credit. Instructions must not mention the verify script.`;

export async function run(argv: string[]): Promise<void> {
  const subcommand = argv[0];
  if (subcommand === "add") return runAdd(argv.slice(1));
  if (subcommand === "tasks") return runTasks(argv.slice(1));
  if (subcommand === "validate") return runValidate(argv.slice(1));
  if (subcommand === "cohorts") return runCohorts(argv.slice(1));
  if (subcommand === "run") return runCompareRun(argv.slice(1));
  if (subcommand === "audit") return runAudit(argv.slice(1));
  if (subcommand === "table") return runTable(argv.slice(1));
  if (subcommand === undefined || bool(parse(argv, {}), "help")) return out(help);
  throw new CliError(`Unknown subcommand "${subcommand}".`, {
    hint: "Try add, tasks, validate, or cohorts — or run with --help.",
  });
}

async function runAdd(argv: string[]): Promise<void> {
  const parsed = parse(argv, { verify: { type: "string" }, tags: { type: "string" } });
  const id = parsed.positionals[0];
  if (!id) {
    throw new CliError("Task id required.", {
      hint: 'Usage: aiand compare add <id> --verify "<cmd>"',
    });
  }
  const verifyCommand = str(parsed, "verify");
  if (!verifyCommand) {
    throw new CliError("--verify is required.", {
      hint: 'Usage: aiand compare add <id> --verify "npm test"',
    });
  }
  const tags = (str(parsed, "tags") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const badTag = validateTags(tags);
  if (badTag !== null) {
    throw new CliError(badTag, {
      hint: `Categories: ${TASK_CATEGORIES.join(", ")}.`,
    });
  }
  const dir = await scaffoldTask(id, verifyCommand);
  if (tags.length > 0) writeTaskMeta(id, { tags: tags as TaskCategory[] });
  if (bool(parsed, "json")) {
    json({ added: id, path: dir, tags: tags.length > 0 ? tags : undefined });
    return;
  }
  out(`Task "${id}" scaffolded at ${dir}`);
  if (tags.length > 0) out(style.dim(`tags: ${tags.join(", ")} (task.json — edit anytime)`));
  out(
    style.dim(
      "Edit instruction.md, put starting files in workspace/, then `aiand compare validate --golden <dir>`.",
    ),
  );
}

function runTasks(argv: string[]): void {
  const parsed = parse(argv, {});
  if (bool(parsed, "help")) {
    out(help);
    return;
  }
  const ids = listTaskIds();
  if (bool(parsed, "json")) {
    json({
      tasks: ids.map((id) => {
        const { status } = taskStatus(id);
        return { id, status };
      }),
    });
    return;
  }
  if (ids.length === 0) {
    out(style.dim('No task packs yet — add one with `aiand compare add <id> --verify "<cmd>"`.'));
    return;
  }
  for (const id of ids) {
    out(`  ${id.padEnd(24)} ${taskStatus(id).status}`);
  }
}

async function runValidate(argv: string[]): Promise<void> {
  const parsed = parse(argv, { golden: { type: "string" } });
  if (bool(parsed, "help")) return out(help);
  const goldenDir = str(parsed, "golden");
  const ids = parsed.positionals.length > 0 ? parsed.positionals : listTaskIds();
  if (ids.length === 0) {
    out(style.dim('No task packs yet — add one with `aiand compare add <id> --verify "<cmd>"`.'));
    return;
  }

  const results: { id: string; verdict: TaskVerdict }[] = [];
  for (const id of ids) {
    if (!existsSync(taskPath(id))) {
      throw new CliError(`Task "${id}" does not exist.`, {
        hint: `Known tasks live under ${tasksPath()}`,
      });
    }
    results.push({ id, verdict: await validateTask(id, goldenDir) });
  }

  const invalidCount = results.filter(({ verdict }) => verdict.valid === false).length;
  if (bool(parsed, "json")) {
    json({
      ok: invalidCount === 0,
      results: results.map(({ id, verdict }) => ({
        id,
        complete: verdict.complete,
        valid: verdict.valid,
        failBefore: verdict.failBefore,
        nullHarness: verdict.nullHarness,
        golden: verdict.golden,
        problems: verdict.problems,
      })),
    });
    if (invalidCount > 0) {
      throw new CliError(`${invalidCount} of ${results.length} task(s) failed validation.`);
    }
    return;
  }

  let invalid = 0;
  for (const { id, verdict } of results) {
    heading(id);
    if (!verdict.complete) {
      invalid++;
      for (const problem of verdict.problems) err(style.red(`  ✗ ${problem}`));
      continue;
    }
    out(
      `  fail-before:  ${verdict.failBefore?.ok ? style.green("✓ verify fails on untouched workspace") : style.red("✗ verify passed — task is trivially solvable")}`,
    );
    out(
      `  null-harness: ${verdict.nullHarness?.ok ? style.green("✓ scores 0") : style.red("✗ did not score 0")}`,
    );
    if (verdict.golden) {
      out(
        `  golden:       ${verdict.golden.ok ? style.green("✓ verify passes after replay") : style.red("✗ verify failed after replay")}`,
      );
    } else {
      out(
        style.dim("  golden:       not run (pass --golden <dir> to replay the recorded solution)"),
      );
    }
    if (verdict.problems.length > 0) {
      invalid++;
      for (const problem of verdict.problems) err(style.red(`  ✗ ${problem}`));
    }
  }
  if (invalid > 0) {
    throw new CliError(`${invalid} of ${results.length} task(s) failed validation.`, {
      hint: "An unvalidated or invalid task must not be used for harness runs.",
    });
  }
}

// ---------------------------------------------------------------------------
// `compare cohorts` — lane-B per-category breakdown (ticket #135)
// ---------------------------------------------------------------------------

/** One task's lane-B rollup over its run rows (infra excluded from solves). */
type TaskRollup = {
  id: string;
  tags: string[];
  runs: number;
  solves: number;
  trials: number;
  infra: number;
  costUsd: number | null;
  meanWallMs: number | null;
};

/** Roll one task's run rows up: solves exclude infra; nulls stay null. */
function rollupTask(id: string, tags: readonly string[]): TaskRollup {
  const rows = readTaskRuns(id);
  const trials = rows.filter((r) => r.failure_mode !== "infra");
  const solves = trials.filter((r) => r.success === true).length;
  const costs = rows.map((r) => r.cost_usd).filter((c): c is number => typeof c === "number");
  const walls = trials.map((r) => r.wall_ms).filter((w): w is number => typeof w === "number");
  return {
    id,
    tags: [...tags],
    runs: rows.length,
    solves,
    trials: trials.length,
    infra: rows.length - trials.length,
    costUsd: costs.length > 0 ? costs.reduce((s, c) => s + c, 0) : null,
    meanWallMs: walls.length > 0 ? walls.reduce((s, w) => s + w, 0) / walls.length : null,
  };
}

async function runCohorts(argv: string[]): Promise<void> {
  const parsed = parse(argv, { cohort: { type: "string" } });
  if (bool(parsed, "help")) return out(help);
  const cohort = str(parsed, "cohort");
  if (cohort !== undefined && !TASK_CATEGORIES.includes(cohort as TaskCategory)) {
    throw new CliError(`Unknown cohort "${cohort}".`, {
      hint: `Categories: ${TASK_CATEGORIES.join(", ")}.`,
    });
  }

  const ids = listTaskIds();
  const selected = ids.filter(
    (id) => cohort === undefined || taskTags(id).includes(cohort as TaskCategory),
  );
  const rollups = selected.map((id) => rollupTask(id, taskTags(id)));
  const runsAvailable = selected.some((id) => hasRuns(id));

  if (bool(parsed, "json")) {
    json({
      cohort: cohort ?? null,
      note: runsAvailable
        ? undefined
        : "no run rows yet — add per-task tags with `compare add --tags` / task.json; breakdown reflects task tags only",
      tasks: rollups,
    });
    return;
  }

  heading(cohort === undefined ? "compare · cohorts" : `compare · cohorts — ${cohort}`);
  if (selected.length === 0) {
    out(
      style.dim(
        cohort === undefined
          ? 'No task packs yet — add one with `aiand compare add <id> --verify "<cmd>"`.'
          : `No task tagged ${cohort} — tag task packs via \`compare add --tags\` or task.json.`,
      ),
    );
    return;
  }
  for (const r of rollups) {
    const solvesPart = r.trials > 0 ? `${r.solves}/${r.trials}` : "—";
    const costPart = r.costUsd === null ? "—" : `${currencySymbol("usd")}${r.costUsd.toFixed(4)}`;
    const wallPart = r.meanWallMs === null ? "—" : `${Math.round(r.meanWallMs)}ms`;
    const infraPart = r.infra > 0 ? ` · infra ${r.infra}` : "";
    out(`  ${r.id.padEnd(24)} [${r.tags.join(", ") || "untagged"}]`);
    if (r.runs === 0) {
      out(style.dim("    no run rows yet — solve/cost/wall appear once `compare run` exists"));
    } else {
      out(
        `    runs ${r.runs} · solve ${solvesPart} · cost ${costPart} · wall ${wallPart}${infraPart}`,
      );
    }
  }
  if (!runsAvailable) {
    out(
      style.dim(
        "run rows: none yet — the per-category solve/cost columns stay empty until `compare run` lands",
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// `compare audit` — opt-in rubric audit of suspicious successes (ticket #134)
// ---------------------------------------------------------------------------

async function runAudit(argv: string[]): Promise<void> {
  const parsed = parse(argv, { task: { type: "string" } });
  if (bool(parsed, "help")) return out(help);
  const task = str(parsed, "task");

  const ids = task === undefined ? listTaskIds() : [task];
  const audited = ids.map((id) => ({ id, runs: auditTask(id) })).filter((t) => t.runs.length > 0);

  if (bool(parsed, "json")) {
    json({
      // Deterministic-only v1: no gateway LLM call, no cost rows.
      note: "deterministic rubric (integrity flags, suspicious-success median heuristic, instruction sufficiency) — advisory only, never part of solve rate",
      tasks: audited,
    });
    return;
  }

  heading(task === undefined ? "compare · audit" : `compare · audit — ${task}`);
  if (audited.length === 0) {
    out(
      style.dim(task === undefined ? "No run rows to audit." : `No run rows to audit for ${task}.`),
    );
    return;
  }
  out(style.dim("  deterministic rubric — advisory only, never part of solve rate or rankings"));
  for (const { id, runs } of audited) {
    out(`  ${id}`);
    for (const r of runs) {
      const color =
        r.verdict === "FAIL"
          ? (v: string) => style.red(v)
          : r.verdict === "PASS"
            ? (v: string) => style.green(v)
            : (v: string) => v;
      out(
        `        ${color(r.verdict.padEnd(4))} ${r.run_id.padEnd(20)} ${r.harness.padEnd(12)}` +
          ` integrity:${r.criteria.integrity} suspicious:${r.criteria.suspicious} specification:${r.criteria.specification}`,
      );
      for (const reason of r.reasons) out(style.dim(`          ${reason}`));
    }
  }
}

// ---------------------------------------------------------------------------

const FAILURE_MODE_ORDER = [
  "agent_timeout",
  "verify_timeout",
  "parse_error",
  "context_exceeded",
  "integrity_violation",
] as const;

type FailureMode = (typeof FAILURE_MODE_ORDER)[number];

const pct = (p: number | null): string => (p === null ? "—" : `${(p * 100).toFixed(0)}%`);

const num2 = (v: number | null): string => (v === null ? "—" : v.toFixed(2));

/** The WINNER_MARKER discipline from harness compare — deterministic, works without color. */
const mark = (cell: string, isWinner: boolean): string =>
  isWinner ? `${WINNER_MARKER} ${cell}` : cell;

/** Render one histogram cell: every mode counted individually, never collapsed. */
function histogramCell(c: CellStats): string {
  const modes = FAILURE_MODE_ORDER.filter((m) => (c.failures[m] ?? 0) > 0).map(
    (m) => `${m} ${c.failures[m]}`,
  );
  if (modes.length === 0) return c.infra > 0 ? `infra ${c.infra}` : "—";
  return c.infra > 0 ? `${modes.join(" · ")} · infra ${c.infra}` : modes.join(" · ");
}

type TableJsonCell = {
  harness: string;
  model: string;
  tasks: number;
  trials: number;
  solves: number;
  solveRate: number | null;
  solveCi95: { lo: number; hi: number } | null;
  lowN: boolean;
  costUsd: number | null;
  costPerSolve: number | null;
  meanWallMs: number | null;
  turnsPerSolve: number | null;
  retryRate: number | null;
  failures: Partial<Record<FailureMode, number>>;
  infra: number;
};

function cellToJson(c: CellStats): TableJsonCell {
  return {
    harness: c.harness,
    model: c.model,
    tasks: c.tasks,
    trials: c.trials,
    solves: c.solves,
    solveRate: c.trials > 0 ? c.solves / c.trials : null,
    solveCi95: c.solveLo !== null && c.solveHi !== null ? { lo: c.solveLo, hi: c.solveHi } : null,
    lowN: c.lowN,
    costUsd: c.costUsd,
    costPerSolve: c.costPerSolve,
    meanWallMs: c.meanWallMs,
    turnsPerSolve: c.turnsPerSolve,
    retryRate: c.retryRate,
    failures: c.failures,
    infra: c.infra,
  };
}

async function runTable(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    task: { type: "string" },
    out: { type: "string" },
    format: { type: "string" },
  });
  if (bool(parsed, "help")) return out(help);

  const ids = str(parsed, "task") ? [str(parsed, "task")!] : listTaskIds();
  if (ids.length === 0) {
    out(
      style.dim(
        'No task packs yet — add one with `aiand compare add <id> --verify "<cmd>"` and run it with `compare run`.',
      ),
    );
    return;
  }

  const rows = ids.flatMap((id) => readTaskRuns(id));
  const cells = aggregateCells(rows);
  const { winners, solveTied, tieNote } = tableWinners(cells);

  if (bool(parsed, "json")) {
    json({
      task: str(parsed, "task") ?? null,
      cells: cells.map(cellToJson),
      solveTied,
      tieNote,
      winners,
      note:
        rows.length === 0
          ? "no run rows yet — run `aiand compare run --task <id>` first"
          : undefined,
    });
    return;
  }

  heading("compare · table");
  if (cells.length === 0) {
    out(style.dim("no run rows yet — run `aiand compare run --task <id>` first"));
    return;
  }

  const cellKey = (c: CellStats) => `${c.harness} / ${c.model}`;
  const w = winners;
  table<CellStats>(cells, [
    { header: "harness / model", value: (c) => cellKey(c) },
    {
      header: "solve",
      value: (c) =>
        mark(
          `${c.solves}/${c.trials} (${pct(c.solveLo)}–${pct(c.solveHi)}, n=${c.trials})${c.lowN ? " low n" : ""}`,
          w.solve === cellKey(c),
        ),
    },
    {
      header: "cost/solve",
      value: (c) =>
        mark(
          c.costPerSolve === null ? "—" : `${currencySymbol("usd")}${c.costPerSolve.toFixed(4)}`,
          w.costPerSolve === cellKey(c),
        ),
    },
    {
      header: "wall",
      value: (c) =>
        mark(
          c.meanWallMs === null ? "—" : `${Math.round(c.meanWallMs)}ms`,
          w.meanWallMs === cellKey(c),
        ),
    },
    {
      header: "turns/solve",
      value: (c) => mark(num2(c.turnsPerSolve), w.turnsPerSolve === cellKey(c)),
    },
    {
      header: "retries/solve",
      value: (c) => mark(num2(c.retryRate), w.retryRate === cellKey(c)),
    },
    { header: "failures", value: histogramCell },
  ]);
  if (tieNote !== null) out(style.dim(tieNote));
  const infraTotal = cells.reduce((s, c) => s + c.infra, 0);
  if (infraTotal > 0) out(style.dim(`infra runs excluded from solve rate: ${infraTotal}`));
  out(style.dim("▸ marks the per-column winner; — = not metered; CIs are Wilson 95%."));

  // Export reuses the shared serializers, preserving winners, n=, CIs, ties.
  const outPath = str(parsed, "out");
  if (outPath !== undefined) {
    const format = inferExportFormat(outPath, str(parsed, "format"));
    const aligns = ["left", "left", "right", "right", "right", "right", "left"] as const;
    const headers = [
      "harness / model",
      "solve",
      "cost/solve",
      "wall",
      "turns/solve",
      "retries/solve",
      "failures",
    ];
    const body = cells.map((c) => [
      cellKey(c),
      `${c.solves}/${c.trials} (${pct(c.solveLo)}–${pct(c.solveHi)}, n=${c.trials})${c.lowN ? " low n" : ""}`,
      c.costPerSolve === null ? "—" : c.costPerSolve.toFixed(4),
      c.meanWallMs === null ? "—" : `${Math.round(c.meanWallMs)}ms`,
      num2(c.turnsPerSolve),
      num2(c.retryRate),
      histogramCell(c),
    ]);
    let payload: string;
    if (format === "csv") {
      payload = [toCsvRows(headers, body).join("\n"), solveTied ? (tieNote ?? "") : ""].join("\n");
    } else if (format === "json") {
      payload = JSON.stringify(
        { cells: cells.map(cellToJson), solveTied, tieNote, winners },
        null,
        2,
      );
    } else {
      const lines = [
        ...toMarkdownTable(headers, [...aligns], body),
        ...(tieNote !== null ? ["", tieNote] : []),
      ];
      payload = lines.join("\n");
    }
    writeFileSync(outPath, `${payload}\n`);
    out(style.dim(`exported to ${outPath} (${format})`));
  }
}
