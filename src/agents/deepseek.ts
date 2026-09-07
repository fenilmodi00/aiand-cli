import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import type { Model } from "../api/models.js";
import { writeFileAtomic } from "../io/atomic.js";
import { CliError } from "../cli/errors.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { detectForeign } from "./foreign.js";
import { agentHome } from "./paths.js";
import type { AgentAdapter, DetectResult, EnableInput, ProbeResult, SessionLaunch, SessionLaunchInput } from "./types.js";

/**
 * DeepSeek Harness (`dsh`) routing lives in a flat YAML home:
 *
 * - `settings.yaml`  — the provider block (under `llm-pi-ai.providers.aiand`)
 *   plus a top-level `agent-default-model`. Only metadata; no credentials.
 * - `.credentials.yaml` — flat `KEY: value` map carrying the literal API key.
 *
 * Both files are first-class config the engine snapshots (`managedFiles`), so
 * `on`/`off` merge-preserve unrelated keys and the byte-for-byte restore is the
 * engine's job. `sessionLaunch` reuses a throwaway `DSH_HOME` overlay so a
 * model remembered in the UI can never outrank the launched session — the
 * overlay copies `settings.yaml` with `agent-default-model` stripped and
 * writes a fresh `.credentials.yaml` carrying the session key.
 */

const LLM_PI_AI_NS = "llm-pi-ai";
const DEFAULT_MODEL_NS = "agent-default-model";
const PROVIDER_ID = "aiand";
const API_KEY_ENV = "AIAND_API_KEY";
const BASE_URL = "https://api.aiand.com/v1";
const DISPLAY_NAME = "ai&";

const SETTINGS_FILE = "settings.yaml";
const CREDENTIALS_FILE = ".credentials.yaml";

/** `$DSH_HOME`, else `<home>/.dsh`. */
export function dshHome(home?: string): string {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv || join(home || agentHome(), ".dsh");
}

export function settingsPath(home?: string): string {
  return join(dshHome(home), SETTINGS_FILE);
}

export function credentialsPath(home?: string): string {
  return join(dshHome(home), CREDENTIALS_FILE);
}

/* -------------------------------------------------------------------------- */
/* Hand-rolled flat YAML (zero deps)                                          */
/* -------------------------------------------------------------------------- */

interface Tok {
  indent: number;
  text: string;
}

function leadingIndent(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) n += 1;
  return n;
}

function tokenize(raw: string): Tok[] {
  const out: Tok[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    out.push({ indent: leadingIndent(line), text: t });
  }
  return out;
}

export function scalarValue(raw: string): unknown {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

function isMapEntry(tok: Tok): boolean {
  return !tok.text.startsWith("-") && tok.text.indexOf(":") !== -1;
}

function yamlErr(label: string, detail: string): CliError {
  const name = label.split(/[\\/]/).pop() || label;
  return new CliError(`Invalid DeepSeek Harness ${name}: ${detail}`);
}

interface Parsed {
  map: Record<string, unknown>;
  next: number;
}

/** Parse `key: value` entries (and `key:` containers) at a fixed indent. */
function parseMapAt(toks: Tok[], i: number, indent: number, label: string, seed?: Record<string, unknown>): Parsed {
  const map = seed ?? {};
  let j = i;
  while (j < toks.length) {
    const tok = toks[j]!;
    if (tok.indent < indent) break;
    if (tok.indent > indent) throw yamlErr(label, "unexpected indentation");
    if (!isMapEntry(tok)) break;
    const colon = tok.text.indexOf(":");
    const key = tok.text.slice(0, colon).trim();
    const rest = tok.text.slice(colon + 1).trim();
    const nextTok = toks[j + 1];
    if (rest === "" && nextTok && nextTok.indent > indent && nextTok.text.startsWith("-")) {
      const { list, next } = parseListAt(toks, j + 1, nextTok.indent, label);
      map[key] = list;
      j = next;
      continue;
    }
    if (rest === "" && nextTok && nextTok.indent > indent) {
      const { map: sub, next } = parseMapAt(toks, j + 1, nextTok.indent, label);
      map[key] = sub;
      j = next;
      continue;
    }
    map[key] = rest === "" ? null : scalarValue(rest);
    j += 1;
  }
  return { map, next: j };
}

/** Parse a block of `- item` lines at a fixed indent. */
function parseListAt(toks: Tok[], i: number, indent: number, label: string): { list: unknown[]; next: number } {
  const list: unknown[] = [];
  let j = i;
  while (j < toks.length) {
    const tok = toks[j]!;
    if (tok.indent < indent) break;
    if (tok.indent > indent) throw yamlErr(label, "unexpected indentation in list");
    if (!tok.text.startsWith("-")) break;
    const rest = tok.text.slice(1).trim();
    if (rest === "") {
      const nextTok = toks[j + 1];
      if (nextTok && nextTok.indent > indent) {
        if (nextTok.text.startsWith("-")) {
          const { list: sub, next } = parseListAt(toks, j + 1, nextTok.indent, label);
          list.push(sub);
          j = next;
          continue;
        }
        const { map: sub, next } = parseMapAt(toks, j + 1, nextTok.indent, label);
        list.push(sub);
        j = next;
        continue;
      }
      list.push(null);
      j += 1;
      continue;
    }
    const colon = rest.indexOf(":");
    if (colon === -1) {
      list.push(scalarValue(rest));
      j += 1;
      continue;
    }
    // Inline `- key: value` (or `- key:` container): map item whose keys live
    // two columns past the list indent.
    const key = rest.slice(0, colon).trim();
    const valuePart = rest.slice(colon + 1).trim();
    const contentIndent = indent + 2;
    const item: Record<string, unknown> = {};
    const nextTok = toks[j + 1];
    if (valuePart === "" && nextTok && nextTok.indent > contentIndent && nextTok.text.startsWith("-")) {
      const { list: sub, next } = parseListAt(toks, j + 1, nextTok.indent, label);
      item[key] = sub;
      const { map: more, next: n2 } = parseMapAt(toks, next, contentIndent, label, item);
      list.push(more);
      j = n2;
      continue;
    }
    if (valuePart === "" && nextTok && nextTok.indent > contentIndent) {
      const { map: sub, next } = parseMapAt(toks, j + 1, nextTok.indent, label);
      item[key] = sub;
      const { map: more, next: n2 } = parseMapAt(toks, next, contentIndent, label, item);
      list.push(more);
      j = n2;
      continue;
    }
    item[key] = valuePart === "" ? null : scalarValue(valuePart);
    const { map: more, next: n2 } = parseMapAt(toks, j + 1, contentIndent, label, item);
    list.push(more);
    j = n2;
  }
  return { list, next: j };
}

/**
 * Parse a flat YAML document into nested maps/lists. `raw` must be a mapping
 * at the top level; invalid input surfaces as a `CliError` naming the file.
 */
export function parseYamlDeepseek(raw: string, label: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  if (raw.trim().startsWith("-")) throw yamlErr(label, "expected a mapping, got a list");
  return parseMapAt(tokenize(raw), 0, 0, label).map;
}

function formatScalar(value: unknown): string {
  if (typeof value === "string" && needsQuoting(value)) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  return String(value);
}

function needsQuoting(s: string): boolean {
  if (s === "") return true;
  if (/^( |#)/.test(s) || /\s$/.test(s)) return true;
  if (/[:#][ ]|^[\-?:\.,\[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(s)) return true;
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return true;
  return false;
}

function writePairAt(prefix: string, key: string, value: unknown, keyColumn: number, lines: string[]): void {
  if (Array.isArray(value)) {
    lines.push(prefix + key + ":");
    writeListAt(value, keyColumn + 2, lines);
    return;
  }
  if (value !== null && typeof value === "object") {
    lines.push(prefix + key + ":");
    writeMapAt(value as Record<string, unknown>, keyColumn + 2, lines);
    return;
  }
  lines.push(prefix + key + ": " + formatScalar(value));
}

function writeMapAt(obj: Record<string, unknown>, indent: number, lines: string[]): void {
  for (const [k, v] of Object.entries(obj)) {
    writePairAt(" ".repeat(indent), k, v, indent, lines);
  }
}

function writeListAt(list: unknown[], indent: number, lines: string[]): void {
  for (const item of list) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const entries = Object.entries(item as Record<string, unknown>);
      const contentColumn = indent + 2;
      if (entries.length === 0) {
        lines.push(" ".repeat(indent) + "- {}");
        continue;
      }
      entries.forEach(([k, v], idx) => {
        const prefix = idx === 0 ? " ".repeat(indent) + "- " : " ".repeat(contentColumn);
        writePairAt(prefix, k, v, contentColumn, lines);
      });
    } else {
      lines.push(" ".repeat(indent) + "- " + formatScalar(item));
    }
  }
}

/** Serialize a parsed doc back to flat YAML. Empty map → empty string. */
export function serializeYamlDeepseek(doc: Record<string, unknown>): string {
  if (Object.keys(doc).length === 0) return "";
  const lines: string[] = [];
  writeMapAt(doc, 0, lines);
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Strip the `agent-default-model:` block from a dsh settings file.
 *
 * Hand-rolled rather than a YAML dependency: the file is a flat top-level
 * map, so the block runs from its key to the next line that starts in column
 * zero.
 */
export function withoutPersistedModel(settings: string): string {
  const lines = settings.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith("agent-default-model:")) {
      skipping = true;
      continue;
    }
    if (skipping && (line.startsWith(" ") || line.startsWith("\t") || line.trim() === "")) {
      continue;
    }
    skipping = false;
    out.push(line);
  }
  return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Provider transforms                                                        */
/* -------------------------------------------------------------------------- */

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The aiand provider block under `llm-pi-ai.providers.aiand`, or null. */
export function aiandProvider(settings: Record<string, unknown>): Record<string, unknown> | null {
  const llm = asPlainObject(settings[LLM_PI_AI_NS]);
  const providers = asPlainObject(llm?.providers);
  return asPlainObject(providers?.[PROVIDER_ID]);
}

export function isManaged(settings: Record<string, unknown>): boolean {
  const provider = aiandProvider(settings);
  const defaults = asPlainObject(settings[DEFAULT_MODEL_NS]);
  return Boolean(
    provider &&
      provider.apiKeyEnv === API_KEY_ENV &&
      provider.api === "openai-completions" &&
      typeof provider.baseURL === "string" &&
      provider.baseURL.startsWith("https://api.aiand.com") &&
      defaults?.provider === PROVIDER_ID,
  );
}

/**
 * A model entry as `dsh` expects it: catalog-derived ids/limits, cost in USD
 * per 1M tokens (the gateway's cached price, `Number(...)` on the string).
 */
export function buildDeepseekModelEntry(model: Model): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    reasoning: (model.reasoning_efforts?.length ?? 0) > 0,
    input: model.capabilities.includes("vision") ? ["text", "image"] : ["text"],
    contextWindow: model.context_window,
    maxTokens: 16384,
    cost: {
      input: Number(model.input_per_1m),
      output: Number(model.output_per_1m),
      cacheRead: Number(model.cached_input_per_1m ?? model.input_per_1m),
      cacheWrite: 0,
    },
  };
}

/**
 * Add (or replace) the aiand provider block + `agent-default-model`, preserving
 * every unrelated key and any non-aiand provider entry that already exists.
 */
export function patchDeepseekSettings(
  settings: Record<string, unknown>,
  opts: { modelId: string; models: Model[] },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...settings };
  const llm = asPlainObject(next[LLM_PI_AI_NS]) ?? {};
  const providers = asPlainObject(llm.providers) ?? {};
  providers[PROVIDER_ID] = {
    displayName: DISPLAY_NAME,
    apiKeyEnv: API_KEY_ENV,
    api: "openai-completions",
    baseURL: BASE_URL,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
    models: opts.models.map(buildDeepseekModelEntry),
  };
  const nextLlm = { ...llm, providers };
  next[LLM_PI_AI_NS] = nextLlm;
  next[DEFAULT_MODEL_NS] = { provider: PROVIDER_ID, model: opts.modelId };
  return next;
}

/** Remove the aiand provider + `agent-default-model`; reports whether it changed. */
export function stripDeepseekSettings(settings: Record<string, unknown>): {
  next: Record<string, unknown>;
  changed: boolean;
} {
  const next: Record<string, unknown> = { ...settings };
  let changed = false;
  const llm = asPlainObject(next[LLM_PI_AI_NS]);
  if (llm) {
    const providers = asPlainObject(llm.providers);
    if (providers && providers[PROVIDER_ID] !== undefined) {
      delete providers[PROVIDER_ID];
      changed = true;
      if (Object.keys(providers).length === 0) delete llm.providers;
    }
    if (Object.keys(llm).length === 0) delete next[LLM_PI_AI_NS];
  }
  const defaults = asPlainObject(next[DEFAULT_MODEL_NS]);
  if (defaults?.provider === PROVIDER_ID) {
    delete next[DEFAULT_MODEL_NS];
    changed = true;
  }
  return { next, changed };
}

/* -------------------------------------------------------------------------- */
/* File I/O                                                                   */
/* -------------------------------------------------------------------------- */

async function readTextIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function writeSettingsHome(overlay: string, apiKey: string, nativeCredentials?: string): void {
  let creds: Record<string, unknown> = {};
  if (nativeCredentials && existsSync(nativeCredentials)) {
    creds = parseYamlDeepseek(readFileSync(nativeCredentials, "utf8"), nativeCredentials);
  }
  writeFileSync(join(overlay, CREDENTIALS_FILE), serializeYamlDeepseek({ ...creds, [API_KEY_ENV]: apiKey }), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * A `DSH_HOME` overlay that lets the launched session own its config without
 * rewriting the real home: everything is symlinked (sessions and profiles stay
 * shared), while `settings.yaml` is copied with `agent-default-model` stripped
 * so a UI-remembered model can't outrank the session, and `.credentials.yaml`
 * is copied with the session's literal key merged in.
 */
export function createDeepseekHomeOverlay(nativeHome: string, apiKey: string): string {
  const overlay = mkdtempSync(join(tmpdir(), "aiand-dsh-"));
  if (!existsSync(nativeHome)) {
    writeSettingsHome(overlay, apiKey);
    return overlay;
  }
  for (const entry of readdirSync(nativeHome, { withFileTypes: true })) {
    const from = join(nativeHome, entry.name);
    const to = join(overlay, entry.name);
    if (entry.isFile() && entry.name === SETTINGS_FILE) {
      writeFileSync(to, withoutPersistedModel(readFileSync(from, "utf8")), {
        encoding: "utf8",
        mode: 0o600,
      });
      continue;
    }
    if (entry.isFile() && entry.name === CREDENTIALS_FILE) {
      writeSettingsHome(overlay, apiKey, from);
      continue;
    }
    symlinkSync(from, to, entry.isDirectory() ? "dir" : "file");
  }
  if (!existsSync(join(overlay, CREDENTIALS_FILE))) {
    writeSettingsHome(overlay, apiKey);
  }
  return overlay;
}

/* -------------------------------------------------------------------------- */
/* Adapter wiring                                                             */
/* -------------------------------------------------------------------------- */

async function probe(): Promise<ProbeResult> {
  const setPath = settingsPath();
  const raw = await readTextIfExists(setPath);
  if (!raw.trim()) {
    return { active: false, foreignTool: null, model: null };
  }
  let settings: Record<string, unknown>;
  try {
    settings = parseYamlDeepseek(raw, setPath);
  } catch {
    // Corrupt/mid-edit file → inactive, never a crash (`status` stays usable).
    return { active: false, foreignTool: null, model: null };
  }
  const active = isManaged(settings);
  const defaults = asPlainObject(settings[DEFAULT_MODEL_NS]);
  const model = active && typeof defaults?.model === "string" ? defaults.model : null;
  const foreignTool = await detectForeign([setPath, credentialsPath()]);
  return { active, foreignTool, model };
}

async function enable(input: EnableInput): Promise<{ model: string; filesWritten: string[] }> {
  if (!input.model || input.model.trim() === "") {
    throw new CliError("No DeepSeek Harness model was resolved.", {
      hint: "Pass --model with a catalog model id.",
    });
  }
  const setPath = settingsPath(input.home);
  const credPath = credentialsPath(input.home);
  const [settingsRaw, credsRaw] = await Promise.all([
    readTextIfExists(setPath),
    readTextIfExists(credPath),
  ]);
  const settings = settingsRaw.trim() ? parseYamlDeepseek(settingsRaw, setPath) : {};
  const creds = credsRaw.trim() ? parseYamlDeepseek(credsRaw, credPath) : {};

  const nextSettings = patchDeepseekSettings(settings, {
    modelId: input.model,
    models: input.catalog,
  });
  const nextCreds = { ...creds, [API_KEY_ENV]: input.apiKey };

  await writeFileAtomic(setPath, serializeYamlDeepseek(nextSettings), { mode: 0o600 });
  await writeFileAtomic(credPath, serializeYamlDeepseek(nextCreds), { mode: 0o600 });

  return { model: input.model, filesWritten: [setPath, credPath] };
}

async function disable(): Promise<void> {
  // The engine restores snapshotted bytes first; this strip only fires for the
  // forced-off/no-manifest case and no-ops cleanly against restored files.
  const setPath = settingsPath();
  const setRaw = await readTextIfExists(setPath);
  if (setRaw.trim()) {
    const { next, changed } = stripDeepseekSettings(parseYamlDeepseek(setRaw, setPath));
    if (changed) {
      await writeFileAtomic(setPath, serializeYamlDeepseek(next), { mode: 0o600 });
    }
  }
  const credPath = credentialsPath();
  const credRaw = await readTextIfExists(credPath);
  if (credRaw.trim()) {
    const creds = parseYamlDeepseek(credRaw, credPath);
    if (creds[API_KEY_ENV] !== undefined) {
      delete creds[API_KEY_ENV];
      await writeFileAtomic(credPath, serializeYamlDeepseek(creds), { mode: 0o600 });
    }
  }
}

/**
 * Swap ONLY the `AIAND_API_KEY` literal in `.credentials.yaml`, preserving
 * settings.yaml (model ids, provider block) and every other credential line.
 * Goes through the same read/parse/serialize/write path enable() uses (mode
 * 0600). Idempotent: a key that already matches leaves the file untouched.
 */
async function refreshKey(input: { apiKey: string; home: string }): Promise<void> {
  const credPath = credentialsPath(input.home);
  const credRaw = await readTextIfExists(credPath);
  if (!credRaw.trim()) return;
  const creds = parseYamlDeepseek(credRaw, credPath);
  if (creds[API_KEY_ENV] === input.apiKey) return;
  await writeFileAtomic(credPath, serializeYamlDeepseek({ ...creds, [API_KEY_ENV]: input.apiKey }), {
    mode: 0o600,
  });
}

async function sessionLaunch(input: SessionLaunchInput): Promise<SessionLaunch> {
  const overlay = createDeepseekHomeOverlay(dshHome(), input.apiKey);
  return {
    env: {
      DSH_HOME: overlay,
      [API_KEY_ENV]: input.apiKey,
    },
    clear: ["DEEPSEEK_API_KEY"],
    cleanup: async () => {
      try {
        rmSync(overlay, { recursive: true, force: true });
      } catch {
        // Never surface a teardown failure after the child already exited.
      }
    },
  };
}

const DEEPSEEK_INSTALL = INSTALL_HINTS.deepseek!;

export const deepseekAdapter: AgentAdapter = {
  id: "deepseek",
  label: "DeepSeek Harness",
  bin: "dsh",
  install: DEEPSEEK_INSTALL,
  detect(): DetectResult {
    return detectBinary("dsh");
  },
  managedFiles(): string[] {
    return [settingsPath(), credentialsPath()];
  },
  probe,
  enable,
  disable,
  refreshKey,
  sessionLaunch,
};