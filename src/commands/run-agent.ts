import { spawn } from "node:child_process";

import { CliError } from "../cli/errors.js";
import { out, style } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { AGENTS, findAgent } from "../agents/registry.js";
import { getCatalog, resolveDefault } from "../agents/catalog.js";
import { requireSessionKey } from "../auth/session.js";

export const help = `${style.bold("aiand run-agent")} -- run a coding agent on ai& for one session

Usage
  aiand run-agent <agent> [--model <id>] [--] [args…]

Agents
${AGENTS.map((a) => `  ${a.id.padEnd(28)} ${a.label}`).join("\n")}

Options
      --model <id>       model from the catalog (default: the agent's own)
      --profile <name>   use a stored profile
      --base-url <url>   point at a different API endpoint
  -h, --help             show this help

Everything after \`--\` (and any bare positional before it) is passed to the
agent's binary verbatim — flags, files, and arguments are forwarded untouched.

Try: aiand run-agent claude -- --version`;

type Invocation = {
  agent: string | undefined;
  model: string | undefined;
  profile: string | undefined;
  baseUrl: string | undefined;
  help: boolean;
  passthrough: string[];
};

/**
 * Split raw argv without the strict parse() (the trailing args must reach the
 * agent's binary byte-for-byte, including unknown flags). The first `--` is
 * the hard boundary: everything before it is ours unless it is a bare
 * positional (relay's withPrependedPassthrough), everything after is
 * passthrough verbatim.
 */
function splitInvocation(argv: string[]): Invocation {
  const sep = argv.indexOf("--");
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const tail = sep === -1 ? [] : argv.slice(sep + 1);

  let agent: string | undefined;
  let model: string | undefined;
  let profile: string | undefined;
  let baseUrl: string | undefined;
  let help = false;
  const prepend: string[] = [];

  let i = 0;
  while (i < head.length) {
    const token = head[i]!;
    if (agent === undefined && !token.startsWith("-")) {
      agent = token;
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      i += 1;
    } else if (token === "--model") {
      model = takeValue(head, i, "--model");
      i += 2;
    } else if (token.startsWith("--model=")) {
      model = inlineValue(token, "--model");
      i += 1;
    } else if (token === "--profile") {
      profile = takeValue(head, i, "--profile");
      i += 2;
    } else if (token.startsWith("--profile=")) {
      profile = inlineValue(token, "--profile");
      i += 1;
    } else if (token === "--base-url") {
      baseUrl = takeValue(head, i, "--base-url");
      i += 2;
    } else if (token.startsWith("--base-url=")) {
      baseUrl = inlineValue(token, "--base-url");
      i += 1;
    } else {
      // Anything unrecognized before the separator (flags we don't own, bare
      // positionals) is still the agent's, prepended ahead of the tail args.
      prepend.push(token);
      i += 1;
    }
  }

  return { agent, model, profile, baseUrl, help, passthrough: [...prepend, ...tail] };
}

function takeValue(head: string[], i: number, name: string): string {
  const value = head[i + 1];
  if (value === undefined) throw new CliError(`--${name} needs a value.`);
  return value;
}

function inlineValue(token: string, name: string): string {
  const value = token.slice(name.length + 1);
  if (!value) throw new CliError(`--${name} needs a value.`);
  return value;
}

export async function run(argv: string[]): Promise<void> {
  const split = splitInvocation(argv);
  if (split.help) {
    out(help);
    return;
  }

  const agentName = split.agent;
  if (!agentName) {
    throw new CliError("run-agent needs a coding agent name.", {
      hint: "Usage: aiand run-agent <agent> [--model <id>] [--] [args…]\nTry: aiand run-agent claude -- --version",
    });
  }

  const adapter = findAgent(agentName);
  if (!adapter) {
    throw new CliError(`Unknown agent "${agentName}".`, {
      hint: `Agents: ${AGENTS.map((a) => a.id).join(", ")}`,
    });
  }

  // Session key first — a signed-out user gets the login flow before any
  // binary or catalog work, matching the engine's ordering.
  const session = await requireSessionKey(split.profile);

  const detected = adapter.detect();
  if (!detected.installed) {
    throw new CliError(`${adapter.label} is not installed.`, {
      exitCode: 127,
      hint: `Install it with: ${adapter.install.command}\nSee: ${adapter.install.url}`,
    });
  }

  if (!adapter.sessionLaunch) {
    throw new CliError(`${adapter.label} does not support session launches.`, {
      hint: `Run \`aiand ${adapter.id} on\` for permanent wiring.`,
    });
  }

  const profile = resolveProfile(split.profile);
  const catalog = await getCatalog(split.baseUrl ?? profile.apiUrl, null);

  // --model validated against the live catalog, else let the adapter fall back
  // to its own default. OpenCode is the one adapter whose session config NEEDS
  // a concrete model baked into OPENCODE_CONFIG_CONTENT, so resolve one there.
  let model: string | undefined;
  if (split.model !== undefined) {
    if (!catalog.some((entry) => entry.id === split.model)) {
      throw new CliError(`--model "${split.model}" is not in the catalog.`, {
        hint: `Valid ids: ${catalog.map((entry) => entry.id).join(", ")}`,
      });
    }
    model = split.model;
  } else if (adapter.id === "opencode") {
    model = resolveDefault(catalog);
  }

  const launch = await adapter.sessionLaunch({ apiKey: session.key, model, catalog });

  // Child env = inherited, minus everything the adapter wants cleared (so a
  // stray ANTHROPIC_API_KEY in the parent can never bypass the gateway
  // session), plus the adapter's injected keys.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of launch.clear) delete env[key];
  Object.assign(env, launch.env);

  try {
    const { status, signal } = await spawnChild(
      adapter.bin,
      [...(launch.args ?? []), ...split.passthrough],
      { env, stdio: "inherit", shell: process.platform === "win32" }
    );
    // Propagate the child's exit. Never process.exit here — the runtime flushes
    // stdio before the shell reads the code, and the dispatcher preserves
    // process.exitCode.
    process.exitCode = typeof status === "number" ? status : signal ? 1 : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`${adapter.label} is not installed.`, {
        exitCode: 127,
        hint: `Install it with: ${adapter.install.command}\nSee: ${adapter.install.url}`,
      });
    }
    throw error;
  } finally {
    // Always run the adapter's teardown, success or failure: it owns ephemeral
    // overlays/servers that must not outlive the session.
    await launch.cleanup?.();
  }
}

function spawnChild(
  binary: string,
  args: string[],
  options: Parameters<typeof spawn>[2]
): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>();
  const child = spawn(binary, args, options);
  child.once("error", reject);
  child.once("exit", (status, signal) => resolve({ status, signal }));
  return promise;
}