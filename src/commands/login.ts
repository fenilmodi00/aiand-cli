import { CREDENTIAL_SOURCE } from "../auth/identity.js";
import { browserLogin, deviceLogin, pasteLogin } from "../auth/login.js";
import { noteReplacedSignIn, type ReplacedSignIn, retireReplacedSignIn } from "../auth/replace.js";
import { bool, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { json, out, safeLine, style } from "../cli/output.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { loadCredential, resolveProfile } from "../config.js";

export const help = `${style.bold("aiand login")} -- sign in with a browser approval, or store a key you already have

Usage
  aiand login [options]

Options
  --base-url <url>    point at a different API endpoint
  --profile <name>    store the session under this profile
  --force             sign in again even if this profile already has a session
  --keep-remote       when replacing a session, keep its key valid on the server
  --paste             paste an existing ai& API key (masked input)
  --with-token        read the key from stdin (aiand login --with-token < key.txt)

The default path opens your browser and signs in. Over SSH, or when browser
sign-in is unavailable, it uses device login (approve a code in any browser);
if that also fails (service unreachable) an interactive terminal offers to
paste a key instead. Paste paths validate the key against the
API first; a pasted key is never rotated or revoked by this CLI.

Signing in again replaces the profile's session. Once the new sign-in is
stored, the key the old session minted is revoked where it was issued, as
\`aiand logout\` would. A sign-in that fails or is cancelled before the new
one is stored keeps the old session; a step that fails after that still
revokes the old key.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    force: { type: "boolean", default: false },
    "keep-remote": { type: "boolean", default: false },
    paste: { type: "boolean", default: false },
    "with-token": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  if (parsed.positionals.length > 0) {
    throw new CliError(`Unknown argument "${parsed.positionals[0]}".`, {
      hint: "Run `aiand login --help` to see the subcommands and flags.",
    });
  }

  const pasteMode = bool(parsed, "paste") || bool(parsed, "with-token");
  const profile = resolveProfile(str(parsed, "profile"));

  // CI mode: the environment key is the session — nothing stored, nothing done.
  // Whitespace-only reads as unset (same normalization as openSession).
  if (process.env.AIAND_API_KEY?.trim()) {
    if (bool(parsed, "json")) {
      return json({ profile: profile.name, source: CREDENTIAL_SOURCE.ENV });
    }
    out(style.yellow("AIAND_API_KEY is set — using it as the session. Nothing stored."));
    return;
  }

  const existing = await loadCredential(profile.name);
  if (!bool(parsed, "force") && existing) {
    if (isInteractive()) {
      const email = safeLine(existing.user?.email ?? "unknown");
      const again = await confirm(
        `Profile ${profile.name} is already signed in as ${email}. Sign in again and replace it?`,
        {
          default: false,
        },
      );
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

  const replaced: ReplacedSignIn | null = existing
    ? await noteReplacedSignIn(profile.name, existing)
    : null;

  // A step that fails after the new sign-in is stored must not skip retiring the old one.
  let failure: unknown;
  try {
    await signIn();
  } catch (error) {
    failure = error;
  }
  if (replaced) await retireReplacedSignIn(replaced, { keepRemote: bool(parsed, "keep-remote") });
  if (failure !== undefined) throw failure;

  async function signIn(): Promise<void> {
    if (pasteMode) {
      await pasteLogin({
        profile: profile.name,
        fromStdin: bool(parsed, "with-token"),
        interactive: bool(parsed, "paste"),
        json: bool(parsed, "json"),
      });
    } else if (isInteractive()) {
      await browserLogin({ profile: profile.name, json: bool(parsed, "json") });
    } else {
      await deviceLogin({ profile: profile.name, json: bool(parsed, "json") });
    }
  }
}
