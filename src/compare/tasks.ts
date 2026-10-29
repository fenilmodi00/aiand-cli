import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CliError } from "../cli/errors.js";
import { configDir, writeFileAtomic } from "../fsutil.js";

/**
 * Personal task packs for harness comparison (ticket #129, plan §2.2): a task
 * is a directory `tasks/<id>/{instruction.md, workspace/, verify.sh}` under
 * the config dir (same data-dir resolution as bench-sweep.json). The layout
 * is the OpenBench shape, simplified to zero config: instruction the agent
 * reads, a workspace copied fresh per run, and a verify script whose exit
 * code — never the harness's own claim — decides success.
 *
 * Privacy: task packs never leave the machine; they are plain local files.
 * Instructions must not reference the verify script (the validator rejects
 * that), so a replayed agent cannot learn how it is graded.
 */

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INSTRUCTION_FILE = "instruction.md";
const VERIFY_FILE = "verify.sh";
const VALIDATION_FILE = "validation.json";
/** A SCORE line must be a number in [0, 1]; anything else is ignored. */
const SCORE_RE = /^SCORE:\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/;

/** The tasks root, next to config.json in the config dir. */
export function tasksPath(): string {
  return join(configDir(), "tasks");
}

export function taskPath(id: string): string {
  return join(tasksPath(), id);
}

export type TaskValidation = {
  /** Fail-before check ran and the verify script failed on the untouched workspace. */
  failBefore?: { ok: boolean; at: string };
  /** Null-harness control: the no-op run scored 0 (verify failed untouched). */
  nullHarness?: { ok: boolean; score: number; at: string };
  /** Golden replay passed on a fresh workspace copy. */
  golden?: { ok: boolean; path: string; at: string };
};

/** Task ids with a directory under tasks/, sorted. Empty when none. */
export function listTaskIds(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(tasksPath());
  } catch {
    return [];
  }
  return entries
    .filter((id) => {
      try {
        return statSync(join(tasksPath(), id)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Read validation.json for a task dir; null when absent/corrupt (fail open). */
export function readValidation(dir: string): TaskValidation | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, VALIDATION_FILE), "utf8")) as TaskValidation;
    if (typeof raw !== "object" || raw === null) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeValidation(dir: string, validation: TaskValidation): Promise<void> {
  return writeFileAtomic(join(dir, VALIDATION_FILE), `${JSON.stringify(validation, null, 2)}\n`);
}

/** Files every task needs; anything missing means the pack is malformed. */
export function missingTaskFiles(dir: string): string[] {
  const missing: string[] = [];
  for (const file of [INSTRUCTION_FILE, VERIFY_FILE, "workspace"]) {
    if (!existsSync(join(dir, file))) missing.push(file);
  }
  return missing;
}

/**
 * `compare add`: scaffold tasks/<id>/ from a verify command. The wrapper
 * captures the command's output so a `SCORE: <0..1>` line survives for
 * partial credit, and forwards its exit code untouched.
 */
export async function scaffoldTask(id: string, verifyCommand: string): Promise<string> {
  if (!TASK_ID_RE.test(id)) {
    throw new CliError(`Invalid task id "${id}".`, {
      hint: "Use letters, digits, dots, dashes, or underscores — it becomes a directory name.",
    });
  }
  const dir = taskPath(id);
  if (existsSync(dir)) {
    throw new CliError(`Task "${id}" already exists: ${dir}`, {
      hint: "Pick another id, or delete the directory first.",
    });
  }
  mkdirSync(join(dir, "workspace"), { recursive: true, mode: 0o700 });

  const instruction = `# Task: ${id}

Describe the change the agent must make inside \`workspace/\` — files to
touch, behavior to reach. Keep it self-contained: the agent sees only this
text and the workspace contents.

## Done

The workspace is left in a state where the project's own checks pass.
If the checker reports partial credit, it prints \`SCORE: <0..1>\` on
stdout (1 = fully solved); without one, passing is all-or-nothing.
`;
  const verify = `#!/bin/sh
# Verify wrapper for task '${id}' (scaffolded by \`aiand compare add\`).
# Exit 0 = the task passes. If the wrapped command prints a
# \`SCORE: <0..1>\` line it is forwarded for partial-credit runs.
out=$(${verifyCommand} 2>&1)
status=$?
printf '%s\\n' "$out"
score=$(printf '%s\\n' "$out" | grep -E '^SCORE:[[:space:]]*[01](\\.[0-9]+)?[[:space:]]*$' | tail -n 1)
[ -n "$score" ] && printf '%s\\n' "$score"
exit $status
`;
  await writeFileAtomic(join(dir, INSTRUCTION_FILE), instruction);
  await writeFileAtomic(join(dir, VERIFY_FILE), verify);
  chmodSync(join(dir, VERIFY_FILE), 0o755);
  return dir;
}

export type VerifyResult = { ok: boolean; exitCode: number | null; output: string; score: number };

/** First valid SCORE line in the output, clamped to [0, 1]; 0 otherwise. */
export function extractScore(output: string): number {
  for (const line of output.split("\n")) {
    const m = SCORE_RE.exec(line.trim());
    if (m) {
      const score = Number(m[1]);
      return Number.isNaN(score) ? 0 : Math.min(1, Math.max(0, score));
    }
  }
  return 0;
}

/** Run a task's verify script in `cwd` (the workspace root under test). */
export function runVerify(dir: string, cwd?: string): VerifyResult {
  const script = join(dir, VERIFY_FILE);
  const proc = spawnSync("sh", [script], {
    cwd: cwd ?? dir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CliError("Could not run verify.sh — no POSIX shell (sh) on PATH.", {
        hint: "Install Git for Windows (it ships sh) or run on a POSIX shell.",
      });
    }
    throw new CliError(`Could not run verify.sh: ${proc.error.message}`);
  }
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  return {
    ok: proc.status === 0,
    exitCode: proc.status,
    output,
    score: extractScore(output),
  };
}

export type TaskVerdict = {
  id: string;
  /** Task files present. */
  complete: boolean;
  failBefore: { ok: boolean; score: number } | null;
  nullHarness: { ok: boolean; score: number } | null;
  golden: { ok: boolean } | null;
  /** true = validated; false = invalid (a check failed); null = not yet fully validated. */
  valid: boolean | null;
  problems: string[];
};

/**
 * `compare validate` for one task: fail-before (verify must FAIL on the
 * untouched workspace — this is also the built-in null-harness control, a
 * no-op run scoring 0), then optionally the golden replay (recorded
 * solution's files copied onto a fresh workspace copy; verify must PASS).
 * Persists the verdict to validation.json so `compare tasks` can report it.
 */
export async function validateTask(id: string, goldenDir?: string): Promise<TaskVerdict> {
  const dir = taskPath(id);
  const verdict: TaskVerdict = {
    id,
    complete: true,
    failBefore: null,
    nullHarness: null,
    golden: null,
    valid: null,
    problems: [],
  };

  const missing = missingTaskFiles(dir);
  if (missing.length > 0) {
    verdict.complete = false;
    verdict.valid = false;
    verdict.problems.push(`missing ${missing.join(", ")}`);
    return verdict;
  }

  const instruction = readFileSync(join(dir, INSTRUCTION_FILE), "utf8");
  if (/\bverify(\.sh)?\b/i.test(instruction)) {
    verdict.complete = false;
    verdict.valid = false;
    verdict.problems.push("instruction.md references the verify script — agents must not see how they are graded");
    return verdict;
  }

  // (a)/(c) Fail-before == null-harness control: untouched workspace, the
  // no-op harness scores 0, so verify must fail. A passing run means the
  // task is trivially solvable and therefore invalid.
  const untouched = runVerify(dir);
  const controlOk = !untouched.ok;
  verdict.failBefore = { ok: controlOk, score: untouched.score };
  verdict.nullHarness = { ok: controlOk, score: controlOk ? 0 : untouched.score };
  if (!controlOk) {
    verdict.valid = false;
    verdict.problems.push(
      `verify passed (exit 0) on the untouched workspace — the task is trivially solvable` +
        (untouched.score > 0 ? ` (score ${untouched.score})` : ""),
    );
  }

  const validation: TaskValidation = {
    failBefore: { ok: controlOk, at: new Date().toISOString() },
    nullHarness: { ok: controlOk, score: controlOk ? 0 : untouched.score, at: new Date().toISOString() },
  };

  if (controlOk && goldenDir !== undefined) {
    if (!existsSync(goldenDir)) {
      throw new CliError(`Golden dir not found: ${goldenDir}`, {
        hint: "Pass a directory holding the recorded solution's file changes.",
      });
    }
    const passAfter = replayGolden(dir, goldenDir);
    verdict.golden = { ok: passAfter.ok };
    validation.golden = { ok: passAfter.ok, path: goldenDir, at: new Date().toISOString() };
    if (!passAfter.ok) {
      verdict.valid = false;
      verdict.problems.push(
        `golden replay failed (verify exited ${passAfter.exitCode ?? "?"} on the replayed workspace)`,
      );
    }
  }

  if (verdict.valid === null && controlOk) {
    verdict.valid = verdict.golden ? true : null; // golden replay decides full validation
  }
  if (verdict.valid === null && verdict.golden === null) {
    verdict.problems.push("not fully validated — re-run with --golden <dir> to replay the recorded solution");
  }
  await writeValidation(dir, validation);
  return verdict;
}

/**
 * (b) Golden replay: copy workspace/ fresh, overlay the recorded solution's
 * file changes, run verify there. Must PASS for the task to validate.
 */
function replayGolden(taskDir: string, goldenDir: string): VerifyResult {
  const runDir = mkdtempSync(join(tmpdir(), `aiand-compare-${basename(taskDir)}-`));
  try {
    cpSync(join(taskDir, "workspace"), runDir, { recursive: true });
    cpSync(goldenDir, runDir, { recursive: true, force: true });
    return runVerify(taskDir, runDir);
  } finally {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Validation status for `compare tasks`, from the persisted verdict. */
export function taskStatus(id: string): { status: string; missing: string[] } {
  const dir = taskPath(id);
  const missing = missingTaskFiles(dir);
  if (missing.length > 0) return { status: "incomplete", missing };
  const validation = readValidation(dir);
  if (!validation) return { status: "unvalidated", missing: [] };
  if (validation.golden && !validation.golden.ok) return { status: "invalid", missing: [] };
  if (!validation.failBefore?.ok) return { status: "invalid", missing: [] };
  if (validation.golden) {
    if (!existsSync(validation.golden.path)) return { status: "golden-missing", missing: [] };
    return { status: "validated", missing: [] };
  }
  return { status: "unvalidated", missing: [] };
}
