#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import os, { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { findAgent } from "./agents/registry.js";
import { VERSION } from "./api/client.js";
import { ApiError, CliError, EXIT } from "./cli/errors.js";
import { promptMenu } from "./cli/menu.js";
import {
  INIT_ALL_ACTION,
  invalidateAgentDetection,
  mainMenuItems,
  signInItems,
  signInMode,
} from "./cli/menu-items.js";
import { err, heading, out, safeLine, sanitizeForTerminal, spinner, style } from "./cli/output.js";
import { forwardsInterrupt, proxyUnsupportedWarning, relaunchPlan } from "./cli/proxy.js";
import { redactSecrets } from "./cli/redact.js";
import type { PromptInput, PromptOutput } from "./cli/select.js";
import { protectProcessEnv } from "./cli/spawn-env.js";
import { renderHome } from "./cli/ui/home.js";
import { playSplash } from "./cli/ui/splash.js";
import { agentHelp, runAgentCommand } from "./commands/agent.js";
import { COMMANDS, findCommand, loadCommand, suggest } from "./commands/index.js";
import * as initCommand from "./commands/init.js";
import * as loginCommand from "./commands/login.js";
import { activeProfileName, loadCredential } from "./config.js";
import { finalizeOnVersionChange } from "./housekeeping/finalize.js";
import { checkForUpdate } from "./housekeeping/update.js";
import { hasPlayedWelcome, markWelcomePlayed } from "./housekeeping/welcome.js";

/** The home screen tagline, shared by the menu and the static screen. */
const HOME_TAGLINE = "Agents and inference.";

/** Menu commands that own the terminal (TUI/REPL/server/prompts); no spinner around them. */
const SPINNER_EXEMPT: Record<string, true> = {
  dashboard: true,
  chat: true,
  "run-agent": true,
  restore: true, // prompts before overwriting
};

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
 * action, run it, then show the menu again, until the user quits.
 *
 * Esc and Ctrl-C always mean one level out, never two: inside an action they
 * cancel that action and the menu redraws (the cancel is a normal outcome, so
 * it is shown as a dim line, not an error). Only at the menu itself do they
 * leave the loop for good — Esc quits with a visible bye, Ctrl-C exits 130.
 * Opening an agent also leaves the loop, because the agent takes over the
 * terminal.
 */
export async function runMainMenu(
  streams: { input?: PromptInput; output?: PromptOutput } = {},
): Promise<void> {
  // The session's own output stream: the frame stream the menu drew on, so a
  // quit line lands where the menu was even under injected streams.
  const session = streams.output ?? process.stdout;
  for (;;) {
    const signedIn = Boolean(await loadCredential(activeProfileName()).catch(() => null));

    const picked = await promptMenu({
      message: signedIn ? "What do you want to run?" : "Sign in to get started",
      brand: { name: "AI&", tagline: HOME_TAGLINE, version: VERSION },
      items: signedIn ? mainMenuItems() : signInItems(),
      ...streams,
    });
    if (picked === null) {
      session.write(`${style.dim("Bye.")}\n`);
      return;
    }

    if (picked === "__quit") {
      session.write(`${style.dim("Bye.")}\n`);
      return;
    }

    try {
      const signIn = signInMode(picked);
      if (signIn) {
        const spin = spinner("Signing in...");
        try {
          await runSignIn(signIn);
        } finally {
          spin.stop();
        }
        // Sign-in either succeeded (loop again, now with the full menu) or was
        // cancelled, which the catch below turns back into the menu.
        continue;
      }

      // The one-shot setup row: wire every installed agent in one go.
      if (picked === INIT_ALL_ACTION) {
        heading(findCommand("init")?.summary ?? "Set up agents");
        const spin = spinner("Wiring agents...");
        try {
          await initCommand.run(["--all"]);
        } finally {
          spin.stop();
        }
        invalidateAgentDetection();
        await runSystemHousekeeping();
        out("");
        continue;
      }

      const agent = findAgent(picked);
      if (agent) {
        heading(`Open ${agent.label}`);
        try {
          await runAgentCommand(agent, [], []);
        } finally {
          invalidateAgentDetection();
        }
        await runSystemHousekeeping();
        // An agent owns the terminal for its whole run; redrawing the menu on
        // top of it would clobber its final frame.
        return;
      }
      const command = findCommand(picked);
      if (command) {
        heading(command.summary);
        // `key` takes a verb, so the menu falls back to the one it prints with.
        const argv = process.argv.includes("--json") ? ["--json"] : [];
        // Terminal-owning commands animate nothing: a spinner on stderr would
        // run for the command's whole lifetime (or forever, for `chat`).
        if (!SPINNER_EXEMPT[picked]) {
          // The heading above already owns the command title; the spinner
          // describes the work, so the title never reads twice.
          const spin = spinner("Working...");
          try {
            await command.run([...(picked === "key" ? ["export"] : argv)]);
          } finally {
            spin.stop();
          }
        } else {
          await command.run([...(picked === "key" ? ["export"] : argv)]);
        }
        await runSystemHousekeeping();
        out("");
        continue;
      }
      return;
    } catch (error) {
      // Esc, or Ctrl-C, inside an action cancels that action — show it and
      // come back to the menu. Only the menu's own Esc/Ctrl-C exits.
      if (error instanceof CliError && error.exitCode === EXIT.INTERRUPTED) {
        err(style.dim(error.message));
        continue;
      }
      throw error;
    }
  }
}

function showHelp(topicHelp?: string): void {
  if (topicHelp) {
    out(topicHelp);
    return;
  }
  out(homeScreen());
}

/** The command that upgrades this install: npm for an npm install, or the
 * installer's `update`, which fetches and verifies the latest release (a
 * plain re-run of an install's own installer would rebuild the same version).
 * Windows runs the script through `powershell -ExecutionPolicy Bypass -File`,
 * which works under the default policy, scoped to that one process. */
export function updateInstallHint(opts?: {
  platform?: NodeJS.Platform;
  launched?: string;
  aiandDir?: string | undefined;
  home?: string;
}): string {
  const platform = opts?.platform ?? process.platform;
  const launched = opts?.launched ?? process.argv[1] ?? "";
  const root = installerRoot(launched, opts?.aiandDir ?? process.env.AIAND_DIR);
  if (root === undefined) return "npm install -g @aiand/cli@latest";
  if (platform === "win32") {
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${root}\\install.ps1" update`;
  }
  const home = (opts?.home ?? homedir()).replace(/\/+$/, "");
  const script =
    root === `${home}/.aiand/cli` ? "~/.aiand/cli/install.sh" : shellQuote(`${root}/install.sh`);
  return `bash ${script} update`;
}

/** The installer's install directory this CLI runs from, or undefined for
 * any other install (npm, a dev checkout). */
function installerRoot(launched: string, aiandDir: string | undefined): string | undefined {
  const normalized = launched.replace(/\\/g, "/");
  const entry = "/dist/index.js";
  if (!normalized.endsWith(entry)) return undefined;
  const root = launched.slice(0, launched.length - entry.length);
  const normalizedRoot = normalized.slice(0, normalized.length - entry.length);
  if (normalizedRoot.includes("/.aiand/")) return root;
  const dir = aiandDir?.replace(/\\/g, "/").replace(/\/+$/, "");
  return dir && normalizedRoot === dir ? root : undefined;
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
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
      style.dim(
        `Update available: v${safeLine(update.current)} → v${safeLine(update.latest)}  (${updateInstallHint()})`,
      ),
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
  protectProcessEnv();
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
      showHelp((await loadCommand(topicName))?.help ?? "");
      return 0;
    }
    const agentTopic = findAgent(topicName);
    if (agentTopic) {
      showHelp(agentHelp(agentTopic));
      return 0;
    }
    err(style.red(`Unknown help topic "${safeLine(topicName)}".`));
    const helpGuess = suggest(topicName);
    if (helpGuess) err(`Did you mean \`aiand help ${helpGuess}\`?`);
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
    err(style.red(`Unknown command "${safeLine(first)}".`));
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
// with the code the command resolved (see main().then above).
process.stdout?.on?.("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw e;
});

if (isMain()) {
  const plan = relaunchPlan({
    env: process.env,
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
    version: process.version,
  });
  if (plan) {
    const child = spawn(plan.cmd, plan.args, { env: plan.env, stdio: "inherit" });
    process.on("SIGINT", () => {
      if (forwardsInterrupt(Boolean(process.stdin.isTTY))) child.kill("SIGINT");
    });
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    child.on("error", (error) => {
      err(style.red(`Could not restart aiand to use the proxy: ${safeLine(error.message)}`));
      process.exitCode = EXIT.BUG;
    });
    child.on("exit", (code, signal) => {
      process.exitCode = signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 0);
    });
  } else {
    const warning = proxyUnsupportedWarning(process.env, process.version);
    if (warning) err(style.yellow(warning));

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
          // Messages can quote a gateway's error body, so they are server text.
          err(style.red(prefix + sanitizeForTerminal(error.message)));
          if (error instanceof ApiError && error.requestId) {
            err(style.dim(`request id: ${safeLine(error.requestId)}`));
          }
          if (error.hint) err(style.dim(sanitizeForTerminal(error.hint)));
          process.exit(error.exitCode);
        }

        err(style.red("Unexpected error:"));
        err(
          sanitizeForTerminal(
            redactSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error)),
          ),
        );
        process.exit(EXIT.BUG);
      });
  }
}
