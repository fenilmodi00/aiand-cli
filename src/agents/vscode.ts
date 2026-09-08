import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliError } from "../cli/errors.js";
import { detectBinary } from "./detect.js";
import { detectForeign } from "./foreign.js";
import { assertIdeStopped, type QuitGuardSpec } from "./quit-guard.js";
import { agentHome, configDir, writeFileAtomic } from "../config.js";
import { notValidJsonError } from "./managed-file.js";
import {
  encryptSecret,
  isSecretEncryptionAvailable,
} from "./cursor-secret.js";
import { applyItemTableWrites, ensureItemTable, readItemTableValue } from "./vscdb.js";
import type { AgentAdapter, DetectResult, EnableInput, GuardOptions, ProbeResult } from "./types.js";
import type { Model } from "../api/models.js";

/**
 * VS Code Chat's custom language models live in `chatLanguageModels.json` (a
 * JSON array of providers). aiand adds a "ai&" customendpoint provider whose
 * `apiKey` is a `${input:chat.lm.secret.<id>}` reference.
 *
 * The real key is NOT a per-secret OS keychain entry: VS Code's
 * `LanguageModelsService` resolves the reference via
 * `ISecretStorageService.get(<id>)`, which reads an Electron `safeStorage`-
 * encrypted blob from the application-scoped `state.vscdb` (`ItemTable`, key
 * `secret://<id>`). The adapter therefore writes the key there — encrypted via
 * the shared cursor-secret OSCrypt ciphertext codec — so VS Code can actually
 * decrypt and use it.
 *
 * - Provider -> array element `{ name, vendor:"customendpoint",
 *   apiType:"chat-completions", apiKey:"${input:<secretId>}", models[] }`.
 * - Model    -> `{ id, name, url, toolCalling, vision, maxInputTokens,
 *   maxOutputTokens }`. VS Code resolves the endpoint path from the model
 *   `url`, so the OpenAI-compatible gateway base `https://api.aiand.com/v1`
 *   resolves correctly.
 * - Secret   -> `state.vscdb` `ItemTable` row, key `secret://<secretId>`,
 *   value = `JSON.stringify(safeStorage.encryptString(key))`.
 *
 * Ownership: aiand-generated secret ids use the prefix
 * `chat.lm.secret.aiand-`. A provider is aiand-owned iff its `apiKey`
 * references such a secret. This keeps `off` from touching a user's manually-
 * configured entry (which uses a VS Code-generated id).
 */

/** Storage-key prefix VS Code's secret storage uses inside `state.vscdb`. */
const SECRET_STORAGE_PREFIX = "secret://";

/** The VS Code (Stable) config folder under the platform user-data root. */
const VSCODE_FOLDER = "Code";

/** The gateway base VS Code appends endpoint paths to. */
export const VSCODE_MODEL_URL = "https://api.aiand.com/v1";

/** Provider display name aiand writes. */
const VSCODE_PROVIDER_NAME = "ai&";

/** Secret id prefix that marks a provider as aiand-owned. */
export const VSCODE_SECRET_PREFIX = "chat.lm.secret.aiand-";

/** The output-token cap VS Code uses for a model (the catalog has no field). */
const VSCODE_MAX_OUTPUT_TOKENS = 16384;

/* -------------------------------------------------------------------------- */
/* Path resolution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the path to VS Code's chatLanguageModels.json. Resolves from the
 * harness home (agentHome, which tests point at a temp dir) so tests/isolated
 * runs never touch the real user profile; XDG_CONFIG_HOME is likewise resolved
 * relative to that home via the standard platform layout.
 * @param {{ home?: string, vscodePath?: string }} opts
 * @returns {string}
 */
export function chatLanguageModelsPath(opts: { home?: string; vscodePath?: string } = {}): string {
  if (opts.vscodePath) {
    return path.resolve(opts.vscodePath);
  }
  const baseHome = opts.home || agentHome();
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(
      baseHome,
      "Library",
      "Application Support",
      VSCODE_FOLDER,
      "User",
      "chatLanguageModels.json"
    );
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(baseHome, "AppData", "Roaming");
    return path.join(appData, VSCODE_FOLDER, "User", "chatLanguageModels.json");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(baseHome, ".config");
  return path.join(configHome, VSCODE_FOLDER, "User", "chatLanguageModels.json");
}

/**
 * Resolve the User-dir-relative paths (state.vscdb + Local State) from the
 * chatLanguageModels.json path.
 */
function userDirPaths(jsonPath: string): { dbPath: string; localStatePath: string } {
  const userDir = path.dirname(jsonPath); // …/User
  const userData = path.dirname(userDir); // parent of User
  return {
    dbPath: path.join(userDir, "globalStorage", "state.vscdb"),
    localStatePath: path.join(userData, "Local State"),
  };
}

/** @param {string} jsonPath @returns {string} the state.vscdb path */
export function vscodeStateDbPath(opts: { home?: string; vscodePath?: string } = {}): string {
  return userDirPaths(chatLanguageModelsPath(opts)).dbPath;
}

/** @param {string} secretId @returns {string} the `secret://<id>` ItemTable key */
function secretStorageKey(secretId: string): string {
  return `${SECRET_STORAGE_PREFIX}${secretId}`;
}

/* -------------------------------------------------------------------------- */
/* Sidecar (secret-id bookkeeping)                                             */
/* -------------------------------------------------------------------------- */

/**
 * VS Code's state.vscdb is a foreign binary store the engine must never
 * byte-snapshot (a restore could nuke user rows). To clean up our secret rows
 * on `off` without a full backup, `enable` records the secret id it created in
 * a small 0600 sidecar at <configDir>/agents/vscode/secrets.json, which
 * `disable` reads and removes.
 */
function sidecarPath(): string {
  return path.join(configDir(), "agents", "vscode", "secrets.json");
}

async function writeSidecar(secretId: string): Promise<void> {
  const p = sidecarPath();
  await mkdir(path.dirname(p), { recursive: true });
  await writeFileAtomic(p, `${JSON.stringify({ secretIds: [secretId] }, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function readSidecar(): Promise<string[]> {
  try {
    const raw = await readFile(sidecarPath(), "utf8");
    const parsed = JSON.parse(raw) as { secretIds?: unknown };
    return Array.isArray(parsed?.secretIds) ? parsed.secretIds.map(String) : [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* JSON I/O                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parse raw chatLanguageModels.json text into the array shape callers expect:
 * non-arrays coerce to `[]`; a `SyntaxError` becomes a clear "not valid JSON"
 * message naming the file.
 * @param {string} raw @param {string} filePath
 * @returns {object[]}
 */
function parseChatLanguageModelsRaw(raw: string, filePath: string): object[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw notValidJsonError(filePath);
    }
    throw error;
  }
}

async function readChatLanguageModels(filePath: string): Promise<object[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return parseChatLanguageModelsRaw(raw, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Write the array with VS Code's tab indentation (minimal diff). */
async function writeChatLanguageModels(filePath: string, arr: object[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(arr, null, "\t")}\n`);
}

/* -------------------------------------------------------------------------- */
/* Ownership + secret id                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} apiKeyField the provider's `apiKey` value
 * @returns {string | null} the secret id if aiand-owned, else null
 */
export function aiandSecretId(apiKeyField: unknown): string | null {
  if (typeof apiKeyField !== "string") return null;
  const match = apiKeyField.match(/^\$\{input:(.+)\}$/);
  if (!match) return null;
  const secretId = match[1] as string;
  return secretId.startsWith(VSCODE_SECRET_PREFIX) ? secretId : null;
}

/** @returns {string} a fresh aiand-owned secret id */
export function makeAiandSecretId(): string {
  return `${VSCODE_SECRET_PREFIX}${randomBytes(8).toString("hex")}`;
}

/** @param {object} provider @returns {boolean} whether the entry is aiand-owned */
export function isAiandProvider(provider: object | undefined): boolean {
  return aiandSecretId((provider as { apiKey?: unknown } | undefined)?.apiKey) !== null;
}

/** Find the aiand-owned provider entry, if any. */
export function findAiandProvider(arr: object[] | undefined): object | undefined {
  return (arr ?? []).find(isAiandProvider);
}

/** All aiand-owned secret ids referenced in the array. */
export function aiandSecretIds(arr: object[] | undefined): string[] {
  return (arr ?? [])
    .map((p) => aiandSecretId((p as { apiKey?: unknown }).apiKey))
    .filter((id): id is string => id !== null);
}

/* -------------------------------------------------------------------------- */
/* Pure transforms (no I/O — unit-testable)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a VS Code model entry from a live catalog Model.
 * @param {Model} model
 * @returns {object}
 */
export function buildModelEntry(model: Model): object {
  return {
    id: model.id,
    name: model.name,
    url: VSCODE_MODEL_URL,
    toolCalling: true,
    vision: Array.isArray(model.capabilities) && model.capabilities.includes("vision"),
    maxInputTokens: model.context_window,
    maxOutputTokens: VSCODE_MAX_OUTPUT_TOKENS,
  };
}

/**
 * Add (or update) the aiand-owned provider with the given models. Replaces an
 * existing aiand provider's models in place; leaves other providers alone.
 * @param {object[]} arr @param {{ secretId: string, models: object[] }} opts
 * @returns {object[]} new array
 */
export function addAiandProvider(
  arr: object[] | undefined,
  { secretId, models }: { secretId: string; models: object[] }
): object[] {
  const next = [...(arr ?? [])];
  const provider = {
    name: VSCODE_PROVIDER_NAME,
    vendor: "customendpoint",
    apiType: "chat-completions",
    apiKey: `\${input:${secretId}}`,
    models,
  };
  const idx = next.findIndex(isAiandProvider);
  if (idx >= 0) {
    next[idx] = provider;
  } else {
    next.push(provider);
  }
  return next;
}

/** Remove aiand-owned provider entries. Other providers are untouched. */
export function removeAiandProvider(arr: object[] | undefined): object[] {
  return (arr ?? []).filter((provider) => !isAiandProvider(provider));
}

/**
 * Compute the provider's model list on `on`: the live catalog, or (when the
 * catalog is empty, e.g. a direct unit test) the previously registered models.
 * @param {object | undefined} existing the current aiand provider, if any
 * @param {Model[]} catalog the live catalog
 * @returns {object[]}
 */
function computeModels(existing: object | undefined, catalog: Model[]): object[] {
  if (Array.isArray(catalog) && catalog.length > 0) {
    return catalog.map(buildModelEntry);
  }
  return (existing as { models?: object[] } | undefined)?.models ?? [];
}

/* -------------------------------------------------------------------------- */
/* Running-VS-Code guard                                                       */
/*                                                                            */
/* `on` writes the API key into `state.vscdb`, which a running VS Code owns:   */
/* it loads the DB into memory at startup and rewrites it on exit, so a write  */
/* made while it's open is silently lost. The guard refuses the write in       */
/* non-interactive contexts and lets --force escape.                           */
/* -------------------------------------------------------------------------- */

/**
 * The VS Code main-process process spec (Stable + Insiders). Only the main
 * process (no `--type=`) owns state.vscdb and must block writes.
 */
export const VSCODE_SPEC: QuitGuardSpec = {
  darwinPattern: "Visual Studio Code( - Insiders)?.app/Contents/MacOS/Electron",
  linuxPattern: "[/]code(-insiders)?([[:space:]]|$)",
  linuxCmdlineMatches: (cmdline) => !/\s--type=/.test(cmdline),
  windowsImage: "Code( - Insiders)?\\.exe",
};

/**
 * The "open the app once" refusal text for when the safeStorage master key
 * can't be read (macOS keychain item absent).
 */
function secretUnavailableMessage(): string {
  return "Could not read VS Code's \"Code Safe Storage\" key from the login Keychain, so the API key can't be stored where VS Code reads it. Open VS Code once (it creates this key on first launch) and retry.";
}

/* -------------------------------------------------------------------------- */
/* Adapter wiring                                                              */
/* -------------------------------------------------------------------------- */

function managedFiles(): string[] {
  return [chatLanguageModelsPath()];
}

/**
 * Enable aiand routing for VS Code Chat: read the current array, reuse (or
 * generate) the aiand secret id, store the key encrypted in state.vscdb, and
 * add/update the "ai&" provider with catalog-derived model entries.
 * @param {EnableInput} input
 * @returns {Promise<{ model: string, filesWritten: string[] }>}
 */
async function enable(
  input: EnableInput
): Promise<{ model: string; filesWritten: string[] }> {
  if (!input.apiKey) {
    throw new CliError("No API key was resolved for VS Code.");
  }
  const jsonPath = chatLanguageModelsPath({ home: input.home });
  const { dbPath, localStatePath } = userDirPaths(jsonPath);
  // On macOS the safeStorage master key may be absent until VS Code launches
  // once; refuse with an actionable message rather than writing a key VS Code
  // can't decrypt. Linux always works; plaintext-mode tests short-circuit here.
  if (!isSecretEncryptionAvailable({ localStatePath })) {
    throw new CliError(secretUnavailableMessage());
  }

  const arr = await readChatLanguageModels(jsonPath);
  const existing = findAiandProvider(arr);
  // Reuse the existing secret id on re-`on` so the provider's apiKey reference
  // stays stable and no duplicate secret row accumulates.
  const secretId = existing ? aiandSecretId((existing as { apiKey?: unknown }).apiKey) : makeAiandSecretId();
  if (!secretId) {
    throw new CliError("VS Code provider has an invalid aiand secret id.");
  }

  await ensureItemTable(dbPath);
  const encrypted = encryptSecret(input.apiKey, { localStatePath });
  await applyItemTableWrites(dbPath, [
    { op: "set", key: secretStorageKey(secretId), value: encrypted },
  ]);

  const models = computeModels(existing, input.catalog);
  const next = addAiandProvider(arr, { secretId, models });
  await writeChatLanguageModels(jsonPath, next);
  await writeSidecar(secretId);

  return {
    model: input.model,
    filesWritten: [jsonPath, dbPath, sidecarPath()],
  };
}

/**
 * Clear aiand-owned secrets from state.vscdb and strip our provider from
 * chatLanguageModels.json when the engine had no manifest to restore (forced
 * off / deleted backup). With a manifest, the engine already restored the JSON
 * byte-for-byte before this runs; removeAiandProvider is then a no-op.
 */
async function disable(): Promise<void> {
  const jsonPath = chatLanguageModelsPath();
  const arr = await readChatLanguageModels(jsonPath);
  // Every id we recorded in the sidecar, plus any aiand-owned secret id still
  // referenced by the current array (belt-and-suspenders in case the sidecar
  // was lost between `on` and `off`).
  const ids = new Set<string>([
    ...(await readSidecar()),
    ...aiandSecretIds(arr),
  ]);
  const { dbPath } = userDirPaths(jsonPath);
  if (ids.size > 0) {
    const mutations = [...ids]
      .filter(Boolean)
      .map((id) => ({ op: "del" as const, key: secretStorageKey(id) }));
    await applyItemTableWrites(dbPath, mutations);
  }
  const next = removeAiandProvider(arr);
  if (next.length === 0) {
    try {
      await unlink(jsonPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } else if (next.length !== arr.length) {
    await writeChatLanguageModels(jsonPath, next);
  }
  await rm(sidecarPath(), { force: true }).catch(() => {});
}

/**
 * Read-only status: active iff an aiand provider exists with a model pointed
 * at the aiand gateway.
 * @returns {Promise<ProbeResult>}
 */
async function probe(): Promise<ProbeResult> {
  const jsonPath = chatLanguageModelsPath();
  let active = false;
  let model: string | null = null;
  try {
    const arr = await readChatLanguageModels(jsonPath);
    const provider = findAiandProvider(arr);
    if (provider) {
      const first = (provider as { models?: Array<{ id?: unknown; url?: unknown }> }).models?.[0];
      active = typeof first?.url === "string" && first.url.startsWith("https://api.aiand.com");
      model = typeof first?.id === "string" ? first.id : null;
    }
  } catch {
    // Unreadable JSON → inactive, never a crash (a file mid-edit shouldn't
    // wedge `vscode status`).
  }
  // Foreign scan: a foreign config writer may have touched the managed file.
  const foreignTool = await detectForeign(managedFiles());
  return { active, foreignTool, model };
}

export const vscodeAdapter: AgentAdapter = {
  id: "vscode",
  label: "VS Code",
  bin: "code",
  install: {
    command: "Download VS Code from code.visualstudio.com",
    url: "https://code.visualstudio.com",
  },
  detect(): DetectResult {
    return detectBinary("code");
  },
  managedFiles,
  probe,
  enable,
  // No refreshKey: VS Code's API key is a safeStorage-encrypted secret that
  // cannot be swapped surgically — re-running `aiand vscode on` is the
  // refresh path.
  async enableGuard(opts: GuardOptions): Promise<void> {
    // VS Code holds state.vscdb in memory while running and rewrites it on
    // exit, clobbering anything written underneath it. Guard only `on`;
    // `disable` must always work so our secrets never linger.
    await assertIdeStopped(VSCODE_SPEC, "VS Code", { force: opts.force });
  },
  disable,
};