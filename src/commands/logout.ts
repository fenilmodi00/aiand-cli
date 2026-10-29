import { logout as logoutFlow } from "../auth/logout.js";
import { bool, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { out, style } from "../cli/output.js";

export const help = `${style.bold("aiand logout")} -- end this machine's session

Usage
  aiand logout [options]

Options
  --profile <name>    log out of this profile instead of the active one
  --keep-remote       forget the local credential without revoking the key
  --revoke            revoke the remote key without asking (device-minted keys)

Keys this CLI minted via device login are revoked by posting the refresh
token to /auth/device/logout (you are asked first when attached to a
terminal). This CLI then strips the baked key from active agent configs on
this machine. Whether the minted sk- stays valid on the gateway after that
is the server's contract -- run aiand <agent> off if a key is still on disk.
Keys you pasted in are only removed locally -- this CLI never revokes a key
it did not mint.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    "keep-remote": { type: "boolean", default: false },
    revoke: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  if (parsed.positionals.length > 0) {
    throw new CliError(`Unknown argument "${parsed.positionals[0]}".`, {
      hint: "Run `aiand logout --help` to see the subcommands and flags.",
    });
  }

  await logoutFlow({
    profile: str(parsed, "profile"),
    revoke: bool(parsed, "revoke"),
    keepRemote: bool(parsed, "keep-remote"),
    json: bool(parsed, "json"),
  });
}
