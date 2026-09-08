import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

import { CliError } from "../cli/errors.js";
import { err, style } from "../cli/output.js";
import { confirm, isInteractive } from "../cli/prompt.js";

/**
 * Quit-guard: the shared "is the desktop app that owns this config running?"
 * gate. ChatGPT Desktop shares ~/.codex/config.toml with the Codex CLI, and
 * Cursor keeps its AI settings inside state.vscdb; both apps hold their
 * config in memory while running and rewrite it on exit, silently clobbering
 * anything written underneath them. Adapters that write into such a config
 * call assertIdeStopped() first: a running app means a TTY confirm, a refusal
 * in non-interactive contexts, and --force escapes the guard entirely.
 */

export type QuitGuardSpec = {
  /** pgrep -f pattern used on darwin. */
  darwinPattern?: string;
  /** pgrep -f pattern used on linux (see linuxCmdlineMatches). */
  linuxPattern?: string;
  /** Optional filter over each hit's /proc cmdline — used to ignore Electron
   *  helper/GPU/utility children that only carry --type= flags. */
  linuxCmdlineMatches?: (cmdline: string) => boolean;
  /** tasklist image name (regex source) used on win32. */
  windowsImage?: string;
};

/**
 * ChatGPT Desktop. It reads the same ~/.codex/config.toml the Codex CLI
 * writes, so the codex adapter guards its writes with this spec. Linux has no
 * ChatGPT Desktop build, so the spec intentionally has no linuxPattern — the
 * guard becomes a no-op there.
 */
export const CHATGPT_DESKTOP_SPEC: QuitGuardSpec = {
  darwinPattern: "ChatGPT",
  windowsImage: "ChatGPT\\.exe",
};

/** Cursor IDE main process (helper children filtered via linuxCmdlineMatches). */
export const CURSOR_SPEC: QuitGuardSpec = {
  darwinPattern: "Cursor.app/Contents/MacOS/Cursor",
  // Unanchored with a trailing boundary so it matches the real install paths
  // (`/opt/cursor/cursor`, `/usr/share/cursor/cursor`, …); an anchored `^cursor`
  // would never match because the directory prefix precedes the binary name.
  linuxPattern: "[/]cursor([[:space:]]|$)",
  // Ignore Electron helper/GPU/utility children (`--type=…`); only the main
  // process owns the on-disk store.
  linuxCmdlineMatches: (cmdline) => !/\s--type=/.test(cmdline),
  windowsImage: "Cursor\\.exe",
};

/** Test seam: replaces the process probe inside isIdeRunning (null restores). */
let probeOverride: ((spec: QuitGuardSpec) => boolean) | null = null;

export function setIdeProbeForTests(probe: ((spec: QuitGuardSpec) => boolean) | null): void {
  probeOverride = probe;
}

function readLinuxCmdline(pid: string): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

function anyLinuxPgrepHitMatches(pgrepOutput: string, cmdlineMatches: (cmdline: string) => boolean): boolean {
  for (const pid of pgrepOutput.trim().split("\n")) {
    if (!pid) continue;
    const cmdline = readLinuxCmdline(pid);
    if (cmdline && cmdlineMatches(cmdline)) return true;
  }
  return false;
}

/**
 * True if the app described by `spec` has a GUI process running. tasklist
 * lists image names in column 0, so the win32 match anchors at line start and
 * requires a word boundary — matching a whole image name and not a substring
 * (e.g. VSCode.exe must not count as Code.exe).
 */
export function isIdeRunning(spec: QuitGuardSpec): boolean {
  if (probeOverride) return probeOverride(spec);
  try {
    if (platform() === "win32") {
      if (!spec.windowsImage) return false;
      const r = spawnSync("tasklist", ["/NH"], { encoding: "utf8" });
      const re = new RegExp(`^\\s*${spec.windowsImage}\\b`, "im");
      return r.status === 0 && re.test(r.stdout || "");
    }
    const pattern = platform() === "darwin" ? spec.darwinPattern : spec.linuxPattern;
    if (!pattern) return false;
    const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout.trim()) return false;
    if (platform() === "linux" && spec.linuxCmdlineMatches) {
      return anyLinuxPgrepHitMatches(r.stdout, spec.linuxCmdlineMatches);
    }
    return true;
  } catch {
    // A failed probe (missing pgrep, tasklist hiccup) must never wedge `on`.
    return false;
  }
}

/**
 * Refuse to write while the app is running (it would clobber the write on
 * exit). TTY gets a confirm; scripts get a CliError naming --force; --force
 * itself warns and proceeds.
 */
export async function assertIdeStopped(
  spec: QuitGuardSpec,
  label: string,
  opts: { force?: boolean } = {}
): Promise<void> {
  const running = isIdeRunning(spec);
  if (!running) return;

  if (opts.force) {
    err(style.yellow(`${label} is running; writing anyway (--force).`));
    return;
  }
  if (isInteractive()) {
    const proceed = await confirm(
      `${label} is running and will overwrite this config. Quit it first — continue anyway?`,
      { default: false }
    );
    if (!proceed) throw new CliError("Keeping your existing config.");
    return;
  }
  throw new CliError(`${label} is running and will overwrite this config. Quit it and rerun.`, {
    hint: "Pass --force to write anyway.",
  });
}
