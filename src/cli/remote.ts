import { readFileSync } from "node:fs";

type RemoteContextOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  readProcVersion?: () => string;
};

/**
 * Whether this process runs somewhere a locally-opened browser cannot reach the
 * user: an SSH session, or WSL (an opener exists, but the user's browser lives
 * on the Windows side). Sign-in flows use this to skip the opener and print the
 * URL directly instead of pretending a browser opened.
 *
 * WSL 1 and 2 both stamp "microsoft" into /proc/version — the conventional
 * detection signal.
 *
 * Options are test seams mirroring ambient values.
 */
export function isRemoteContext({
  env = process.env,
  platform = process.platform,
  readProcVersion = defaultReadProcVersion,
}: RemoteContextOptions = {}): boolean {
  if (
    env.SSH_CONNECTION?.trim() ||
    env.SSH_TTY?.trim() ||
    env.SSH_CLIENT?.trim()
  ) {
    return true;
  }
  return platform === "linux" && readProcVersion().toLowerCase().includes("microsoft");
}

function defaultReadProcVersion(): string {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}