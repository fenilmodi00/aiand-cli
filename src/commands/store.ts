import { openSession } from "../api/client.js";
import { bool, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, json, out, relativeTime, style } from "../cli/output.js";
import { confirm } from "../cli/prompt.js";
import { resolveProfile } from "../config.js";
import {
  getStoreInfo,
  noSyncRequested,
  resetStore,
  type StoreInfo,
  syncStore,
} from "../store/index.js";

/**
 * Minimal store surface for this ticket: status inspection and the manual
 * sync. Reporting commands (usage/cache/harness) consume the store through
 * the auto-sync-before-command wiring that later tickets add; every one of
 * them parses `--no-sync` and honors `AIAND_NO_SYNC=1` (see
 * noSyncRequested) to read local data without touching the network.
 */

export const help = `${style.bold("aiand store")} -- local request store

Usage
  aiand store            show the store's status
  aiand store sync       pull new gateway rows into the store
  aiand store reset      clear request/session rows; the next sync re-pulls
                         everything (self-heal; keeps schema + import ledger)

Options
  --no-sync              skip the network sync and show local state only
                         (also AIAND_NO_SYNC=1)
  --force                skip the reset confirmation (scripts)
  --json                 machine-readable output

The store keeps long-term, metadata-only request history (the gateway serves
only the last 30 days). Observability commands sync it automatically; a sync
failure never fails a command — it warns and serves local data.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    "no-sync": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  // #103: resolve up front so `store status` (no network) also warns on an
  // unknown --profile instead of silently serving default-profile state.
  resolveProfile(str(parsed, "profile")); // #103

  const wantsSync = parsed.positionals[0] === "sync";
  const skipSync = bool(parsed, "no-sync") || noSyncRequested();

  if (parsed.positionals[0] === "reset")
    return runReset(bool(parsed, "force"), bool(parsed, "json"));

  if (!wantsSync || skipSync) {
    const info = getStoreInfo();
    if (bool(parsed, "json")) return json(info);
    printInfo(info);
    return;
  }

  const before = getStoreInfo();
  warnStatus(before);
  const session = await openSession(resolveProfile(str(parsed, "profile"))); // #103
  const result = await syncStore(session);
  const info = getStoreInfo();

  if (result.ok) {
    if (bool(parsed, "json")) return json({ result, store: info });
    const noun = `request${result.inserted === 1 ? "" : "s"}`;
    out(
      style.green(
        `Synced ${result.pages} page${result.pages === 1 ? "" : "s"}: ` +
          `${result.inserted} new ${noun} stored (${info.rows} total).`,
      ),
    );
  } else {
    // Visible on stderr in both output modes: a stale store must never be
    // silently folded away.
    err(style.yellow(`Warning: sync failed (${result.error}).`));
    err(style.dim("Serving local data; it may be stale."));
    if (bool(parsed, "json")) return json({ result, store: info });
  }
  printInfo(info);
}

/**
 * #95 (OBS-BF-10) — Destructive self-heal: clears request/session data rows,
 * keeps schema + migrations + the ccusage import dedupe ledger + locally
 * captured envelopes. Confirms on a
 * TTY unless --force; a decline exits 0 with the store untouched.
 */
async function runReset(force: boolean, jsonOut: boolean): Promise<void> {
  if (!force) {
    const ok = await confirm(
      "Reset the local request store? All synced request/session history is deleted " +
        "(locally captured envelopes are kept) and the next `aiand store sync` re-pulls everything.",
      { default: false },
    );
    if (!ok) {
      if (jsonOut) return json({ reset: false });
      out(style.dim("Cancelled — the store is unchanged."));
      return;
    }
  }
  const result = resetStore();
  if ("error" in result) {
    throw new CliError(`Store reset failed: ${result.error}`);
  }
  const { requests, sessions, envelopesKept, storeVersion, importedUsageKept } = result;
  if (jsonOut) return json({ reset: true, ...result });
  out(
    style.green(
      `Store reset: cleared ${requests} request${requests === 1 ? "" : "s"} and ` +
        `${sessions} session${sessions === 1 ? "" : "s"} ` +
        `(schema v${storeVersion}; ${importedUsageKept} imported-usage rows and ` +
        `${envelopesKept} locally captured envelope${envelopesKept === 1 ? "" : "s"} kept).`,
    ),
  );
  out(
    style.dim(
      "The next `aiand store sync` will be a full re-pull (the gateway serves the last 30 days).",
    ),
  );
}

function printInfo(info: StoreInfo): void {
  warnStatus(info);
  out(`${style.bold("Local request store")}: ${info.path}`);
  out(`  status:   ${info.status} (schema v${info.storeVersion})`);
  out(`  requests: ${info.rows}`);
  out(`  last sync: ${info.lastSyncAt ? relativeTime(info.lastSyncAt) : "never"}`);
  if (info.newestCreatedAt) out(`  newest request: ${relativeTime(info.newestCreatedAt)}`);
}

/** Loud, on stderr, so a degraded store is never silently folded away. */
function warnStatus(info: StoreInfo): void {
  if (info.status === "corrupt-recovered") {
    err(style.yellow(`Warning: ${info.detail ?? "the store was recovered from corruption."}`));
  } else if (info.status === "unavailable") {
    err(style.yellow(`Warning: ${info.detail ?? "the request store is unavailable."}`));
  }
}
