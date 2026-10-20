import { type ChildProcess, spawn } from "node:child_process";
import { CliError, EXIT } from "../cli/errors.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { resolveWindowsCommand } from "../cli/win-spawn.js";
import type { AgentAdapter } from "./types.js";

export function notInstalledError(adapter: AgentAdapter): CliError {
  return new CliError(`${adapter.label} is not installed.`, {
    exitCode: EXIT.NOT_FOUND,
    hint: `Install it with: ${adapter.install.command}\nSee: ${adapter.install.url}`,
  });
}

export async function installIfMissing(adapter: AgentAdapter): Promise<void> {
  if (adapter.detect().installed) return;
  const { command, url } = adapter.install;
  const [bin, ...args] = command.split(" ");
  if (bin !== "npm" || !isInteractive()) throw notInstalledError(adapter);
  const prompt = `${adapter.label} is not installed. Install it with ${command}?`;
  if (!(await confirm(prompt, { default: true }))) {
    throw notInstalledError(adapter);
  }

  const failed = (reason: string): CliError =>
    new CliError(`Installing ${adapter.label} failed: ${reason}.`, {
      exitCode: EXIT.NOT_FOUND,
      hint: `Install it yourself with: ${command}\nSee: ${url}`,
    });
  // Install scripts run third-party code: never hand them the session key.
  const env = { ...process.env };
  delete env.AIAND_API_KEY;
  const npm = await spawnChild(bin, args, { stdio: "inherit", env }).catch((error: Error) => ({
    error,
  }));
  if ("error" in npm) throw failed(npm.error.message);
  if (npm.status !== 0) throw failed(`npm exited with ${npm.status ?? "a signal"}`);
  if (!adapter.detect().installed) {
    throw new CliError(`${adapter.label} is installed, but ${adapter.bin} is not on your PATH.`, {
      exitCode: EXIT.NOT_FOUND,
      hint: "Add npm's global bin directory (under `npm prefix -g`) to PATH, then run this again.",
    });
  }
}

/**
 * The passthrough minus the adapter's own routing flags. Both launch paths
 * (run-agent and the bare-verb open) drop the user's `--flag value` and
 * `--flag=value` forms so the injected routing cannot be overridden.
 * Everything else passes verbatim. A value is only consumed when it is not
 * itself a flag, so `--model --print` keeps --print and a trailing `--model`
 * eats nothing.
 */
export function dropOwnedFlags(
  args: string[],
  ownedFlags: readonly string[] | undefined,
): string[] {
  if (ownedFlags === undefined || ownedFlags.length === 0) return [...args];
  const passthrough: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (ownedFlags.includes(token)) {
      // `--flag value`: the value is the next token, when present and not
      // itself a flag.
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) i += 1;
      continue;
    }
    if (ownedFlags.some((flag) => token.startsWith(`${flag}=`))) continue;
    passthrough.push(token);
  }
  return passthrough;
}

export async function runAgentBinary(
  adapter: AgentAdapter,
  args: string[],
  env: NodeJS.ProcessEnv,
  cleanup?: () => Promise<void>,
): Promise<void> {
  let cleaned = false;
  const doCleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await cleanup?.();
  };
  const onSigint = (): void => {
    void doCleanup().finally(() => process.exit(EXIT.INTERRUPTED));
  };
  const onSigterm = (): void => {
    void doCleanup().finally(() => process.exit(EXIT.TERMINATED));
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.stdin.pause();

  try {
    const { status, signal } = await spawnChild(adapter.bin, args, { env, stdio: "inherit" });
    process.exitCode = typeof status === "number" ? status : signal ? 1 : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notInstalledError(adapter);
    throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await doCleanup();
  }
}

function spawnChild(
  binary: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>();
  let child: ChildProcess;
  if (process.platform === "win32") {
    const resolved = resolveWindowsCommand(binary, args, options.env ?? process.env);
    if (!resolved) {
      reject(Object.assign(new Error(`spawn ${binary} ENOENT`), { code: "ENOENT" }));
      return promise;
    }
    child = spawn(resolved.command, resolved.args, {
      ...options,
      windowsVerbatimArguments: resolved.verbatim,
    });
  } else {
    child = spawn(binary, args, options);
  }
  child.once("error", reject);
  child.once("exit", (status, signal) => resolve({ status, signal }));
  return promise;
}
