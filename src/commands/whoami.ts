import { parse, bool, str } from "../cli/args.js";
import { fields, json, out, style } from "../cli/output.js";
import { loadCredential, maskKey, resolveProfile } from "../config.js";
import { openSession } from "../api/client.js";
import { getUser, listOrgs } from "../api/account.js";

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

  const profile = resolveProfile(str(parsed, "profile"));
  const session = await openSession(profile);
  const cached = await loadCredential(profile.name);

  const [user, orgs] = bool(parsed, "local")
    ? [cached?.user ?? null, cached?.org ? [cached.org] : []]
    : await Promise.all([getUser(session), listOrgs(session)]);

  const org = orgs[0] ?? null;
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
      source: session.credential ? (session.credential.origin === "paste" ? "pasted-key" : "device-login") : "AIAND_API_KEY",
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

function sourceLabel(credential: { origin?: "device" | "paste" } | null): string {
  if (!credential) return "AIAND_API_KEY";
  return credential.origin === "paste" ? "pasted key" : "device login";
}

function storageLabel(storage: string | null): string {
  switch (storage) {
    case "keychain":
      return "keychain";
    case "file":
      return "encrypted file";
    case "plaintext":
      return "plaintext file";
    default:
      return "from AIAND_API_KEY";
  }
}
