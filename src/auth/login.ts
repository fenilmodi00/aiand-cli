import { hostname } from "node:os";
import { printRebakeNotes, rebakeForBinding } from "../agents/rebake.js";
import { getUser, listOrgs, validateKey } from "../api/account.js";
import { assertValidKey, openSession, type Session } from "../api/client.js";
import {
  type DeviceCodeResponse,
  pollForToken,
  startDeviceAuthorization,
  type TokenResponse,
  verificationUrl,
} from "../api/device.js";
import { openBrowser } from "../cli/browser.js";
import { ApiError, CliError, EXIT, loginCancelled, SYNTHETIC_STATUS } from "../cli/errors.js";
import { link } from "../cli/links.js";
import {
  err,
  fields,
  out,
  safeLine,
  sanitizeForTerminal,
  spinner,
  style,
  styled,
} from "../cli/output.js";
import { confirm, isInteractive, readSecret } from "../cli/prompt.js";
import { INVALID_KEY_MESSAGE, isValidKeyShape } from "../cli/redact.js";
import type { PromptInput, PromptOutput } from "../cli/select.js";
import { readStdin } from "../cli/stdin.js";
import {
  bindingFor,
  CREDENTIAL_ORIGIN,
  type CredentialBinding,
  legacyBinding,
  loadConfig,
  maskKey,
  type ResolvedProfile,
  resolveProfile,
  saveConfig,
  saveCredential,
  updateProfile,
} from "../config.js";
import { fileTierNotOwnerOnly } from "../secrets.js";
import { nowSeconds } from "../time.js";
import { type BrowserFlowResult, signInViaLocalhostCallback } from "./browser.js";
import { CREDENTIAL_SOURCE, storageLabel } from "./identity.js";

/** Server-side name for a key minted on this machine. */
const defaultKeyName = (): string => `aiand@${hostname() || "cli"}`;

/** Promote a freshly-signed-in profile to the active one when it is not. The
 * URLs the credential was bound to are written onto the profile when they
 * differ from what it already resolves to (`login --base-url X`), since the
 * next run carries no flag and would otherwise be refused. */
async function activateProfile(name: string, bound: CredentialBinding): Promise<void> {
  const stored = legacyBinding(name);
  await updateProfile(name, {
    ...(bound.api_url === stored.api_url ? {} : { apiUrl: bound.api_url }),
    ...(bound.auth_url === stored.auth_url ? {} : { authUrl: bound.auth_url }),
  });
  if (loadConfig().profile !== name) {
    await saveConfig({ ...loadConfig(), profile: name });
  }
}

/** The rebake after sign-in, held to the endpoint each agent was wired for. */
async function rebakeAfterSignIn(
  profile: ResolvedProfile,
  key: string,
  binding: CredentialBinding,
): Promise<void> {
  printRebakeNotes(await rebakeForBinding(key, profile.name, binding));
}

export type DeviceLoginOptions = {
  profile?: string;
  json?: boolean;
  /** Internal test seam: prompt streams for the paste fallback confirm. */
  input?: PromptInput;
  output?: PromptOutput;
  /** Internal: display name for the minted key; defaults to aiand@<hostname>. */
  keyName?: string;
  /** Internal test seam: opener injected into the browser sign-in. */
  open?: (url: string) => Promise<boolean>;
  /** Internal test seam: browser callback wait cap (default 5 minutes). */
  timeoutMs?: number;
  /** Internal test seam: the wait between device-token polls. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** Mint an org-scoped API key via a browser device-code approval, persist the
 * credential, promote the profile, and rebake the key into active agents. */
export async function deviceLogin(opts: DeviceLoginOptions = {}): Promise<void> {
  const profile = resolveProfile(opts.profile);

  const keyName = opts.keyName ?? defaultKeyName();
  let deviceStart: DeviceCodeResponse;
  try {
    deviceStart = await startDeviceAuthorization(profile.authUrl, {
      keyName,
    });
  } catch (error) {
    return degradeToPaste(error, opts, "starting the device sign-in");
  }
  const url = verificationUrl(profile.authUrl, deviceStart);

  // --json stdout carries only the final JSON blob (completeSignIn below);
  // the code/URL a human follows go to stderr, like browserLogin's status.
  const show = opts.json ? err : out;
  show();
  show(`  ${style.dim("Your code ")}  ${style.bold(style.cyan(safeLine(deviceStart.user_code)))}`);
  show(`  ${style.dim("Approve at")}  ${link(url)}`);
  show();
  // Over SSH a browser opened here isn't the user's; the URL above is enough.
  if (!isSshSession() && !(await openBrowser(url)))
    err(style.dim("Could not open a browser -- open the URL above to continue."));

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);

  const spin = spinner("Waiting for approval in the browser...");
  let tokens: TokenResponse;
  try {
    tokens = await pollForToken(profile.authUrl, deviceStart, {
      signal: controller.signal,
      sleep: opts.sleep,
      onSlowDown: (interval) =>
        err(style.dim(`Server asked us to back off; polling every ${interval}s.`)),
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
    (error.exitCode === EXIT.INTERRUPTED || error.exitCode === EXIT.LOGIN_DENIED)
  )
    throw error;
  const recoverable =
    error instanceof ApiError &&
    (error.status === SYNTHETIC_STATUS.UNREACHABLE || error.status >= 500);
  if (!recoverable || !isInteractive() || opts.json) throw error;
  err(
    style.yellow(
      `Device sign-in failed while ${doing} (${safeLine((error as Error).message)}) — paste a key instead.`,
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

/** Over SSH the loopback redirect lands on the laptop's 127.0.0.1, not this
 * machine's listener, so the browser flow could only time out. */
function isSshSession(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
}

/** Default interactive sign-in: browser authorization-code + PKCE with a
 * device-code fallback when the server or terminal cannot do the browser
 * half. Minted keys keep origin "device" either way. */
export async function browserLogin(opts: DeviceLoginOptions = {}): Promise<void> {
  const profile = resolveProfile(opts.profile);
  const keyName = opts.keyName ?? defaultKeyName();
  if (isSshSession()) {
    err(style.dim("SSH session detected — signing in with a device code."));
    return deviceLogin({ ...opts, keyName });
  }

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
      onStatus: (line) => err(style.dim(sanitizeForTerminal(line))),
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
  if (!result.ok) {
    // Ctrl-C after a successful callback still completes the sign-in; only a
    // failed wait is a cancellation.
    if (controller.signal.aborted) throw loginCancelled();
    if (result.fatal) throw new CliError(result.failure, { exitCode: EXIT.LOGIN_DENIED });
    if (!result.unsupported) {
      err(
        style.dim(
          `Browser sign-in didn't complete (${safeLine(result.failure)}) — continuing with a device code.`,
        ),
      );
    }
    return deviceLogin({ ...opts, keyName });
  }
  await completeSignIn(profile, result.tokens, opts);
}

async function completeSignIn(
  profile: ResolvedProfile,
  tokens: TokenResponse,
  opts: { json?: boolean },
): Promise<void> {
  // A minted key belongs to exactly one org: the token response names it, and
  // when it does not, /api/orgs lists the authenticating key's org first. No
  // picker, since choosing another org would record one the key does not bill.
  // The pending session carries no refresh_token, which would otherwise rotate
  // and save before the org is known, and a non-null credential keeps a 401
  // from reading as a bad env key.
  assertValidKey(tokens.access_token);
  const bound_to = bindingFor(profile);
  const pending: Session = {
    profile,
    token: tokens.access_token,
    credential: { access_token: tokens.access_token, origin: CREDENTIAL_ORIGIN.DEVICE, bound_to },
  };
  const [user, orgs] = await Promise.all([getUser(pending), listOrgs(pending)]);
  const org = tokens.org ?? orgs[0] ?? null;

  await saveCredential(profile.name, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: nowSeconds() + tokens.expires_in,
    origin: CREDENTIAL_ORIGIN.DEVICE,
    bound_to,
    user,
    ...(org ? { org } : {}),
  });

  await activateProfile(profile.name, bound_to);

  const session = await openSession(resolveProfile(profile.name));

  await rebakeAfterSignIn(profile, session.token, bound_to);

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
    ["email", user.email ?? styled(style.dim, "unknown")],
    ["org", org ? [`${org.name} `, styled(style.dim, `(${org.id})`)] : styled(style.dim, "none")],
    ["profile", profile.name],
    ["key", styled(style.dim, maskKey(session.token))],
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
    const key = (
      await readSecret("Paste your ai& API key (sk-…): ", {
        input: opts.input,
        output: opts.output,
      })
    ).trim();
    if (!/^sk-/.test(key)) {
      err(style.red(`Keys start with "sk-" (attempt ${attempt} of 3).`));
      continue;
    }
    // Inside the loop: a stray space or control character in the middle of a
    // paste is another attempt, not a fatal error after the third-try budget.
    if (!isValidKeyShape(key)) {
      err(style.red(`${INVALID_KEY_MESSAGE} (attempt ${attempt} of 3).`));
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
  assertValidKey(key);
  const user = await validateKey(key, profile.authUrl);
  // A pasted key is already scoped to one org, so there is nothing to pick:
  // offering a picker let the user record an org the key does not bill.
  // The account API's /api/orgs lists the authenticating key's org first.
  const bound_to = bindingFor(profile);
  const pending: Session = {
    profile,
    token: key,
    credential: { access_token: key, origin: CREDENTIAL_ORIGIN.PASTE, bound_to },
  };
  const [org = null] = await listOrgs(pending);
  const storage = await saveCredential(profile.name, {
    access_token: key,
    origin: CREDENTIAL_ORIGIN.PASTE,
    bound_to,
    user,
    ...(org ? { org } : {}),
  });

  await activateProfile(profile.name, bound_to);
  await rebakeAfterSignIn(profile, key, bound_to);

  if (opts.json) {
    return out(
      JSON.stringify({ profile: profile.name, source: CREDENTIAL_SOURCE.PASTED, storage }, null, 2),
    );
  }

  out(style.green("Signed in with a pasted key."));
  out();
  fields([
    ["email", user.email || styled(style.dim, "unknown")],
    ["profile", profile.name],
    ["source", "pasted key"],
    ["storage", storageLabel(storage, fileTierNotOwnerOnly() ? { owner_only: false } : null)],
  ]);
}
