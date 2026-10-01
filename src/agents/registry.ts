import { claudeAdapter } from "./claude/adapter.js";
import { codexAdapter } from "./codex/adapter.js";
import { hermesAdapter } from "./hermes/adapter.js";
import { opencodeAdapter } from "./opencode/adapter.js";
import type { AgentAdapter } from "./types.js";

/** Every adapter ships here, in display order: adding one is an import plus a line. */
const registered: AgentAdapter[] = [opencodeAdapter, claudeAdapter, codexAdapter, hermesAdapter];

export const AGENTS: readonly AgentAdapter[] = registered;

/** Append an adapter at runtime (test fixtures). Idempotent by id. */
export function registerAgent(adapter: AgentAdapter): void {
  if (registered.some((entry) => entry.id === adapter.id)) return;
  registered.push(adapter);
}

/** Resolve an agent id or alias to its adapter. */
export function findAgent(name: string): AgentAdapter | undefined {
  return AGENTS.find(
    (adapter) => adapter.id === name || adapter.aliases?.some((alias) => alias === name),
  );
}
