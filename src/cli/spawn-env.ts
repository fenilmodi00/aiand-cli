/**
 * The environment every child process of the CLI runs in.
 *
 * On Windows, cmd.exe tries the current directory before PATH for a bare
 * command, and an npm `.cmd` shim runs a bare `node` whenever no `node.exe`
 * sits beside it (the default Node installer keeps the shims in
 * `%APPDATA%\npm` and node.exe in Program Files, so that is the usual case).
 * Spawning the shim by absolute path therefore does not stop `cd evil-repo &&
 * aiand codex` from running a `node.exe` or `node.cmd` planted in the repo.
 * `NoDefaultCurrentDirectoryInExePath` is the Windows switch that makes
 * cmd.exe skip the current directory for those lookups. It is inherited, so
 * the agent's own children get it too. It does not cover a `.` or relative
 * entry in PATH, which cmd.exe still resolves under the current directory:
 * a shim launch drops those (`shimEnv` in win-spawn.ts).
 */

import { shimEnv } from "./win-spawn.js";

/** Windows' opt-out from searching the current directory for programs. */
export const NO_CWD_EXE_VAR = "NoDefaultCurrentDirectoryInExePath";

/** `env` with the current directory ruled out of program lookups on Windows. A
 * copied `process.env` loses Windows' case folding, so any other spelling of
 * the name is dropped rather than left to shadow ours. */
export function withNoCwdExeSearch(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() !== NO_CWD_EXE_VAR.toUpperCase()) next[key] = value;
  }
  next[NO_CWD_EXE_VAR] = "1";
  return next;
}

/** The environment for a child the CLI spawns. */
export function childEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return withNoCwdExeSearch(env, platform);
}

/** Set the switch on this process at startup, so a spawn that forgets
 * `childEnv` still inherits it. */
export function protectProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") env[NO_CWD_EXE_VAR] = "1";
}

/** The key that decrypts the file tier of the secret store. */
export const MASTER_KEY_VAR = "AIAND_SECRET_STORE_MASTER_KEY";

/** Secrets the CLI holds in its own environment; no system tool needs them. */
const SECRET_VARS = ["AIAND_API_KEY", MASTER_KEY_VAR];

/**
 * `env` for an agent (or the `npm install -g` that fetches one), minus the
 * CLI's own secrets. The agent's adapter injects the session key itself, and
 * a copy left in the environment reaches every process the agent starts, npm
 * install scripts included. `keep` names the ones a child of the agent still
 * needs.
 */
export function scrubAgentEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  { keep = [] }: { keep?: string[] } = {},
): NodeJS.ProcessEnv {
  // Windows folds the case of names, and a copied process.env does not, so
  // `aiand_api_key` there is the same variable as `AIAND_API_KEY`.
  const fold = (name: string): string => (platform === "win32" ? name.toUpperCase() : name);
  const secrets = SECRET_VARS.map(fold);
  const kept = keep.map(fold);
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!secrets.includes(fold(key)) || kept.includes(fold(key))) next[key] = value;
  }
  return next;
}

/** What a POSIX lookup falls back to when PATH holds no absolute entry. An
 * emptied PATH would not do: execvp reads an empty PATH as the current directory. */
const SAFE_POSIX_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** PATH with only its absolute entries. execvp, `which` and `command -v` read
 * an empty, `.` or relative entry as the current directory, so a cloned repo
 * could shadow `open`, `pgrep` or `security` with a file of its own. */
export function absolutePathOnly(
  path: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return path ?? "";
  const kept = (path ?? "").split(":").filter((entry) => entry.startsWith("/"));
  return kept.length > 0 ? kept.join(":") : SAFE_POSIX_PATH;
}

/**
 * `env` for an agent: PATH reduced to its absolute entries, on every platform.
 * The agent runs inside whatever directory the user is in, and `#!/usr/bin/env
 * node` or a Windows shim's bare `node` read an empty, `.` or relative entry as
 * that directory, so a clone could plant the program they run first.
 */
export function agentPathEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === "win32") return shimEnv(env);
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: absolutePathOnly(env[key], platform) };
}

/**
 * The environment for a system tool (`which`, `open`, `xdg-open`, `pgrep`,
 * `security`, `secret-tool`, `sqlite3`): childEnv, minus the CLI's own
 * secrets, and on POSIX a PATH of absolute entries only. Agents get childEnv
 * instead, since they need the caller's PATH and key as they are.
 */
export function systemToolEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_VARS.includes(key.toUpperCase())) next[key] = value;
  }
  if (platform !== "win32") {
    const pathKey = Object.keys(next).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    next[pathKey] = absolutePathOnly(next[pathKey], platform);
  }
  return withNoCwdExeSearch(next, platform);
}
