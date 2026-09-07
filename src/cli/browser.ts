import { spawn } from "node:child_process";
import { isRemoteContext } from "./remote.js";

export function openBrowser(url: string): boolean {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  try {
    const child = spawn(command as string, args as string[], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a sign-in approval URL in the user's browser where one is reachable
 * from this machine. On a remote context (SSH session or WSL) the browser
 * lives on the user's side, so the opener is skipped and a "remote" marker
 * is returned — the caller prints the URL for the user to open themselves
 * instead of pretending a browser opened.
 */
export function openBrowserAware(
  url: string,
  { remote = isRemoteContext() }: { remote?: boolean } = {}
): "opened" | "remote" {
  if (remote) return "remote";
  return openBrowser(url) ? "opened" : "remote";
}