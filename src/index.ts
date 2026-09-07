#!/usr/bin/env node
import { ApiError, CliError } from "./cli/errors.js";
import { err, out, style } from "./cli/output.js";
import { VERSION } from "./api/client.js";
import { COMMANDS, findCommand, suggest } from "./commands/index.js";
import { findAgent } from "./agents/registry.js";
import { runAgentCommand } from "./commands/agent.js";

const USAGE = `${style.bold("aiand")} -- the ai& command line interface

Usage
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

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (!first || first === "help") {
    const topic = argv[1] ? findCommand(argv[1]) : undefined;
    out(topic ? topic.help : USAGE);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    out(VERSION);
    return 0;
  }
  if (first === "--help" || first === "-h") {
    out(USAGE);
    return 0;
  }

  const command = findCommand(first);
  if (!command) {
    const agent = findAgent(first);
    if (agent) {
      await runAgentCommand(agent, argv.slice(1));
      return 0;
    }
    const guess = suggest(first);
    err(style.red(`Unknown command "${first}".`));
    err(guess ? `Did you mean \`aiand ${guess}\`?` : "Run `aiand help` to see the commands.");
    return 127;
  }

  await command.run(argv.slice(1));
  return 0;
}

main()
  .then((code) => {
    // A command (run-agent) may set process.exitCode to propagate a child's
    // exit status without process.exit-ing (so stdio flushes); honor it when
    // the command itself did not return a nonzero code.
    const finalCode = code !== 0 ? code : (process.exitCode ?? 0);
    process.exit(finalCode);
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
    process.exit(70);
  });
