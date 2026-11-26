import { join } from "node:path";
import type { Model } from "../../api/models.js";
import { agentHome } from "../../config.js";
import { asObject, readTextIfExists } from "../managed-file.js";
import { getAddedState } from "../snapshot.js";
import {
  type Env,
  inCatalog,
  parseSettings,
  routedByUs,
  type SlotEntry,
  slotReport,
} from "./settings.js";

/** Where `on` keeps what it wrote, and reads of the wired file through it. */
export const CLAUDE_ID = "claude";

type Choice = { model?: string; fast?: string; fromProfile?: boolean };

/** What enable() recorded so off can tell its values from the user's. */
export type ClaudeRecord = {
  path?: string;
  /**
   * The model the user chose, which every slot follows, and `--fast-model`,
   * the one other model they asked for. `fromProfile`: the choice was the
   * profile's model, so a later `on` follows the profile, not this record.
   * Always written, empty when nothing was chosen; absent only in a 0.8.0
   * record.
   */
  choice?: Choice;
  env?: Env;
  previousEnv?: Env;
  removedModel?: string;
  removedEnvModel?: string;
  addedDeny?: string[];
  createdKeys?: string[];
  modelPicker?: unknown;
  previousMode?: number;
  created?: boolean;
};

export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(agentHome(), ".claude");
  return join(dir, "settings.json");
}

/**
 * While wired, the file `on` wrote: logout, uninstall and rotation run from
 * shells that may not share the CLAUDE_CONFIG_DIR it was wired under. An
 * unreadable record falls back to the current file, so status still reads one.
 */
export async function wiredSettingsPath(): Promise<string> {
  try {
    return (await getAddedState<ClaudeRecord>(CLAUDE_ID))?.path ?? claudeSettingsPath();
  } catch {
    return claudeSettingsPath();
  }
}

/** Every model slot in the wired file, and a warning for each the user did not choose. */
export async function modelSlots(): Promise<
  { slots: SlotEntry[]; warnings: string[] } | undefined
> {
  let settings: Record<string, unknown>;
  try {
    const path = await wiredSettingsPath();
    settings = parseSettings(path, await readTextIfExists(path));
  } catch {
    return undefined;
  }
  if (!routedByUs(asObject(settings.env))) return undefined;
  const record = await getAddedState<ClaudeRecord>(CLAUDE_ID).catch(() => null);
  return slotReport(settings, { chosen: record?.choice?.model, fast: record?.choice?.fast });
}

/**
 * The models a `--model` / `--fast-model` given to `on` chose, while that
 * wiring is live: a later session launch without --model keeps them. A
 * profile-sourced choice is left out, since the launch reads the profile.
 */
export async function stickyChoice(catalog: Model[]): Promise<{ model?: string; fast?: string }> {
  const record = await getAddedState<ClaudeRecord>(CLAUDE_ID).catch(() => null);
  if (!record?.path || !record.choice) return {};
  try {
    const settings = parseSettings(record.path, await readTextIfExists(record.path));
    if (!routedByUs(asObject(settings.env))) return {};
  } catch {
    return {};
  }
  const served = (id: string | undefined) => (id && inCatalog(catalog, id) ? id : undefined);
  return {
    model: record.choice.fromProfile ? undefined : served(record.choice.model),
    fast: served(record.choice.fast),
  };
}
