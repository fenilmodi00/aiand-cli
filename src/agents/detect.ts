import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { posix } from "node:path";

import { systemToolEnv } from "../cli/spawn-env.js";
import { findWindowsExecutable } from "../cli/win-spawn.js";
import type { DetectResult } from "./types.js";

/**
 * Probe whether a coding-agent binary is on PATH. A binary that resolves only
 * through the current directory counts as missing: a cloned repo must not be
 * able to plant one.
 */
export function detectBinary(bin: string): DetectResult {
  const path = findOnPath(bin);
  return path === null ? { installed: false, path: null } : { installed: true, path };
}

/** The absolute path `bin` resolves to on PATH, never a current-directory hit, or null. */
export function findOnPath(bin: string): string | null {
  if (process.platform === "win32") return findWindowsExecutable(bin, process.env);
  const probe = spawnSync("which", ["-a", bin], { encoding: "utf8", env: systemToolEnv() });
  if (probe.error || probe.status !== 0) return null;
  return pickPosixHit(probe.stdout, process.env.PATH ?? "", process.cwd(), realpathOr);
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The first `which -a` line that is not a current-directory hit. POSIX
 * searches the current directory only through an empty, `.` or relative PATH
 * entry, so a relative result is refused outright. An absolute result inside
 * the current directory is kept only when that directory is itself an
 * absolute PATH entry: then the user put it there on purpose (`cd ~/bin`),
 * and the shell would run the same file.
 */
export function pickPosixHit(
  whichOutput: string,
  pathEnv: string,
  cwd: string,
  realpath: (path: string) => string = (path) => path,
): string | null {
  const here = realpath(posix.resolve(cwd));
  const cwdOnPath = pathEnv
    .split(":")
    .some((entry) => posix.isAbsolute(entry) && realpath(posix.resolve(entry)) === here);
  return (
    whichOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(
        (line) => posix.isAbsolute(line) && (cwdOnPath || realpath(posix.dirname(line)) !== here),
      ) ?? null
  );
}
