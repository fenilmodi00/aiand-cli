import { parse, bool, str } from "../cli/args.js";
import { out, style } from "../cli/output.js";
import { logout as logoutFlow } from "../auth/flow.js";

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

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    "keep-remote": { type: "boolean", default: false },
    revoke: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  await logoutFlow({
    profile: str(parsed, "profile"),
    revoke: bool(parsed, "revoke"),
    keepRemote: bool(parsed, "keep-remote"),
    json: bool(parsed, "json"),
  });
}