import { isRoutableBaseUrl } from "../../config.js";
import { asObject, jsoncDelete, jsoncSet, parseWrittenObject } from "../managed-file.js";

/** Provider id in Pi's models.json and the key of its auth.json credential. */
export const PI_PROVIDER_ID = "aiand";

/**
 * What enable() recorded so off can tell its values from the user's. The
 * baked key never appears here: only ids, previous values, file modes,
 * and the absolute paths we wrote (paths are not secrets; the snapshot
 * manifest already stores them).
 */
export type PiRecord = {
  /** What settings.json's defaultProvider was before on (undefined = absent). */
  previousDefaultProvider?: string;
  /** What settings.json's defaultModel was before the write off must undo. */
  previousDefaultModel?: string;
  /** The defaultModel this on wrote (a catalog id); off hands back or removes it. */
  wroteDefaultModel?: string;
  /**
   * The providers.aiand baseUrl `on` wrote — names only, never the
   * key. probe, disable, and refreshKey prove a stamp-less block is
   * still ours by matching it; a repointed block is the user's.
   * (#18 P18-pi-1)
   */
  wroteBaseUrl?: string;
  /** File mode before `on` wrote it, per file off rewrites. */
  previousModelsMode?: number;
  previousSettingsMode?: number;
  /** auth.json's mode before `on` wrote it; a new file stays private. */
  previousAuthMode?: number;
  /** Where `on` actually wrote the files; off strips them if the dir moved. */
  modelsPath?: string;
  authPath?: string;
  settingsPath?: string;
};

/** The provider block Pi's model runtime composes from models.json. */
export function aiandProvider(
  models: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return asObject(asObject(models.providers)?.[PI_PROVIDER_ID]);
}

/**
 * parseWrittenObject for raw file text: {} when empty, undefined when
 * malformed. Never throws — a file mid-edit must fail the ownership
 * proof below, not crash a status or cleanup path.
 */
export function parseConfigQuiet(text: string): Record<string, unknown> | undefined {
  try {
    return text.trim() ? parseWrittenObject(text) : {};
  } catch {
    return undefined;
  }
}

/**
 * The proof that a stamp-less routing is still ours: the models.json
 * block names the baseUrl `on` wrote, it is still routable, and
 * settings.json still defaults to aiand. The record alone never proves
 * anything — with no record, wroteBaseUrl is undefined and no
 * routable block can match it. (#18 P18-pi-1, P18-pi-2, P18-pi-4,
 * P18-pi-5)
 */
export function routingStillOurs(
  models: Record<string, unknown> | undefined,
  settings: Record<string, unknown> | undefined,
  added: PiRecord | null,
): boolean {
  const baseUrl = models === undefined ? undefined : aiandProvider(models)?.baseUrl;
  return (
    baseUrl === added?.wroteBaseUrl &&
    isRoutableBaseUrl(baseUrl) &&
    settings?.defaultProvider === PI_PROVIDER_ID
  );
}

/**
 * The settings.json hand-back off performs on one file, current dir or
 * moved: a defaultModel we wrote is restored (or removed) only while it is
 * still ours, and a defaultProvider we set is handed back. Values the user
 * changed in between are theirs and stay, with a note.
 */
export function handBackSettings(
  text: string,
  added: PiRecord | null,
): { text: string; notes: string[] } {
  const notes: string[] = [];
  const settings = text.trim() ? parseWrittenObject(text) : {};
  let out = text;
  if (added?.wroteDefaultModel !== undefined) {
    if (settings.defaultModel === added.wroteDefaultModel) {
      out =
        added.previousDefaultModel !== undefined
          ? jsoncSet(out, ["defaultModel"], added.previousDefaultModel)
          : jsoncDelete(out, ["defaultModel"]);
    } else if (settings.defaultModel !== undefined) {
      notes.push("left defaultModel because you edited it");
    }
  }
  if (settings.defaultProvider === PI_PROVIDER_ID) {
    out =
      added?.previousDefaultProvider !== undefined
        ? jsoncSet(out, ["defaultProvider"], added.previousDefaultProvider)
        : jsoncDelete(out, ["defaultProvider"]);
  } else if (settings.defaultProvider !== undefined) {
    notes.push("left defaultProvider because you edited it");
  }
  return { text: out, notes };
}

/**
 * models.json text with our provider block dropped: unrelated providers
 * survive, and an emptied `providers` map (ours alone) is dropped with it.
 * An empty or malformed text passes through unchanged (nothing of ours to
 * drop), never throws.
 */
export function dropPiProvider(text: string): string {
  let out = jsoncDelete(text, ["providers", PI_PROVIDER_ID]);
  const left = asObject((out.trim() ? parseWrittenObject(out) : {}).providers);
  if (left && Object.keys(left).length === 0) {
    out = jsoncDelete(out, ["providers"]);
  }
  return out;
}
