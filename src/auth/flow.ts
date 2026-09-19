import { hostname } from "node:os";
import { ApiError, CliError, NotLoggedInError } from "../cli/errors.js";
import { openSession, type Session } from "../api/client.js";
import {
  getUser,
  listOrgs,
  validateKey,
  type AccountOrg,
  type AccountUser,
} from "../api/account.js";
import {
  signInViaLocalhostCallback,
  type BrowserFlowResult,
} from "./browser.js";
import { readSecret, confirm, isInteractive } from "../cli/prompt.js";
import { readStdin } from "../cli/stdin.js";
import { openBrowser } from "../cli/browser.js";
import {
  promptSelect,
  type PromptInput,
  type PromptOutput,
} from "../cli/select.js";
import { link } from "../cli/links.js";
import { err, fields, out, spinner, style } from "../cli/output.js";
import {
  clearCredential,
  loadConfig,
  loadCredential,
  maskKey,
  resolveProfile,
  saveConfig,
  saveCredential,
  updateProfile,
  type Credential,
  type LoadedCredential,
  type ResolvedProfile,
} from "../config.js";
import { AGENTS } from "../agents/registry.js";
import { rebakeAgentKeys, type RebakeNote } from "../agents/rebake.js";
import {
  type DeviceCodeResponse,
  type TokenResponse,
  revokeTokens,
  startDeviceAuthorization,
  verificationUrl,
  pollForToken,
} from "../api/device.js";

function printRebakeNotes(notes: RebakeNote[]): void {
  for (const note of notes) {
    err(style.dim(`[${note.agent}] ${note.note}`));
  }
}

/** Promote a freshly-signed-in profile to the active one when it is not. */
async function activateProfile(name: string): Promise<void> {
  await updateProfile(name, {});
  if (loadConfig().profile !== name) {
    await saveConfig({ ...loadConfig(), profile: name });
  }
}
/** Map a credential's origin to the wire/source string both status and
 * whoami emit. Shared classification lives here so the two commands cannot
 * drift. */
export function classifySource(
  origin: Credential["origin"] | null | undefined,
): "device-login" | "pasted-key" | "AIAND_API_KEY" {
  if (origin === undefined || origin === null) return "AIAND_API_KEY";
  return origin === "paste" ? "pasted-key" : "device-login";
}

export function sourceLabel(
  credential: { origin?: "device" | "paste" } | null,
): string {
  if (!credential) return "AIAND_API_KEY";
  return credential.origin === "paste" ? "pasted key" : "device login";
}

export function storageLabel(storage: string | null): string {
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
};

/** The shared sign-in probe: resolve the profile, open a session, and fetch
 * identity/orgs (or the cached copy under --local). A signed-out profile
 * returns `session: null` (with `reachable: true`) rather than throwing, so
 * callers decide how to present it. A gateway failure (connection refused,
 * 5xx) returns `reachable: false` with the ApiError in `probeError` instead
 * of throwing, so status can report the outage without failing scripts.
 * Anything else — a rejected key (401), corrupt local state, Ctrl-C —
 * still throws for the caller to surface loudly. */
export async function probeIdentity(
  profileOverride?: string,
  local = false,
): Promise<Identity> {
  const profile = resolveProfile(profileOverride);
  let session: Session | null = null;
  let user: AccountUser | null = null;
  let org: AccountOrg | null = null;
  let orgs: AccountOrg[] = [];
  let cached: LoadedCredential | null = null;
  let reachable = true;
  let probeError: ApiError | null = null;

  try {
    if (local) {
      // Cached-only: never touch the network. openSession rotates device
      // tokens near expiry, so build the session straight from the stored
      // credential instead of opening one.
      const fromEnv = process.env.AIAND_API_KEY;
      if (fromEnv) {
        // The env key is a different credential than the cached one —
        // attaching the cached identity here would report the wrong
        // account. Identity stays unknown under an env key until the
        // gateway is asked (the non-local path).
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
      cached = await loadCredential(profile.name);
      [orgs, user] = await Promise.all([listOrgs(session), getUser(session)]);
      const cachedOrg = cached?.org;
      org =
        cachedOrg && orgs.some((o) => o.id === cachedOrg.id)
          ? cachedOrg
          : (orgs[0] ?? null);
    }
  } catch (error) {
    if (error instanceof NotLoggedInError) {
      // Signed out: fall through with session null; reachable stays true.
    } else if (
      error instanceof ApiError &&
      (error.status === 0 || error.status >= 500)
    ) {
      // Gateway unreachable or erroring: report it, don't throw, so status
      // can name the outage without failing scripts that gate on it.
      reachable = false;
      probeError = error;
    } else {
      throw error;
    }
  }

  return { profile, session, user, org, orgs, cached, reachable, probeError };
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
  source: "device-login" | "pasted-key" | "AIAND_API_KEY" | null;
  storage: string | null;
};

export type AuthStatusOptions = {
  profile?: string;
  local?: boolean;
};

/** The auth half of `aiand status`: identity, masked key, key source, and the
 * storage tier holding the secret. Uses the shared probe so whoami classifies
 * identically. */
export async function authStatus(
  opts: AuthStatusOptions = {},
): Promise<AuthStatus> {
  const { profile, session, user, org, cached, reachable } = await probeIdentity(
    opts.profile,
    opts.local,
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
    source: credential ? classifySource(credential.origin) : "AIAND_API_KEY",
    storage: storage !== null ? storageLabel(storage) : null,
  };
}

export type DeviceLoginOptions = {
  profile?: string;
  json?: boolean;
  /** Internal test seam: prompt streams for the multi-org picker. */
  input?: PromptInput;
  output?: PromptOutput;
  /** Internal: display name for the minted key; defaults to aiand@<hostname>. */
  keyName?: string;
  /** Internal test seam: opener injected into the browser sign-in. */
  open?: (url: string) => Promise<boolean>;
  /** Internal test seam: browser callback wait cap (default 5 minutes). */
  timeoutMs?: number;
};

/** Mint an org-scoped API key via a browser device-code approval, persist the
 * credential, promote the profile, and rebake the key into active agents. */
export async function deviceLogin(
  opts: DeviceLoginOptions = {},
): Promise<void> {
  const profile = resolveProfile(opts.profile);

  const keyName = opts.keyName ?? `aiand@${hostname() || "cli"}`;
  let deviceStart: DeviceCodeResponse;
  try {
    deviceStart = await startDeviceAuthorization(profile.authUrl, {
      keyName,
    });
  } catch (error) {
    return degradeToPaste(error, opts, "starting the device sign-in");
  }
  const url = verificationUrl(profile.authUrl, deviceStart);

  out();
  out(
    `  ${style.dim("Your code ")}  ${style.bold(style.cyan(deviceStart.user_code))}`,
  );
  out(`  ${style.dim("Approve at")}  ${link(url)}`);
  out();
  if (!(await openBrowser(url)))
    err(style.dim("Could not open a browser -- open the URL above to continue."));

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);

  const spin = spinner("Waiting for approval in the browser...");
  let tokens: TokenResponse;
  try {
    tokens = await pollForToken(profile.authUrl, deviceStart, {
      signal: controller.signal,
      onSlowDown: (interval) =>
        err(
          style.dim(`Server asked us to back off; polling every ${interval}s.`),
        ),
    });
  } catch (error) {
    return degradeToPaste(error, opts, "waiting for the approval");
  } finally {
    spin.stop();
    process.removeListener("SIGINT", onInterrupt);
  }

  await completeSignIn(profile, tokens, opts);
}

/**
 * Device-to-paste fallback: when the device service can't be reached, an
 * interactive terminal may fall through to pasting a key instead of
 * dead-ending the sign-in. Non-interactive runs (CI, pipes) keep the original
 * error — paste needs a prompt. User-driven outcomes (deny, Ctrl-C, poll
 * expiry) stay fatal so cancellation remains cancellation.
 */
async function degradeToPaste(
  error: unknown,
  opts: DeviceLoginOptions,
  doing: string,
): Promise<void> {
  // Ctrl-C (130), an explicit deny (3), and poll expiry (also 3) stay fatal.
  // Only network (status 0) and 5xx may fall through to pasting a key.
  if (
    error instanceof CliError &&
    (error.exitCode === 130 || error.exitCode === 3)
  )
    throw error;
  const recoverable =
    error instanceof ApiError && (error.status === 0 || error.status >= 500);
  if (!recoverable || !isInteractive() || opts.json) throw error;
  err(
    style.yellow(
      `Device sign-in failed while ${doing} (${(error as Error).message}) — paste a key instead.`,
    ),
  );
  const ok = await confirm("Paste a key instead?", {
    default: false,
    input: opts.input,
    output: opts.output,
  });
  if (!ok) throw error;
  return pasteLogin({ ...opts, interactive: true });
}

/** Default interactive sign-in: browser authorization-code + PKCE with a
 * device-code fallback when the server or terminal cannot do the browser
 * half. Minted keys keep origin "device" either way. */
export async function browserLogin(
  opts: DeviceLoginOptions = {},
): Promise<void> {
  const profile = resolveProfile(opts.profile);
  const keyName = opts.keyName ?? `aiand@${hostname() || "cli"}`;

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  let result: BrowserFlowResult;
  try {
    result = await signInViaLocalhostCallback({
      authUrl: profile.authUrl,
      keyName,
      open: opts.open,
      timeoutMs: opts.timeoutMs,
      signal: controller.signal,
      onStatus: (line) => err(style.dim(line)),
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
  if (!result.ok) {
    // Ctrl-C after a successful callback still completes the sign-in; only a
    // failed wait is a cancellation.
    if (controller.signal.aborted)
      throw new CliError("Login cancelled.", { exitCode: 130 });
    if (result.fatal) throw new CliError(result.failure, { exitCode: 3 });
    if (!result.unsupported) {
      err(
        style.dim(
          `Browser sign-in didn't complete (${result.failure}) — continuing with a device code.`,
        ),
      );
    }
    return deviceLogin({ ...opts, keyName });
  }
  await completeSignIn(profile, result.tokens, opts);
}

async function pickOrg(
  orgs: AccountOrg[],
  opts: { json?: boolean; input?: PromptInput; output?: PromptOutput },
): Promise<AccountOrg | null> {
  if (orgs.length === 1) return orgs[0]!;
  if (orgs.length === 0) return null;
  if (!opts.json && isInteractive()) {
    const picked = await promptSelect({
      message: "Which organization should this machine use?",
      choices: orgs.map((o) => ({ value: o.id, label: o.name })),
      input: opts.input,
      output: opts.output,
    });
    if (picked === null)
      throw new CliError("Login cancelled.", { exitCode: 130 });
    return orgs.find((o) => o.id === picked) ?? orgs[0]!;
  }
  err(
    style.dim(
      `This account has multiple organizations; using ${orgs[0]!.name}.`,
    ),
  );
  return orgs[0]!;
}

async function completeSignIn(
  profile: ResolvedProfile,
  tokens: TokenResponse,
  opts: { json?: boolean; input?: PromptInput; output?: PromptOutput },
): Promise<void> {
  await saveCredential(profile.name, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
    origin: "device",
  });

  await activateProfile(profile.name);

  const session = await openSession(resolveProfile(profile.name));
  const [user, orgs] = await Promise.all([getUser(session), listOrgs(session)]);
  const org = tokens.org ?? (await pickOrg(orgs, opts));
  const stored = await loadCredential(profile.name);
  if (!stored) throw new CliError("Session vanished while signing in.");
  await saveCredential(profile.name, {
    ...stored,
    user,
    ...(org ? { org } : {}),
  });

  const notes = await rebakeAgentKeys(session.token);
  printRebakeNotes(notes);

  if (opts.json) {
    return out(
      JSON.stringify(
        {
          profile: profile.name,
          user,
          org: org ?? null,
          key: maskKey(session.token),
        },
        null,
        2,
      ),
    );
  }

  out(style.green("Signed in."));
  out();
  fields([
    ["email", user.email || style.dim("unknown")],
    [
      "org",
      org ? `${org.name} ${style.dim(`(${org.id})`)}` : style.dim("none"),
    ],
    ["profile", profile.name],
    ["key", style.dim(maskKey(session.token))],
  ]);
}

export type PasteLoginOptions = {
  profile?: string;
  /** Key supplied programmatically (tests, internal callers). */
  key?: string;
  /** `--with-token`: read the key from stdin. */
  fromStdin?: boolean;
  /** `--paste`: prompt interactively (masked input). */
  interactive?: boolean;
  json?: boolean;
  /** Internal test seam: prompt streams for the masked paste prompt. */
  input?: PromptInput;
  output?: PromptOutput;
};

function readPastedKey(opts: PasteLoginOptions): Promise<string> {
  if (opts.interactive) {
    return readPastedKeyInteractive(opts);
  }
  if (opts.key !== undefined) {
    if (!/^sk-/.test(opts.key)) {
      throw new CliError('Keys start with "sk-".', {
        hint: "Check the key and try again.",
      });
    }
    return Promise.resolve(opts.key);
  }
  if (opts.fromStdin) {
    return readPastedKeyStdin();
  }
  throw new CliError("No key source given for paste login.");
}

async function readPastedKeyInteractive(
  opts: Pick<PasteLoginOptions, "input" | "output">,
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const key = await readSecret("Paste your ai& API key (sk-…): ", {
      input: opts.input,
      output: opts.output,
    });
    if (!/^sk-/.test(key)) {
      err(style.red(`Keys start with "sk-" (attempt ${attempt} of 3).`));
      continue;
    }
    return key;
  }

  throw new CliError("Three invalid keys in a row — giving up.");
}

async function readPastedKeyStdin(): Promise<string> {
  const piped = await readStdin();
  if (piped === null) {
    throw new CliError("Pipe the key: aiand login --with-token < key.txt");
  }
  const [firstLine = "", ...rest] = piped.split(/\r?\n/);
  if (rest.some((line) => line.trim() !== "")) {
    throw new CliError("Pipe a single-line key.", {
      hint: "aiand login --with-token < key.txt",
    });
  }
  const key = firstLine.trim();
  if (!/^sk-/.test(key)) {
    throw new CliError('Keys start with "sk-".', {
      hint: "Check the key and try again.",
    });
  }
  return key;
}

/** Validate an existing key against the API (401 → rejected), store it as a
 * pasted credential, promote the profile, and rebake active agents. */
export async function pasteLogin(opts: PasteLoginOptions = {}): Promise<void> {
  const profile = resolveProfile(opts.profile);

  const key = await readPastedKey(opts);
  const user = await validateKey(key, profile.authUrl);
  await saveCredential(profile.name, {
    access_token: key,
    origin: "paste",
    user,
  });
  // Same /api/orgs resolution as the minted paths: a multi-org account picks
  // its org so rebaked configs land on the right one.
  const session = await openSession(resolveProfile(profile.name));
  const orgs = await listOrgs(session);
  const org = await pickOrg(orgs, opts);
  const stored = await loadCredential(profile.name);
  if (!stored) throw new CliError("Session vanished while signing in.");
  await saveCredential(profile.name, {
    ...stored,
    ...(org ? { org } : {}),
  });
  const storage = stored.storage ?? "file";

  await activateProfile(profile.name);

  if (opts.json) {
    const notes = await rebakeAgentKeys(key);
    printRebakeNotes(notes);
    return out(
      JSON.stringify(
        { profile: profile.name, source: "pasted-key", storage },
        null,
        2,
      ),
    );
  }

  const notes = await rebakeAgentKeys(key);
  printRebakeNotes(notes);

  out(style.green("Signed in with a pasted key."));
  out();
  fields([
    ["email", user.email || style.dim("unknown")],
    ["profile", profile.name],
    ["source", "pasted key"],
    ["storage", storage],
  ]);
}

export type LogoutOptions = {
  profile?: string;
  revoke?: boolean;
  keepRemote?: boolean;
  json?: boolean;
};

/** End this machine's session: clear the local credential and, for a
 * device-minted key, revoke it server-side (unless --keep-remote keeps it). */
export async function logout(opts: LogoutOptions = {}): Promise<void> {
  const profile = resolveProfile(opts.profile);
  const credential = await loadCredential(profile.name);

  if (!credential) {
    if (process.env.AIAND_API_KEY) {
      out(
        style.dim(
          `Profile "${profile.name}" was not signed in. The AIAND_API_KEY environment variable still applies until it is unset.`,
        ),
      );
      return;
    }
    out(style.dim(`Profile "${profile.name}" was not signed in.`));
    return;
  }

  const pasted = credential.origin === "paste";
  if (pasted && opts.revoke) {
    throw new CliError(
      "This key was pasted, not minted by this CLI; refusing to revoke it.",
      { hint: "Revoke it in the console if you no longer need it." },
    );
  }

  let revoked = false;
  let keepRemote = opts.keepRemote ?? false;
  // Only a minted refresh token revokes server-side, and only via
  // {refresh_token} — the server contract sends exactly that. No refresh
  // token means nothing to revoke: the local clear below is the whole job.
  const revokeToken = credential.refresh_token;
  if (pasted) {
    keepRemote = true;
  } else if (keepRemote || !revokeToken) {
    // keepRemote: caller said keep; no refresh token: local clear only.
  } else if (opts.revoke) {
    revoked = await revokeTokens(profile.authUrl, revokeToken);
  } else if (isInteractive()) {
    const yes = await confirm("Revoke the ai& key this machine minted?", {
      default: true,
    });
    if (yes) {
      revoked = await revokeTokens(profile.authUrl, revokeToken);
    } else {
      keepRemote = true;
    }
  } else {
    revoked = await revokeTokens(profile.authUrl, revokeToken);
  }

  // Inverse of the login rebake: strip aiand-owned writes from every active
  // agent before the credential is gone, so no baked key lingers on disk.
  // Rebake runs at sign-in, which promotes config.profile — AIAND_PROFILE
  // only overrides command targeting, not which key was baked. Teardown
  // follows the stored active profile, not the env override.
  // Best-effort per adapter — a strip failure is a stderr hint, never fatal.
  if (profile.name === loadConfig().profile) {
    for (const adapter of AGENTS) {
      if (adapter.launcherOnly) continue;
      if (typeof adapter.disable !== "function") continue;
      let active = false;
      try {
        active = (await adapter.probe()).active;
      } catch {
        continue;
      }
      if (!active) continue;
      try {
        await adapter.disable();
      } catch (error) {
        err(
          style.dim(
            `[${adapter.id}] Could not strip its key: ${(error as Error).message ?? String(error)} Re-run \`aiand ${adapter.id} off\`.`
          )
        );
      }
    }
  }

  await clearCredential(profile.name);

  if (opts.json) {
    return out(
      JSON.stringify(
        {
          profile: profile.name,
          revoked,
          source: pasted ? "pasted-key" : "device-login",
        },
        null,
        2,
      ),
    );
  }

  out(style.green(`Signed out of "${profile.name}".`));
  if (pasted) {
    out(
      style.dim(
        "The pasted key was removed locally; it is still valid in the console.",
      ),
    );
  } else if (!revoked && !keepRemote) {
    out(
      style.dim(
        "The server could not be reached, so the key was only removed locally. Revoke it in the console if this machine is untrusted.",
      ),
    );
  }
}
