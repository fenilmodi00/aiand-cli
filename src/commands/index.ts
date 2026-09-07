import * as login from "./login.js";
import * as logout from "./logout.js";
import * as whoami from "./whoami.js";
import * as orgs from "./orgs.js";
import * as models from "./models.js";
import * as run from "./run.js";
import * as chat from "./chat.js";
import * as logs from "./logs.js";
import * as usage from "./usage.js";
import * as config from "./config.js";
import * as init from "./init.js";
import * as status from "./status.js";
import { AGENTS } from "../agents/registry.js";

export type Command = {
  name: string;
  summary: string;
  help: string;
  run: (argv: string[]) => Promise<void>;
  aliases?: string[];
};

export const COMMANDS: Command[] = [
  { name: "login", summary: "Sign in with a browser approval", ...login },
  { name: "logout", summary: "End this machine's session", ...logout },
  { name: "whoami", summary: "Show the signed-in identity", ...whoami },
  { name: "run", summary: "Send one prompt and print the answer", aliases: ["ask"], ...run },
  { name: "chat", summary: "Interactive conversation", ...chat },
  { name: "models", summary: "List the model catalog", aliases: ["ls-models"], ...models },
  { name: "logs", summary: "Recent inference requests", ...logs },
  { name: "usage", summary: "Request and token usage", aliases: ["analytics"], ...usage },
  { name: "orgs", summary: "List your organizations", ...orgs },
  { name: "config", summary: "Inspect and change stored settings", ...config },
  { name: "init", summary: "Detect agents and wire them to ai&", ...init },
  { name: "status", summary: "Show auth and agent wiring", ...status },
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
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  return best && best.distance <= Math.max(2, Math.floor(name.length / 3))
    ? best.name
    : undefined;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}
