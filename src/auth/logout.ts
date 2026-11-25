import { sweepOverlays } from "../agents/overlays.js";
import { AGENTS, wiringCheckFor } from "../agents/registry.js";
import { scrubSnapshotKeys } from "../agents/snapshot.js";
import { forgetWired } from "../agents/wired.js";
import { revokeTokens } from "../api/device.js";
import { CliError } from "../cli/errors.js";
import { err, out, safeLine, style } from "../cli/output.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { redactSecrets } from "../cli/redact.js";
import {
  CONSOLE_KEYS_URL,
  CREDENTIAL_ORIGIN,
  clearCredential,
  issuerBinding,
  loadConfig,
  loadCredential,
  redactUrl,
  resolveProfile,
  unprovenIssuer,
} from "../config.js";
import { classifySource } from "./identity.js";

export type LogoutOptions = {
  profile?: string;
  revoke?: boolean;
  keepRemote?: boolean;
  json?: boolean;
};

/** End this machine's session: clear the local credential and, for a
 * device-minted key, revoke it server-side (unless --keep-remote keeps it). */
export async function logout(opts: LogoutOptions = {}): Promise<void> {
  const profile = resolveProfile(opts.profile);
  const credential = await loadCredential(profile.name);

  if (!credential) {
    if (opts.json) {
      return out(
        JSON.stringify(
          {
            profile: profile.name,
            revoked: false,
            signed_in: false,
            ...(process.env.AIAND_API_KEY?.trim()
              ? { note: "AIAND_API_KEY still applies until unset" }
              : {}),
          },
          null,
          2,
        ),
      );
    }
    if (process.env.AIAND_API_KEY?.trim()) {
      out(
        style.dim(
          `Profile "${profile.name}" was not signed in. The AIAND_API_KEY environment variable still applies until it is unset.`,
        ),
      );
      return;
    }
    out(style.dim(`Profile "${profile.name}" was not signed in.`));
    return;
  }

  const pasted = credential.origin === CREDENTIAL_ORIGIN.PASTE;
  if (pasted && opts.revoke) {
    throw new CliError("This key was pasted, not minted by this CLI; refusing to revoke it.", {
      hint: "Revoke it in the console if you no longer need it.",
    });
  }

  let revoked = false;
  let keepRemote = opts.keepRemote ?? false;
  // Only a minted refresh token revokes server-side, and only via
  // {refresh_token} — the server contract sends exactly that. No refresh
  // token means nothing to revoke: the local clear below is the whole job.
  const revokeToken = credential.refresh_token;
  let attempt = false;
  if (pasted) {
    keepRemote = true;
  } else if (keepRemote || !revokeToken) {
    // keepRemote: caller said keep; no refresh token: local clear only.
  } else if (opts.revoke || !isInteractive()) {
    attempt = true;
  } else if (await confirm("Revoke the ai& key this machine minted?", { default: true })) {
    attempt = true;
  } else {
    keepRemote = true;
  }
  if (attempt && revokeToken) {
    const binding = await issuerBinding(profile.name, credential);
    if (!binding) {
      const { message, hint } = unprovenIssuer(
        profile.name,
        "its key was not revoked; you are still signed in",
      );
      throw new CliError(message, { hint });
    }
    const issuer = binding.auth_url;
    const result = await revokeTokens(issuer, revokeToken);
    revoked = result.revoked;
    if (!revoked) {
      // The refresh token is the only way this CLI can ever revoke the key:
      // deleting it now would leave a live key nobody here can revoke. Keep
      // the whole sign-in, untouched, for a retry.
      const cause =
        result.status === undefined
          ? "Check your connection"
          : `${safeLine(redactUrl(issuer))} answered HTTP ${result.status} to the sign-out request, so the key was not revoked. Check that this sign-in was issued there`;
      throw new CliError(
        `Could not revoke the key this machine minted for "${profile.name}"; you are still signed in.`,
        {
          hint: `${cause}, then run \`aiand logout\` again. To forget it here anyway, run \`aiand logout --keep-remote\` and revoke the key at ${CONSOLE_KEYS_URL}.`,
        },
      );
    }
  }

  // Strip aiand's writes from every agent before the credential goes, so no
  // baked key lingers. disable() checks the marker itself, so it runs even
  // when probe() reads inactive (a marked config with a bad baseURL still
  // holds our key). Teardown follows the stored active profile, which is
  // what the rebake baked; AIAND_PROFILE only targets commands. A strip
  // failure is a stderr hint, never fatal.
  if (profile.name === loadConfig().profile) {
    for (const adapter of AGENTS) {
      if (adapter.launcherOnly) continue;
      try {
        await adapter.disable({ loggingOut: profile.name });
        await forgetWired(adapter.id);
      } catch (error) {
        err(
          style.dim(
            `[${adapter.id}] Could not strip its key: ${redactSecrets(safeLine((error as Error).message ?? String(error)))} Re-run \`aiand ${adapter.id} off\`.`,
          ),
        );
      }
    }
  } else {
    // The strip above only covers the stored active profile; switching to a
    // signed-out profile can leave another profile's key baked on disk.
    err(
      style.dim(
        `Profile "${profile.name}" is not the active profile ("${loadConfig().profile}"); baked keys were left in place in agent configs. Switch to it and log out again to strip them.`,
      ),
    );
  }

  // A snapshot taken by an older aiand may have copied a file that already
  // held this key; the copy would outlive logout. Best-effort, like the strip.
  try {
    await scrubSnapshotKeys([credential.access_token], wiringCheckFor);
  } catch (error) {
    err(
      style.dim(
        `Could not scrub snapshot copies: ${redactSecrets(safeLine((error as Error).message ?? String(error)))}`,
      ),
    );
  }

  await clearCredential(profile.name);

  // A launcher session killed before its cleanup left its key in tmp.
  await sweepOverlays().catch(() => {});

  // openSession prefers the Env key over any stored Credential, so clearing
  // alone does not end the Session while AIAND_API_KEY is set — the same
  // warn the not-signed-in branch already prints. stderr, so --json stdout
  // stays parseable.
  if (process.env.AIAND_API_KEY?.trim()) {
    err(style.dim("The AIAND_API_KEY environment variable still applies until it is unset."));
  }

  if (opts.json) {
    return out(
      JSON.stringify(
        {
          profile: profile.name,
          revoked,
          source: classifySource(credential),
        },
        null,
        2,
      ),
    );
  }

  out(style.green(`Signed out of "${profile.name}".`));
  if (pasted) {
    out(
      style.dim(
        `The pasted key was removed locally; it is still valid. Revoke it at ${CONSOLE_KEYS_URL} if you no longer need it.`,
      ),
    );
  } else if (!revoked && !keepRemote) {
    out(
      style.dim(
        `No refresh token was stored, so the key was only removed locally. Revoke it at ${CONSOLE_KEYS_URL} if this machine is untrusted.`,
      ),
    );
  }
}
