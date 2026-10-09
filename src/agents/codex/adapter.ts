import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "../../api/models.js";
import { CliError } from "../../cli/errors.js";
import { findWindowsExecutable } from "../../cli/win-spawn.js";
import {
  agentHome,
  DEFAULT_BASE_URL,
  isRoutableBaseUrl,
  loadConfig,
  trimSlash,
  writeFileAtomic,
} from "../../config.js";
import { existingFileMode } from "../../fsutil.js";
import { inCatalog, resolveDefault } from "../catalog.js";
import { detectBinary } from "../detect.js";
import { readTextIfExists } from "../managed-file.js";
import {
  clearAddedState,
  discardSnapshot,
  fileCreatedByUs,
  getAddedState,
  hasSnapshot,
  recordAddedState,
} from "../snapshot.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableInput,
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeResult,
  SessionLaunchInput,
} from "../types.js";
import {
  logicalLines,
  readKeys,
  renderInline,
  renderTable,
  splitSections,
  type TomlSection,
  type TomlTable,
} from "./toml.js";

const CODEX_ID = "codex";
const CODEX_BIN = "codex";
const PROFILE = "aiand";
const PROVIDER_ID = "aiand";
const PROVIDER_TABLE = `model_providers.${PROVIDER_ID}`;
const AUTH_TABLE = `${PROVIDER_TABLE}.auth`;
// Also the ownership marker: --strict-config rejects unknown keys, so no marker key can be added.
const AUTH_COMMAND = "aiand";
const AUTH_ARGS = ["key", "export"];
const WIRE_API = "responses";
// ai& serves function tools only; a hosted tool fails the whole request.
const HOSTED_OFF: TomlTable = { web_search: "disabled" };
// The guide's `[tools] view_image` is not a Codex setting (0.152 ignores it,
// 0.158 warns, --strict-config rejects it); the switch lives under features.
const FEATURES: TomlTable = {
  unified_exec: false,
  apps: false,
  browser_use: false,
  browser_use_external: false,
  computer_use: false,
  image_generation: false,
  multi_agent: false,
  in_app_browser: false,
  view_image: false,
};
// Codex's /model writes these into the profile: a pick, not an edit to ai&'s settings.
const PICK_KEYS = new Set(["model", "model_reasoning_effort", "plan_mode_reasoning_effort"]);
// Preferred over the catalog default, which can be the model's most expensive level.
const PREFERRED_EFFORT = "high";
const isProjectTable = (section: TomlSection): boolean => section.name.startsWith("projects.");

type CodexRecord = {
  path?: string;
  codexOwned?: string;
  // Codex writes `[projects."…"]` trust tables into the profile; these were there before `on`.
  userProjects?: string[];
};

const HEADER =
  "# Managed by aiand: `aiand codex off` removes it. Use with `codex --profile aiand`.\n";

function currentProfilePath(): string {
  const dir = process.env.CODEX_HOME || join(agentHome(), ".codex");
  return join(dir, `${PROFILE}.config.toml`);
}

const codexBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

function resolveAuthCommand(): string | null {
  if (process.platform !== "win32") {
    return detectBinary(AUTH_COMMAND).installed ? AUTH_COMMAND : null;
  }
  // Codex spawns the auth command without a PATHEXT lookup, so bare `aiand` misses `aiand.cmd`.
  return findWindowsExecutable(AUTH_COMMAND, process.env);
}

const spawnableByCodex = (command: unknown): boolean =>
  process.platform !== "win32" || (typeof command === "string" && /[\\/]/.test(command));

const isAuthCommand = (command: unknown): boolean =>
  typeof command === "string" &&
  command
    .split(/[\\/]/)
    .at(-1)!
    .toLowerCase()
    .replace(/\.(?:cmd|exe|bat)$/, "") === AUTH_COMMAND;

// `/v1/responses` rejects a level the model does not publish, so one it does is always pinned.
function effortFor(model: Model | undefined, current?: unknown): string | undefined {
  const levels = model?.reasoning_efforts ?? [];
  if (levels.length === 0) return undefined;
  if (typeof current === "string" && levels.includes(current)) return current;
  if (levels.includes(PREFERRED_EFFORT)) return PREFERRED_EFFORT;
  const fallback = model?.reasoning_effort_default;
  return fallback && levels.includes(fallback) ? fallback : levels[0];
}

type Session = {
  model: string;
  effort?: string;
  // Plan Mode ignores `model_reasoning_effort` and falls back to `medium`, which most ai& models
  // don't publish.
  planEffort?: string;
  baseUrl?: string;
  auth: { command: string; args: string[] };
};

const authArgs = (profileName?: string): string[] =>
  profileName ? [...AUTH_ARGS, "--profile", profileName] : [...AUTH_ARGS];

function ownedTables(session: Session): [string, TomlTable][] {
  return [
    [
      "",
      {
        model: session.model,
        ...(session.effort ? { model_reasoning_effort: session.effort } : {}),
        ...(session.planEffort ? { plan_mode_reasoning_effort: session.planEffort } : {}),
        model_provider: PROVIDER_ID,
        ...HOSTED_OFF,
      },
    ],
    [PROVIDER_TABLE, { name: "ai&", base_url: codexBaseUrl(session.baseUrl), wire_api: WIRE_API }],
    [AUTH_TABLE, session.auth],
    ["features", FEATURES],
  ];
}

const OWNED_KEYS = new Map<string, Set<string>>([
  [
    "",
    new Set([
      "model",
      "model_reasoning_effort",
      "plan_mode_reasoning_effort",
      "model_provider",
      ...Object.keys(HOSTED_OFF),
    ]),
  ],
  [PROVIDER_TABLE, new Set(["name", "base_url", "wire_api"])],
  [AUTH_TABLE, new Set(["command", "args"])],
  ["features", new Set(Object.keys(FEATURES))],
]);

const KEY_LINE = /^\s*([A-Za-z0-9_-]+)\s*=/;

function ownedKey(table: string, line: string): string | null {
  const key = KEY_LINE.exec(line)?.[1];
  return key !== undefined && OWNED_KEYS.get(table)?.has(key) ? key : null;
}

function theirLines(section: TomlSection, keep: (line: string) => boolean = () => false): string {
  return logicalLines(section.text)
    .filter((_line, index) => !(section.name && index === 0))
    .filter((line) => line !== HEADER && (ownedKey(section.name, line) === null || keep(line)))
    .join("")
    .replace(/\s+$/, "");
}

function ownedText(sections: TomlSection[]): string {
  return sections
    .filter((section) => OWNED_KEYS.has(section.name))
    .flatMap((section) =>
      logicalLines(section.text).filter((line) => {
        const key = ownedKey(section.name, line);
        return key !== null && !PICK_KEYS.has(key);
      }),
    )
    .map((line) => line.trim())
    .join("\n");
}

const hasContent = (text: string): boolean =>
  text.split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("#"));

function leftover(section: TomlSection, keep?: (line: string) => boolean): string {
  const lines = OWNED_KEYS.has(section.name) ? theirLines(section, keep) : section.text.trim();
  if (!hasContent(lines)) return "";
  const header = OWNED_KEYS.has(section.name) && section.name ? `[${section.name}]\n` : "";
  return `${header}${lines.trim()}\n`;
}

// Other args could select another credential, so they read as someone else's profile.
function pinnedProfile(keys: Record<string, Record<string, unknown>>): string | null | undefined {
  const auth = keys[AUTH_TABLE];
  const args = auth?.args;
  if (!isAuthCommand(auth?.command) || !Array.isArray(args)) return undefined;
  if (!AUTH_ARGS.every((arg, index) => args[index] === arg)) return undefined;
  if (args.length === AUTH_ARGS.length) return null;
  const name = args[AUTH_ARGS.length + 1];
  return args.length === AUTH_ARGS.length + 2 &&
    args[AUTH_ARGS.length] === "--profile" &&
    typeof name === "string" &&
    name !== ""
    ? name
    : undefined;
}

const markedByUs = (keys: Record<string, Record<string, unknown>>): boolean =>
  pinnedProfile(keys) !== undefined;

function routesElsewhere(sections: TomlSection[], keys: Record<string, Record<string, unknown>>) {
  if (markedByUs(keys)) return false;
  return (
    keys[""]?.model_provider !== undefined ||
    sections.some((section) => section.name === PROVIDER_TABLE || section.name === AUTH_TABLE)
  );
}

const routedByUs = (keys: Record<string, Record<string, unknown>>): boolean =>
  markedByUs(keys) &&
  spawnableByCodex(keys[AUTH_TABLE]?.command) &&
  isRoutableBaseUrl(keys[PROVIDER_TABLE]?.base_url);

const DOTTED_KEY = /^(\s*)([A-Za-z0-9_.-]+)\.([A-Za-z0-9_-]+)(\s*=)/;

// A root `features.x = …` beside the `[features]` header `on` writes would define the table twice.
function foldDottedKeys(sections: TomlSection[]): TomlSection[] {
  const moved = new Map<string, string>();
  const root = logicalLines(sections[0]!.text).filter((line) => {
    const dotted = DOTTED_KEY.exec(line);
    if (!dotted || !OWNED_KEYS.has(dotted[2]!)) return true;
    const body = line.replace(DOTTED_KEY, "$1$3$4");
    moved.set(
      dotted[2]!,
      `${moved.get(dotted[2]!) ?? ""}${body.endsWith("\n") ? body : `${body}\n`}`,
    );
    return false;
  });
  if (moved.size === 0) return sections;
  const folded = [{ name: "", text: root.join("") }, ...sections.slice(1)];
  for (const [name, lines] of moved) {
    const section = folded.find((entry) => entry.name === name);
    if (section) section.text = `${section.text.replace(/\n*$/, "\n")}${lines}`;
    else folded.push({ name, text: `[${name}]\n${lines}` });
  }
  return folded;
}

async function readProfile(
  path = currentProfilePath(),
): Promise<{ raw: string; sections: TomlSection[] }> {
  const raw = await readTextIfExists(path);
  return { raw, sections: foldDottedKeys(splitSections(raw)) };
}

async function probe(): Promise<ProbeResult> {
  const { sections } = await readProfile();
  const keys = readKeys(sections);
  const active = routedByUs(keys);
  const model = keys[""]?.model;
  return { active, model: active && typeof model === "string" ? model : null };
}

async function enableGuard({ force }: { force: boolean }): Promise<void> {
  const path = currentProfilePath();
  const wired = (await getAddedState<CodexRecord>(CODEX_ID))?.path;
  // Moving on would replace the snapshot that is the only copy of the profile at the old path.
  if (wired && wired !== path && markedByUs(readKeys((await readProfile(wired)).sections))) {
    throw new CliError(`Codex is on at ${wired}.`, {
      hint: "Run aiand codex off first, then aiand codex on.",
    });
  }
  const { sections } = await readProfile();
  if (force || !routesElsewhere(sections, readKeys(sections))) return;
  throw new CliError(`${path} already routes Codex somewhere ai& does not manage.`, {
    hint: "Take it over with aiand codex on --force (aiand restore codex --force brings it back), or use aiand run-agent codex, which leaves it alone.",
  });
}

async function enable(input: EnableInput): Promise<EnableResult> {
  if (input.model === "native") {
    throw new CliError("Codex's own models are not on ai&.", {
      hint: "Pass --model with an ai& model id, or leave it out for the default.",
    });
  }
  const path = currentProfilePath();
  const { raw, sections } = await readProfile();
  const keys = readKeys(sections);
  const marked = markedByUs(keys);
  const prior = marked ? await getAddedState<CodexRecord>(CODEX_ID) : null;
  const userProjects = marked
    ? (prior?.userProjects ?? [])
    : sections.filter(isProjectTable).map((section) => section.name);
  const warnings: string[] = [];

  const current = keys[""]?.model;
  const keep = !input.pinModel && marked && inCatalog(input.catalog, current);
  const model = keep ? current : input.model;
  const command = resolveAuthCommand();
  if (command === null) {
    warnings.push(
      "Codex runs `aiand key export` for the key, but aiand is not on PATH; run aiand codex on again once it is.",
    );
  }
  const catalogModel = input.catalog.find((entry) => entry.id === model);
  if (catalogModel && !catalogModel.reasoning_efforts?.length) {
    warnings.push(
      `${model} publishes no reasoning levels, so ai& refuses a level set in your config.toml.`,
    );
  }
  const tables = ownedTables({
    model,
    effort: effortFor(catalogModel, keep ? keys[""]?.model_reasoning_effort : undefined),
    planEffort: effortFor(catalogModel, keep ? keys[""]?.plan_mode_reasoning_effort : undefined),
    baseUrl: input.baseUrl,
    // The active profile is left unpinned, so `aiand config use` and logout carry Codex along.
    auth: {
      command: command ?? AUTH_COMMAND,
      args: authArgs(input.profileName === loadConfig().profile ? undefined : input.profileName),
    },
  });

  const byName = new Map(sections.map((section) => [section.name, section]));
  const owned = tables.map(([name, table]) => {
    const section = byName.get(name);
    const theirs = section ? theirLines(section) : "";
    return `${renderTable(name, table)}${theirs.trim() ? `${theirs.trim()}\n` : ""}`;
  });
  const kept = sections.filter((section) => !OWNED_KEYS.has(section.name));
  const text = `${HEADER}${owned.join("\n")}${kept.map((section) => `\n${section.text.trim()}\n`).join("")}`;

  const before = ownedText(sections);
  if (
    prior?.codexOwned !== undefined &&
    before !== prior.codexOwned &&
    before !== ownedText(foldDottedKeys(splitSections(text)))
  ) {
    warnings.push(`Rewrote ${path}; your edits to ai&'s settings there were replaced.`);
  }
  warnings.push("Start it with `aiand codex`, or `codex --profile aiand`.");

  if (text !== raw) {
    // No key lives in the file, so it keeps its mode rather than 0600.
    await writeFileAtomic(path, text, { mode: (await existingFileMode(path)) ?? 0o644 });
  }
  await recordAddedState(CODEX_ID, {
    path,
    codexOwned: ownedText(foldDottedKeys(splitSections(text))),
    userProjects,
  } satisfies CodexRecord);

  return {
    model,
    catalogModel: inCatalog(input.catalog, model) ? model : undefined,
    filesWritten: [path],
    warnings,
  };
}

async function disable(input: DisableInput = {}): Promise<DisableResult> {
  const added = await getAddedState<CodexRecord>(CODEX_ID);
  const path = added?.path ?? currentProfilePath();
  const { sections } = await readProfile(path);
  const keys = readKeys(sections);
  if (!markedByUs(keys)) {
    await clearAddedState(CODEX_ID);
    return { stripped: false };
  }
  const pinned = pinnedProfile(keys);
  if (input.loggingOut && pinned && pinned !== input.loggingOut) return { stripped: false };
  const notes: string[] = [];
  const recorded = added?.codexOwned === undefined ? null : new Set(added.codexOwned.split("\n"));
  const edited: string[] = [];
  const left = sections
    .filter((section) => !isProjectTable(section) || added?.userProjects?.includes(section.name))
    .map((section) =>
      leftover(section, (line) => {
        const key = ownedKey(section.name, line);
        if (!recorded || key === null || PICK_KEYS.has(key) || recorded.has(line.trim())) {
          return false;
        }
        edited.push(key);
        return true;
      }),
    )
    .filter(Boolean);
  if (edited.length > 0) notes.push(`left ${edited.join(", ")} in ${path} because you edited it`);
  if (left.length > 0) {
    await writeFileAtomic(path, left.join("\n"), {
      mode: (await existingFileMode(path)) ?? 0o644,
    });
    notes.push(`kept your other settings in ${path}`);
  } else {
    await unlink(path);
  }
  // A snapshot holding a profile's bytes is the user's only copy, so it outlives off.
  if (await fileCreatedByUs(CODEX_ID, path)) {
    await discardSnapshot(CODEX_ID);
  } else if (await hasSnapshot(CODEX_ID)) {
    notes.push("run aiand restore codex --force to bring back your previous profile");
  }
  await clearAddedState(CODEX_ID);
  return { stripped: true, notes };
}

function codexOverrides(tables: [string, TomlTable][]): string[] {
  const pairs: string[] = [];
  const auth = tables.find(([name]) => name === AUTH_TABLE)?.[1] ?? {};
  for (const [name, table] of tables) {
    if (name === AUTH_TABLE) continue;
    if (name === PROVIDER_TABLE) {
      pairs.push(`${name}=${renderInline({ ...table, auth })}`);
      continue;
    }
    for (const [key, value] of Object.entries(table)) {
      pairs.push(`${name ? `${name}.` : ""}${key}=${renderInline(value)}`);
    }
  }
  return pairs.flatMap((pair) => ["-c", pair]);
}

const NON_RUNTIME_COMMANDS = new Set([
  "a",
  "agents",
  "app",
  "app-server",
  "apply",
  "cloud",
  "completion",
  "doctor",
  "exec-server",
  "features",
  "help",
  "login",
  "logout",
  "migrate-rollouts",
  "plugin",
  "remote-control",
  "update",
]);

const CODEX_INSTALL = {
  command: "npm install -g @openai/codex",
  url: "https://developers.openai.com/codex/cli",
};

export const codexAdapter: AgentAdapter = {
  id: CODEX_ID,
  label: "Codex",
  bin: CODEX_BIN,
  install: CODEX_INSTALL,
  detect(): DetectResult {
    return detectBinary(CODEX_BIN);
  },
  managedFiles(): string[] {
    return [currentProfilePath()];
  },
  probe,
  enableGuard,
  enable,
  disable,
  async refreshKey(): Promise<boolean> {
    return false;
  },
  async sessionLaunch(input: SessionLaunchInput) {
    const model = input.model ?? resolveDefault(input.catalog, input.profileModel);
    const effort = effortFor(input.catalog.find((entry) => entry.id === model));
    const tables = ownedTables({
      model,
      effort,
      planEffort: effort,
      baseUrl: input.baseUrl,
      // This very aiand, so the session works from npx or a checkout with no aiand on PATH.
      auth: {
        command: process.execPath,
        args: [process.argv[1]!, ...authArgs(input.profileName)],
      },
    });
    // Codex's `aiand key export` runs as its child and can only find an AIAND_API_KEY session
    // there.
    const env: Record<string, string> = process.env.AIAND_API_KEY?.trim()
      ? { AIAND_API_KEY: input.apiKey }
      : {};
    return { env, args: codexOverrides(tables) };
  },
  async openExtras({ args }) {
    const own = args.some((arg) => /^(?:-p|--profile(?:=|$))/.test(arg));
    if (own || NON_RUNTIME_COMMANDS.has(args[0] ?? "")) return {};
    const extras: { env?: Record<string, string>; args: string[] } = {
      args: ["--profile", PROFILE],
    };
    // Same child as sessionLaunch: `aiand key export` needs the env-key session there.
    if (process.env.AIAND_API_KEY?.trim())
      extras.env = { AIAND_API_KEY: process.env.AIAND_API_KEY };
    return extras;
  },
};
