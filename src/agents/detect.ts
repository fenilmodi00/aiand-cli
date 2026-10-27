import { existsSync } from "node:fs";
import path from "node:path";

import type { DetectResult } from "./types.js";

/** Windows executable extensions, in PATHEXT order. */
const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

/**
 * Probe whether a coding-agent binary is on PATH by scanning the PATH
 * directories directly instead of spawning `where`/`which`.
 *
 * WHY: spawnSync("where") measured ~330ms per call on Windows, and the menu
 * drew once per adapter-detection pass (16 spawns) — a ~5.3s black screen
 * before the menu painted. An existsSync scan resolves in microseconds.
 *
 * Bare-name cwd resolution is intentionally not supported: empty PATH
 * entries are skipped, so a name is only found in a listed directory,
 * matching how spawn resolves binaries closely enough for detection.
 */
export function detectBinary(bin: string): DetectResult {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
  // On win32 a bare name only executes via a PATHEXT extension; on POSIX the
  // file itself must exist and carry the executable bit (not probed here —
  // registry bins are fixed, well-known agent names).
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT?.split(path.delimiter) ?? DEFAULT_PATHEXT)]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.resolve(dir, bin + ext);
      if (existsSync(candidate)) return { installed: true, path: candidate };
    }
  }
  return { installed: false, path: null };
}
