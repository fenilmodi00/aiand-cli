import { fstatSync } from "node:fs";

type StdinStats = {
  isFIFO(): boolean;
  isFile(): boolean;
  isSocket(): boolean;
  mode: number;
};

/** Exported so tests can cover Windows anonymous-pipe mode bits (4096) on Linux CI. */
export function stdinLooksPiped(stats: StdinStats, isTTY: unknown): boolean {
  if (isTTY) return false;
  if (stats.isFIFO() || stats.isFile() || stats.isSocket()) return true;
  return (stats.mode & 0o170000) === 0o10000;
}

function hasPipedInput(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const stats = fstatSync(0);
    // FIFO covers shell pipes, files cover redirections — and sockets cover
    // parents that spawn us with socketpair stdio (notably Node's
    // child_process, whose pipes are AF_UNIX sockets, not FIFOs). Without
    // the socket branch, piped context from a Node parent is silently
    // dropped: `run` answers without it, `login --with-token` dies asking
    // for a pipe that is already there. On Windows, libuv reports anonymous
    // pipes as S_IFIFO in mode (4096) while isFIFO() stays false, so the
    // mode-bits fallback in stdinLooksPiped covers them.
    return stdinLooksPiped(stats, false);
  } catch {
    return false;
  }
}

export async function readStdin(): Promise<string | null> {
  if (!hasPipedInput()) return null;
  if (typeof process.stdin.resume === "function") process.stdin.resume();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length > 0 ? text : null;
}
