import { join } from "node:path";
import { readFileSync } from "node:fs";
import { configDir, writeFileAtomic } from "../config.js";
import { VERSION, publicJson } from "../api/client.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // fresh ok-cache window (<24h)
const FAILURE_RETRY_MS = 60 * 60 * 1000; // retry window after a failed check (>1h)
const FETCH_TIMEOUT_MS = 3000;

const REGISTRY_URL = "https://registry.npmjs.org/@aiand/cli/latest";

export type UpdateInfo = {
  current: string;
  latest: string;
};


type UpdateCache = {
  checkedAt: number;
  latest?: string;
  ok: boolean;
};
/**
 * Kill-switches that short-circuit the check before any I/O: the owner can
 * disable the notice entirely (AIAND_UPDATE_CHECK=0 / NO_UPDATE_CHECK=1) or
 * rely on CI being non-interactive by default.
 */
function updateDisabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.AIAND_UPDATE_CHECK === "0" ||
    env.NO_UPDATE_CHECK === "1" ||
    env.CI !== undefined
  );
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
  await writeFileAtomic(updateCachePath(), JSON.stringify(payload) + "\n");
}

function versionParts(version: string): number[] {
  return String(version)
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

/**
 * Compare two dotted-integer version strings on same-length padded parts
 * (pad the shorter with zeros). Returns >0 when `left` is newer than `right`.
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Check the npm registry for a newer @aiand/cli, caching the result for 24h
 * (or retrying after 1h on failure). Never throws: any failure degrades to
 * "no update" and writes a failed cache so the next run retries later.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const env = process.env;
  const now = (): number => Date.now();

  if (updateDisabled(env)) return null;

  const cache = readUpdateCache();
  const checkedAt = cache?.checkedAt ?? 0;

  if (cache?.ok === true) {
    if (now() - checkedAt < CACHE_TTL_MS) {
      // Fresh ok-cache: trust it without touching the network.
      return cache.latest && compareVersions(cache.latest, VERSION) > 0
        ? { current: VERSION, latest: cache.latest }
        : null;
    }
  } else if (cache !== null && now() - checkedAt < FAILURE_RETRY_MS) {
    // Recent failed check: don't hammer the registry.
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const data = await publicJson<{ version?: string }>(REGISTRY_URL);
    clearTimeout(timer);
    const latest = data?.version;
    if (typeof latest !== "string") throw new Error("registry response missing version");
    const payload: UpdateCache = { checkedAt: now(), ok: true, latest };
    await writeUpdateCache(payload).catch(() => {});
    return compareVersions(latest, VERSION) > 0
      ? { current: VERSION, latest }
      : null;
  } catch {
    try {
      await writeUpdateCache({ checkedAt: now(), ok: false }).catch(() => {});
    } catch {
      // even the failure write is best-effort
    }
    return null;
  }
}