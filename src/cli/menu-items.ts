import { AGENTS } from "../agents/registry.js";
import type { DetectResult } from "../agents/types.js";
import type { MenuItem } from "../cli/menu.js";
import { COMMANDS } from "../commands/index.js";

/**
 * The menu rows for the interactive entry point. Kept apart from the entry
 * module so the row shape is testable without a terminal: the menu itself
 * needs a TTY, but building its rows does not.
 */

/** Group headings, in the order the menu shows them. */
const MENU_GROUPS = {
  start: "Get started",
  agents: "Agents",
  moreAgents: "More agents",
  commands: "Commands",
  menu: "Menu",
} as const;

/** Menu rows that run one of the two sign-in flows. */
const SIGN_IN_ACTIONS: Record<string, "browser" | "paste"> = {
  __login: "browser",
  __paste: "paste",
};

/** The signed-out menu: exactly two rows, the two ways in. */
export function signInItems(signedIn = false): MenuItem[] {
  return [
    {
      value: "__login",
      label: "Sign in with your browser",
      group: MENU_GROUPS.start,
      shortcut: "aiand login",
      hint: "no key to copy",
      keywords: ["browser", "device", "signin", "login"],
      detail:
        "Opens your browser for an approval, then gives this machine a key. Falls back to a code on any device.",
    },
    {
      value: "__paste",
      label: "Paste an API key",
      group: MENU_GROUPS.start,
      shortcut: "aiand login --paste",
      hint: "console",
      keywords: ["paste", "key", "api", "token", "console", "signin"],
      detail:
        "Pastes a key you already made. It is validated before it is stored, and stays on this computer.",
      ...(signedIn ? {} : { state: { text: "key missing", tone: "warning" as const } }),
    },
  ];
}

/** Memoized one-pass detection; detect() is cheap now but still disk I/O per draw. */
let detectedCache: { adapter: (typeof AGENTS)[number]; result: DetectResult }[] | undefined;

/** Forget the memoized detection so the next menu draw re-probes PATH. */
export function invalidateAgentDetection(): void {
  detectedCache = undefined;
}

/**
 * The signed-in menu rows. Installed agents get their own section; supported
 * agents the machine is missing get a "More agents" section, because entering
 * one offers its install and then wires it.
 */
export function mainMenuItems(): MenuItem[] {
  detectedCache ??= AGENTS.map((adapter) => ({ adapter, result: adapter.detect() }));
  const installed = detectedCache
    .filter(({ result }) => result.installed)
    .map(({ adapter }) => adapter);
  const missing = detectedCache
    .filter(({ result }) => !result.installed)
    .map(({ adapter }) => adapter);
  const rows: MenuItem[] = [];

  // One row that wires every installed agent, so a new machine is set up
  // without stepping through each one.
  rows.push({
    value: "__init_all",
    label: "Set up every agent I have",
    group: MENU_GROUPS.start,
    shortcut: "aiand init --all",
    hint: "one command",
    keywords: ["wire", "all", "setup", "init", "every", "batch"],
    detail: installed.length
      ? `Wires ${installed.map((adapter) => adapter.label).join(", ")} to ai&, leaving your own settings alone.`
      : "No coding agents are installed yet, so there is nothing to wire.",
    ...(installed.length ? {} : { state: { text: "none installed", tone: "warning" as const } }),
  });

  for (const adapter of installed) {
    rows.push({
      value: adapter.id,
      label: adapter.label,
      group: MENU_GROUPS.agents,
      keywords: ["agent", "terminal", adapter.bin],
      shortcut: `aiand ${adapter.id}`,
      detail: `Open ${adapter.label} on ai&, wiring it first if needed.`,
    });
  }

  for (const adapter of missing) {
    rows.push({
      value: adapter.id,
      label: adapter.label,
      group: MENU_GROUPS.moreAgents,
      keywords: ["agent", "terminal", adapter.bin, "install"],
      shortcut: `aiand ${adapter.id}`,
      detail: `${adapter.label} is not installed yet. Enter installs it with: ${adapter.install.command}`,
      state: { text: "not installed", tone: "warning" },
    });
  }

  for (const command of COMMANDS) {
    rows.push({
      value: command.name,
      label: command.name,
      group: MENU_GROUPS.commands,
      hint: command.summary,
      keywords: [command.name, ...(command.aliases ?? [])],
      detail: command.summary,
      ...(command.name === "config"
        ? { state: { text: "signed in", tone: "success" as const } }
        : {}),
    });
  }

  rows.push({
    value: "__quit",
    label: "Quit",
    group: MENU_GROUPS.menu,
    detail: "Leave the menu.",
  });
  return rows;
}

/** The one row that runs `aiand init --all` from the menu. */
export const INIT_ALL_ACTION = "__init_all";

/** Which sign-in mode a menu row runs, if it is one. */
export function signInMode(picked: string): "browser" | "paste" | undefined {
  return SIGN_IN_ACTIONS[picked];
}
