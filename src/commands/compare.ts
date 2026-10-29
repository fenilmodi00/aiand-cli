import { existsSync } from "node:fs";
import { bool, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, heading, json, out, style } from "../cli/output.js";
import {
  listTaskIds,
  scaffoldTask,
  taskPath,
  taskStatus,
  tasksPath,
  validateTask,
} from "../compare/tasks.js";
import { runCompareRun } from "../compare/run.js";
import type { TaskVerdict } from "../compare/tasks.js";

export const help = `${style.bold("aiand compare")} -- replay your own tasks across harnesses

Usage
  aiand compare add <id> --verify "<cmd>"   scaffold tasks/<id>/ with a verify wrapper
  aiand compare tasks                       list task packs and their validation status
  aiand compare validate [--golden <dir>]   fail-before check + optional golden replay
  aiand compare run  --task <id>            replay across harnesses (--dry-run = free)
  aiand compare table [--task <id>]         (coming soon)

Options
  --verify "<cmd>"    command the verify wrapper runs (scaffolded)
  --golden <dir>      recorded solution's file changes, replayed after fail-before
  --json              machine-readable output

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
  if (subcommand === "run") return runCompareRun(argv.slice(1));
  if (subcommand === "table") {
    throw new CliError("`aiand compare table` is not implemented yet.", {
      hint: "Run rows land under compare-runs/; the table reads them (coming soon).",
    });
  }
  if (subcommand === undefined || bool(parse(argv, {}), "help")) return out(help);
  throw new CliError(`Unknown subcommand "${subcommand}".`, {
    hint: "Try add, tasks, or validate — or run with --help.",
  });
}

async function runAdd(argv: string[]): Promise<void> {
  const parsed = parse(argv, { verify: { type: "string" } });
  const id = parsed.positionals[0];
  if (!id) {
    throw new CliError("Task id required.", { hint: "Usage: aiand compare add <id> --verify \"<cmd>\"" });
  }
  const verifyCommand = str(parsed, "verify");
  if (!verifyCommand) {
    throw new CliError("--verify is required.", {
      hint: 'Usage: aiand compare add <id> --verify "npm test"',
    });
  }
  const dir = await scaffoldTask(id, verifyCommand);
  if (bool(parsed, "json")) {
    return json({ added: id, path: dir });
  }
  out(`Task "${id}" scaffolded at ${dir}`);
  out(style.dim("Edit instruction.md, put starting files in workspace/, then `aiand compare validate --golden <dir>`."));
}

function runTasks(argv: string[]): void {
  const parsed = parse(argv, {});
  if (bool(parsed, "help")) return out(help);
  const ids = listTaskIds();
  if (bool(parsed, "json")) {
    return json({
      tasks: ids.map((id) => {
        const { status } = taskStatus(id);
        return { id, status };
      }),
    });
  }
  if (ids.length === 0) {
    out(style.dim("No task packs yet — add one with `aiand compare add <id> --verify \"<cmd>\"`."));
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
    out(style.dim("No task packs yet — add one with `aiand compare add <id> --verify \"<cmd>\"`."));
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
    out(`  fail-before:  ${verdict.failBefore?.ok ? style.green("✓ verify fails on untouched workspace") : style.red("✗ verify passed — task is trivially solvable")}`);
    out(`  null-harness: ${verdict.nullHarness?.ok ? style.green("✓ scores 0") : style.red("✗ did not score 0")}`);
    if (verdict.golden) {
      out(`  golden:       ${verdict.golden.ok ? style.green("✓ verify passes after replay") : style.red("✗ verify failed after replay")}`);
    } else {
      out(style.dim("  golden:       not run (pass --golden <dir> to replay the recorded solution)"));
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
