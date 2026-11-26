import { recordAgentKey } from "../api/agent-keys.js";
import { printNotes, safeLine } from "../cli/output.js";
import { redactSecrets } from "../cli/redact.js";
import { normalizeBaseUrl, redactUrl } from "../config.js";
import { AGENTS } from "./registry.js";
import type { AgentAdapter } from "./types.js";
import { wiredApiUrl } from "./wired.js";

/** One agent's key-refresh outcome, after a fresh credential is stored. */
export type RebakeNote = {
  agent: string;
  state: "refreshed" | "skipped" | "failed";
  note: string;
};

/** An error's text for a note: it can quote a file or a gateway response, so it is one safe line with no key in it. */
function reason(error: unknown): string {
  return redactSecrets(safeLine((error as Error | null)?.message ?? String(error)));
}

function probeFailedNote(agent: string, error: unknown): RebakeNote {
  return { agent, state: "failed", note: `Could not probe its config: ${reason(error)}` };
}

/** Print each note dim on stderr, `[agent]`-prefixed. */
export function printRebakeNotes(notes: readonly RebakeNote[]): void {
  printNotes(notes.map((note) => `[${note.agent}] ${note.note}`));
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
  { previousKey, skip }: { previousKey?: string; skip?: ReadonlySet<string> } = {},
): Promise<RebakeNote[]> {
  const notes: RebakeNote[] = [];

  for (const adapter of AGENTS) {
    if (adapter.launcherOnly || skip?.has(adapter.id)) continue;

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
        note.note += ` Refresh also failed: ${reason(error)}`;
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
        note: `Could not refresh its key: ${reason(error)}`,
      });
    }
  }

  return notes;
}

/** The API origin a config's base URL belongs to: the agent's `/v1` is a path under it, not part of it. */
const originOf = (baseUrl: string): string => normalizeBaseUrl(baseUrl.replace(/\/v1\/*$/, ""));

/**
 * Where an agent is wired, or null when nothing can say. The URL baked into
 * its config is what the key would actually be sent to, so it outranks the
 * record `on` keeps; the record covers an adapter that cannot read it back.
 * Never the previously active profile's URL: an agent wired for one origin
 * and a profile on another would be judged equal by it.
 */
async function wiredOrigin(adapter: AgentAdapter): Promise<string | null> {
  const baked = await adapter.bakedBaseUrl?.().catch(() => undefined);
  if (baked !== undefined) return originOf(baked);
  const recorded = await wiredApiUrl(adapter.id);
  return recorded === null ? null : normalizeBaseUrl(recorded);
}

/**
 * Rebake a key into agents only where it belongs: a key is bound to the API
 * origin that issued it, so baking it into a config wired for another origin
 * would send it there. An agent wired to a different origin than `binding`
 * is left alone with a note saying how to move it (`on --profile`). Its
 * origin is the base URL its own config bakes; failing that, the record `on`
 * keeps in wired.json. An agent with neither (wired before the record
 * existed, by an adapter that cannot read its URL back, or the record is
 * missing or corrupt) is left alone too, never assumed to be wired like the
 * previous profile. Only routed agents get a note; a mismatched agent that
 * is off has nothing to move.
 *
 * `previousKey` (automatic rotation) additionally limits the swap to configs
 * baked with exactly that key.
 */
export async function rebakeForBinding(
  apiKey: string,
  profileName: string,
  binding: { api_url: string },
  { previousKey }: { previousKey?: string } = {},
): Promise<RebakeNote[]> {
  const target = normalizeBaseUrl(binding.api_url);
  const skip = new Set<string>();
  const notes: RebakeNote[] = [];
  for (const adapter of AGENTS) {
    if (adapter.launcherOnly) continue;
    const wired = await wiredOrigin(adapter);
    if (wired === target) continue;
    skip.add(adapter.id);
    let active = false;
    try {
      active = (await adapter.probe()).active;
    } catch {
      // An unreadable config is reported by nothing here: it is skipped, and
      // `aiand <agent> status` says why.
    }
    if (!active) continue;
    const move = `Run \`aiand --profile ${profileName} ${adapter.id} on\` to move it.`;
    notes.push({
      agent: adapter.id,
      state: "skipped",
      note:
        wired === null
          ? `It is wired, but ai& cannot tell for which endpoint, so profile "${profileName}"'s key was not baked in. ${move}`
          : `Wired to ${redactUrl(wired)}, but profile "${profileName}" is bound to ${redactUrl(target)}, so its key was not baked in. ${move}`,
    });
  }
  return [...notes, ...(await rebakeAgentKeys(apiKey, { skip, previousKey }))];
}
