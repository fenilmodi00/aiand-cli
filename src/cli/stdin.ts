import { fstatSync } from "node:fs";

function hasPipedInput(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const stats = fstatSync(0);
    // FIFO covers shell pipes, files cover redirections — and sockets cover
    // parents that spawn us with socketpair stdio (notably Node's
    // child_process, whose pipes are AF_UNIX sockets, not FIFOs). Without
    // the socket branch, piped context from a Node parent is silently
    // dropped: `run` answers without it, `login --with-token` dies asking
    // for a pipe that is already there.
    return stats.isFIFO() || stats.isFile() || stats.isSocket();
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
