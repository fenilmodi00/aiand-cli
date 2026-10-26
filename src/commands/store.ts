import { openSession } from "../api/client.js";
import { bool, parse } from "../cli/args.js";
import { err, json, out, relativeTime, style } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { getStoreInfo, noSyncRequested, type StoreInfo, syncStore } from "../store/index.js";

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

Options
  --no-sync              skip the network sync and show local state only
                         (also AIAND_NO_SYNC=1)
  --json                 machine-readable output

The store keeps long-term, metadata-only request history (the gateway serves
only the last 30 days). Observability commands sync it automatically; a sync
failure never fails a command — it warns and serves local data.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const wantsSync = parsed.positionals[0] === "sync";
  const skipSync = bool(parsed, "no-sync") || noSyncRequested();

  if (!wantsSync || skipSync) {
    const info = getStoreInfo();
    if (bool(parsed, "json")) return json(info);
    printInfo(info);
    return;
  }

  const before = getStoreInfo();
  warnStatus(before);
  const session = await openSession(resolveProfile());
  const result = await syncStore(session);
  const info = getStoreInfo();

  if (result.ok) {
    // #85: a stuck cursor can still end ok with a partial ingest — never
    // fold that away silently, in either output mode.
    if (result.error) {
      err(
        style.yellow(
          `Warning: sync stopped early (stuck cursor) — history may be incomplete: ${result.error}`,
        ),
      );
    }
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
