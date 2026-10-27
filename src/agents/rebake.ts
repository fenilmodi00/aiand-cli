import { recordAgentKey } from "../api/agent-keys.js";
import { AGENTS } from "./registry.js";

/** One agent's key-refresh outcome, after a fresh credential is stored. */
export type RebakeNote = {
  agent: string;
  state: "refreshed" | "skipped" | "failed";
  note: string;
};

function probeFailedNote(agent: string, error: unknown): RebakeNote {
  return {
    agent,
    state: "failed",
    note: `Could not probe its config: ${(error as Error).message ?? String(error)}`,
  };
}

/**
 * Walk every registered adapter and swap the freshly-stored API key into any
 * config that may still hold ours:
 *
 * - probe throws            → failed note; a present `refreshKey` is still
 *   attempted, and its failure extends the same note (never a second note,
 *   never a silent skip)
 * - no refreshKey + active  → skipped note telling the user to re-run
 *   `aiand <id> on` (the adapter does not persist a plaintext key)
 * - refreshKey present      → try it, even when inactive: a marked config
 *   with a bad baseURL reads inactive yet still holds our key. refreshKey
 *   reports whether it touched a marked config, so unmarked files stay
 *   silent
 * - inactive + unmarked     → no note
 *
 * launcherOnly adapters are skipped. Never throws: a probe or refresh
 * failure becomes a `failed` note rather than aborting the login.
 * `previousKey` (automatic rotation) limits the swap to configs baked with
 * exactly that key.
 */
export async function rebakeAgentKeys(
  apiKey: string,
  { previousKey }: { previousKey?: string } = {},
): Promise<RebakeNote[]> {
  const notes: RebakeNote[] = [];

  for (const adapter of AGENTS) {
    if (adapter.launcherOnly) continue;

    let active = false;
    let probeError: unknown = null;
    try {
      active = (await adapter.probe()).active;
    } catch (error) {
      probeError = error;
    }

    if (!adapter.refreshKey) {
      if (probeError !== null) {
        notes.push(probeFailedNote(adapter.id, probeError));
      } else if (active) {
        notes.push({
          agent: adapter.id,
          state: "skipped",
          note: `Re-run \`aiand ${adapter.id} on\` to refresh its key.`,
        });
      }
      continue;
    }

    if (probeError !== null) {
      // The config may still be marked, so attempt the swap — but the failed
      // note stands either way (a throwing probe is never a silent skip).
      const note = probeFailedNote(adapter.id, probeError);
      try {
        await adapter.refreshKey({ apiKey, previousKey });
      } catch (error) {
        note.note += ` Refresh also failed: ${(error as Error).message ?? String(error)}`;
      }
      notes.push(note);
      continue;
    }

    try {
      if (!(await adapter.refreshKey({ apiKey, previousKey }))) continue;
      // The gateway's /logs identify this agent's rows by the new key from
      // now on; remember it so rotation never strands history as "unknown".
      await recordAgentKey(adapter.id, apiKey).catch(() => {
        // Observability must never break a refresh that already succeeded.
      });
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
