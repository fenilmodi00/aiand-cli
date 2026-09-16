import { spawn } from "node:child_process";

/** How long a non-zero opener exit must arrive to count as spawn failure.
 * A real browser stays open far longer; xdg-open / open that cannot find a
 * handler typically exit in a few milliseconds. */
const QUICK_FAIL_MS = 50;

/** Open a URL in the default browser. Resolves false when no opener exists
 * (e.g. a bare WSL install); callers print the URL instead. Does not wait
 * for the opener process to exit — a successful spawn is enough. */
export function openBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
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

    const quick = setTimeout(() => {
      child.unref();
      settle(true);
    }, QUICK_FAIL_MS);

    child.once("error", () => {
      clearTimeout(quick);
      settle(false);
    });
    child.once("close", (code) => {
      if (settled) return;
      clearTimeout(quick);
      if (code === 0) {
        child.unref();
        settle(true);
        return;
      }
      settle(false);
    });
  });
}
