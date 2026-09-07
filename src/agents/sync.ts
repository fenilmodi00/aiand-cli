import { AGENTS } from "./registry.js";
import { agentHome } from "./paths.js";

/** One agent's key-refresh outcome, after a fresh credential is stored. */
export type SyncNote = {
  agent: string;
  state: "refreshed" | "skipped" | "failed";
  note: string;
};

/**
 * Walk every registered adapter and swap the freshly-stored API key into any
 * config that is currently active (`probe().active`):
 *
 * - active + `refreshKey`  → try it (refreshed / failed with the reason)
 * - active + no refreshKey → skipped note telling the user to re-run
 *   `aiand <id> on` (the adapter does not persist a plaintext key)
 * - inactive               → no note
 *
 * launcherOnly adapters and non-persisting ones are skipped. Never throws: a
 * probe or refresh failure becomes a `failed` note rather than aborting the
 * login.
 */
export async function rebakeAgentKeys(apiKey: string): Promise<SyncNote[]> {
  const home = agentHome();
  const notes: SyncNote[] = [];

  for (const adapter of AGENTS) {
    if (adapter.launcherOnly) continue;

    let active: boolean;
    try {
      active = (await adapter.probe()).active;
    } catch {
      active = false;
    }
    if (!active) continue;

    if (!adapter.refreshKey) {
      notes.push({
        agent: adapter.id,
        state: "skipped",
        note: `Re-run \`aiand ${adapter.id} on\` to refresh its key.`,
      });
      continue;
    }

    try {
      await adapter.refreshKey({ apiKey, home });
      notes.push({ agent: adapter.id, state: "refreshed", note: "Key refreshed." });
    } catch (error) {
      notes.push({
        agent: adapter.id,
        state: "failed",
        note: `Could not refresh its key: ${(error as Error).message ?? String(error)}`,
      });
    }
  }

  return notes;
}