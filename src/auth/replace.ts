import { wiringCheckFor } from "../agents/registry.js";
import { scrubSnapshotKeys } from "../agents/snapshot.js";
import { revokeTokens } from "../api/device.js";
import { err, safeLine, style } from "../cli/output.js";
import { redactSecrets } from "../cli/redact.js";
import {
  CONSOLE_KEYS_URL,
  CREDENTIAL_ORIGIN,
  type CredentialBinding,
  issuerBinding,
  type LoadedCredential,
  loadCredential,
  redactUrl,
} from "../config.js";

/** What a login replacing `previous` needs to retire it afterwards. The
 * issuer is read before the login runs: a login can rewrite config.json,
 * which is where an unbound sign-in takes its issuer from. */
export type ReplacedSignIn = {
  profile: string;
  previous: LoadedCredential;
  binding: CredentialBinding | null;
};

export async function noteReplacedSignIn(
  profile: string,
  previous: LoadedCredential,
): Promise<ReplacedSignIn> {
  const minted = previous.origin !== CREDENTIAL_ORIGIN.PASTE && Boolean(previous.refresh_token);
  return {
    profile,
    previous,
    binding: minted ? await issuerBinding(profile, previous) : null,
  };
}

export type RetireOutcome =
  | "revoked"
  | "kept"
  | "failed"
  | "pasted"
  | "unrevocable"
  | "unchanged"
  | "unconfirmed";

/**
 * Revoke the key a login just replaced. Runs only after the new sign-in is
 * stored, so a failed or cancelled login never costs the old one. A failure
 * here is a warning, not an error: the new sign-in is already in place, and
 * the old refresh token is gone from disk, so the console is the way left.
 * Everything goes to stderr, so `--json` stdout stays one JSON document.
 */
export async function retireReplacedSignIn(
  replaced: ReplacedSignIn,
  opts: { keepRemote?: boolean } = {},
): Promise<RetireOutcome> {
  const { profile, previous, binding } = replaced;
  const stillValid = `The key "${profile}" signed in with before is still valid. Revoke it at ${CONSOLE_KEYS_URL} if you no longer need it.`;
  let current: LoadedCredential | null;
  try {
    current = await loadCredential(profile);
  } catch (error) {
    // Without the stored sign-in there is no telling which key is current, so nothing is revoked.
    err(
      style.yellow(
        `Could not read the stored sign-in for "${profile}", so the replaced key was not revoked: ${redactSecrets(safeLine((error as Error).message ?? String(error)))}`,
      ),
    );
    err(style.dim(stillValid));
    return "unconfirmed";
  }
  if (!current || current.access_token === previous.access_token) return "unchanged";

  // A copy of the old key in a pre-0.8 snapshot would outlive the sign-in,
  // revoked or not. Best-effort, like logout's scrub.
  try {
    await scrubSnapshotKeys([previous.access_token], wiringCheckFor);
  } catch (error) {
    err(
      style.dim(
        `Could not scrub snapshot copies of the replaced key: ${redactSecrets(safeLine((error as Error).message ?? String(error)))}`,
      ),
    );
  }

  if (previous.origin === CREDENTIAL_ORIGIN.PASTE) {
    err(style.dim(`The replaced key was pasted, so this CLI did not revoke it. ${stillValid}`));
    return "pasted";
  }
  if (opts.keepRemote) {
    err(style.dim(`--keep-remote: the replaced key was not revoked. ${stillValid}`));
    return "kept";
  }
  const refreshToken = previous.refresh_token;
  if (!refreshToken) {
    err(
      style.dim(
        `No refresh token was stored for the replaced key, so it could not be revoked. ${stillValid}`,
      ),
    );
    return "unrevocable";
  }
  if (!binding) {
    err(
      style.yellow(
        "The replaced sign-in did not record where it was issued, and this directory's config.json can't be trusted to say where, so its key was not revoked.",
      ),
    );
    err(style.dim(stillValid));
    return "unrevocable";
  }

  const result = await revokeTokens(binding.auth_url, refreshToken);
  if (result.revoked) {
    err(style.dim("Revoked the key this profile signed in with before."));
    return "revoked";
  }
  const cause =
    result.status === undefined
      ? "the request did not reach it"
      : `it answered HTTP ${result.status}`;
  err(
    style.yellow(
      `Could not revoke the replaced key at ${safeLine(redactUrl(binding.auth_url))}: ${cause}.`,
    ),
  );
  err(style.dim(stillValid));
  return "failed";
}
