import path from "node:path";
import os from "node:os";

import { CliError } from "../cli/errors.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { detectForeign } from "./foreign.js";
import { assertIdeStopped, CURSOR_SPEC } from "./ide-guard.js";
import { agentHome } from "./paths.js";
import {
  decryptSecret,
  encryptSecret,
  isSecretEncryptionAvailable,
} from "./safestorage.js";
import { applyItemTableWrites, ensureItemTable, readItemTableValue } from "./vscdb.js";
import type { ItemTableMutation } from "./vscdb.js";
import type { AgentAdapter, DetectResult, EnableInput, ProbeResult } from "./types.js";

/**
 * Cursor stores AI settings in a SQLite DB (`state.vscdb`), not a JSON file.
 *
 * - API key        -> ItemTable row `secret://cursorAuth/openAIKey`, an Electron
 *                     `safeStorage`-encrypted cell. Older Cursor builds used a
 *                     plaintext `cursorAuth/openAIKey` cell — we still write
 *                     that as a fallback so either Cursor version can read it.
 * - Base URL       -> field `openAIBaseUrl` on the `applicationUser` JSON blob.
 * - Custom models  -> `aiSettings.userAddedModels` + `aiSettings.modelOverrideEnabled`.
 * - Per-mode model -> `aiSettings.modelConfig[mode].{modelName, selectedModels}`.
 *
 * The `applicationUser` blob is one ItemTable row whose value is a compact JSON
 * string. We read/write it as text and re-serialize as compact JSON to keep the
 * on-disk byte delta minimal (Cursor's own format is compact).
 */

/** The ItemTable key holding the whole `applicationUser` JSON blob. */
export const APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

/** The API key base URL field on the blob. */
export const CURSOR_BASE_URL = "https://api.aiand.com/v1";

/** The OpenAI key cell modern Cursor reads. */
export const CURSOR_AUTH_OPENAI_KEY = "cursorAuth/openAIKey";

/**
 * The encrypted key cell modern Cursor reads. The value is
 * `JSON.stringify(safeStorage.encryptString(plaintext))` — the same form
 * Cursor stores for other secrets. Cursor writes an empty ciphertext
 * (`{"type":"Buffer","data":[]}`) here when the user clears the key in the
 * IDE, which is why a stale plaintext `cursorAuth/openAIKey` cell can't
 * override it.
 */
export const CURSOR_AUTH_OPENAI_KEY_SECRET = "secret://cursorAuth/openAIKey";

/**
 * The empty ciphertext Cursor itself writes to the `secret://` cell when the
 * user clears the key in the IDE (`safeStorage.encryptString("")` round-trips
 * to an empty buffer). Used by `off`/restore so a "no key" state matches
 * Cursor's own on-disk shape rather than a missing row.
 */
export const EMPTY_SAFE_STORAGE_CIPHERTEXT = JSON.stringify({ type: "Buffer", data: [] });

/** Cursor "modes" that carry a selected model in aiSettings.modelConfig. */
export const CURSOR_DEFAULT_MODE = "composer";

/** Field we own on the blob to track which models we registered. */
const AIAND_ADDED_FIELD = "aiandAddedModels";
/** Field we own to track which modes we touched (for clean reset). */
const AIAND_TOUCHED_MODES_FIELD = "aiandTouchedModes";

/**
 * Resolve the path to Cursor's state.vscdb for the current platform.
 * Resolves from the harness home (agentHome, which tests point at a temp dir)
 * so tests/isolated runs never touch the real user profile; XDG_CONFIG_HOME is
 * likewise resolved relative to that home, not the OS HOME.
 */
export function cursorStateDbPath(opts: { home?: string; dbPath?: string } = {}): string {
  if (opts.dbPath) {
    return opts.dbPath;
  }
  const baseHome = opts.home || agentHome();
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(
      baseHome,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb"
    );
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(baseHome, "AppData", "Roaming");
    return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  // linux / others follow the XDG-ish Cursor layout
  const configHome = process.env.XDG_CONFIG_HOME || path.join(baseHome, ".config");
  return path.join(configHome, "Cursor", "User", "globalStorage", "state.vscdb");
}

/**
 * Resolve Cursor's `Local State` file — the Chromium user-data root that holds
 * the OSCrypt `os_crypt.encrypted_key` (DPAPI-protected AES-256 key) on Windows.
 * state.vscdb lives at `<userData>/User/globalStorage/state.vscdb`, so `Local
 * State` is three levels up. Only used on Windows; harmless elsewhere.
 * @param {string} dbPath
 * @returns {string}
 */
export function cursorLocalStatePath(dbPath: string): string {
  return path.join(
    path.dirname(path.dirname(path.dirname(path.resolve(dbPath)))),
    "Local State"
  );
}

/* -------------------------------------------------------------------------- */
/* Blob I/O                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Read the applicationUser blob + the OpenAI key cell.
 * @param {string} dbPath
 * @returns {Promise<{ blob: Record<string, unknown>, openAIKey: string, exists: boolean }>}
 */
export async function readCursorState(
  dbPath: string
): Promise<{ blob: Record<string, unknown>; openAIKey: string; exists: boolean }> {
  const raw = await readItemTableValue(dbPath, APPLICATION_USER_KEY);
  let blob: Record<string, unknown> = {};
  let exists = false;
  if (raw) {
    blob = JSON.parse(raw) as Record<string, unknown>;
    exists = true;
  }
  if (!blob || typeof blob !== "object") {
    blob = {};
  }
  if (!blob.aiSettings || typeof blob.aiSettings !== "object") {
    blob.aiSettings = {};
  }
  const openAIKey = await readCursorOpenAiKey(dbPath);
  return { blob, openAIKey, exists };
}

/**
 * Read the OpenAI key Cursor actually uses, decrypting the `secret://` cell
 * that modern Cursor reads. Falls back to the legacy plaintext
 * `cursorAuth/openAIKey` cell for older Cursor builds. Returns "" when no
 * usable key is present (e.g. the user cleared it in the IDE, which leaves an
 * empty ciphertext).
 * @param {string} dbPath
 * @returns {Promise<string>}
 */
export async function readCursorOpenAiKey(dbPath: string): Promise<string> {
  const secretRaw = await readItemTableValue(dbPath, CURSOR_AUTH_OPENAI_KEY_SECRET);
  const secret = decryptSecret(secretRaw ?? "", {
    variant: "cursor",
    localStatePath: cursorLocalStatePath(dbPath),
  });
  if (secret) {
    return secret;
  }
  const legacy = await readItemTableValue(dbPath, CURSOR_AUTH_OPENAI_KEY);
  return legacy ?? "";
}

/* -------------------------------------------------------------------------- */
/* Pure blob transforms (no I/O — easy to unit-test)                          */
/* -------------------------------------------------------------------------- */

/** @returns {Record<string, unknown>} a blank aiSettings-shaped object */
export function emptyAiSettings(): Record<string, unknown> {
  return {
    userAddedModels: [],
    modelOverrideEnabled: [],
    modelConfig: {},
    [AIAND_ADDED_FIELD]: [],
    [AIAND_TOUCHED_MODES_FIELD]: [],
  };
}

/**
 * Shallow-clone `blob` and its `aiSettings`, hand the aiSettings clone to `fn`
 * for mutation, then reattach it. Collapses the repeated clone-and-assign
 * ceremony shared by every blob transform.
 * @param {Record<string, unknown>} blob
 * @param {(ai: Record<string, unknown>) => void} fn
 * @returns {Record<string, unknown>} new blob
 */
function withAiSettings(
  blob: Record<string, unknown>,
  fn: (ai: Record<string, unknown>) => void
): Record<string, unknown> {
  const next = { ...blob };
  const ai: Record<string, unknown> = {
    ...(blob.aiSettings && typeof blob.aiSettings === "object" ? blob.aiSettings : emptyAiSettings()),
  };
  fn(ai);
  next.aiSettings = ai;
  return next;
}

/**
 * Register a model id in the picker list (userAddedModels + modelOverrideEnabled),
 * dedup, and track it under aiandAddedModels so `off` only removes ours.
 * Model ids are used verbatim (no ref shortening — aiand ids are already final).
 * @param {Record<string, unknown>} blob
 * @param {string} modelId
 * @returns {Record<string, unknown>} new blob (shallow-cloned)
 */
export function addUserModel(blob: Record<string, unknown>, modelId: string): Record<string, unknown> {
  return withAiSettings(blob, (ai) => {
    const uam = dedupe([...(ai.userAddedModels as string[]) ?? []]);
    const moe = dedupe([...(ai.modelOverrideEnabled as string[]) ?? []]);
    const added = dedupe([...(ai[AIAND_ADDED_FIELD] as string[]) ?? []]);
    if (!uam.includes(modelId)) {
      uam.push(modelId);
    }
    if (!moe.includes(modelId)) {
      moe.push(modelId);
    }
    if (!added.includes(modelId)) {
      added.push(modelId);
    }
    ai.userAddedModels = uam;
    ai.modelOverrideEnabled = moe;
    ai[AIAND_ADDED_FIELD] = added;
  });
}

/**
 * Remove exactly the models we registered (tracked in aiandAddedModels) from
 * userAddedModels + modelOverrideEnabled, then clear the tracker. User-added
 * custom models are never touched.
 * @param {Record<string, unknown>} blob
 * @returns {Record<string, unknown>} new blob
 */
export function removeAiandModels(blob: Record<string, unknown>): Record<string, unknown> {
  const ai = (blob?.aiSettings ?? {}) as Record<string, unknown>;
  const ours = new Set<string>(
    ((ai[AIAND_ADDED_FIELD] as string[] | undefined) ?? []).filter(
      (x) => x != null && x !== ""
    )
  );
  if (ours.size === 0) {
    return { ...blob };
  }
  return withAiSettings(blob, (ai) => {
    ai.userAddedModels = ((ai.userAddedModels as string[] | undefined) ?? []).filter(
      (model) => !ours.has(model)
    );
    ai.modelOverrideEnabled = ((ai.modelOverrideEnabled as string[] | undefined) ?? []).filter(
      (model) => !ours.has(model)
    );
    ai[AIAND_ADDED_FIELD] = [];
  });
}

/**
 * Set the selected model for a Cursor mode, preserving maxMode and recording
 * the mode in aiandTouchedModes for clean reset.
 * @param {Record<string, unknown>} blob
 * @param {string} mode
 * @param {string} modelId
 * @returns {Record<string, unknown>} new blob
 */
export function setModeModel(
  blob: Record<string, unknown>,
  mode: string,
  modelId: string
): Record<string, unknown> {
  return withAiSettings(blob, (ai) => {
    const config = { ...((ai.modelConfig as Record<string, unknown> | undefined) ?? {}) };
    const prev = (config[mode] as Record<string, unknown> | undefined) ?? {};
    config[mode] = {
      ...prev,
      modelName: modelId,
      selectedModels: [{ modelId, parameters: [] }],
    };
    ai.modelConfig = config;
    const touched = dedupe([...(ai[AIAND_TOUCHED_MODES_FIELD] as string[]) ?? []]);
    if (!touched.includes(mode)) {
      touched.push(mode);
    }
    ai[AIAND_TOUCHED_MODES_FIELD] = touched;
  });
}

/**
 * Reset every mode we touched back to `"default"`, then clear the
 * touched-modes tracker. Modes the user configured themselves are left alone.
 *
 * We reset to Cursor's literal `"default"` so Cursor falls back to its own
 * model — the no-backup `off` strip path has no prior model to restore.
 * @param {Record<string, unknown>} blob
 * @returns {Record<string, unknown>} new blob
 */
export function resetTouchedModes(blob: Record<string, unknown>): Record<string, unknown> {
  const ai = (blob?.aiSettings ?? {}) as Record<string, unknown>;
  const touched = (ai[AIAND_TOUCHED_MODES_FIELD] as string[] | undefined) ?? [];
  if (touched.length === 0) {
    return { ...blob };
  }
  return withAiSettings(blob, (ai) => {
    const config = { ...((ai.modelConfig as Record<string, unknown> | undefined) ?? {}) };
    for (const mode of touched) {
      const prev = (config[mode] as Record<string, unknown> | undefined) ?? {};
      config[mode] = {
        ...prev,
        modelName: "default",
        selectedModels: [{ modelId: "default", parameters: [] }],
      };
    }
    ai.modelConfig = config;
    ai[AIAND_TOUCHED_MODES_FIELD] = [];
  });
}

/** @param {Record<string, unknown>} blob @param {string | null} url */
export function setOpenAiBaseUrl(
  blob: Record<string, unknown>,
  url: string | null
): Record<string, unknown> {
  return { ...blob, openAIBaseUrl: url };
}

/** @param {Record<string, unknown>} blob @param {boolean} enabled */
export function setUseOpenAiKey(
  blob: Record<string, unknown>,
  enabled: boolean
): Record<string, unknown> {
  return { ...blob, useOpenAIKey: Boolean(enabled) };
}

/**
 * Fields only we write. Their presence is proof we applied config to this
 * Cursor, independent of whether the API key is still readable.
 * @param {Record<string, unknown>} blob
 * @returns {boolean}
 */
export function cursorHasAiandMarkers(blob: Record<string, unknown>): boolean {
  const ai = (blob?.aiSettings ?? {}) as Record<string, unknown>;
  return (
    ((ai[AIAND_ADDED_FIELD] as unknown[] | undefined)?.length ?? 0) > 0 ||
    ((ai[AIAND_TOUCHED_MODES_FIELD] as unknown[] | undefined)?.length ?? 0) > 0
  );
}

/**
 * @param {Record<string, unknown>} blob
 * @param {string} mode
 * @returns {string} model id or "" if unset
 */
export function cursorCurrentModelId(blob: Record<string, unknown>, mode: string): string {
  const ai = (blob?.aiSettings ?? {}) as Record<string, unknown>;
  const cfg = (ai.modelConfig as Record<string, unknown> | undefined)?.[mode] as
    | Record<string, unknown>
    | undefined;
  const name = cfg?.modelName;
  if (typeof name === "string") {
    return name;
  }
  const selected = cfg?.selectedModels as Array<{ modelId?: string }> | undefined;
  return typeof selected?.[0]?.modelId === "string" ? selected[0].modelId : "";
}

/** @param {Record<string, unknown>} blob @returns {string[]} modes already present in modelConfig */
export function existingModes(blob: Record<string, unknown>): string[] {
  const ai = (blob?.aiSettings ?? {}) as Record<string, unknown>;
  const cfg = ai.modelConfig;
  return cfg && typeof cfg === "object" ? Object.keys(cfg) : [];
}

/**
 * Set the same model on every mode that already exists in modelConfig.
 * Non-destructive: modes without an existing entry are not created.
 * @param {Record<string, unknown>} blob
 * @param {string} modelId
 * @returns {Record<string, unknown>} new blob
 */
export function setAllExistingModes(
  blob: Record<string, unknown>,
  modelId: string
): Record<string, unknown> {
  let next = blob;
  for (const mode of existingModes(blob)) {
    next = setModeModel(next, mode, modelId);
  }
  return next;
}

/** @param {unknown[]} arr @returns {string[]} */
function dedupe(arr: unknown[]): string[] {
  return [...new Set(arr.filter((x) => x != null && x !== "").map(String))];
}

/* -------------------------------------------------------------------------- */
/* Adapter wiring                                                              */
/* -------------------------------------------------------------------------- */

function managedFiles(): string[] {
  return [cursorStateDbPath()];
}

/**
 * Build the atomic write set for the applicationUser blob + the OpenAI key.
 * The key goes to the encrypted `secret://` cell modern Cursor reads; we also
 * write the legacy plaintext cell as a fallback for older Cursor builds. When
 * the encrypted cell can't be produced (Cursor's Safe Storage key isn't in the
 * keychain yet — e.g. Cursor never launched), only the legacy cell is written
 * so `on` still works for older Cursor builds and the test seam.
 * @param {string} dbPath @param {string} blobRaw @param {string} apiKey
 * @returns {ItemTableMutation[]}
 */
async function cursorKeyWrites(
  dbPath: string,
  blobRaw: string,
  apiKey: string
): Promise<ItemTableMutation[]> {
  const writes: ItemTableMutation[] = [
    { op: "set", key: APPLICATION_USER_KEY, value: blobRaw },
    { op: "set", key: CURSOR_AUTH_OPENAI_KEY, value: apiKey },
  ];
  const localStatePath = cursorLocalStatePath(dbPath);
  if (isSecretEncryptionAvailable({ variant: "cursor", localStatePath })) {
    const encrypted = encryptSecret(apiKey, { variant: "cursor", localStatePath });
    writes.push({
      op: "set",
      key: CURSOR_AUTH_OPENAI_KEY_SECRET,
      value: encrypted,
    });
  }
  return writes;
}

/**
 * Enable routing for Cursor: set the base URL + OpenAI-key flag, register the
 * resolved model, and point every existing mode at it. Re-`on` is idempotent —
 * addUserModel/setModeModel dedupe against what's already there, and empty
 * aiandAddedModels markers are never duplicated.
 *
 * @param {EnableInput} input
 * @returns {Promise<{ model: string, filesWritten: string[] }>}
 */
async function enable(
  input: EnableInput
): Promise<{ model: string; filesWritten: string[] }> {
  if (!input.model || input.model.trim() === "") {
    throw new CliError("No Cursor model was resolved.", {
      hint: "Pass --model with a catalog model id.",
    });
  }
  const dbPath = cursorStateDbPath({ home: input.home });
  // Fresh installs (never launched) have no ItemTable yet — create it so the
  // atomic write below has somewhere to go.
  await ensureItemTable(dbPath);

  const { blob } = await readCursorState(dbPath);
  let next = setOpenAiBaseUrl(blob, CURSOR_BASE_URL);
  next = setUseOpenAiKey(next, true);
  next = addUserModel(next, input.model);
  // Select the model on every mode the user already has. When no mode exists
  // yet (fresh install), Cursor defaults to the "composer" mode, so set that
  // one explicitly — otherwise the model is registered but never selected.
  next = setAllExistingModes(next, input.model);
  if (existingModes(next).length === 0) {
    next = setModeModel(next, CURSOR_DEFAULT_MODE, input.model);
  }

  const blobRaw = JSON.stringify(next);
  const writes = await cursorKeyWrites(dbPath, blobRaw, input.apiKey);
  await applyItemTableWrites(dbPath, writes);

  return { model: input.model, filesWritten: [dbPath] };
}

/**
 * Strip-only path for the forced-off/no-manifest case (the engine already
 * restored bytes when a manifest exists, and then this runs against the
 * ORIGINAL bytes and must detect no markers and no-op cleanly).
 *
 * @param {object} opts
 * @param {string} opts.dbPath
 * @returns {Promise<"stripped" | "none">}
 */
async function disableDb(dbPath: string): Promise<"stripped" | "none"> {
  const { blob } = await readCursorState(dbPath);
  if (!cursorHasAiandMarkers(blob)) {
    return "none";
  }
  let next = removeAiandModels(blob);
  next = resetTouchedModes(next);
  next = setUseOpenAiKey(next, false);
  next = setOpenAiBaseUrl(next, null);
  const blobRaw = JSON.stringify(next);
  const writes: ItemTableMutation[] = [
    { op: "set", key: APPLICATION_USER_KEY, value: blobRaw },
    // Match Cursor's own "no key" shape: empty ciphertext in the secret cell,
    // legacy plaintext row removed.
    { op: "set", key: CURSOR_AUTH_OPENAI_KEY_SECRET, value: EMPTY_SAFE_STORAGE_CIPHERTEXT },
    { op: "del", key: CURSOR_AUTH_OPENAI_KEY },
  ];
  await applyItemTableWrites(dbPath, writes);
  return "stripped";
}

async function probe(): Promise<ProbeResult> {
  const dbPath = cursorStateDbPath();
  let blob: Record<string, unknown> = {};
  try {
    const { blob: readBlob } = await readCursorState(dbPath);
    blob = readBlob;
  } catch {
    // Missing/corrupt DB → inactive, never a crash (a file mid-edit shouldn't
    // wedge `cursor status`).
    blob = {};
  }
  const active = blob.openAIBaseUrl === CURSOR_BASE_URL;
  const modelId = active ? cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE) : null;
  // A `"default"`/empty selection means Cursor falls back to its own model —
  // report no model rather than the sentinel.
  const model = modelId && modelId !== "default" ? modelId : null;
  // Foreign scan: pass the db path with the default reader; it reads the
  // binary file as text and matches fragment probes — sufficient for a
  // foreign config writer whose markers are plaintext bytes in the DB.
  const foreignTool = await detectForeign([dbPath]);
  return { active, foreignTool, model };
}

const CURSOR_INSTALL = INSTALL_HINTS.cursor!;

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  label: "Cursor IDE",
  bin: "cursor",
  install: CURSOR_INSTALL,
  detect(): DetectResult {
    return detectBinary("cursor");
  },
  managedFiles,
  probe,
  enable,
  async enableGuard(opts: { force: boolean }): Promise<void> {
    // Cursor holds state.vscdb in memory while running and rewrites it on
    // exit, clobbering anything written underneath it. Guard on every platform
    // — Cursor runs on linux too.
    await assertIdeStopped(CURSOR_SPEC, "Cursor IDE", { force: opts.force });
  },
  async offGuard(opts: { force: boolean }): Promise<void> {
    // The byte-for-byte restore lands on disk; a running Cursor rewrites the
    // DB from memory on exit and would undo it.
    await assertIdeStopped(CURSOR_SPEC, "Cursor IDE", { force: opts.force });
  },
  async disable(): Promise<void> {
    // The engine restores the snapshotted DB byte-for-byte when a manifest
    // exists; this strip only fires for the forced-off/no-manifest case and
    // no-ops cleanly against already-restored (marker-free) bytes.
    await disableDb(cursorStateDbPath());
  },
};