import { AGENTS } from "../agents/registry.js";
import { listAgentKeys } from "../api/agent-keys.js";
import { openSession, type Session } from "../api/client.js";
import { getLogs } from "../api/logs.js";
import { bool, parse, str } from "../cli/args.js";
import { ApiError, EXIT, NotLoggedInError, SYNTHETIC_STATUS } from "../cli/errors.js";
import { json, out, relativeTime, style } from "../cli/output.js";
import { type ResolvedProfile, resolveProfile } from "../config.js";

/**
 * `aiand doctor` — observability health checks.
 *
 * One independent check per data source, one line each, so a user can answer
 * "why are my numbers empty or weird" in a single command. Probes here are
 * diagnostic-only and cheap: at most one tiny /logs page. Doctor diagnoses,
 * never repairs — the output hints at the fixing command instead of running it.
 */

export const help = `${style.bold("aiand doctor")} -- observability health checks

Usage
  aiand doctor
  aiand doctor --json

Options
  --profile <name>    check a specific profile
  --json              machine-readable per-check results

Checks (one line each, all run even when earlier ones fail)
  gateway      gateway reachable? (one minimal /logs probe)
  auth         is the session key valid?
  adapters     which agents carry an ai& key (bakedKey wiring)?
  agent-keys   how many key→agent mappings exist?
  store        local store open, migrated, and recently synced?
  lag          how far stored data lags the newest request?

Verdicts read as OK (n) / NOTHING FOUND / ERRORS, plus SKIPPED when a
dependency (the store, or the gateway) is absent.

Exit codes
  0  every non-skipped check is OK or NOTHING FOUND
  1  at least one check reports ERRORS`;

type CheckStatus = "ok" | "nothing-found" | "errors" | "skipped";

type CheckResult = {
  /** Stable id scripts rely on. */
  check: "gateway" | "auth" | "adapters" | "agent-keys" | "store" | "lag";
  status: CheckStatus;
  /** Human line; starts with the verdict word (OK (n), NOTHING FOUND, …). */
  detail: string;
  [field: string]: unknown;
};

/** The store surface doctor binds to (OBS-P0-1 #61 contract). The module may
 * not exist yet — every use degrades to a SKIPPED verdict, never a crash. */
type StoreModule = {
  STORE_VERSION: number;
  getStoreInfo: () => StoreInfo;
};

type StoreInfo = {
  path: string;
  status: "ok" | "missing" | "corrupt-recovered" | "unavailable" | "stale";
  rows: number;
  storeVersion: number;
  migrationsCurrent: boolean;
  lastSyncAt: string | null;
  newestCreatedAt: string | null;
  detail?: string;
};

type GatewayProbe =
  | { kind: "ok"; count: number }
  | { kind: "signed-out" }
  | { kind: "auth"; status: number; message: string }
  | { kind: "network"; message: string }
  | { kind: "unexpected"; message: string; status?: number };

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {});
  if (bool(parsed, "help")) return out(help);

  const profile = resolveProfile(str(parsed, "profile"));
  const probe = await probeGateway(profile);
  const storeModule = await loadStore();

  const checks: CheckResult[] = [
    gatewayCheck(probe),
    authCheck(probe),
    await adaptersCheck(),
    agentKeysCheck(),
    storeCheck(storeModule),
    await lagCheck(storeModule),
  ];

  if (bool(parsed, "json")) {
    json({ checks });
  } else {
    printChecks(checks);
  }

  // Aggregate severity: a diagnostic must be scriptable, so the exit code
  // says whether anything is actually broken, not just unknown.
  if (checks.some((check) => check.status === "errors")) process.exitCode = EXIT.ERROR;
}

function printChecks(checks: CheckResult[]): void {
  const width = Math.max(...checks.map((check) => check.check.length));
  for (const check of checks) {
    const label = style.bold(check.check.padEnd(width));
    const tint =
      check.status === "ok" ? style.green : check.status === "errors" ? style.red : style.yellow;
    out(`${label}  ${tint(check.detail)}`);
  }
}

/** One authenticated /logs page, smallest range: the cheapest probe that
 * answers both "is the gateway up" and "does this key work". */
async function probeGateway(profile: ResolvedProfile): Promise<GatewayProbe> {
  let session: Session;
  try {
    session = await openSession(profile);
  } catch (error) {
    if (error instanceof NotLoggedInError) return { kind: "signed-out" };
    return { kind: "unexpected", message: messageOf(error) };
  }
  try {
    const page = await getLogs(session, { range: "15m", limit: 1 });
    return { kind: "ok", count: page.data.length };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === SYNTHETIC_STATUS.UNREACHABLE) {
        return { kind: "network", message: error.message };
      }
      if (error.status === 401 || error.status === 403) {
        return { kind: "auth", status: error.status, message: error.message };
      }
      return { kind: "unexpected", status: error.status, message: error.message };
    }
    return { kind: "unexpected", message: messageOf(error) };
  }
}

function gatewayCheck(probe: GatewayProbe): CheckResult {
  switch (probe.kind) {
    case "ok":
      return {
        check: "gateway",
        status: "ok",
        detail: `OK — reachable (${probe.count} request${probe.count === 1 ? "" : "s"} in the last 15m)`,
      };
    case "signed-out":
      return { check: "gateway", status: "skipped", detail: "SKIPPED — not signed in" };
    case "auth":
      return {
        check: "gateway",
        status: "errors",
        detail: `ERRORS — reachable, but auth rejected the key (HTTP ${probe.status}): ${probe.message}`,
      };
    case "network":
      return { check: "gateway", status: "errors", detail: `ERRORS — network: ${probe.message}` };
    case "unexpected":
      return {
        check: "gateway",
        status: "errors",
        detail: `ERRORS — unexpected${probe.status ? ` (HTTP ${probe.status})` : ""}: ${probe.message}`,
      };
  }
}

function authCheck(probe: GatewayProbe): CheckResult {
  switch (probe.kind) {
    case "ok":
      return { check: "auth", status: "ok", detail: "OK — key accepted" };
    case "signed-out":
      return {
        check: "auth",
        status: "nothing-found",
        detail: "NOTHING FOUND — not signed in; run `aiand login` to authenticate",
      };
    case "auth":
      return {
        check: "auth",
        status: "errors",
        detail: `ERRORS — key rejected (HTTP ${probe.status}); run \`aiand login\` again`,
      };
    case "network":
      return {
        check: "auth",
        status: "skipped",
        detail: "SKIPPED — unknown; the gateway could not be reached",
      };
    case "unexpected":
      return {
        check: "auth",
        status: "skipped",
        detail: `SKIPPED — unknown; probe failed: ${probe.message}`,
      };
  }
}

/** Which adapters exist and which actually carry a usable baked key. */
async function adaptersCheck(): Promise<CheckResult> {
  const wired: string[] = [];
  for (const adapter of AGENTS) {
    if (!adapter.bakedKey) continue;
    try {
      if (await adapter.bakedKey()) wired.push(adapter.id);
    } catch {
      // A config mid-edit must not take the whole check down.
    }
  }
  if (wired.length === 0) {
    return {
      check: "adapters",
      status: "nothing-found",
      detail: "NOTHING FOUND — no agents carry an ai& key; run `aiand init` to wire one",
    };
  }
  return {
    check: "adapters",
    status: "ok",
    detail: `OK (${wired.length} wired: ${wired.join(", ")})`,
    wired,
    total: AGENTS.length,
  };
}

function agentKeysCheck(): CheckResult {
  const keys = listAgentKeys();
  if (keys.length === 0) {
    return {
      check: "agent-keys",
      status: "nothing-found",
      detail:
        "NOTHING FOUND — no key→agent mappings; wire an agent with `aiand init`, then `aiand cache --attribute` attributes past requests",
    };
  }
  const perAgent = new Map<string, number>();
  for (const key of keys) perAgent.set(key.agent, (perAgent.get(key.agent) ?? 0) + 1);
  const breakdown = [...perAgent].map(([agent, count]) => `${agent}:${count}`).join(", ");
  return {
    check: "agent-keys",
    status: "ok",
    detail: `OK (${keys.length}; ${breakdown})`,
    count: keys.length,
    perAgent: Object.fromEntries(perAgent),
  };
}

async function loadStore(): Promise<StoreModule | null> {
  // Non-literal specifier on purpose: src/store/ may not exist yet (OBS-P0-1
  // #61 is a parallel slice) and a statically-resolvable import would fail to
  // compile. When the compiled module is absent — or fails to load — doctor
  // degrades to a SKIPPED verdict instead of crashing.
  const specifier = "../store/index.js";
  try {
    const store = (await import(specifier)) as Partial<StoreModule>;
    if (typeof store.getStoreInfo !== "function") return null;
    return store as StoreModule;
  } catch {
    return null;
  }
}

const NO_STORE_DETAIL = "SKIPPED — no store module yet; observability features are limited";

function storeCheck(store: StoreModule | null): CheckResult {
  if (!store) {
    return { check: "store", status: "skipped", detail: NO_STORE_DETAIL };
  }
  let info: StoreInfo;
  try {
    info = store.getStoreInfo();
  } catch (error) {
    return {
      check: "store",
      status: "errors",
      detail: `ERRORS — store probe failed: ${messageOf(error)}`,
    };
  }
  const extra = {
    path: info.path,
    rows: info.rows,
    storeVersion: info.storeVersion,
    storeStatus: info.status,
    lastSyncAt: info.lastSyncAt,
  };
  switch (info.status) {
    case "ok":
    case "stale": {
      if (!info.migrationsCurrent) {
        return {
          check: "store",
          status: "errors",
          detail: `ERRORS — schema v${info.storeVersion}, but this CLI expects v${store.STORE_VERSION}; re-run to migrate`,
          ...extra,
        };
      }
      const sync = info.lastSyncAt ? relativeTime(info.lastSyncAt) : "never";
      const staleNote = info.status === "stale" ? " (stale)" : "";
      return {
        check: "store",
        status: "ok",
        detail: `OK (${info.rows} rows, last sync ${sync}${staleNote})`,
        ...extra,
      };
    }
    case "missing":
      return {
        check: "store",
        status: "nothing-found",
        detail: "NOTHING FOUND — no store yet; run any observability command once to create it",
        ...extra,
      };
    case "corrupt-recovered":
      return {
        check: "store",
        status: "errors",
        detail: `ERRORS — the store was corrupt and was quarantined + recreated${
          info.detail ? `: ${info.detail}` : ""
        }`,
        ...extra,
      };
    case "unavailable":
      return {
        check: "store",
        status: "skipped",
        detail: "SKIPPED — node:sqlite unavailable on this Node build; store disabled",
        ...extra,
      };
  }
}

async function lagCheck(store: StoreModule | null): Promise<CheckResult> {
  if (!store) {
    return { check: "lag", status: "skipped", detail: NO_STORE_DETAIL };
  }
  let info: StoreInfo;
  try {
    info = store.getStoreInfo();
  } catch (error) {
    return {
      check: "lag",
      status: "skipped",
      detail: `SKIPPED — store probe failed: ${messageOf(error)}`,
    };
  }
  if (info.status === "missing" || info.status === "unavailable") {
    return { check: "lag", status: "skipped", detail: "SKIPPED — no store to measure" };
  }
  if (!info.newestCreatedAt) {
    return {
      check: "lag",
      status: "nothing-found",
      detail: "NOTHING FOUND — no stored requests yet",
    };
  }
  return {
    check: "lag",
    status: "ok",
    detail: `OK (newest stored request ${relativeTime(info.newestCreatedAt)})`,
    newestCreatedAt: info.newestCreatedAt,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
