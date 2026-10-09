import { type Dirent, existsSync } from "node:fs";
import { chmod, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CliError } from "../../cli/errors.js";
import { DEFAULT_BASE_URL, isRoutableBaseUrl, trimSlash, writeFileAtomic } from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import { inCatalog } from "../catalog.js";
import { detectBinary } from "../detect.js";
import { readTextIfExists } from "../managed-file.js";
import {
  clearAddedState,
  fileCreatedByUs,
  getAddedState,
  getAddedStateSync,
  recordAddedState,
} from "../snapshot.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeResult,
} from "../types.js";
import { dshHome, sessionLaunch } from "./launch.js";
import {
  credentialDocumentEmpty,
  credentialRefDelete,
  findRowById,
  leadingSpaces,
  type RowBlock,
  rowHasLine,
  rowProviderKeys,
  rowValue,
  spliceRow,
  stripOwnershipLines,
  unquote,
} from "./patch.js";
import {
  buildDshCredentials,
  buildDshDefaultRow,
  buildDshLlmRow,
  DEFAULT_ROW_ID,
  DSH_BANNER,
  DSH_KEY_REF,
  DSH_MARKER,
  DSH_ROUTE,
  LLM_ROW_ID,
} from "./rows.js";

const DSH_ID = "dsh";
const DSH_BIN = "dsh";

/** The dsh release the install hint pins (check-dist keeps ci.yml in step).
 * @public read from dist/ by scripts/check-dist.mjs */
export const DSH_VERSION = "0.2.0-rc.2";

const DSH_INSTALL = {
  command: `npm install -g --ignore-scripts @deepseek-ai/dsh@${DSH_VERSION}`,
  url: "https://deepseek.com/en/harness/",
};

/** `$DSH_HOME` resolves through the shared launcher helper so `on` and
 * `run-agent` agree on the root. */
const dshPatchPath = (home = dshHome()): string => join(home, "cordis.patch.yml");
const dshCredentialsPath = (patchPath = dshPatchPath()): string =>
  join(dirname(patchPath), ".credentials.yaml");

const dshBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

/** What enable() recorded so off can tell its own values from the user's.
 * Never the key: only ids, previous values, paths, and file modes. */
type DshRecord = {
  /** The route baseURL `on` wrote: the durable proof a row whose marker a
   * rewrite dropped is still ours. A repointed row is the user's. */
  wroteBaseUrl?: string;
  /** The default row's provider/model before `on` replaced it (undefined =
   * there was no row, so off removes it instead of restoring). */
  previousProvider?: string;
  previousModel?: string;
  /** The provider/model this `on` wrote. */
  wroteProvider?: string;
  wroteModel?: string;
  /** Modes before `on` wrote each file; a file on created stays private. */
  previousPatchMode?: number;
  previousCredsMode?: number;
  /** Where `on` actually wrote; `off` strips there too if the home moved. */
  patchPath?: string;
  credsPath?: string;
};

/** Whether a foreign llm-pi-ai row's `config:` block holds anything our
 * whole-row replace would clobber (providers, timeoutMs, anything). Empty
 * (`config:` alone) or absent is the dormant shipped shape and stays
 * replaceable. */
function rowHasConfigContent(row: RowBlock): boolean {
  const header = row.lines.findIndex((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return false;
    return /^(-\s+)?config:(?=\s|$)/.test(trimmed.split("#")[0]!.trim());
  });
  if (header < 0) return false;
  // An inline value (`config: {...}`) is content itself.
  if (
    row.lines[header]!.split("#")[0]!
      .replace(/^\s*(?:-\s+)?config:\s*/, "")
      .trim() !== ""
  ) {
    return true;
  }
  const base = leadingSpaces(row.lines[header]!);
  return row.lines
    .slice(header + 1)
    .some(
      (line) => line.trim() !== "" && !line.trim().startsWith("#") && leadingSpaces(line) > base,
    );
}

/** Our route row plus whether it still carries the ownership marker. */
type Ours = { row: RowBlock; marked: boolean };

/** Whether a row proves itself ours: the marker is present, or a rewrite
 * dropped it while the record's exact baseURL and key ref survive. The
 * record alone never proves anything — a foreign route merely named `aiand`
 * matches neither proof, so probe, off and refreshKey always agree. */
function ourLlmRow(patchText: string, added: DshRecord | null): Ours | undefined {
  const row = findRowById(patchText, LLM_ROW_ID);
  if (row === undefined) return undefined;
  if (rowHasLine(row, DSH_MARKER)) return { row, marked: true };
  const baseUrl = rowValue(row, "baseURL");
  const proven =
    baseUrl !== undefined &&
    baseUrl === added?.wroteBaseUrl &&
    isRoutableBaseUrl(baseUrl) &&
    rowValue(row, "apiKeyEnv") === DSH_KEY_REF;
  return proven ? { row, marked: false } : undefined;
}

const markedDefaultRow = (patchText: string): RowBlock | undefined => {
  const row = findRowById(patchText, DEFAULT_ROW_ID);
  return row !== undefined && rowHasLine(row, DSH_MARKER) ? row : undefined;
};

/** Profile layers shadowing our home route: the home llm-pi-ai row
 * replaces the entry's whole config, hiding Web UI providers in any profile
 * layer while the aiand route is on. Best-effort: a broken profile file
 * never refuses routing. */
async function profileLayerWarnings(home: string): Promise<string[]> {
  const warnings: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(join(home, "profiles"), { withFileTypes: true });
  } catch {
    return warnings;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profilePatch = join(home, "profiles", entry.name, "cordis.patch.yml");
    try {
      const text = await readTextIfExists(profilePatch);
      if (text !== "" && findRowById(text, LLM_ROW_ID) !== undefined) {
        warnings.push(
          `The dsh profile layer ${profilePatch} also configures llm-pi-ai; its providers are hidden while the aiand route is on.`,
        );
      }
    } catch {}
  }
  return warnings;
}

async function probe(): Promise<ProbeResult> {
  // A file this parser cannot read (duplicate keys, a flow-style block)
  // reads as not-ours: status is a read surface and never crashes on the
  // user's hand-edited file, same as claude's probe.
  try {
    const added = await getAddedState<DshRecord>(DSH_ID);
    const patchText = await readTextIfExists(dshPatchPath());
    if (ourLlmRow(patchText, added) === undefined) return { active: false, model: null };
    const row = markedDefaultRow(patchText);
    const provider = row === undefined ? undefined : rowValue(row, "provider");
    const model = row === undefined ? undefined : rowValue(row, "model");
    // Routing is live even when the default points elsewhere (the user picked
    // in dsh's own UI, or the row was stamped over a foreign one): then the
    // model reads unpinned, like the config-only adapters report.
    return { active: true, model: provider === DSH_ROUTE && model !== undefined ? model : null };
  } catch {
    return { active: false, model: null };
  }
}

async function enable(input: EnableInput): Promise<EnableResult> {
  if (input.model === "native") {
    // dsh's own default is the official DeepSeek route, which needs a
    // DeepSeek key the gateway cannot supply — an unpinned session would
    // fail its first prompt. Same refusal Codex makes (CONTEXT.md: Native).
    throw new CliError("DeepSeek Harness's own models are not on ai&.", {
      hint: "Pass --model with an ai& model id, or leave it out for the default.",
    });
  }
  const patchPath = dshPatchPath();
  const credsPath = dshCredentialsPath();
  const added = await getAddedState<DshRecord>(DSH_ID);
  let rawPatch: string;
  let existing: Ours | undefined;
  let existingRow: RowBlock | undefined;
  let defaultRow: RowBlock | undefined;
  let providerRead: string | undefined;
  let modelRead: string | undefined;
  try {
    rawPatch = await readTextIfExists(patchPath);
    existing = ourLlmRow(rawPatch, added);
    existingRow = findRowById(rawPatch, LLM_ROW_ID);
    defaultRow = findRowById(rawPatch, DEFAULT_ROW_ID);
    providerRead = defaultRow === undefined ? undefined : rowValue(defaultRow, "provider");
    modelRead = defaultRow === undefined ? undefined : rowValue(defaultRow, "model");
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError(`${patchPath} is not a patch file aiand can read: ${error.message}`, {
        hint: "Fix it by hand, then run aiand dsh on again.",
      });
    }
    throw error;
  }
  const currentProvider = providerRead;
  const currentModel = modelRead;

  // A hand-written llm-pi-ai row whose `config:` block holds anything is
  // the user's own composition: our whole-row replace would delete it, so
  // refuse. An empty or absent config is the dormant shipped shape and
  // stays replaceable. A row still proving itself ours may be re-`on`ed.
  if (
    existing === undefined &&
    existingRow !== undefined &&
    (rowProviderKeys(existingRow).length > 0 || rowHasConfigContent(existingRow))
  ) {
    throw new CliError("dsh already has a provider config that ai& does not manage.", {
      hint: `Remove or rename the aiand route in ${patchPath}, then run aiand dsh on again.`,
    });
  }
  // The prior record stays authoritative only while our routing is still
  // live; after an off or a foreign write it must not be carried forward.
  const prior = existing !== undefined ? added : null;

  const defaultMarked = defaultRow !== undefined && rowHasLine(defaultRow, DSH_MARKER);
  const userServable =
    currentProvider === DSH_ROUTE &&
    currentModel !== undefined &&
    inCatalog(input.catalog, currentModel);
  // Our own write, untouched since: the first capture's undo target stands.
  const ourUntouched =
    defaultMarked &&
    prior !== null &&
    currentProvider === prior.wroteProvider &&
    currentModel === prior.wroteModel;

  let wroteModel = input.model;
  let previousProvider = prior?.previousProvider;
  let previousModel = prior?.previousModel;
  const warnings: string[] = [];
  warnings.push(...(await profileLayerWarnings(dshHome())));

  if (userServable && !input.pinModel) {
    // A servable model the user left inside our routing is theirs: keep it.
    // Only a foreign (unmarked) default row needs an undo target — an
    // unmarked row means on stamped over their config.
    wroteModel = currentModel;
    // A marker a rewrite dropped does not make the row foreign. Capturing
    // the undo target only on the first stamp keeps the hand-back the user
    // had before `on`; a later re-on must not overwrite it with the aiand
    // values already in the file.
    if (!ourUntouched && !defaultMarked && prior === null) {
      previousProvider = currentProvider;
      previousModel = currentModel;
    }
  } else if (currentProvider !== undefined && currentProvider !== DSH_ROUTE && !ourUntouched) {
    // Replacing a default that is not our own still-live write: hand it back
    // on off, and say so when the gateway could never serve it.
    previousProvider = currentProvider;
    previousModel = currentModel;
    if (currentModel === undefined || !inCatalog(input.catalog, currentModel)) {
      warnings.push(
        `Set aside your dsh default (${currentProvider}/${currentModel ?? "unset"}); aiand dsh off puts it back.`,
      );
    }
  }

  const baseUrl = dshBaseUrl(input.baseUrl);
  let patchText = spliceRow(rawPatch, LLM_ROW_ID, buildDshLlmRow(baseUrl, input.catalog));
  patchText = spliceRow(patchText, DEFAULT_ROW_ID, buildDshDefaultRow(DSH_ROUTE, wroteModel, true));
  const rawCreds = await readTextIfExists(credsPath);
  let credsText: string;
  try {
    credsText = buildDshCredentials(rawCreds, input.apiKey);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError(
        `${credsPath} is not a credentials file aiand can read: ${error.message}`,
        { hint: "Fix it by hand, then run aiand dsh on again." },
      );
    }
    throw error;
  }

  // The patch file carries no secret (the key rides in the credential ref),
  // so an existing mode is respected and a created file takes the ordinary
  // 0644 a user's own patch file would have. The credential file is 0600 for
  // as long as our key lives in it — dsh enforces that mode on its own
  // store — and a file on created has no prior mode, so it stays private.
  const previousPatchMode =
    prior?.previousPatchMode ?? (rawPatch === "" ? undefined : await existingFileMode(patchPath));
  const previousCredsMode =
    prior?.previousCredsMode ?? (rawCreds === "" ? undefined : await existingFileMode(credsPath));

  await writeFileAtomic(patchPath, patchText, { mode: previousPatchMode ?? DEFAULT_FILE_MODE });
  await writeFileAtomic(credsPath, credsText, { mode: PRIVATE_FILE_MODE });
  if (credsText === rawCreds) await chmod(credsPath, PRIVATE_FILE_MODE);

  await recordAddedState(DSH_ID, {
    wroteBaseUrl: baseUrl,
    previousProvider,
    previousModel,
    wroteProvider: DSH_ROUTE,
    wroteModel,
    previousPatchMode,
    previousCredsMode,
    patchPath,
    credsPath,
  });

  return {
    model: wroteModel,
    catalogModel: inCatalog(input.catalog, wroteModel) ? wroteModel : undefined,
    filesWritten: [patchPath, credsPath],
    warnings,
  };
}

/** The ownership proofs (banner + marker) removed from rows the user is
 * keeping: an edited route must stop reading as ours on the next probe. */
function releaseOwnership(patchText: string): string {
  return stripOwnershipLines(patchText, DSH_MARKER, DSH_BANNER);
}

/** Strip one home directory's aiand wiring, given the record. `stripped` is
 * honest: notes about values left behind for the user do not count. */
async function stripHome(
  patchPath: string,
  credsPath: string,
  added: DshRecord | null,
): Promise<{ stripped: boolean; notes: string[] }> {
  let rawPatch: string;
  let ours: Ours | undefined;
  let patchText: string;
  const notes: string[] = [];
  let stripped = false;
  // The credential read cannot throw; the patch read can. Read the creds
  // first so a parse crash still knows whether it must drop the key.
  const rawCreds = await readTextIfExists(credsPath);
  const credsText = rawCreds === "" ? rawCreds : credentialRefDelete(rawCreds, DSH_KEY_REF);
  try {
    rawPatch = await readTextIfExists(patchPath);
    ours = ourLlmRow(rawPatch, added);
    if (ours === undefined) return { stripped: false, notes: [] };
    // Compute every edit before writing anything: a file the user broke
    // mid-edit must not leave half-stripped state behind — a raw throw after
    // the first write would strand the key in the credential file.
    patchText = rawPatch;
    if (ours.marked && rowValue(ours.row, "baseURL") !== added?.wroteBaseUrl) {
      // A marked row the user repointed is theirs now: release the ownership
      // proofs, keep the routing they edited, and let the default pin go.
      notes.push("left the aiand route because you edited it");
      patchText = releaseOwnership(patchText);
    } else {
      patchText = spliceRow(patchText, LLM_ROW_ID, undefined);
      stripped = true;
    }

    const defaultRow = markedDefaultRow(patchText);
    if (defaultRow !== undefined) {
      const provider = rowValue(defaultRow, "provider");
      const model = rowValue(defaultRow, "model");
      if (provider !== added?.wroteProvider) {
        notes.push("left the aiand default because you edited it");
      } else if (model !== added?.wroteModel) {
        notes.push("left the aiand default model because you edited it");
      } else if (added?.previousProvider !== undefined && added?.previousModel !== undefined) {
        patchText = spliceRow(
          patchText,
          DEFAULT_ROW_ID,
          buildDshDefaultRow(added.previousProvider, added.previousModel, false),
        );
      } else {
        patchText = spliceRow(patchText, DEFAULT_ROW_ID, undefined);
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      // A baked key must never outlive the strip — including when the file
      // broke at document level (a tab, a second document) before
      // ourLlmRow could prove the row ours: the record plus the key we
      // baked are proof enough to drop the ref, and the record stays so a
      // retry after the hand fix still completes. Before any on of ours
      // (no record, nothing baked), the files are the user's alone.
      if (credsText !== rawCreds) {
        await writeFileAtomic(credsPath, credsText, {
          mode: added?.previousCredsMode ?? PRIVATE_FILE_MODE,
        }).catch(() => {});
      }
      throw new CliError(`${patchPath} is not a patch file aiand can read: ${error.message}`, {
        hint: "Fix it by hand, then run aiand dsh off again.",
      });
    }
    throw error;
  }
  const credsChanged = credsText !== rawCreds;

  // The credential ref is ours to remove whenever the routing proves ours —
  // even when the route block itself is now the user's: a baked key must
  // never outlive the strip.
  if (credsChanged) {
    if (credentialDocumentEmpty(credsText) && (await fileCreatedByUs(DSH_ID, credsPath))) {
      await rm(credsPath, { force: true });
    } else {
      await writeFileAtomic(credsPath, credsText, {
        mode: added?.previousCredsMode ?? PRIVATE_FILE_MODE,
      });
    }
    stripped = true;
  } else if (
    rawCreds !== "" &&
    credentialDocumentEmpty(rawCreds) &&
    (await fileCreatedByUs(DSH_ID, credsPath))
  ) {
    // A previous off dropped the key but died before unlinking the file it
    // created: finish the job.
    await rm(credsPath, { force: true });
    stripped = true;
  }

  if (patchText !== rawPatch) {
    if (patchText.trim() === "" && (await fileCreatedByUs(DSH_ID, patchPath))) {
      await rm(patchPath, { force: true });
    } else {
      await writeFileAtomic(patchPath, patchText, {
        mode: added?.previousPatchMode ?? DEFAULT_FILE_MODE,
      });
    }
    stripped = true;
  }
  return { stripped, notes };
}

async function disable(): Promise<DisableResult> {
  const added = await getAddedState<DshRecord>(DSH_ID);
  const current = await stripHome(dshPatchPath(), dshCredentialsPath(), added);
  const notes = [...current.notes];
  let stripped = current.stripped;

  // A $DSH_HOME move between on and off strands the wired files in the old
  // home: strip the recorded paths too, or the credential ref keeps a live
  // key nothing current points at.
  if (
    added?.patchPath !== undefined &&
    added.patchPath !== dshPatchPath() &&
    existsSync(added.patchPath)
  ) {
    const stale = await stripHome(
      added.patchPath,
      added.credsPath ?? dshCredentialsPath(added.patchPath),
      added,
    );
    if (stale.stripped) {
      stripped = true;
      notes.push(`stripped the aiand config from ${added.patchPath} because the dsh home moved`);
    }
    for (const note of stale.notes) notes.push(note);
  }

  await clearAddedState(DSH_ID);
  return { stripped, notes: notes.length > 0 ? notes : undefined };
}

/** The raw value of our credentials ref (unquoted), for the previousKey test. */
function readCredentialRef(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (line.trim().startsWith(`${DSH_KEY_REF}:`)) {
      return unquote(line.slice(line.indexOf(":") + 1).trim());
    }
  }
  return undefined;
}

async function refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
  // Gated like disable(): only routing that proves itself ours authorizes a
  // swap, and a rotation only swaps the key it replaced — a ref holding a
  // hand-set value is the user's. A read or parse failure is a plain false,
  // never a throw: rebake runs while the user may be mid-edit. The write is
  // not swallowed — a genuine failure (EACCES, disk full) must reach rebake
  // instead of silently skipping the rotation.
  let path: string;
  let raw: string;
  try {
    const added = await getAddedState<DshRecord>(DSH_ID);
    const patchText = await readTextIfExists(dshPatchPath());
    const ours = ourLlmRow(patchText, added);
    if (ours === undefined) return false;
    // A marked row whose baseURL the user changed is theirs. off releases
    // it and drops the baked ref; a rotation must not write the session
    // key at that endpoint first.
    if (added?.wroteBaseUrl !== undefined && rowValue(ours.row, "baseURL") !== added.wroteBaseUrl) {
      return false;
    }
    path = dshCredentialsPath();
    raw = await readTextIfExists(path);
    const current = readCredentialRef(raw);
    if (current === undefined) return false;
    if (current === input.apiKey) {
      // A same-key rebake still re-tightens a loosened file mode.
      await chmod(path, PRIVATE_FILE_MODE).catch(() => {});
      return true;
    }
    if (input.previousKey !== undefined && current !== input.previousKey) return false;
  } catch {
    return false;
  }
  await writeFileAtomic(path, buildDshCredentials(raw, input.apiKey), {
    mode: PRIVATE_FILE_MODE,
  });
  return true;
}

export const dshAdapter: AgentAdapter = {
  id: DSH_ID,
  label: "DeepSeek Harness",
  bin: DSH_BIN,
  install: DSH_INSTALL,
  detect(): DetectResult {
    return detectBinary(DSH_BIN);
  },
  managedFiles(): string[] {
    const paths = new Set([dshPatchPath(), dshCredentialsPath()]);
    const added = getAddedStateSync<DshRecord>(DSH_ID);
    if (added?.patchPath !== undefined) paths.add(added.patchPath);
    if (added?.credsPath !== undefined) paths.add(added.credsPath);
    return [...paths];
  },
  probe,
  enable,
  disable,
  refreshKey,
  sessionLaunch,
};
