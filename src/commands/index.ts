import { AGENTS } from "../agents/registry.js";
import { nearestMatch } from "../cli/args.js";
import * as cache from "./cache.js";
import * as chat from "./chat.js";
import * as config from "./config.js";
import * as doctor from "./doctor.js";
import * as harness from "./harness.js";
import * as init from "./init.js";
import * as key from "./key.js";
import * as login from "./login.js";
import * as logout from "./logout.js";
import * as logs from "./logs.js";
import * as models from "./models.js";
import * as orgs from "./orgs.js";
import * as restore from "./restore.js";
import * as run from "./run.js";
import * as runAgent from "./run-agent.js";
import * as status from "./status.js";
import * as update from "./update.js";
import * as usage from "./usage.js";
import * as whoami from "./whoami.js";

export type Command = {
  name: string;
  summary: string;
  help: string;
  run: (argv: string[]) => Promise<void>;
  aliases?: string[];
};

export const COMMANDS: Command[] = [
  { name: "login", summary: "Sign in with a browser approval", help: login.help, run: login.run },
  { name: "logout", summary: "End this machine's session", help: logout.help, run: logout.run },
  { name: "whoami", summary: "Show the signed-in identity", help: whoami.help, run: whoami.run },
  {
    name: "run",
    summary: "Send one prompt and print the answer",
    aliases: ["ask"],
    help: run.help,
    run: run.run,
  },
  { name: "chat", summary: "Interactive conversation", help: chat.help, run: chat.run },
  {
    name: "models",
    summary: "List the model catalog",
    aliases: ["ls-models"],
    help: models.help,
    run: models.run,
  },
  { name: "logs", summary: "Recent inference requests", help: logs.help, run: logs.run },
  {
    name: "cache",
    summary: "Cache hit rate and what it saved",
    help: cache.help,
    run: cache.run,
  },
  {
    name: "harness",
    summary: "Compare harnesses on cache behavior",
    help: harness.help,
    run: harness.run,
  },
  {
    name: "usage",
    summary: "Request and token usage",
    aliases: ["analytics"],
    help: usage.help,
    run: usage.run,
  },
  { name: "orgs", summary: "List your organizations", help: orgs.help, run: orgs.run },
  {
    name: "config",
    summary: "Inspect and change stored settings",
    help: config.help,
    run: config.run,
  },
  { name: "init", summary: "Detect agents and wire them to ai&", help: init.help, run: init.run },
  {
    name: "restore",
    summary: "Restore a pre-aiand config snapshot",
    help: restore.help,
    run: restore.run,
  },
  { name: "status", summary: "Show auth and agent wiring", help: status.help, run: status.run },
  {
    name: "doctor",
    summary: "Check observability health, source by source",
    help: doctor.help,
    run: doctor.run,
  },
  {
    name: "run-agent",
    summary: "Run a coding agent on ai& for one session",
    help: runAgent.help,
    run: runAgent.run,
  },
  { name: "key", summary: "Print the active session key", help: key.help, run: key.run },
  {
    name: "update",
    summary: "Update ai& to the latest version",
    aliases: ["upgrade"],
    help: update.help,
    run: update.run,
  },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

export function suggest(name: string): string | undefined {
  // Agent nouns are valid dispatch targets, so include them in the
  // suggestion candidate set alongside commands.
  const candidates = [
    ...COMMANDS.map((c) => c.name),
    ...AGENTS.flatMap((a) => [a.id, ...(a.aliases ?? [])]),
  ];
  return nearestMatch(name, candidates);
}
