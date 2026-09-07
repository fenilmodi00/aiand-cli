import { parse, bool, str } from "../cli/args.js";
import { err, fields, json, out, style } from "../cli/output.js";
import { NotLoggedInError } from "../cli/errors.js";
import { loadCredential, maskKey, resolveProfile } from "../config.js";
import { openSession, type Session } from "../api/client.js";
import { getUser, listOrgs, type AccountOrg, type AccountUser } from "../api/account.js";

export const help = `${style.bold("aiand status")} -- sign-in state at a glance

Usage
  aiand status [options]

Options
  --json              machine-readable output
  --local             read the cached identity without calling the API
  --profile <name>    inspect a specific profile

Shows who you are signed in as, where the active key comes from, and which
storage tier holds it. Agent wiring rows are added by \`aiand status\` once
agents are configured.`;

type AuthState = {
  signed_in: boolean;
  profile: string;
  email: string | null;
  org: string | null;
  key: string | null;
  source: "device-login" | "pasted-key" | "AIAND_API_KEY" | null;
  storage: string | null;
};

const STORAGE_LABELS: Record<string, string> = {
  keychain: "keychain",
  file: "encrypted file",
  plaintext: "plaintext file",
};

/**
 * The auth half of global status: identity, masked key, key source, and the
 * storage tier holding the secret. Falls back to the cached credential like
 * `whoami --local` when the API cannot be reached or `--local` is passed.
 */
export async function authStatusBlock(profileOverride?: string, useLocal = false): Promise<AuthState> {
  const profile = resolveProfile(profileOverride);
  let session: Session | null = null;
  let user: AccountUser | null = null;
  let org: AccountOrg | null = null;

  try {
    session = await openSession(profile);
    const cached = await loadCredential(profile.name);
    if (useLocal) {
      user = cached?.user ?? null;
      org = cached?.org ?? null;
    } else {
      [user, org] = await Promise.all([getUser(session), listOrgs(session).then((o) => o[0] ?? null)]);
    }
  } catch (error) {
    if (!(error instanceof NotLoggedInError)) throw error;
  }

  if (!session) {
    return {
      signed_in: false,
      profile: profile.name,
      email: null,
      org: null,
      key: null,
      source: null,
      storage: null,
    };
  }

  const cached = await loadCredential(profile.name);
  const source =
    session.credential
      ? session.credential.origin === "paste"
        ? "pasted-key"
        : "device-login"
      : "AIAND_API_KEY";
  const storage = session.credential ? cached?.storage ?? null : null;

  return {
    signed_in: true,
    profile: profile.name,
    email: user?.email ?? cached?.user?.email ?? null,
    org: org?.name ?? cached?.org?.name ?? null,
    key: maskKey(session.token),
    source,
    storage: storage ? STORAGE_LABELS[storage] ?? storage : null,
  };
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, { local: { type: "boolean", default: false } });
  if (bool(parsed, "help")) return out(help);

  const auth = await authStatusBlock(str(parsed, "profile"), bool(parsed, "local"));

  if (bool(parsed, "json")) {
    return json({ auth });
  }

  if (!auth.signed_in) {
    if (process.env.AIAND_API_KEY) {
      fields([
        ["profile", auth.profile],
        ["source", style.dim("AIAND_API_KEY")],
      ]);
      return;
    }
    out(style.yellow("Not signed in."));
    err(style.dim("Run `aiand login` first."));
    return;
  }

  fields([
    ["email", auth.email ?? style.dim("unknown")],
    ["org", auth.org ?? style.dim("none")],
    ["profile", auth.profile],
    ["key", style.dim(auth.key ?? "unknown")],
    ["source", style.dim(auth.source ?? "unknown")],
    ["storage", style.dim(auth.storage ?? "unknown")],
  ]);
}
