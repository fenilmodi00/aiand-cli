import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { vscodeAdapter } from "./vscode.js";
import { deepseekAdapter } from "./deepseek.js";
import { primeAdapter } from "./prime.js";
import { hermesAdapter } from "./hermes.js";
import { grokAdapter } from "./grok.js";
import type { AgentAdapter } from "./types.js";

/**
 * Every adapter ships here, in a stable display order. Growing the matrix is
 * one import + one line; findAgent matches ids and aliases over this list.
 * Order: P0 surface first, then later phases in plan order.
 */
const registered: AgentAdapter[] = [
  claudeAdapter,
  codexAdapter,
  cursorAdapter,
  opencodeAdapter,
  piAdapter,
  vscodeAdapter,
  deepseekAdapter,
  primeAdapter,
  hermesAdapter,
  grokAdapter,
];

/** Every registered adapter, in registration order. */
export const AGENTS: readonly AgentAdapter[] = registered;

/**
 * Append an adapter at runtime (tests use this for fixtures; later phases
 * may register adapters built dynamically). Idempotent by id.
 */
export function registerAgent(adapter: AgentAdapter): void {
  if (registered.some((entry) => entry.id === adapter.id)) return;
  registered.push(adapter);
}

/**
 * Resolve an agent name (id or alias) to its adapter, or undefined when no
 * registered adapter matches.
 */
export function findAgent(name: string): AgentAdapter | undefined {
  return AGENTS.find(
    (adapter) => adapter.id === name || adapter.aliases?.some((alias) => alias === name)
  );
}
