import { type ChildProcess, spawn } from "node:child_process";
import { SECOND_MS } from "../time.js";
import { systemToolEnv } from "./spawn-env.js";
import { windowsSystemTool } from "./win-spawn.js";

/** How long to wait for an opener exit code before assuming it launched and
 * stayed open (real browsers outlive login). */
export const LAUNCH_OK_MS = 2 * SECOND_MS;

/**
 * The opener for `url`. Never `cmd /c start`: cmd re-parses `& | ^ < >` after
 * Node quoting, so a server-controlled URL would be a command-injection shape
 * on Windows. rundll32 FileProtocolHandler takes the URL as one argv entry,
 * and is spawned from System32 so the current directory is never searched.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") {
    return [windowsSystemTool("rundll32.exe", env), ["url.dll,FileProtocolHandler", url]];
  }
  return ["xdg-open", [url]];
}

/** Open a URL in the default browser. Resolves false when no opener exists
 * (e.g. a bare WSL install); callers print the URL instead. Waits for a
 * quick nonzero exit (missing handler); otherwise treats a still-running
 * opener as success after LAUNCH_OK_MS. AIAND_NO_BROWSER=1 skips the opener
 * entirely (test runs, a desktop whose browser isn't yours); `aiand login`
 * already skips it in an SSH session. `launchOkMs` exists for tests: on a
 * loaded machine, spawning a shell alone can outlast 2 s, and an exit-code
 * test needs a window it cannot miss. */
export function openBrowser(
  url: string,
  { launchOkMs = LAUNCH_OK_MS }: { launchOkMs?: number } = {},
): Promise<boolean> {
  if (process.env.AIAND_NO_BROWSER === "1") return Promise.resolve(false);
  const [command, args] = browserCommand(url, process.platform, process.env);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let launchTimer: NodeJS.Timeout | undefined;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (launchTimer) clearTimeout(launchTimer);
      resolve(ok);
    };

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env: systemToolEnv(),
        stdio: "ignore",
        detached: true,
      });
    } catch {
      settle(false);
      return;
    }

    launchTimer = setTimeout(() => {
      child.unref();
      settle(true);
    }, launchOkMs);

    child.once("error", () => settle(false));
    child.once("close", (code) => {
      if (settled) return;
      child.unref();
      settle(code === 0);
    });
  });
}
