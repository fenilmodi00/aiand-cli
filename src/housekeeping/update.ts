import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { publicJson, VERSION } from "../api/client.js";
import { resolveWindowsCommand } from "../cli/win-spawn.js";
import { configDir, writeFileAtomic } from "../config.js";
import { DAY_MS, HOUR_MS, SECOND_MS } from "../time.js";

const CACHE_TTL_MS = DAY_MS; // fresh ok-cache window
const FAILURE_RETRY_MS = HOUR_MS; // retry window after a failed check
const FETCH_TIMEOUT_MS = 3 * SECOND_MS;

const REGISTRY_URL = "https://registry.npmjs.org/@aiand/cli/latest";

/** The launcher checkout install.sh creates, under AIAND_DIR when set. */
const DEFAULT_INSTALL_DIR = join(".aiand", "cli");

/** An npm global install: <prefix>/…/node_modules/@aiand/cli/dist/index.js. */
const NPM_PACKAGE_SEGMENT = "node_modules/@aiand/cli";

export type UpdateInfo = {
  current: string;
  latest: string;
};

/** How this CLI was installed, which decides how it upgrades itself. */
export type InstallKind = {
  kind: "installer" | "npm" | "source";
  /** The checkout root: for `installer`, the dir holding install.sh. */
  root?: string;
};

type UpdateCache = {
  checkedAt: number;
  latest?: string;
  ok: boolean;
};
/**
 * Kill-switches that short-circuit the check before any I/O: the owner can
 * disable the notice entirely (AIAND_UPDATE_CHECK=0 / NO_UPDATE_CHECK=1), and
 * any set CI variable (even CI=false) counts as CI, which never checks.
 */
function updateDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.AIAND_UPDATE_CHECK === "0" || env.NO_UPDATE_CHECK === "1" || env.CI !== undefined;
}

function updateCachePath(): string {
  return join(configDir(), "update-check.json");
}

function readUpdateCache(): UpdateCache | null {
  try {
    const parsed = JSON.parse(readFileSync(updateCachePath(), "utf8")) as Partial<UpdateCache>;
    if (typeof parsed.checkedAt !== "number" || typeof parsed.ok !== "boolean") return null;
    return {
      checkedAt: parsed.checkedAt,
      ok: parsed.ok,
      latest: typeof parsed.latest === "string" ? parsed.latest : undefined,
    };
  } catch {
    return null;
  }
}

async function writeUpdateCache(payload: UpdateCache): Promise<void> {
  await writeFileAtomic(updateCachePath(), `${JSON.stringify(payload)}\n`);
}

function versionCore(version: string): { parts: number[]; prerelease: boolean } {
  const stripped = String(version).replace(/^v/, "");
  const dash = stripped.indexOf("-");
  const core = dash === -1 ? stripped : stripped.slice(0, dash);
  const parts = core.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return { parts, prerelease: dash !== -1 };
}

/**
 * Compare two dotted-integer version strings on same-length padded parts
 * (pad the shorter with zeros). A prerelease is older than the same numeric
 * release (1.0.0-rc.1 < 1.0.0). Returns >0 when `left` is newer than `right`.
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = versionCore(left);
  const rightParts = versionCore(right);
  const length = Math.max(leftParts.parts.length, rightParts.parts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts.parts[index] ?? 0) - (rightParts.parts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (leftParts.prerelease !== rightParts.prerelease) {
    return leftParts.prerelease ? -1 : 1;
  }
  return 0;
}

function isPrerelease(version: string): boolean {
  return versionCore(version).prerelease;
}

function shouldOfferUpdate(latest: string, current: string): boolean {
  if (isPrerelease(latest) && !isPrerelease(current)) return false;
  return compareVersions(latest, current) > 0;
}

/**
 * Check the npm registry for a newer @aiand/cli, caching the result for 24h
 * (or retrying after 1h on failure). Never throws: any failure degrades to
 * "no update" and writes a failed cache so the next run retries later.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (updateDisabled(process.env)) return null;

  const cache = readUpdateCache();
  const checkedAt = cache?.checkedAt ?? 0;

  if (cache?.ok === true) {
    if (Date.now() - checkedAt < CACHE_TTL_MS) {
      // Fresh ok-cache: trust it without touching the network.
      return typeof cache.latest === "string" && shouldOfferUpdate(cache.latest, VERSION)
        ? { current: VERSION, latest: cache.latest }
        : null;
    }
  } else if (cache !== null && Date.now() - checkedAt < FAILURE_RETRY_MS) {
    // Recent failed check: don't hammer the registry.
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let data: { version?: string };
    try {
      data = await publicJson<{ version?: string }>(REGISTRY_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const latest = data?.version;
    if (typeof latest !== "string") throw new Error("registry response missing version");
    const payload: UpdateCache = { checkedAt: Date.now(), ok: true, latest };
    await writeUpdateCache(payload).catch(() => {});
    return shouldOfferUpdate(latest, VERSION) ? { current: VERSION, latest } : null;
  } catch {
    // Even the failure write is best-effort.
    await writeUpdateCache({ checkedAt: Date.now(), ok: false }).catch(() => {});
    return null;
  }
}

/**
 * Fetch the newest published version, straight from the registry: the
 * foreground check behind `aiand update` must never be answered by the
 * 24h background cache, or a stale notice would decide whether to upgrade.
 * Throws when the registry cannot be reached or has no version.
 */
export async function fetchLatestVersion(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const data = await publicJson<{ version?: string }>(REGISTRY_URL, {
      signal: controller.signal,
    });
    if (typeof data?.version !== "string") throw new Error("registry response missing version");
    return data.version;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How this install was made, from where the running entry point lives: the
 * launcher's own checkout (`root` is the dir holding install.sh), an npm
 * global prefix, or a source checkout. Only the launcher's checkouts get
 * `root`, so `aiand update` never hands an arbitrary dev checkout to
 * install.sh.
 */
export function detectInstallKind(): InstallKind {
  const fromEnv = process.env.AIAND_DIR;
  const root = fromEnv ? resolve(fromEnv) : join(homedir(), DEFAULT_INSTALL_DIR);
  let launched: string;
  try {
    launched = realpathSync(process.argv[1] ?? "");
  } catch {
    return { kind: "source" };
  }
  // The launcher runs <root>/dist/index.js; a checkout run in place
  // (`AIAND_DIR=/repo aiand update`) upgrades the same way.
  const inRoot = launched === root || relative(root, launched).split(sep)[0] !== "..";
  if (inRoot) {
    if (launched === join(root, "dist", "index.js") || isAiandCheckout(root)) {
      return { kind: "installer", root };
    }
  }
  // An npm global install runs <prefix>/lib/node_modules/@aiand/cli/dist/index.js.
  return launched.replace(/\\/g, "/").includes(`/${NPM_PACKAGE_SEGMENT}/`)
    ? { kind: "npm" }
    : { kind: "source" };
}

/** True when the checkout at `path` is our own package, not a stray dir. */
function isAiandCheckout(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as {
      name?: string;
    };
    return parsed.name === "@aiand/cli";
  } catch {
    return false;
  }
}

/**
 * Run `command` with inherited stdio and resolve its exit code (null when
 * the child was killed outright). `extraEnv` layers on top of the parent
 * env, which is always scrubbed of AIAND_API_KEY first: an installer runs
 * third-party code and must never inherit the session key.
 */
export async function runInstallScript(
  command: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<number | null> {
  const env = { ...process.env, ...extraEnv };
  delete env.AIAND_API_KEY;
  const { promise, resolve, reject } = Promise.withResolvers<number | null>();
  // npm is a .cmd shim on Windows, which cannot be spawned directly.
  const resolved = process.platform === "win32" ? resolveWindowsCommand(command, args, env) : null;
  if (resolved === null && process.platform === "win32") {
    reject(Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" }));
    return promise;
  }
  const child = spawn(resolved?.command ?? command, resolved?.args ?? args, {
    env,
    stdio: "inherit",
    windowsVerbatimArguments: resolved?.verbatim,
  });
  child.once("error", reject);
  child.once("exit", (status, signal) => resolve(status ?? (signal ? 1 : null)));
  return promise;
}

/** The absolute path of the running entry point, for the post-update probe. */
export function launchedEntry(): string {
  return realpathSync(process.argv[1] ?? "");
}
