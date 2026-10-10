#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findAgent } from "./agents/registry.js";
import { VERSION } from "./api/client.js";
import { ApiError, CliError, EXIT } from "./cli/errors.js";
import { err, out, style } from "./cli/output.js";
import { isInteractive } from "./cli/prompt.js";
import { printBanner } from "./cli/ui/banner.js";
import { runLauncherMenu } from "./cli/ui/menu.js";
import { agentHelp, runAgentCommand } from "./commands/agent.js";
import { COMMANDS, findCommand, suggest } from "./commands/index.js";
import { configDir } from "./fsutil.js";
import { finalizeOnVersionChange } from "./housekeeping/finalize.js";
import { checkForUpdate } from "./housekeeping/update.js";

const USAGE = `${style.bold("aiand")} -- the ai& command line interface

  aiand                          pick what to run (launcher menu)
  aiand <command> [options]
  aiand <agent> [on|off|status] [options]

Commands
${COMMANDS.map((c) => `  ${c.name.padEnd(9)} ${c.summary}`).join("\n")}

Agents
  aiand <agent> on|off|status    wire a coding agent to ai&
  aiand init                     detect and wire agents
  aiand run-agent <agent>        run a coding agent for one session
  aiand status                   show auth and agent wiring

Global options
  --profile <name>    use a stored profile
  --base-url <url>    point at a different API endpoint
  --json              machine-readable output
  -h, --help          help for any command
  -v, --version       print the version

Get started
  aiand login
  aiand run "hello"

Run \`aiand <command> --help\` for a command's own flags.`;

function showHelp(topicHelp?: string): void {
  printBanner({ version: VERSION });
  out("");
  out(topicHelp ?? USAGE);
}

/** The command that upgrades this install: the installer for a launcher
 * install, npm otherwise. */
export function updateInstallHint(opts?: {
  platform?: NodeJS.Platform;
  launched?: string;
  aiandDir?: string | undefined;
}): string {
  const platform = opts?.platform ?? process.platform;
  // Copy-pasteable: curl users have no install.sh on PATH.
  const installHint =
    platform === "win32"
      ? '& "$env:USERPROFILE\\.aiand\\cli\\install.ps1"'
      : "bash ~/.aiand/cli/install.sh";
  const launched = opts?.launched ?? process.argv[1] ?? "";
  const normalizedLaunched = launched.replace(/\\/g, "/");
  if (normalizedLaunched.includes("/.aiand/")) {
    return installHint;
  }
  const aiandDir = opts?.aiandDir ?? process.env.AIAND_DIR;
  if (aiandDir) {
    const normalizedDir = aiandDir.replace(/\\/g, "/").replace(/\/+$/, "");
    const trimmedLaunched = normalizedLaunched.replace(/\/+$/, "");
    if (trimmedLaunched === normalizedDir || trimmedLaunched.startsWith(`${normalizedDir}/`)) {
      return installHint;
    }
  }
  return "npm install -g @aiand/cli";
}

/**
 * Background housekeeping shown only on an interactive terminal with a real
 * command (never --version, never --json, never CI). Update notice and
 * version-change notes both go to stderr as dim lines so they never pollute
 * a command's stdout. Any failure is swallowed — housekeeping never breaks a
 * command.
 */
async function runSystemHousekeeping(): Promise<void> {
  const interactive =
    process.stderr.isTTY === true &&
    !process.argv.includes("--json") &&
    process.env.CI === undefined;
  if (!interactive) return;

  const [update, notes] = await Promise.all([
    checkForUpdate().catch(() => undefined),
    finalizeOnVersionChange().catch(() => []),
  ]);
  if (update) {
    err(
      style.dim(
        `Update available: v${update.current} → v${update.latest}  (${updateInstallHint()})`,
      ),
    );
  }
  for (const note of notes) err(style.dim(note));
}

/**
 * Split leading `--profile`/`--base-url`/`--json` (USAGE globals) off argv so
 * `aiand --profile foo status` works like `aiand status --profile foo`. The
 * leading flags are returned separately and re-appended to the command's argv
 * after dispatch, so per-command `parse()` still sees them.
 */
function splitLeadingGlobals(argv: string[]): { globalArgs: string[]; rest: string[] } {
  const globalArgs: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--json") {
      globalArgs.push(arg);
      i += 1;
    } else if (arg === "--profile" || arg === "--base-url") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new CliError(`Missing value for ${arg}.`, {
          hint: `Usage: aiand ${arg} <value> <command>`,
        });
      }
      globalArgs.push(arg, value);
      i += 2;
    } else if (arg.startsWith("--profile=") || arg.startsWith("--base-url=")) {
      globalArgs.push(arg);
      i += 1;
    } else {
      break;
    }
  }
  return { globalArgs, rest: argv.slice(i) };
}

/** True when this module is the CLI entry point (not imported by tests). */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { globalArgs, rest } = splitLeadingGlobals(argv);
  const first = rest[0];
  const restArgs = rest.slice(1);

  // Not listed in help.
  if (first === "banner") {
    printBanner({ version: VERSION });
    return 0;
  }
  // Not listed in help.
  if (first === "welcome") {
    const { playWelcome } = await import("./cli/ui/welcome.js");
    await playWelcome();
    return 0;
  }

  if (!first) {
    // Bare `aiand` on a terminal is the launcher menu (TogetherLink's `tlink`
    // experience); piped stdio keeps the plain help text. `--json` is consumed
    // by splitLeadingGlobals and is meaningless to the menu's dispatch, so it
    // is stripped instead of forwarded to run-agent.
    if (isInteractive()) {
      // Lazy: bare `aiand` must not pay for the welcome module when the
      // animation has already played (or is disabled).
      const { playWelcome, shouldPlayWelcome, markWelcomePlayed } = await import(
        "./cli/ui/welcome.js"
      );
      const stateDir = configDir();
      // AIAND_NO_WELCOME suppresses without marking, so it re-enables later.
      if (process.env.AIAND_NO_WELCOME !== "1" && shouldPlayWelcome(stateDir)) {
        await playWelcome();
        markWelcomePlayed(stateDir);
      }
      const code = await runLauncherMenu({
        argv: [...globalArgs.filter((arg) => arg !== "--json"), ...rest],
      });
      // Same housekeeping pass as the agent/command dispatch paths above;
      // 130 is a cancel — the user backed out, don't follow with noise.
      if (code !== 130) await runSystemHousekeeping();
      return code;
    }
    showHelp();
    return 0;
  }
  if (first === "help") {
    const topicName = rest.slice(1).find((arg) => !arg.startsWith("-"));
    if (!topicName) {
      showHelp();
      return 0;
    }
    const commandTopic = findCommand(topicName);
    if (commandTopic) {
      showHelp(commandTopic.help);
      return 0;
    }
    const agentTopic = findAgent(topicName);
    if (agentTopic) {
      showHelp(agentHelp(agentTopic));
      return 0;
    }
    err(style.red(`Unknown help topic "${topicName}".`));
    err("Run `aiand help` to see the commands.");
    return 1;
  }
  if (first === "--version" || first === "-v") {
    out(VERSION);
    return 0;
  }
  if (first === "--help" || first === "-h") {
    showHelp();
    return 0;
  }

  const command = findCommand(first);
  if (!command) {
    const agent = findAgent(first);
    if (agent) {
      await runAgentCommand(agent, [...restArgs, ...globalArgs]);
      await runSystemHousekeeping();
      return 0;
    }
    const guess = suggest(first);
    err(style.red(`Unknown command "${first}".`));
    err(guess ? `Did you mean \`aiand ${guess}\`?` : "Run `aiand help` to see the commands.");
    return EXIT.NOT_FOUND;
  }

  await command.run([...restArgs, ...globalArgs]);

  // Housekeeping after a real command's output — never on the --version path,
  // which returns above after printing VERSION.
  await runSystemHousekeeping();

  return 0;
}

// A downstream consumer (head, less, a closed socket) closing the pipe turns
// the next stdout write into an EPIPE crash with a stack trace. Dying quietly
// with SIGPIPE semantics is what a Unix tool does; the process still exits
// with its code from exitCode above.
process.stdout?.on?.("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw e;
});

if (isMain()) {
  main()
    .then((code) => {
      // A command (run-agent) may set process.exitCode to propagate a child's
      // exit status without process.exit-ing (so stdio flushes); honor it when
      // the command itself did not return a nonzero code. Assign exitCode and
      // let the process end naturally — process.exit() can drop piped output.
      const finalCode = code !== 0 ? code : (process.exitCode ?? 0);
      process.exitCode = finalCode;
    })
    .catch((error: unknown) => {
      if (error instanceof CliError) {
        const prefix = error instanceof ApiError && error.status ? `HTTP ${error.status}: ` : "";
        err(style.red(prefix + error.message));
        if (error instanceof ApiError && error.requestId) {
          err(style.dim(`request id: ${error.requestId}`));
        }
        if (error.hint) err(style.dim(error.hint));
        process.exit(error.exitCode);
      }

      err(style.red("Unexpected error:"));
      err(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(EXIT.BUG);
    });
}
