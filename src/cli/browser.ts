import { spawn } from "node:child_process";

/** Open a URL in the default browser. Returns false when no opener exists
 * (e.g. a bare WSL install); callers print the URL instead. */
export function openBrowser(url: string): boolean {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  try {
    const child = spawn(command, args, {
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
