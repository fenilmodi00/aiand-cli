import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../fsutil.js";
import { TASK_CATEGORIES, type TaskCategory } from "../obs/classifier.js";
import { taskPath } from "./tasks.js";

/**
 * Lane-B run rows and task tags for the cohort + export surface (ticket #135).
 *
 * The run rows live at compare-runs/<task>.jsonl — one JSON object per line,
 * the plan §1 lane-B row shape, written by `compare run` (ticket #136). This
 * module only READS: every reader is fail-open so `compare cohorts` and the
 * compare table degrade honestly (empty, never an error) while the run
 * surface is absent or a row is corrupt. Run rows with `failure_mode: infra`
 * are surfaced but never counted as solves; nulls mean "not metered", never 0.
 */

const RUNS_DIR = "compare-runs";

export type CompareRunRow = {
  run_id: string;
  ts: string;
  harness: string;
  harness_version: string | null;
  model: string;
  task: string;
  success: boolean | null;
  score: number | null;
  failure_mode:
    | "agent_timeout"
    | "verify_timeout"
    | "parse_error"
    | "context_exceeded"
    | "infra"
    | "integrity_violation"
    | null;
  completed: boolean;
  wall_ms: number;
  turns: number | null;
  retries: number | null;
  tokens_in: number | null;
  tokens_cached: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  token_basis: string | null;
  cost_basis: string | null;
  request_ids: string[];
  verify_exit: number | null;
};

/** The compare-runs root under the config dir (created on first write). */
export function runsPath(): string {
  return join(configDir(), RUNS_DIR);
}

/** A task's run-row JSONL. */
function taskRunsPath(id: string): string {
  return join(runsPath(), `${id}.jsonl`);
}

/** Does any run-row file exist for this task? Guard for the absent run surface. */
export function hasRuns(id: string): boolean {
  return existsSync(taskRunsPath(id));
}

/** Parse one JSONL of run rows; corrupt lines are skipped, never fatal. */
export function parseRunRows(content: string): CompareRunRow[] {
  const rows: CompareRunRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const row = JSON.parse(trimmed) as CompareRunRow;
      if (typeof row === "object" && row !== null && typeof row.harness === "string") {
        rows.push(row);
      }
    } catch {
      // corrupt line → skipped (fail-open read contract)
    }
  }
  return rows;
}

/** Read a task's run rows; [] when the file is absent or unreadable. */
export function readTaskRuns(id: string): CompareRunRow[] {
  try {
    return parseRunRows(readFileSync(taskRunsPath(id), "utf8"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Task tags (C6 for lane B): categories from the same classifier taxonomy
// ---------------------------------------------------------------------------

/** The optional task metadata file (created by `compare add --tags`, hand-editable). */
const TASK_META_FILE = "task.json";

export type TaskMeta = {
  /** Classifier categories this task belongs to (same taxonomy as --cohort). */
  tags?: TaskCategory[];
};

function taskMetaPath(id: string): string {
  return join(taskPath(id), TASK_META_FILE);
}

/** Read task.json; {} when absent/corrupt (fail open — tags are optional). */
function readTaskMeta(id: string): TaskMeta {
  try {
    const raw = JSON.parse(readFileSync(taskMetaPath(id), "utf8")) as TaskMeta;
    if (typeof raw !== "object" || raw === null) return {};
    return raw;
  } catch {
    return {};
  }
}

/** Write task.json for a task dir; no-op when the task dir doesn't exist. */
export function writeTaskMeta(id: string, meta: TaskMeta): void {
  if (!existsSync(taskPath(id))) return;
  writeMetaFile(taskMetaPath(id), meta);
}

function writeMetaFile(path: string, meta: TaskMeta): void {
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
}

/** Validate a tags list against the classifier taxonomy; error message on bad. */
export function validateTags(tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (!TASK_CATEGORIES.includes(tag as TaskCategory)) {
      return `Unknown tag "${tag}".`;
    }
  }
  return null;
}

/** The tags of one task, sorted; [] when absent (tags are optional). */
export function taskTags(id: string): TaskCategory[] {
  const tags = readTaskMeta(id).tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is TaskCategory => TASK_CATEGORIES.includes(t)).sort();
}
