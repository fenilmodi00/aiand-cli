// Node reads NODE_USE_ENV_PROXY only at startup, so enabling env proxies requires a relaunch.

export const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
export const RELAUNCH_MARKER = "AIAND_PROXY_RELAUNCHED";

function configuredProxy(env: NodeJS.ProcessEnv): (typeof PROXY_VARS)[number] | undefined {
  return PROXY_VARS.find((name) => env[name] !== undefined && env[name] !== "");
}

export function nodeSupportsEnvProxy(version: string): boolean {
  const match = /^v(\d+)\.(\d+)\.\d+$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 21);
}

export function relaunchPlan(opts: {
  env: NodeJS.ProcessEnv;
  execPath: string;
  execArgv: string[];
  argv: string[];
  version: string;
}): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  const { env } = opts;
  if (
    configuredProxy(env) === undefined ||
    env.NODE_USE_ENV_PROXY === "1" ||
    env[RELAUNCH_MARKER] === "1" ||
    !nodeSupportsEnvProxy(opts.version)
  ) {
    return null;
  }
  const execArgv = opts.execArgv.includes("--use-system-ca")
    ? opts.execArgv
    : ["--use-system-ca", ...opts.execArgv];
  return {
    cmd: opts.execPath,
    args: [...execArgv, ...opts.argv.slice(1)],
    env: { ...env, NODE_USE_ENV_PROXY: "1", [RELAUNCH_MARKER]: "1" },
  };
}

export function proxyUnsupportedWarning(env: NodeJS.ProcessEnv, version: string): string | null {
  const name = configuredProxy(env);
  if (name === undefined || env.NODE_USE_ENV_PROXY === "1" || nodeSupportsEnvProxy(version)) {
    return null;
  }
  return `A proxy is set (${name}), but Node ${version} can't send requests through it. Install Node 22.21 or later.`;
}

/**
 * Whether the relaunching parent passes SIGINT on to the child. A terminal's Ctrl-C
 * already reaches the child, which shares the terminal's process group; passing it on
 * as well reads as a second Ctrl-C, and some agents (Claude Code) exit on that.
 */
export function forwardsInterrupt(stdinIsTerminal: boolean): boolean {
  return !stdinIsTerminal;
}
