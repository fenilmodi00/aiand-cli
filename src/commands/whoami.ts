import { parse, bool, str } from "../cli/args.js";
import { fields, json, out, style } from "../cli/output.js";
import { NotLoggedInError } from "../cli/errors.js";
import { maskKey } from "../config.js";
import { probeIdentity, classifySource, sourceLabel, storageLabel } from "../auth/flow.js";

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

  const { profile, session, user, org, orgs, cached } = await probeIdentity(
    str(parsed, "profile"),
    bool(parsed, "local")
  );

  if (!session) {
    // whoami requires a session; probeIdentity swallows NotLoggedInError and
    // returns null. Surface the same exit the key path uses.
    throw new NotLoggedInError();
  }

  const expiresAt = cached?.expires_at ? new Date(cached.expires_at * 1000) : null;

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
      source: classifySource(session.credential?.origin),
      storage: session.credential ? cached?.storage ?? null : null,
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
    ["storage", style.dim(storageLabel(session.credential ? cached?.storage ?? null : null))],
    [
      "expires",
      expiresAt
        ? `${expiresAt.toISOString().slice(0, 10)} ${style.dim("(rotated automatically)")}`
        : style.dim("from AIAND_API_KEY"),
    ],
  ]);
}