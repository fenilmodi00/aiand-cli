import { CliError, NotLoggedInError } from "../cli/errors.js";
import { openSession, type Session } from "../api/client.js";
import {
  getUser,
  listOrgs,
  validateKey,
  type AccountOrg,
  type AccountUser,
} from "../api/account.js";
import * as device from "../api/device.js";
import { readSecret, confirm, isInteractive } from "../cli/prompt.js";
import { readStdin } from "../cli/stdin.js";
import { copyToClipboard } from "../cli/clipboard.js";
import { openBrowserAware } from "../cli/browser.js";
import { isRemoteContext } from "../cli/remote.js";
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
  type Config,
  type Credential,
  type LoadedCredential,
  type Profile,
  type ResolvedProfile,
} from "../config.js";
import { rebakeAgentKeys, type RebakeNote } from "../agents/rebake.js";
import { revokeTokens } from "../api/device.js";

type Style = {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  magenta(s: string): string;
  cyan(s: string): string;
};

/** Injectable seams for every auth flow. Each maps to the module-level
 * default when omitted; tests swap only the slice they exercise. */
export type AuthDeps = {
  deviceApi?: {
    startDeviceAuthorization(authUrl: string): Promise<device.DeviceCodeResponse>;
    verificationUrl(authUrl: string, device: device.DeviceCodeResponse): string;
    pollForToken(
      authUrl: string,
      device: device.DeviceCodeResponse,
      options?: device.PollOptions
    ): Promise<device.TokenResponse>;
  };
  api?: {
    openSession(profile: ResolvedProfile): Promise<Session>;
    getUser(session: Session): Promise<AccountUser>;
    listOrgs(session: Session): Promise<AccountOrg[]>;
    validateKey(key: string, authUrl: string): Promise<AccountUser>;
  };
  store?: {
    saveCredential(profile: string, credential: LoadedCredential): Promise<void>;
    loadCredential(profile: string): Promise<LoadedCredential | null>;
    clearCredential(profile: string): Promise<void>;
  };
  config?: {
    loadConfig(): Config;
    saveConfig(config: Config): void;
    updateProfile(name: string, patch: Partial<Profile>): void;
    resolveProfile(override?: string): ResolvedProfile;
    maskKey(key: string): string;
  };
  rebake?: (apiKey: string) => Promise<RebakeNote[]>;
  revoke?: (authUrl: string, token: string) => Promise<boolean>;
  ui?: {
    out(line?: string): void;
    err(line?: string): void;
    style: Style;
    fields(pairs: [string, string][]): void;
    link(url: string): string;
    spinner(text: string): { stop(final?: string): void };
    confirm(message: string, options?: { default?: boolean }): Promise<boolean>;
    isInteractive(): boolean;
    copyToClipboard(text: string): Promise<boolean>;
    openBrowserAware(url: string, options?: { remote?: boolean }): "opened" | "remote";
    isRemoteContext(): boolean;
  };
};

type ResolvedDeps = {
  deviceApi: NonNullable<AuthDeps["deviceApi"]>;
  api: NonNullable<AuthDeps["api"]>;
  store: NonNullable<AuthDeps["store"]>;
  config: NonNullable<AuthDeps["config"]>;
  rebake: (apiKey: string) => Promise<RebakeNote[]>;
  revoke: (authUrl: string, token: string) => Promise<boolean>;
  ui: NonNullable<AuthDeps["ui"]>;
};

function resolvedDeps(deps: AuthDeps): ResolvedDeps {
  return {
    deviceApi: {
      startDeviceAuthorization: device.startDeviceAuthorization,
      verificationUrl: device.verificationUrl,
      pollForToken: device.pollForToken,
      ...deps.deviceApi,
    },
    api: { openSession, getUser, listOrgs, validateKey, ...deps.api },
    store: { saveCredential, loadCredential, clearCredential, ...deps.store },
    config: { loadConfig, saveConfig, updateProfile, resolveProfile, maskKey, ...deps.config },
    rebake: deps.rebake ?? rebakeAgentKeys,
    revoke: deps.revoke ?? revokeTokens,
    ui: {
      out,
      err,
      style,
      fields,
      link,
      spinner,
      confirm,
      isInteractive,
      copyToClipboard,
      openBrowserAware,
      isRemoteContext,
      ...deps.ui,
    },
  };
}

function printRebakeNotes(d: ResolvedDeps, notes: RebakeNote[]): void {
  for (const note of notes) {
    d.ui.err(d.ui.style.dim(`[${note.agent}] ${note.note}`));
  }
}

/** Promote a freshly-signed-in profile to the active one when it is not. */
function activateProfile(name: string, cfg: ResolvedDeps["config"]): void {
  cfg.updateProfile(name, {});
  if (cfg.loadConfig().profile !== name) {
    cfg.saveConfig({ ...cfg.loadConfig(), profile: name });
  }
}

/** Map a credential's origin to the wire/source string both status and
 * whoami emit. Shared classification lives here so the two commands cannot
 * drift. */
export function classifySource(
  origin: Credential["origin"] | null | undefined
): "device-login" | "pasted-key" | "AIAND_API_KEY" {
  if (origin === undefined || origin === null) return "AIAND_API_KEY";
  return origin === "paste" ? "pasted-key" : "device-login";
}

export function sourceLabel(credential: { origin?: "device" | "paste" } | null): string {
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
};

/** The shared sign-in probe: resolve the profile, open a session, and fetch
 * identity/orgs (or the cached copy under --local). A signed-out profile
 * returns `session: null` rather than throwing, so callers decide how to
 * present it. */
export async function probeIdentity(
  profileOverride?: string,
  local = false,
  deps: AuthDeps = {}
): Promise<Identity> {
  const d = resolvedDeps(deps);
  const profile = d.config.resolveProfile(profileOverride);
  let session: Session | null = null;
  let user: AccountUser | null = null;
  let org: AccountOrg | null = null;
  let orgs: AccountOrg[] = [];
  let cached: LoadedCredential | null = null;

  try {
    session = await d.api.openSession(profile);
    cached = await d.store.loadCredential(profile.name);
    if (local) {
      user = cached?.user ?? null;
      org = cached?.org ?? null;
      orgs = cached?.org ? [cached.org] : [];
    } else {
      orgs = await d.api.listOrgs(session);
      user = await d.api.getUser(session);
      org = orgs[0] ?? null;
    }
  } catch (error) {
    if (!(error instanceof NotLoggedInError)) throw error;
  }

  return { profile, session, user, org, orgs, cached };
}

export type AuthStatus = {
  signed_in: boolean;
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
  deps?: AuthDeps;
};

/** The auth half of `aiand status`: identity, masked key, key source, and the
 * storage tier holding the secret. Uses the shared probe so whoami classifies
 * identically. */
export async function authStatus(opts: AuthStatusOptions = {}): Promise<AuthStatus> {
  const d = resolvedDeps(opts.deps ?? {});
  const { profile, session, user, org, cached } = await probeIdentity(
    opts.profile,
    opts.local,
    opts.deps
  );

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

  const credential = session.credential;
  const storage = credential ? (cached?.storage ?? null) : null;
  return {
    signed_in: true,
    profile: profile.name,
    email: user?.email ?? cached?.user?.email ?? null,
    org: org?.name ?? cached?.org?.name ?? null,
    key: d.config.maskKey(session.token),
    source: credential ? classifySource(credential.origin) : "AIAND_API_KEY",
    storage: storage !== null ? storageLabel(storage) : null,
  };
}

export type DeviceLoginOptions = {
  profile?: string;
  noBrowser?: boolean;
  json?: boolean;
  deps?: AuthDeps;
};

/** Mint an org-scoped API key via a browser device-code approval, persist the
 * credential, promote the profile, and rebake the key into active agents. */
export async function deviceLogin(opts: DeviceLoginOptions = {}): Promise<void> {
  const d = resolvedDeps(opts.deps ?? {});
  const profile = d.config.resolveProfile(opts.profile);

  const deviceStart = await d.deviceApi.startDeviceAuthorization(profile.authUrl);
  const url = d.deviceApi.verificationUrl(profile.authUrl, deviceStart);

  const remote = d.ui.isRemoteContext();

  d.ui.out();
  d.ui.out(
    `  ${d.ui.style.dim("Your code ")}  ${d.ui.style.bold(d.ui.style.cyan(deviceStart.user_code))}`
  );
  d.ui.out(`  ${d.ui.style.dim("Approve at")}  ${d.ui.link(url)}`);
  d.ui.out();

  if (opts.noBrowser) {
    d.ui.err(d.ui.style.dim("Open the URL above to continue."));
  } else if (remote) {
    d.ui.err(
      d.ui.style.dim(
        "No browser can open from here (SSH/WSL) -- open the URL above to continue."
      )
    );
    if (d.ui.isInteractive() && (await d.ui.copyToClipboard(url))) {
      d.ui.err(d.ui.style.dim("Copied the approval URL to your clipboard."));
    }
  } else if (d.ui.openBrowserAware(url) === "remote") {
    d.ui.err(d.ui.style.dim("Could not open a browser -- open the URL above to continue."));
  }

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);

  const spin = d.ui.spinner("Waiting for approval in the browser...");
  let tokens: device.TokenResponse;
  try {
    tokens = await d.deviceApi.pollForToken(profile.authUrl, deviceStart, {
      signal: controller.signal,
      onSlowDown: (interval) =>
        d.ui.err(d.ui.style.dim(`Server asked us to back off; polling every ${interval}s.`)),
    });
  } finally {
    spin.stop();
    process.removeListener("SIGINT", onInterrupt);
  }

  await d.store.saveCredential(profile.name, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
    origin: "device",
  });

  activateProfile(profile.name, d.config);

  const session = await d.api.openSession(d.config.resolveProfile(profile.name));
  const [user, orgs] = await Promise.all([d.api.getUser(session), d.api.listOrgs(session)]);
  const org = orgs[0];
  const stored = await d.store.loadCredential(profile.name);
  if (!stored) throw new CliError("Session vanished while signing in.");
  await d.store.saveCredential(profile.name, {
    ...stored,
    user,
    ...(org ? { org } : {}),
  });

  const notes = await d.rebake(session.token);
  printRebakeNotes(d, notes);

  if (opts.json) {
    return d.ui.out(
      JSON.stringify(
        { profile: profile.name, user, org: org ?? null, key: d.config.maskKey(session.token) },
        null,
        2
      )
    );
  }

  d.ui.out(d.ui.style.green("Signed in."));
  d.ui.out();
  d.ui.fields([
    ["email", user.email || d.ui.style.dim("unknown")],
    ["org", org ? `${org.name} ${d.ui.style.dim(`(${org.id})`)}` : d.ui.style.dim("none")],
    ["profile", profile.name],
    ["key", d.ui.style.dim(d.config.maskKey(session.token))],
  ]);
}

export type PasteLoginOptions = {
  profile?: string;
  /** `--api-key` value supplied on the command line. */
  key?: string;
  /** `--with-token`: read the key from stdin. */
  fromStdin?: boolean;
  /** `--paste`: prompt interactively (masked input). */
  interactive?: boolean;
  json?: boolean;
  deps?: AuthDeps;
};

function readPastedKey(opts: PasteLoginOptions): Promise<string> {
  if (opts.interactive) {
    return readPastedKeyInteractive();
  }
  if (opts.key !== undefined) {
    if (!/^sk-/.test(opts.key)) {
      throw new CliError('Keys start with "sk-".', { hint: "Check the key and try again." });
    }
    return Promise.resolve(opts.key);
  }
  if (opts.fromStdin) {
    return readPastedKeyStdin();
  }
  throw new CliError("No key source given for paste login.");
}

async function readPastedKeyInteractive(): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const key = await readSecret("Paste your ai& API key (sk-…): ");
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
  if (!/^sk-/.test(piped)) {
    throw new CliError('Keys start with "sk-".', { hint: "Check the key and try again." });
  }
  return piped;
}

/** Validate an existing key against the API (401 → rejected), store it as a
 * pasted credential, promote the profile, and rebake active agents. */
export async function pasteLogin(opts: PasteLoginOptions = {}): Promise<void> {
  const d = resolvedDeps(opts.deps ?? {});
  const profile = d.config.resolveProfile(opts.profile);

  const key = await readPastedKey(opts);
  const user = await d.api.validateKey(key, profile.authUrl);
  await d.store.saveCredential(profile.name, {
    access_token: key,
    origin: "paste",
    user,
  });
  const stored = await d.store.loadCredential(profile.name);
  const storage = stored?.storage ?? "file";

  activateProfile(profile.name, d.config);

  if (opts.json) {
    return d.ui.out(
      JSON.stringify({ profile: profile.name, source: "pasted-key", storage }, null, 2)
    );
  }

  const notes = await d.rebake(key);
  printRebakeNotes(d, notes);

  d.ui.out(d.ui.style.green("Signed in with a pasted key."));
  d.ui.out();
  d.ui.fields([
    ["email", user.email || d.ui.style.dim("unknown")],
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
  deps?: AuthDeps;
};

/** End this machine's session: clear the local credential and, for a
 * device-minted key, revoke it server-side (unless --keep-remote keeps it). */
export async function logout(opts: LogoutOptions = {}): Promise<void> {
  const d = resolvedDeps(opts.deps ?? {});
  const profile = d.config.resolveProfile(opts.profile);
  const credential = await d.store.loadCredential(profile.name);

  if (!credential) {
    if (process.env.AIAND_API_KEY) {
      d.ui.out(
        d.ui.style.dim(
          `Profile "${profile.name}" was not signed in. The AIAND_API_KEY environment variable still applies until it is unset.`
        )
      );
      return;
    }
    d.ui.out(d.ui.style.dim(`Profile "${profile.name}" was not signed in.`));
    return;
  }

  const pasted = credential.origin === "paste";
  if (pasted && opts.revoke) {
    throw new CliError(
      "This key was pasted, not minted by this CLI; refusing to revoke it.",
      { hint: "Revoke it in the console if you no longer need it." }
    );
  }

  let revoked = false;
  let keepRemote = opts.keepRemote ?? false;

  if (pasted) {
    keepRemote = true;
  } else if (!keepRemote) {
    if (opts.revoke) {
      revoked = await d.revoke(profile.authUrl, credential.refresh_token ?? credential.access_token);
    } else if (d.ui.isInteractive()) {
      const yes = await d.ui.confirm("Revoke the ai& key this machine minted?", { default: true });
      if (yes) {
        revoked = await d.revoke(profile.authUrl, credential.refresh_token ?? credential.access_token);
      } else {
        keepRemote = true;
      }
    } else {
      revoked = await d.revoke(profile.authUrl, credential.refresh_token ?? credential.access_token);
    }
  }

  await d.store.clearCredential(profile.name);

  if (opts.json) {
    return d.ui.out(
      JSON.stringify(
        { profile: profile.name, revoked, source: pasted ? "pasted-key" : "device-login" },
        null,
        2
      )
    );
  }

  d.ui.out(d.ui.style.green(`Signed out of "${profile.name}".`));
  if (pasted) {
    d.ui.out(
      d.ui.style.dim(
        "The pasted key was removed locally; it is still valid in the console."
      )
    );
  } else if (!revoked && !keepRemote) {
    d.ui.out(
      d.ui.style.dim(
        "The server could not be reached, so the key was only removed locally. Revoke it in the console if this machine is untrusted."
      )
    );
  }
}