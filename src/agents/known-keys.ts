import { createHash } from "node:crypto";

import { loadAllCredentials, loadCredential } from "../config.js";

/**
 * Every ai& key this machine knows: the session key, `AIAND_API_KEY`, and
 * each stored profile's. A snapshot must never copy a file holding any of
 * them, and `off` strips a key from a block the user repointed only when it
 * is one of them. An unreadable store narrows the list rather than blocking.
 */
export async function knownKeys(sessionKey?: string): Promise<string[]> {
  const keys: string[] = [];
  if (sessionKey) keys.push(sessionKey);
  const env = process.env.AIAND_API_KEY;
  if (env) keys.push(env);
  try {
    for (const name of Object.keys(await loadAllCredentials())) {
      const credential = await loadCredential(name).catch(() => null);
      if (credential?.access_token) keys.push(credential.access_token);
    }
  } catch {
    // What is already collected still guards the common case.
  }
  return keys;
}

/**
 * What `on` records of the key it wrote: a hash, never the key, so the
 * record stays free of secrets while `off` can still recognise a key that
 * has since left the credential store (a rotated or logged-out one).
 */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Whether `candidate` is a key ai& put there: a known key, or the one `on` recorded. */
export function isAiandKey(
  candidate: unknown,
  known: readonly string[],
  wroteFingerprint?: string,
): boolean {
  if (typeof candidate !== "string" || candidate === "") return false;
  if (known.includes(candidate)) return true;
  return wroteFingerprint !== undefined && keyFingerprint(candidate) === wroteFingerprint;
}
