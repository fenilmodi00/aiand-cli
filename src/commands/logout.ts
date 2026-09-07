import { parse, bool, str } from "../cli/args.js";
import { out, style } from "../cli/output.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { CliError } from "../cli/errors.js";
import { clearCredential, loadCredential, resolveProfile } from "../config.js";
import { revokeTokens } from "../api/device.js";

export const help = `${style.bold("aiand logout")} -- end this machine's session

Usage
  aiand logout [options]

Options
  --profile <name>    log out of this profile instead of the active one
  --keep-remote       forget the local credential without revoking the key
  --revoke            revoke the remote key without asking (device-minted keys)

Keys this CLI minted via device login are revoked server-side (you are asked
first when attached to a terminal). Keys you pasted in are only removed
locally -- this CLI never revokes a key it did not mint.`;

// Test seam: swap the revoke call so non-TTY tests can spy on it without
// network access.
let revoke: (authUrl: string, token: string) => Promise<boolean> = revokeTokens;

export function __setRevokeForTests(fn: ((authUrl: string, token: string) => Promise<boolean>) | null): void {
  revoke = fn ?? revokeTokens;
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    "keep-remote": { type: "boolean", default: false },
    revoke: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const profile = resolveProfile(str(parsed, "profile"));
  const credential = await loadCredential(profile.name);

  if (!credential) {
    if (process.env.AIAND_API_KEY) {
      out(style.dim(`Profile "${profile.name}" was not signed in. The AIAND_API_KEY environment variable still applies until it is unset.`));
      return;
    }
    out(style.dim(`Profile "${profile.name}" was not signed in.`));
    return;
  }

  const pasted = credential.origin === "paste";
  if (pasted && bool(parsed, "revoke")) {
    throw new CliError(
      "This key was pasted, not minted by this CLI; refusing to revoke it.",
      { hint: "Revoke it in the console if you no longer need it." }
    );
  }

  let revoked = false;
  let keepRemote = bool(parsed, "keep-remote");

  if (pasted) {
    // A shared console key: never revoked on the user's behalf.
    keepRemote = true;
  } else if (!keepRemote) {
    if (bool(parsed, "revoke")) {
      revoked = await revoke(profile.authUrl, credential.refresh_token ?? credential.access_token);
    } else if (isInteractive()) {
      const yes = await confirm("Revoke the ai& key this machine minted?", { default: true });
      if (yes) {
        revoked = await revoke(profile.authUrl, credential.refresh_token ?? credential.access_token);
      } else {
        keepRemote = true;
      }
    } else {
      // Non-TTY keeps today's default: revoke.
      revoked = await revoke(profile.authUrl, credential.refresh_token ?? credential.access_token);
    }
  }

  await clearCredential(profile.name);

  if (bool(parsed, "json")) {
    return out(JSON.stringify({ profile: profile.name, revoked, source: pasted ? "pasted-key" : "device-login" }, null, 2));
  }

  out(style.green(`Signed out of "${profile.name}".`));
  if (pasted) {
    out(style.dim("The pasted key was removed locally; it is still valid in the console."));
  } else if (!revoked && !keepRemote) {
    out(
      style.dim(
        "The server could not be reached, so the key was only removed locally. Revoke it in the console if this machine is untrusted."
      )
    );
  }
}
