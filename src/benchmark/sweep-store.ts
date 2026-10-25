import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, writeFileAtomic } from "../fsutil.js";
import type { BenchResult } from "./harness-bench.js";

/**
 * Persistence for synthetic sweep results (ticket #79): `aiand harness
 * --sweep-models` saves its output here so `aiand harness matrix --synthetic`
 * can display the synthetic rows alongside the observed ones — DISPLAY only.
 *
 * The synthetic lane is never merged into observed aggregates and never
 * reaches `aiand recommend`: synthetic traffic is a fixed scenario replay,
 * not the user's workload, and mixing the two would poison the
 * "cheapest pair for you" framing (feature catalog C2). Consumers that only
 * want observed numbers simply never call `loadSavedSweep()`.
 */

/** The file, next to config.json in the config dir. */
export function sweepPath(): string {
  return join(configDir(), "bench-sweep.json");
}

export type SavedSweep = {
  savedAt: string;
  scenario: string;
  sweep: { model: string; results: BenchResult[] }[];
};

/** Save a sweep atomically; a failure to persist never fails the benchmark. */
export function saveSweep(
  sweep: { model: string; results: BenchResult[] }[],
  scenario: string,
): boolean {
  const payload: SavedSweep = {
    savedAt: new Date().toISOString(),
    scenario,
    sweep,
  };
  try {
    writeFileAtomic(sweepPath(), `${JSON.stringify(payload, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Load the last saved sweep; null when none (fail-open, never a throw). */
export function loadSavedSweep(): SavedSweep | null {
  try {
    const raw = JSON.parse(readFileSync(sweepPath(), "utf8")) as SavedSweep;
    if (!Array.isArray(raw?.sweep)) return null;
    return raw;
  } catch {
    return null;
  }
}
