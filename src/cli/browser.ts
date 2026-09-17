import { spawn } from "node:child_process";

/** How long to wait for an opener exit code before assuming it launched and
 * stayed open (real browsers outlive login). */
const LAUNCH_OK_MS = 2000;

/** Open a URL in the default browser. Resolves false when no opener exists
 * (e.g. a bare WSL install); callers print the URL instead. Waits for a
 * quick nonzero exit (missing handler); otherwise treats a still-running
 * opener as success after LAUNCH_OK_MS. */
export function openBrowser(url: string): Promise<boolean> {
  // Never `cmd /c start`: cmd re-parses `& | ^ < >` after Node quoting, so a
  // server-controlled URL would be a command-injection shape on Windows.
  // rundll32 FileProtocolHandler takes the URL as one argv entry.
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let launchTimer: NodeJS.Timeout | undefined;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (launchTimer) clearTimeout(launchTimer);
      resolve(ok);
    };

    let child;
    try {
      child = spawn(command, args, {
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
    }, LAUNCH_OK_MS);

    child.once("error", () => settle(false));
    child.once("close", (code) => {
      if (settled) return;
      child.unref();
      settle(code === 0);
    });
  });
}
