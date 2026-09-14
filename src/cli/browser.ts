import { spawn } from "node:child_process";

/** Open a URL in the default browser. Resolves false when no opener exists
 * (e.g. a bare WSL install); callers print the URL instead. */
export function openBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  return new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      resolve(false);
      return;
    }
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
    child.once("error", () => {
      resolve(false);
    });
  });
}
