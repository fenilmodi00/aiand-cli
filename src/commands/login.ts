import { parse, bool, str } from "../cli/args.js";
import { out, err, style } from "../cli/output.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { CliError } from "../cli/errors.js";
import { loadCredential, resolveProfile } from "../config.js";
import { deviceLogin, pasteLogin } from "../auth/flow.js";

export const help = `${style.bold("aiand login")} -- sign in with a browser approval, or store a key you already have

Usage
  aiand login [options]

Options
  --base-url <url>    point at a different API endpoint
  --profile <name>    store the session under this profile
  --no-browser        print the URL instead of opening it
  --force             sign in again even if this profile already has a session
  --paste             paste an existing ai& API key (masked input)
  --api-key <sk-...>  store a key passed on the command line
  --with-token        read the key from stdin (aiand login --with-token < key.txt)

The default path mints an org-scoped API key via a browser approval. Paste paths
validate the key against the API first; a pasted key is never rotated or revoked
by this CLI.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    "no-browser": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    paste: { type: "boolean", default: false },
    "api-key": { type: "string" },
    "with-token": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const pasteMode = bool(parsed, "paste") || str(parsed, "api-key") !== undefined || bool(parsed, "with-token");
  const profile = resolveProfile(str(parsed, "profile"));

  if (!bool(parsed, "force") && (await loadCredential(profile.name))) {
    if (isInteractive()) {
      const existing = await loadCredential(profile.name);
      const email = existing?.user?.email ?? "unknown";
      const again = await confirm(`Profile ${profile.name} is already signed in as ${email}. Sign in again?`, {
        default: false,
      });
      if (!again) {
        out("Keeping the existing session.");
        return;
      }
    } else {
      throw new CliError(`Profile "${profile.name}" is already signed in.`, {
        hint: "Run `aiand whoami` to see who, or `aiand login --force` to replace it.",
      });
    }
  }

  if (process.env.AIAND_API_KEY) {
    err(style.yellow("AIAND_API_KEY is set; it takes precedence over the stored session until unset."));
  }

  if (pasteMode) {
    return pasteLogin({
      profile: profile.name,
      key: str(parsed, "api-key"),
      fromStdin: bool(parsed, "with-token"),
      interactive: bool(parsed, "paste"),
      json: bool(parsed, "json"),
    });
  }

  return deviceLogin({
    profile: profile.name,
    noBrowser: bool(parsed, "no-browser"),
    json: bool(parsed, "json"),
  });
}