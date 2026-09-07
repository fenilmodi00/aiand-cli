import { spawn, type ChildProcess } from "node:child_process";

type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: ("pipe" | "ignore")[] }
) => ChildProcess;

type ClipboardOptions = {
  platform?: string;
  spawnFn?: SpawnLike;
};

function platformCandidates(platform: string): Array<[string, string[]]> {
  if (platform === "darwin") return [["pbcopy", []]];
  if (platform === "win32") return [["clip", []]];
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
  ];
}

/**
 * Copy `text` to the system clipboard. Tries each candidate opener in order
 * (Wayland before X11 on Linux) until one starts and exits 0. Never throws;
 * returns false when every candidate fails or none exist.
 *
 * `spawnFn` is a test seam; the default is node:child_process.spawn.
 */
export function copyToClipboard(
  text: string,
  { platform = process.platform, spawnFn = spawn }: ClipboardOptions = {}
): Promise<boolean> {
  const candidates = platformCandidates(platform);

  return candidates.reduce(
    (prev, [command, args]) =>
      prev.then((ok) => (ok ? true : tryOne(command, args, text, spawnFn))),
    Promise.resolve(false)
  );
}

function tryOne(
  command: string,
  args: string[],
  text: string,
  spawnFn: SpawnLike
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let child: ChildProcess;
  try {
    child = spawnFn(command, args, {
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {
    resolve(false);
    return promise;
  }
  child.on("error", () => resolve(false));
  child.on("close", (code) => resolve(code === 0));
  child.stdin?.on("error", () => {});
  child.stdin?.end(text);
  return promise;
}