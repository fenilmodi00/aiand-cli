// Which `aiand` provider row and model pin are ours, from the record `on`
// left, and how off hands them back.
import { isRoutableBaseUrl } from "../../config.js";
import { isAiandKey } from "../known-keys.js";
import { asObject, jsoncDelete, jsoncSet, parseWrittenObject } from "../managed-file.js";
import { COPILOT_PROVIDER_NAME, COPILOT_SELECTION_PREFIX, copilotBaseUrl } from "./provider.js";

/**
 * What enable() recorded so off can tell its values from the user's. The
 * baked key never appears here: only selections, the baseUrl we wrote,
 * previous values, modes, and the paths we wrote (not secrets; the
 * snapshot manifest already stores them).
 */
export type CopilotRecord = {
  /** settings.json's `model` before on overwrote it (undefined = absent). */
  previousModelSelection?: string;
  /** The `aiand/<id>` selection this on wrote; off hands back or removes it. */
  wroteModelSelection?: string;
  /**
   * The provider row's baseUrl this on wrote — names only, never
   * the key: off/refresh-key prove the row ours by it.
   */
  wroteBaseUrl?: string;
  /** SHA-256 of the key this on wrote: lets off recognise it after rotation. */
  wroteKeyHash?: string;
  /** File mode before `on` wrote it, per file off rewrites. */
  previousProvidersMode?: number;
  previousSettingsMode?: number;
  /** Where `on` actually wrote the files; off strips them if the dir moved. */
  providersPath?: string;
  settingsPath?: string;
};

/** The `aiand` provider row in providers.json `providers[]`, when shaped like one. */
export function aiandRow(providers: Record<string, unknown>): Record<string, unknown> | undefined {
  const rows = Array.isArray(providers.providers) ? providers.providers : [];
  return rows.map(asObject).find((row) => row?.name === COPILOT_PROVIDER_NAME);
}

/**
 * Ownership proof, mirroring the shared stamp-or-record gating: the
 * provider name alone is not proof — the CLI ignores unknown provider
 * fields (neither errors on nor preserves them), so a marker field would
 * not survive as durable proof, and a routable `aiand` row can be the
 * user's own hand write. With
 * a live record the row is ours only while its baseUrl still names where
 * `on` wrote it (a repointed row is the user's, key inside); without a
 * record (state dir wiped) only the baked shape for `expectedBaseUrl`
 * (default profile's URL, probe's case), key included, is ours.
 */
export function isOurRow(
  row: Record<string, unknown> | undefined,
  added: CopilotRecord | null,
  expectedBaseUrl: string = copilotBaseUrl(),
): boolean {
  if (row === undefined || !isRoutableBaseUrl(row.baseUrl)) return false;
  if (added?.wroteBaseUrl !== undefined) return row.baseUrl === added.wroteBaseUrl;
  return row.baseUrl === expectedBaseUrl && typeof row.apiKey === "string";
}

/**
 * The settings.json selection hand-back off performs on one file, current
 * dir or moved: an `aiand/`-prefixed `model` is ours to undo (off just
 * deleted every row that could serve it, so leaving it dangles a dead
 * model); the user's own value stays, with a note.
 */
export function handBackSelection(
  text: string,
  added: CopilotRecord | null,
): { text: string; notes: string[] } {
  const notes: string[] = [];
  const model = text.trim() ? parseWrittenObject(text).model : undefined;
  const isOurSelection = typeof model === "string" && model.startsWith(COPILOT_SELECTION_PREFIX);
  let out = text;
  if (isOurSelection) {
    out =
      added?.previousModelSelection !== undefined
        ? jsoncSet(out, ["model"], added.previousModelSelection)
        : jsoncDelete(out, ["model"]);
  } else if (added?.wroteModelSelection !== undefined && model !== undefined) {
    notes.push("left model because you edited it");
  }
  return { text: out, notes };
}

/**
 * An `aiand` row a live record says `on` wrote, still holding one of our
 * keys, that the user repointed since. The row is theirs; the key in it is
 * ours only when it is a known ai& key: a key the user put there stays.
 */
export function keyedRowWeWrote(
  row: Record<string, unknown> | undefined,
  added: CopilotRecord | null,
  known: readonly string[],
): boolean {
  return added?.wroteBaseUrl !== undefined && isAiandKey(row?.apiKey, known, added.wroteKeyHash);
}

/** providers.json text with the `aiand` row's apiKey dropped; every other field stays. */
export function withoutRowKey(text: string, providers: Record<string, unknown>): string {
  const rows = (Array.isArray(providers.providers) ? providers.providers : []).map((entry) => {
    const row = asObject(entry);
    if (row?.name !== COPILOT_PROVIDER_NAME) return entry;
    const { apiKey: _ours, ...rest } = row;
    return rest;
  });
  return jsoncSet(text, ["providers"], rows);
}
