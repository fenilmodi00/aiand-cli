import type { Model } from "../../api/models.js";
import { writeFileAtomic } from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode } from "../../fsutil.js";
import { asObject, jsoncDelete, jsoncSet, readTextIfExists } from "../managed-file.js";
import { inCatalog, nonEmpty, parseSettings, routedByUs } from "./settings.js";

/**
 * Putting the user's own default model back after a one-session launch:
 * Claude Code's `/model` → "set as default" saves to the user's settings even
 * inside an ai& session, where a plain `claude` could not use it.
 */
export type UserDefault = { model: unknown; replaced?: string; wired?: boolean };

export function launchDefault(settings: Record<string, unknown>, catalog: Model[]): UserDefault {
  if (routedByUs(asObject(settings.env))) return { model: settings.model, wired: true };
  const { model } = settings;
  return { model: nonEmpty(model) && inCatalog(catalog, model) ? undefined : model };
}

/** `/model` → "set as default" saves to the user's settings even inside an ai& session. */
export function putBackStep(
  user: UserDefault,
  settings: Record<string, unknown>,
  catalog: Model[],
): string | undefined {
  if (user.wired) return undefined;
  if (routedByUs(asObject(settings.env))) {
    user.wired = true;
    return undefined;
  }
  const saved = settings.model;
  if (saved === user.model) return undefined;
  if (!nonEmpty(saved) || !inCatalog(catalog, saved)) {
    user.model = saved;
    return undefined;
  }
  return saved;
}

export async function putBackUserDefault(
  path: string,
  user: UserDefault,
  catalog: Model[],
): Promise<void> {
  let raw: string;
  let pick: string | undefined;
  try {
    raw = await readTextIfExists(path);
    pick = putBackStep(user, parseSettings(path, raw), catalog);
  } catch {
    return;
  }
  if (pick === undefined) return;
  // ponytail: no lock; a Claude Code write landing in the same instant is lost.
  const text =
    user.model === undefined ? jsoncDelete(raw, ["model"]) : jsoncSet(raw, ["model"], user.model);
  await writeFileAtomic(path, text, { mode: (await existingFileMode(path)) ?? DEFAULT_FILE_MODE });
  user.replaced = pick;
}
