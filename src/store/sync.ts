import { openSession } from "../api/client.js";
import { resolveProfile } from "../config.js";
import type { SyncOutcome } from "./coverage.js";
import { noSyncRequested, syncStore } from "./index.js";

/**
 * Pre-read store sync shared by the fail-open report commands (#84 review).
 *
 * Contract (#87): `profileName` is validated by the caller BEFORE this runs,
 * so `--no-sync` and the fail-open path still reject bad profile names.
 * Never throws — a sign-in or network problem degrades to a local read.
 */
export async function runPreReadSync(
  profileName: string | undefined,
  skipSync: boolean,
): Promise<SyncOutcome> {
  if (skipSync || noSyncRequested()) return { skipped: true };
  try {
    const session = await openSession(resolveProfile(profileName));
    const result = await syncStore(session);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
