import { classifySource, probeIdentity, sourceLabel, storageLabel } from "../auth/identity.js";
import { bool, parse, str } from "../cli/args.js";
import { CliError, NotLoggedInError } from "../cli/errors.js";
import { fields, json, out, style } from "../cli/output.js";
import { CREDENTIAL_ORIGIN, maskKey } from "../config.js";
import { SECOND_MS } from "../time.js";

export const help = `${style.bold("aiand whoami")} -- show the signed-in identity

Usage
  aiand whoami [options]

Options
  --json              machine-readable output
  --local             read the cached identity without calling the API
  --profile <name>    inspect a specific profile`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, { local: { type: "boolean", default: false } });
  if (bool(parsed, "help")) return out(help);

  if (parsed.positionals.length > 0) {
    throw new CliError(`Unknown argument "${parsed.positionals[0]}".`, {
      hint: "Run `aiand whoami --help` to see the subcommands and flags.",
    });
  }

  const { profile, session, user, org, orgs, cached, reachable, probeError } = await probeIdentity(
    str(parsed, "profile"),
    bool(parsed, "local"),
  );

  if (!reachable) {
    // Foreground identity check: failing loudly is correct. The key is
    // unverified, not absent — rethrow the gateway error rather than
    // printing cached data as if it were verified.
    throw probeError ?? new NotLoggedInError();
  }

  if (!session) {
    // whoami requires a session; probeIdentity swallows NotLoggedInError and
    // returns null. Surface the same exit the key path uses.
    throw new NotLoggedInError();
  }

  const expiresAt =
    session.credential && cached?.expires_at ? new Date(cached.expires_at * SECOND_MS) : null;
  const storage = session.credential ? (cached?.storage ?? null) : null;
  // A pasted key is saved without an expiry; only the env key has no credential at all.
  const expires = expiresAt
    ? `${expiresAt.toISOString().slice(0, 10)} ${style.dim("(rotated automatically)")}`
    : style.dim(
        !session.credential
          ? "from AIAND_API_KEY"
          : session.credential.origin === CREDENTIAL_ORIGIN.PASTE
            ? "never (pasted key)"
            : "unknown",
      );

  if (bool(parsed, "json")) {
    return json({
      profile: profile.name,
      api_url: profile.apiUrl,
      auth_url: profile.authUrl,
      user,
      org,
      organizations: orgs,
      key: maskKey(session.token),
      key_expires_at: expiresAt?.toISOString() ?? null,
      source: classifySource(session.credential),
      storage,
    });
  }
  fields([
    ["email", user?.email || style.dim("unknown")],
    ["user id", user?.id ?? style.dim("unknown")],
    ["org", org ? `${org.name} ${style.dim(`(${org.id})`)}` : style.dim("none")],
    ["profile", profile.name],
    ["api", style.dim(profile.apiUrl)],
    ["key", style.dim(maskKey(session.token))],
    ["source", style.dim(sourceLabel(session.credential))],
    ["storage", style.dim(storageLabel(storage))],
    ["expires", expires],
  ]);
}
