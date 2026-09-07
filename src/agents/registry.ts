import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import type { AgentAdapter } from "./types.js";

/**
 * Every adapter ships here, in a stable display order. Growing the matrix is
 * one import + one line; findAgent matches ids and aliases over this list.
 */
const registered: AgentAdapter[] = [claudeAdapter, codexAdapter];

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
