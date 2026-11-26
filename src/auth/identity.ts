import { type AccountOrg, type AccountUser, getUser, listOrgs } from "../api/account.js";
import { envApiKey, openSession, type Session } from "../api/client.js";
import { ApiError, NotBoundError, NotLoggedInError, SYNTHETIC_STATUS } from "../cli/errors.js";
import {
  CREDENTIAL_ORIGIN,
  type Credential,
  type LoadedCredential,
  loadCredential,
  maskKey,
  type ResolvedProfile,
  resolveProfile,
} from "../config.js";

/** Where the active key came from, as status, whoami, login, and logout report it. */
export const CREDENTIAL_SOURCE = {
  DEVICE: "device-login",
  PASTED: "pasted-key",
  ENV: "AIAND_API_KEY",
} as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCE)[keyof typeof CREDENTIAL_SOURCE];

/** The key-source string status and whoami both emit. `null` is the env key;
 * a stored credential with no origin predates origin tracking (0.1.x) and was
 * device-minted. */
export function classifySource(
  credential: Pick<Credential, "origin"> | null | undefined,
): CredentialSource {
  if (!credential) return CREDENTIAL_SOURCE.ENV;
  return credential.origin === CREDENTIAL_ORIGIN.PASTE
    ? CREDENTIAL_SOURCE.PASTED
    : CREDENTIAL_SOURCE.DEVICE;
}

const SOURCE_LABELS: Record<CredentialSource, string> = {
  [CREDENTIAL_SOURCE.DEVICE]: "device login",
  [CREDENTIAL_SOURCE.PASTED]: "pasted key",
  [CREDENTIAL_SOURCE.ENV]: "AIAND_API_KEY",
};

/** Human label for classifySource, so text and --json output always agree. */
export function sourceLabel(credential: Pick<Credential, "origin"> | null | undefined): string {
  return SOURCE_LABELS[classifySource(credential)];
}

/**
 * The file tier's label. Its key normally sits beside the ciphertext, so it
 * is worth an owner-only file and no more; with AIAND_SECRET_STORE_MASTER_KEY
 * the key is held elsewhere and the file really is encrypted at rest. On
 * Windows an icacls failure leaves the inherited ACL, so it is not owner-only.
 */
function fileTierLabel(ownerOnly: boolean): string {
  if (process.env.AIAND_SECRET_STORE_MASTER_KEY) {
    return ownerOnly
      ? "file (encrypted; key held outside the config folder)"
      : "file (encrypted; key held outside the config folder; not owner-only)";
  }
  return ownerOnly
    ? "file (owner-only, not encrypted at rest)"
    : "file (not owner-only, not encrypted at rest)";
}

/** `credential` is what credentials.json records; omit it for a secret just stored with its ACLs intact. */
export function storageLabel(
  storage: string | null,
  credential?: Pick<Credential, "owner_only"> | null,
): string {
  switch (storage) {
    case "keychain":
      return "keychain";
    case "dpapi":
      return "Windows DPAPI";
    case "file":
      return fileTierLabel(credential?.owner_only !== false);
    case "plaintext":
      return "plaintext file";
    default:
      return "from AIAND_API_KEY";
  }
}

export type Identity = {
  profile: ResolvedProfile;
  session: Session | null;
  user: AccountUser | null;
  org: AccountOrg | null;
  orgs: AccountOrg[];
  cached: LoadedCredential | null;
  /** False when the gateway could not verify the key (connection refused,
   * 5xx). whoami rethrows probeError; status reports the outage as its own
   * state instead of throwing, so scripts never mistake it for signed-out. */
  reachable: boolean;
  /** The gateway failure behind reachable=false; null when reachable. */
  probeError: ApiError | null;
  /** The refusal when the stored sign-in is for another endpoint and the
   * caller asked to absorb it (`absorbNotBound`); session stays null. */
  notBound: NotBoundError | null;
};

/** The sign-in probe shared by status and whoami. Signed out returns
 * `session: null`; a gateway failure (connection refused, 5xx) returns
 * `reachable: false` with the error in `probeError`. Anything else (a
 * rejected key, corrupt local state, Ctrl-C) throws. A sign-in bound to
 * another endpoint throws NotBoundError too, unless `absorbNotBound` returns it
 * as `notBound` so status can say so. */
export async function probeIdentity(
  profileOverride?: string,
  local = false,
  { absorbNotBound = false }: { absorbNotBound?: boolean } = {},
): Promise<Identity> {
  const profile = resolveProfile(profileOverride);
  let session: Session | null = null;
  let user: AccountUser | null = null;
  let org: AccountOrg | null = null;
  let orgs: AccountOrg[] = [];
  let cached: LoadedCredential | null = null;
  let reachable = true;
  let probeError: ApiError | null = null;
  let notBound: NotBoundError | null = null;

  try {
    if (local) {
      // Cached-only: never touch the network. openSession rotates device
      // tokens near expiry, so build the session straight from the stored
      // credential instead of opening one.
      const fromEnv = envApiKey();
      if (fromEnv) {
        // The cached identity belongs to the stored credential, not the env
        // key, so it would name the wrong account here.
        session = { profile, token: fromEnv, credential: null };
      } else {
        cached = await loadCredential(profile.name);
        if (!cached) throw new NotLoggedInError();
        session = { profile, token: cached.access_token, credential: cached };
        user = cached.user ?? null;
        org = cached.org ?? null;
        orgs = cached.org ? [cached.org] : [];
      }
    } else {
      session = await openSession(profile);
      // An AIAND_API_KEY session has no credential; the stored login's
      // identity would name the wrong org for it (as in the local branch).
      cached = session.credential ? await loadCredential(profile.name) : null;
      [orgs, user] = await Promise.all([listOrgs(session), getUser(session)]);
      const cachedOrg = cached?.org;
      org = cachedOrg && orgs.some((o) => o.id === cachedOrg.id) ? cachedOrg : (orgs[0] ?? null);
    }
  } catch (error) {
    if (error instanceof NotLoggedInError) {
      // Signed out: fall through with session null; reachable stays true.
    } else if (
      error instanceof ApiError &&
      (error.status === SYNTHETIC_STATUS.UNREACHABLE || error.status >= 500)
    ) {
      // Gateway unreachable or erroring: report it, don't throw, so status
      // can name the outage without failing scripts that gate on it.
      reachable = false;
      probeError = error;
    } else if (absorbNotBound && error instanceof NotBoundError) {
      notBound = error;
    } else {
      throw error;
    }
  }

  return { profile, session, user, org, orgs, cached, reachable, probeError, notBound };
}

/** The auth half of status --json: identity, masked key, key source, and the
 * storage tier holding the secret. Three states, kept distinct so scripts
 * can gate without false-failing during an outage: verified (signed_in and
 * reachable), signed_out (!signed_in, reachable), unreachable (!reachable —
 * the key could not be verified, not proven absent). */
export type AuthStatus = {
  signed_in: boolean;
  /** False when the gateway could not be reached to verify the key. status
   * prints its own outage line and exits 0; whoami rethrows instead. */
  reachable: boolean;
  profile: string;
  email: string | null;
  org: string | null;
  key: string | null;
  source: CredentialSource | null;
  /** Human label of the tier holding the key. */
  storage: string | null;
  /** Stable machine-readable tier id behind `storage`: keychain, dpapi, file,
   * or plaintext; null when signed out or the key came from AIAND_API_KEY. */
  storage_tier: string | null;
  /** One line on why a Windows key sits in the owner-only file, not DPAPI. */
  storage_notice: string | null;
  /** Why a stored sign-in is not in use: it was issued for another endpoint
   * than this run's. Null otherwise. */
  reason: string | null;
};

const STORAGE_NOTICES: Record<string, string> = {
  clm: "PowerShell's Constrained Language Mode blocks Windows DPAPI here, so the key is in the owner-only file instead.",
  unavailable:
    "Windows DPAPI could not be reached through PowerShell, so the key is in the owner-only file instead; aiand tries again in a few minutes.",
};

export type AuthStatusOptions = {
  profile?: string;
  local?: boolean;
};

/** The auth half of `aiand status`, built on the same probe as whoami. */
export async function authStatus(opts: AuthStatusOptions = {}): Promise<AuthStatus> {
  const { profile, session, user, org, cached, reachable, notBound } = await probeIdentity(
    opts.profile,
    opts.local,
    { absorbNotBound: true },
  );

  if (!reachable || !session) {
    return {
      signed_in: false,
      reachable,
      profile: profile.name,
      email: null,
      org: null,
      key: null,
      source: null,
      storage: null,
      storage_tier: null,
      storage_notice: null,
      reason: notBound?.message ?? null,
    };
  }

  const credential = session.credential;
  const storage = credential ? (cached?.storage ?? null) : null;
  return {
    signed_in: true,
    reachable,
    profile: profile.name,
    email: user?.email ?? cached?.user?.email ?? null,
    org: org?.name ?? cached?.org?.name ?? null,
    key: maskKey(session.token),
    source: classifySource(credential),
    storage: storage !== null ? storageLabel(storage, cached) : null,
    storage_tier: storage,
    storage_notice:
      storage === "file" && cached?.storage_fallback
        ? (STORAGE_NOTICES[cached.storage_fallback] ?? null)
        : null,
    reason: null,
  };
}
