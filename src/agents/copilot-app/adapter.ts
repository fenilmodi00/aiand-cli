import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../../cli/errors.js";
import { agentHome, DEFAULT_BASE_URL, isRoutableBaseUrl, trimSlash } from "../../config.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeResult,
} from "../types.js";
import {
  COPILOT_APP_PROVIDER_PREFIX,
  type CopilotAppModel,
  copilotModelInsert,
  execCopilotSql,
  isCopilotSchemaError,
  newCopilotProviderId,
  queryCopilotSql,
  sqlString,
} from "./sqlite.js";

const COPILOT_APP_ID = "copilot-app";

/**
 * The app's provider name in the picker. The name is not the ownership
 * marker (the `aiand-` row-id prefix is), so the human-readable brand
 * form is safe here.
 */
const COPILOT_APP_PROVIDER_NAME = "ai&";

/** The app's config tree: ~/.copilot/, or $COPILOT_HOME when set. */
function copilotAppHomeDir(): string {
  return process.env.COPILOT_HOME?.trim() || join(agentHome(), ".copilot");
}

/**
 * The desktop app's provider database. The docs cover COPILOT_HOME for the
 * CLI only; whether the app honors it is unverified. Honoring it keeps
 * tests isolatable through this same path and gives users an escape
 * hatch — if the app turns out to read `~/.copilot` unconditionally, this
 * only changes where `on` looks, never what the app loads.
 */
export function copilotDataDbPath(): string {
  return join(copilotAppHomeDir(), "data.db");
}

/**
 * The app's GUI install dirs per platform, checked in detect(). The db
 * probe covers the rest (an AppImage mounts elsewhere and is not
 * enumerable).
 */
function copilotAppInstallPaths(): string[] {
  if (process.platform === "darwin") return ["/Applications/GitHub Copilot.app"];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    return local ? [join(local, "Programs", "GitHub Copilot")] : [];
  }
  return [];
}

/**
 * Process matcher for the desktop app, used by the quit guards. The names
 * are the app's real ones: macOS `GitHub Copilot.app/Contents/MacOS/GitHub
 * Copilot`, Windows `github.exe`. The patterns must NEVER match the
 * Copilot CLI: the app's bundled CLI child `copilot.exe` is
 * image-name-identical to the standalone binary, and a bare `copilot`
 * pattern would block on/off for a quit no one needs.
 *
 * - POSIX: ERE for `pgrep -f` against the full command line. The
 *   `Contents/MacOS/` anchor separates the app's own executable from a
 *   `copilot` CLI whose argv merely mentions the app.
 * - Linux: `[/]` eats the pgrep line itself (the pattern text contains
 *   `/GitHub Copilot`, not `[ ]GitHub Copilot`).
 * - Windows: tasklist lists image names only, matched line-anchored.
 *   `github.exe` cannot be a substring of the SDK child's `copilot.exe`.
 */
export const copilotAppProcessSpec = {
  darwin: "GitHub Copilot\\.app/Contents/MacOS/",
  linux: "[/]GitHub Copilot",
  windowsImage: "github\\.exe",
};

/** True when `commandLine` is the desktop app for `platform` (pure: unit-tested). */
export function copilotAppProcessMatches(
  spec: typeof copilotAppProcessSpec,
  platform: NodeJS.Platform,
  commandLine: string,
): boolean {
  if (platform === "win32") {
    return new RegExp(`^\\s*${spec.windowsImage}(\\s|$)`, "i").test(commandLine);
  }
  const pattern = platform === "darwin" ? spec.darwin : spec.linux;
  return new RegExp(pattern, "i").test(commandLine);
}

/** True while the desktop app process is live (CLI probe tools included). */
function copilotAppProcessRunning(): boolean {
  if (process.platform === "win32") {
    const listing = spawnSync("tasklist", ["/FI", "IMAGENAME eq github.exe", "/NH"], {
      encoding: "utf8",
    });
    if (listing.error || listing.status !== 0) return false;
    return /github\.exe/i.test(listing.stdout ?? "");
  }
  const pattern =
    process.platform === "darwin" ? copilotAppProcessSpec.darwin : copilotAppProcessSpec.linux;
  const probe = spawnSync("pgrep", ["-fi", pattern], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return false;
  return Boolean(probe.stdout?.trim());
}

/**
 * Quit-refusal shared by enableGuard/offGuard: the app holds data.db open
 * and rewrites it on exit, which would clobber our rows. --force escapes.
 */
async function refuseRunningApp({ force }: { force: boolean }): Promise<void> {
  if (force || !copilotAppProcessRunning()) return;
  throw new CliError("Quit the GitHub Copilot app first.", {
    hint: "It rewrites data.db when it exits and would clobber the change — quit it fully, rerun, or pass --force.",
  });
}

/** Wrap a raw db failure so schema drift reads as advice, never a stack trace. */
async function guardSchema<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (isCopilotSchemaError(error)) {
      throw new CliError(
        "The Copilot app's provider database changed (its schema is undocumented).",
        {
          hint: "Use Settings -> Model providers in the app to add ai& there.",
        },
      );
    }
    throw error;
  }
}

const copilotAppBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

/** The provider row's settings_json: auth rides the Authorization header. */
function copilotAppSettingsJson(baseUrl: string, apiKey: string): string {
  return JSON.stringify({
    // `authKind: "none"` keeps the app out of the OS keychain: keychain
    // items a CLI tool creates are not on the app's partition list, and
    // adding them needs the user's login password — an interactive prompt
    // a non-interactive `aiand copilot-app on` cannot answer.
    authKind: "none",
    baseUrl,
    headersJson: JSON.stringify({ Authorization: `Bearer ${apiKey}` }),
    wireApi: "completions",
  });
}

/** The app provider row plus its settings object, parsed back for the header. */
type AppProviderRow = {
  id: string;
  settings: Record<string, unknown>;
  apiKey: string | undefined;
};

async function findAppProvider(): Promise<AppProviderRow | null> {
  const rows = await queryCopilotSql(
    copilotDataDbPath(),
    `SELECT id, settings_json FROM model_providers WHERE id LIKE '${COPILOT_APP_PROVIDER_PREFIX}%';`,
  );
  const row = rows[0];
  if (!row) return null;
  const settings = JSON.parse(String(row.settings_json ?? "{}")) as Record<string, unknown>;
  const headers = JSON.parse(String(settings.headersJson ?? "{}")) as Record<string, unknown>;
  const bearer = (typeof headers.Authorization === "string" ? headers.Authorization : "").match(
    /^Bearer\s+(.*)$/i,
  );
  return { id: String(row.id), settings, apiKey: bearer?.[1] };
}

function copilotAppModels(input: EnableInput): CopilotAppModel[] {
  return input.catalog.map((model) => ({
    id: model.id,
    name: model.name,
    // The catalog carries no separate output cap; mirror the context
    // window, the cap the gateway enforces (opencode's policy).
    contextWindow: model.context_window,
    // NULL hides the app's effort picker (live-app finding); an empty
    // JSON array is the honest "no efforts" answer.
    reasoningEfforts: JSON.stringify(model.reasoning_efforts ?? []),
  }));
}

async function probe(): Promise<ProbeResult> {
  let provider: AppProviderRow | null;
  try {
    provider = await findAppProvider();
  } catch {
    // A db mid-write or a drifted schema must not wedge `status`.
    return { active: false, model: null };
  }
  if (!provider) return { active: false, model: null };
  // GitHub sign-in is required for the app regardless of BYOK, and the
  // app keeps its model pick per session (no persisted default), so probe
  // reports routing only.
  return {
    active: isRoutableBaseUrl(provider.settings.baseUrl),
    model: null,
  };
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const dbPath = copilotDataDbPath();
  if (!existsSync(dbPath)) {
    throw new CliError("The GitHub Copilot app has not created its config database yet.", {
      hint: "Open the GitHub Copilot app once so it can create its config database, then run aiand copilot-app on again.",
    });
  }
  const settingsJson = copilotAppSettingsJson(copilotAppBaseUrl(input.baseUrl), input.apiKey);
  await guardSchema(async () => {
    // Reuse an existing aiand- provider id: stored app sessions resolve
    // their model by provider row, and a fresh id each `on` would orphan
    // them.
    const existing = await findAppProvider().catch(() => null);
    const providerId = existing?.id ?? newCopilotProviderId();
    const statements = [
      `INSERT OR REPLACE INTO model_providers (id, name, type, settings_json, account_id) VALUES (${sqlString(providerId)}, ${sqlString(COPILOT_APP_PROVIDER_NAME)}, 'openai', ${sqlString(settingsJson)}, NULL);`,
      // Replace the whole model set under one transaction; UNIQUE
      // (provider_id, model_id) makes a re-on idempotent.
      `DELETE FROM provider_models WHERE provider_id = ${sqlString(providerId)};`,
      ...copilotAppModels(input).map((model) => copilotModelInsert(providerId, model)),
    ];
    await execCopilotSql(dbPath, statements);
  });
  // The app resolves its own model per session; there is no ai& "model in
  // effect" to report, so enable reports the resolved pick without
  // claiming the app pinned it.
  const warnings = [
    "The app keeps GitHub sign-in even for BYOK providers, and you pick the ai& model in its model menu.",
  ];
  if (input.pinModel) {
    warnings.push(`The app keeps its own model pick: choose ${input.model} in its model menu.`);
  }
  return {
    model: input.model,
    catalogModel: input.model === "native" ? undefined : input.model,
    filesWritten: [dbPath],
    warnings,
  };
}

async function disable(): Promise<DisableResult> {
  const dbPath = copilotDataDbPath();
  if (!existsSync(dbPath)) return { stripped: false };
  return guardSchema(async () => {
    const ours = await queryCopilotSql(
      dbPath,
      `SELECT id FROM model_providers WHERE id LIKE '${COPILOT_APP_PROVIDER_PREFIX}%';`,
    );
    if (ours.length === 0) return { stripped: false };
    const ids = ours.map((row) => String(row.id));
    // Both DELETEs run explicitly: rely on the FK cascade for nothing, and
    // a provider_models table without matching rows stays clean either way.
    await execCopilotSql(dbPath, [
      ...ids.map((id) => `DELETE FROM provider_models WHERE provider_id = ${sqlString(id)};`),
      `DELETE FROM model_providers WHERE id LIKE '${COPILOT_APP_PROVIDER_PREFIX}%';`,
    ]);
    return { stripped: true };
  });
}

export const copilotAppAdapter: AgentAdapter = {
  id: COPILOT_APP_ID,
  label: "GitHub Copilot app",
  // The shared product family's binary; detect() never uses it (the app is
  // GUI-installed — its db or app dir is the footprint), but `bin` feeds
  // status display and must name the real command family.
  bin: "copilot",
  // Linux has no GUI install-path probe (an AppImage mounts unenumerably),
  // so detect() gates on data.db — which the app only creates on first
  // open. The Linux hint therefore says "open it once", and never suggests
  // brew (macOS-only) for an app that may already be installed.
  install:
    process.platform === "win32"
      ? {
          command: "winget install GitHub.CopilotApp",
          url: "https://github.com/features/ai/github-app",
        }
      : process.platform === "darwin"
        ? {
            command: "brew install --cask github-copilot-app",
            url: "https://github.com/features/ai/github-app",
          }
        : {
            command: "Install the GitHub Copilot desktop app, then open it once",
            url: "https://github.com/features/ai/github-app",
          },
  detect(): DetectResult {
    const dbPath = copilotDataDbPath();
    if (existsSync(dbPath)) return { installed: true, path: dbPath };
    const appDir = copilotAppInstallPaths().find((path) => existsSync(path));
    return { installed: appDir !== undefined, path: appDir ?? null };
  },
  managedFiles(): string[] {
    return [copilotDataDbPath()];
  },
  probe,
  enable,
  enableGuard: refuseRunningApp,
  offGuard: refuseRunningApp,
  disable,
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    let provider: AppProviderRow | null;
    try {
      provider = await findAppProvider();
    } catch {
      return false;
    }
    if (!provider) return false;
    // Same-key rotation is a no-op that still counts as touched; a
    // rotation swaps only the key it replaced.
    if (provider.apiKey === undefined) return false;
    if (provider.apiKey === input.apiKey) return true;
    if (input.previousKey !== undefined && provider.apiKey !== input.previousKey) return false;
    const headers = JSON.parse(String(provider.settings.headersJson ?? "{}")) as Record<
      string,
      unknown
    >;
    headers.Authorization = `Bearer ${input.apiKey}`;
    const settings = { ...provider.settings, headersJson: JSON.stringify(headers) };
    try {
      await execCopilotSql(copilotDataDbPath(), [
        `UPDATE model_providers SET settings_json = ${sqlString(JSON.stringify(settings))} WHERE id = ${sqlString(provider.id)};`,
      ]);
    } catch (error) {
      if (isCopilotSchemaError(error)) return false;
      throw error;
    }
    return true;
  },
};
