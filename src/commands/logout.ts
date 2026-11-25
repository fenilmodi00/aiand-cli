import { logout as logoutFlow } from "../auth/logout.js";
import { logoutAll, WIPE_OUTSIDE_HOME_ENV } from "../auth/logout-all.js";
import { bool, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { out, style } from "../cli/output.js";
import { CONSOLE_KEYS_URL } from "../config.js";

export const help = `${style.bold("aiand logout")} -- end this machine's session

Usage
  aiand logout [options]
  aiand logout --all [--force] [--keep-remote]

Options
  --profile <name>    log out of this profile instead of the active one
  --keep-remote       forget the local credential without revoking the key
  --revoke            revoke the remote key without asking (device-minted keys)
  --all               hand the machine back: every profile, every agent, all
                      local aiand data (see below)
  --force             with --all, skip the confirmation (required off a terminal)

Keys this CLI minted via device login are revoked by posting the refresh
token to /auth/device/logout (you are asked first when attached to a
terminal). If that fails, you stay signed in so you can retry. This CLI then
strips the baked key from active agent configs on this machine. Whether the
minted sk- stays valid on the gateway after that is the server's contract --
run aiand <agent> off if a key is still on disk. Keys you pasted in are only
removed locally -- this CLI never revokes a key it did not mint; revoke them
at ${CONSOLE_KEYS_URL}.

--all revokes every minted key (best-effort, one profile at a time), removes
ai& from every agent whichever profile wired it, deletes leftover session
overlays in the temp dir, every stored secret (keychain included), and the
config directory with its snapshots. The config directory must be inside
your home directory unless ${WIPE_OUTSIDE_HOME_ENV}=1. Exits 1 if anything
was left behind, after listing it.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    "keep-remote": { type: "boolean", default: false },
    revoke: { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  if (parsed.positionals.length > 0) {
    throw new CliError(`Unknown argument "${parsed.positionals[0]}".`, {
      hint: "Run `aiand logout --help` to see the subcommands and flags.",
    });
  }
  if (bool(parsed, "all")) {
    if (str(parsed, "profile") !== undefined) {
      throw new CliError("--all covers every profile; drop --profile.", {
        hint: "Run `aiand logout --profile <name>` to sign out of one profile only.",
      });
    }
    if (bool(parsed, "revoke") && bool(parsed, "keep-remote")) {
      throw new CliError("--revoke and --keep-remote contradict each other.");
    }
    return logoutAll({
      force: bool(parsed, "force"),
      keepRemote: bool(parsed, "keep-remote"),
      json: bool(parsed, "json"),
    });
  }
  if (bool(parsed, "force")) {
    throw new CliError("--force only applies to logout --all.");
  }

  await logoutFlow({
    profile: str(parsed, "profile"),
    revoke: bool(parsed, "revoke"),
    keepRemote: bool(parsed, "keep-remote"),
    json: bool(parsed, "json"),
  });
}
