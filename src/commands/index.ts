import { AGENTS } from "../agents/registry.js";
import { nearestMatch } from "../cli/args.js";

/**
 * Command registry — metadata only.
 *
 * Importing all 31 command modules eagerly cost ~440ms cold on this machine
 * (`node -e import('./dist/commands/index.js')`), which delayed every menu
 * launch. The oclif/eslint/promptfoo pattern applies instead: keep the
 * command table as plain metadata and dynamic-import the module on first
 * `run()` or explicit `loadCommand()`. Summaries stay in the table verbatim
 * so the interactive menu (menu-items.ts) renders with zero module loads.
 */
export type Command = {
  name: string;
  summary: string;
  run: (argv: string[]) => Promise<void>;
  aliases?: string[];
  /** Only materialized after the module loads (see loadCommand). */
  help?: string;
  /** Internal lazy binding added by `lazy()`; memoized. */
  load: () => Promise<{ help: string; run: (argv: string[]) => Promise<void> }>;
};

/**
 * Memoized lazy binding for one command module. `run` is created eagerly so
 * it is always a plain function (`typeof run === "function"` holds without
 * loading anything — check-dist asserts this); the module is imported on the
 * first call and reused after.
 */
const lazy = <M extends { help: string; run: (argv: string[]) => Promise<void> }>(
  importMod: () => Promise<M>,
): { run: (argv: string[]) => Promise<void>; load: () => Promise<M> } => {
  let cache: M | undefined;
  return {
    run: async (argv) => {
      cache ??= await importMod();
      return cache.run(argv);
    },
    load: async () => {
      cache ??= await importMod();
      return cache;
    },
  };
};

export const COMMANDS: Command[] = [
  {
    name: "dashboard",
    summary: "interactive spend/burn TUI (plain-text overview when piped)",
    ...lazy(() => import("./dashboard.js")),
  },
  {
    name: "heatmap",
    summary: "24h x 7d activity heatmap of the local store",
    ...lazy(() => import("./heatmap.js")),
  },
  {
    name: "wrapped",
    summary: "share-friendly period summary",
    ...lazy(() => import("./wrapped.js")),
  },

  {
    name: "login",
    summary: "Sign in with a browser approval",
    ...lazy(() => import("./login.js")),
  },
  { name: "logout", summary: "End this machine's session", ...lazy(() => import("./logout.js")) },
  { name: "whoami", summary: "Show the signed-in identity", ...lazy(() => import("./whoami.js")) },
  {
    name: "run",
    summary: "Send one prompt and print the answer",
    aliases: ["ask"],
    ...lazy(() => import("./run.js")),
  },
  { name: "chat", summary: "Interactive conversation", ...lazy(() => import("./chat.js")) },
  {
    name: "models",
    summary: "List the model catalog",
    aliases: ["ls-models"],
    ...lazy(() => import("./models.js")),
  },
  { name: "logs", summary: "Recent inference requests", ...lazy(() => import("./logs.js")) },
  {
    name: "cache",
    summary: "Cache hit rate and what it saved",
    ...lazy(() => import("./cache.js")),
  },
  {
    name: "harness",
    summary: "Compare harnesses on cache behavior",
    ...lazy(() => import("./harness.js")),
  },
  {
    name: "compare",
    summary: "Personal task packs: scaffold, list, validate",
    ...lazy(() => import("./compare.js")),
  },
  {
    name: "usage",
    summary: "Request and token usage",
    aliases: ["analytics"],
    ...lazy(() => import("./usage.js")),
  },
  {
    name: "sessions",
    summary: "Requests grouped into conversations (sessions)",
    ...lazy(() => import("./sessions.js")),
  },
  {
    name: "overview",
    summary: "Pasteable plain-text period summary",
    ...lazy(() => import("./overview.js")),
  },
  {
    name: "report",
    summary: "Self-contained offline HTML usage report",
    ...lazy(() => import("./report.js")),
  },
  {
    name: "efficiency",
    summary: "One-shot/retry, task mix, project/branch spend",
    ...lazy(() => import("./efficiency.js")),
  },
  { name: "orgs", summary: "List your organizations", ...lazy(() => import("./orgs.js")) },
  {
    name: "config",
    summary: "Inspect and change stored settings",
    ...lazy(() => import("./config.js")),
  },
  {
    name: "init",
    summary: "Detect agents and wire them to ai&",
    ...lazy(() => import("./init.js")),
  },
  {
    name: "restore",
    summary: "Restore a pre-aiand config snapshot",
    ...lazy(() => import("./restore.js")),
  },
  { name: "status", summary: "Show auth and agent wiring", ...lazy(() => import("./status.js")) },
  {
    name: "doctor",
    summary: "Check observability health, source by source",
    ...lazy(() => import("./doctor.js")),
  },
  {
    name: "run-agent",
    summary: "Run a coding agent on ai& for one session",
    ...lazy(() => import("./run-agent.js")),
  },
  { name: "key", summary: "Print the active session key", ...lazy(() => import("./key.js")) },
  {
    name: "store",
    summary: "Local request store status and sync",
    ...lazy(() => import("./store.js")),
  },
  {
    name: "export",
    summary: "Export metrics as OTel or Prometheus",
    ...lazy(() => import("./export.js")),
  },
  {
    name: "forecast",
    summary: "Burn-rate projection against your budget",
    ...lazy(() => import("./forecast.js")),
  },
  {
    name: "recommend",
    summary: "Best (harness, model) pair for your workload",
    ...lazy(() => import("./recommend.js")),
  },
  {
    name: "update",
    summary: "Update ai& to the latest version",
    aliases: ["upgrade"],
    ...lazy(() => import("./update.js")),
  },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

/** Loads the module behind a command (memoized) so its help text is available. */
export async function loadCommand(name: string): Promise<Command | undefined> {
  const command = findCommand(name);
  if (!command) return undefined;
  const mod = await command.load();
  command.help = mod.help;
  command.run = mod.run;
  return command;
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
