#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findAgent } from "./agents/registry.js";
import { VERSION } from "./api/client.js";
import { ApiError, CliError, EXIT } from "./cli/errors.js";
import { promptMenu } from "./cli/menu.js";
import { INIT_ALL_ACTION, mainMenuItems, signInItems, signInMode } from "./cli/menu-items.js";
import { err, out, style } from "./cli/output.js";
import { renderHome } from "./cli/ui/home.js";
import { playSplash } from "./cli/ui/splash.js";
import { agentHelp, runAgentCommand } from "./commands/agent.js";
import { COMMANDS, findCommand, suggest } from "./commands/index.js";
import * as initCommand from "./commands/init.js";
import * as loginCommand from "./commands/login.js";
import { activeProfileName, loadCredential } from "./config.js";
import { finalizeOnVersionChange } from "./housekeeping/finalize.js";
import { checkForUpdate } from "./housekeeping/update.js";
import { hasPlayedWelcome, markWelcomePlayed } from "./housekeeping/welcome.js";

/** The home screen tagline, shared by the menu and the static screen. */
const HOME_TAGLINE = "Agents and inference.";

/** Agents in display order, for the home screen's agent section. */
function agentRows(): Array<[string, string]> {
  return [
    ["aiand code", "Open OpenCode on ai&, the default agent"],
    ["aiand <agent> [args…]", "open a coding agent on ai&, set up as needed"],
    ["aiand <agent> on|off|status", "wire a coding agent to ai&"],
  ];
}

/** The home screen: brand header, then sections of command rows. */
export function homeScreen(version = VERSION): string {
  return renderHome({
    brand: "aiand",
    version,
    tagline: HOME_TAGLINE,
    sections: [
      {
        title: "Agents",
        rows: agentRows(),
      },
      {
        title: "Commands",
        rows: COMMANDS.map((command) => [command.name, command.summary]),
      },
      {
        title: "Get started",
        rows: [
          ["aiand login", "Sign in with a browser approval"],
          ["aiand code", "Open the default agent on ai&"],
          ['aiand run "hello"', "Send one prompt and print the answer"],
        ],
      },
    ],
    notes: [
      "Global options: --profile <name>, --base-url <url>, --json. Run `aiand <command> --help` for a command's own flags.",
    ],
  });
}

/** Run one sign-in flow, committing to the full menu when it succeeds. */
async function runSignIn(mode: "browser" | "paste"): Promise<void> {
  await loginCommand.run(mode === "paste" ? ["--paste"] : []);
  await runSystemHousekeeping();
  out("");
}

/**
 * The interactive main menu. When nobody is signed in it shows only the two
 * sign-in steps — browser approval or a pasted API key — because nothing else
 * in the menu can work yet. Once signed in it shows the full menu: pick one
 * action, run it, then show the menu again, until the user quits. Only an
 * explicit quit, a cancel, or opening an agent (which takes over the
 * terminal) leaves the loop for good.
 */
async function runMainMenu(): Promise<void> {
  for (;;) {
    const signedIn = Boolean(await loadCredential(activeProfileName()).catch(() => null));

    const picked = await promptMenu({
      message: signedIn ? "What do you want to run?" : "Sign in to get started",
      brand: { name: "AI&", tagline: HOME_TAGLINE, version: VERSION },
      items: signedIn ? mainMenuItems() : signInItems(),
    });
    if (picked === null) return;

    if (picked === "__quit") return;

    const signIn = signInMode(picked);
    if (signIn) {
      await runSignIn(signIn);
      // Sign-in either succeeded (loop again, now with the full menu) or threw
      // a CliError the top-level handler prints.
      continue;
    }

    // The one-shot setup row: wire every installed agent in one go.
    if (picked === INIT_ALL_ACTION) {
      out("");
      await initCommand.run(["--all"]);
      await runSystemHousekeeping();
      out("");
      continue;
    }

    const agent = findAgent(picked);
    if (agent) {
      out("");
      await runAgentCommand(agent, [], []);
      await runSystemHousekeeping();
      // An agent owns the terminal for its whole run; redrawing the menu on
      // top of it would clobber its final frame.
      return;
    }
    const command = findCommand(picked);
    if (command) {
      out("");
      // `key` takes a verb, so the menu falls back to the one it prints with.
      const argv = process.argv.includes("--json") ? ["--json"] : [];
      await command.run([...(picked === "key" ? ["export"] : argv)]);
      await runSystemHousekeeping();
      out("");
      continue;
    }
    return;
  }
}

function showHelp(topicHelp?: string): void {
  if (topicHelp) {
    out(topicHelp);
    return;
  }
  out(homeScreen());
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

  // AIAND_AUTO_UPDATE=0 silences just the background notice; the daily
  // check-switches below still apply, and `aiand update --check` still works.
  const [update, notes] = await Promise.all([
    process.env.AIAND_AUTO_UPDATE === "0"
      ? Promise.resolve(null)
      : checkForUpdate().catch(() => undefined),
    finalizeOnVersionChange().catch(() => []),
  ]);
  if (update) {
    err(
      style.dim(`Update available: v${update.current} → v${update.latest}  (run \`aiand update\`)`),
    );
  }
  for (const note of notes) err(style.dim(note));
}

/**
 * Split leading `--profile`/`--base-url`/`--json` (global flags) off argv so
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
  if (first === "welcome" || first === "banner") {
    await playSplash({ version: VERSION, animation: true });
    await markWelcomePlayed().catch(() => {});
    return 0;
  }

  if (!first || first === "help") {
    // First bare run on a fresh install plays the splash, then the menu.
    // Never in CI, never on --json, never twice.
    if (!first) {
      const wantsJson = globalArgs.includes("--json");
      const interactive =
        process.stdout.isTTY === true && !wantsJson && process.env.CI === undefined;
      if (interactive && !hasPlayedWelcome()) {
        await playSplash({ version: VERSION });
        await markWelcomePlayed().catch(() => {});
      }
      // A terminal gets the interactive menu; a pipe gets the static home
      // screen, so scripts and `aiand | less` keep working.
      if (interactive) {
        await runMainMenu();
        return 0;
      }
    }
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
      await runAgentCommand(agent, restArgs, globalArgs);
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
