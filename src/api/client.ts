import { createRequire } from "node:module";
import { join } from "node:path";
import {
  ApiError,
  CliError,
  cancelled,
  NotBoundError,
  NotLoggedInError,
  SYNTHETIC_STATUS,
} from "../cli/errors.js";
import { INVALID_KEY_MESSAGE, isValidKeyShape, redactSecrets } from "../cli/redact.js";
import {
  bindCredential,
  bindingFor,
  type CredentialBinding,
  fallbackBinding,
  type LoadedCredential,
  legacyBinding,
  loadCredential,
  normalizeBaseUrl,
  type ResolvedProfile,
  redactUrl,
  saveCredential,
  storedBinding,
  unprovenIssuer,
} from "../config.js";
import { withFileLock } from "../filelock.js";
import { configDir } from "../fsutil.js";
import { DAY_SECONDS, nowSeconds } from "../time.js";

const ROTATE_BEFORE_SECONDS = 3 * DAY_SECONDS;

const refreshInflight = new Map<string, Promise<{ token: string; credential: LoadedCredential }>>();

export const HEADERS = {
  METRICS: "X-Aiand-Metrics",
  MODEL: "X-Model",
  COST: "X-Cost",
  COST_CURRENCY: "X-Cost-Currency",
  INFERENCE_MS: "X-Inference-Ms",
  REASONING_EFFORT: "X-Reasoning-Effort",
  EMPTY_COMPLETION: "X-Empty-Completion",
  REQUEST_ID: "X-Request-ID",
  RATE_LIMIT_POLICY: "X-RateLimit-Policy",
} as const;

export type Session = {
  profile: ResolvedProfile;
  /** Padding wires trimmed (like login's stdin read) instead of baking
   * whitespace that 401s every request. */
  token: string;
  /** null under AIAND_API_KEY: nothing stored, nothing to rotate. */
  credential: LoadedCredential | null;
};

/**
 * AIAND_API_KEY, trimmed and checked. Whitespace-only is unset; a key with an
 * inner line break (two lines of a grepped .env) is refused here, before
 * Headers would echo it whole in its rejection.
 */
export function envApiKey(): string | undefined {
  const key = process.env.AIAND_API_KEY?.trim() || undefined;
  if (key !== undefined && !isValidKeyShape(key)) {
    throw new CliError(INVALID_KEY_MESSAGE, {
      hint: "Fix AIAND_API_KEY: it must be the key alone, on one line.",
    });
  }
  return key;
}

/** Refuse a key that cannot ride an Authorization header verbatim. */
export function assertValidKey(key: string): void {
  if (!isValidKeyShape(key)) {
    throw new CliError(INVALID_KEY_MESSAGE, { hint: "Copy the key again, without line breaks." });
  }
}

/** The Authorization value in any HeadersInit shape, read without building
 * a Headers (which throws, quoting the value, on a bad one). */
function authorizationOf(headers: RequestInit["headers"]): string | undefined {
  if (!headers || headers instanceof Headers) return undefined;
  const entries: [string, unknown][] = Array.isArray(headers)
    ? headers.map(([name, value]) => [String(name), value])
    : Object.entries(headers);
  const found = entries.find(([name]) => name.toLowerCase() === "authorization");
  return found ? String(found[1]) : undefined;
}

function assertSendableAuth(headers: RequestInit["headers"]): void {
  const value = authorizationOf(headers);
  if (value !== undefined) assertValidKey(value.replace(/^Bearer /, ""));
}

export async function openSession(profile: ResolvedProfile): Promise<Session> {
  // Whitespace-only is unset: a truthy read would wire a literal all-spaces
  // key into agent configs. Padding trims: the header serializes as
  // "Bearer  sk-…  " otherwise and the gateway 401s it.
  const fromEnv = envApiKey();
  if (fromEnv) return { profile, token: fromEnv, credential: null };

  const loaded = await loadCredential(profile.name);
  if (!loaded) throw new NotLoggedInError();
  const stored = await pinBinding(profile.name, loaded);
  assertBoundTo(profile, stored);

  // A pasted key has no refresh token: rotation is impossible and a 401 must
  // surface as the plain hint, so hand it back as-is regardless of expiry.
  if (!stored.refresh_token) {
    return { profile, token: stored.access_token.trim(), credential: stored };
  }

  const secondsLeft = (stored.expires_at ?? 0) - nowSeconds();
  if (secondsLeft > ROTATE_BEFORE_SECONDS) {
    return { profile, token: stored.access_token.trim(), credential: stored };
  }
  return { profile, ...(await refresh(profile, stored, { expiring: true })) };
}

/** Give a pre-0.8 credential its binding (see legacyBinding) and persist it,
 * so a later `config set` cannot move where its key goes. */
async function pinBinding(name: string, credential: LoadedCredential): Promise<LoadedCredential> {
  if (storedBinding(credential)) return credential;
  const bound_to = await fallbackBinding(name);
  if (!bound_to) {
    const { message, hint } = unprovenIssuer(name, "its key was not sent");
    throw new NotBoundError(message, hint);
  }
  await bindCredential(name, bound_to);
  return { ...credential, bound_to };
}

/**
 * Refuse to send a stored credential anywhere but where it was issued. One
 * pasted `--base-url` would otherwise hand the key, and on a 401 the refresh
 * token, to that host, and the rotated pair it answers with would replace
 * the real one. AIAND_API_KEY never reaches here: the user supplies it each
 * run, so it goes wherever they point it.
 */
export function assertBoundTo(profile: ResolvedProfile, credential: LoadedCredential): void {
  const bound = storedBinding(credential);
  const wanted = bindingFor(profile);
  const mismatches: string[] = [];
  if (bound?.api_url !== wanted.api_url) mismatches.push(wanted.api_url);
  if (bound?.auth_url !== wanted.auth_url && !mismatches.includes(wanted.auth_url)) {
    mismatches.push(wanted.auth_url);
  }
  if (mismatches.length === 0) return;
  throw notBoundError(profile.name, bound, mismatches);
}

/** `aiand key export --for <origin>`: a stored key leaves only for the API origin that issued it. */
export function assertKeyBoundTo(
  name: string,
  credential: LoadedCredential | null,
  origin: string,
): void {
  if (!credential) return;
  const bound = storedBinding(credential);
  const target = normalizeBaseUrl(origin);
  if (bound?.api_url === target) return;
  throw notBoundError(name, bound, [target]);
}

function notBoundError(
  name: string,
  bound: CredentialBinding | null,
  targets: string[],
): NotBoundError {
  // What is printed carries no credential an endpoint URL may hold.
  const shown = targets.map(redactUrl);
  const issuer = bound ? redactUrl(bound.api_url) : "an endpoint that was never recorded";
  const signIn = `sign in for that endpoint on its own profile: \`aiand login --profile <name> --base-url ${shown[0]}\``;
  const overridden = Boolean(process.env.AIAND_BASE_URL || process.env.AIAND_AUTH_URL);
  const hint = overridden
    ? `Drop the override (--base-url, AIAND_BASE_URL, AIAND_AUTH_URL) to use this login, or ${signIn}.`
    : bound
      ? `Point the profile back at the endpoint that issued it: \`aiand config set api-url ${redactUrl(bound.api_url)}\` and \`aiand config set auth-url ${redactUrl(bound.auth_url)}\`, or ${signIn}.`
      : `Run \`aiand login\` again to bind this profile to its endpoints, or ${signIn}.`;
  return new NotBoundError(
    `The key stored for profile "${name}" was issued for ${issuer}; refusing to send it to ${shown.join(" and ")}.`,
    hint,
  );
}

/** The last gate before a stored key leaves: the request's base URL must be
 * one the credential is bound to, whatever the caller passed as baseUrl. */
function assertTargetBound(session: Session, base: string): void {
  if (!session.credential) return;
  // No binding is a refusal, never a pass: openSession pins a legacy credential,
  // so a stored credential reaching here without one was built around that.
  const bound = storedBinding(session.credential);
  const target = normalizeBaseUrl(base);
  if (bound && (target === bound.api_url || target === bound.auth_url)) return;
  throw notBoundError(session.profile.name, bound, [target]);
}
const sameBinding = (a: CredentialBinding, b: CredentialBinding): boolean =>
  a.auth_url === b.auth_url && a.api_url === b.api_url;

export function withRefreshLock<T>(profileName: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(configDir(), "locks", `refresh-${profileName}`);
  return withFileLock(lock, fn);
}

async function refresh(
  profile: ResolvedProfile,
  stored: LoadedCredential,
  { expiring = false }: { expiring?: boolean } = {},
): Promise<{ token: string; credential: LoadedCredential }> {
  const inflight = refreshInflight.get(profile.name);
  if (inflight) return inflight;

  // Across processes too: Codex runs `aiand key export` in every session, and two
  // rotations with one refresh token can get the whole grant revoked for reuse.
  const promise = withRefreshLock(profile.name, async () => {
    // Another process may have rotated since this session loaded `stored`;
    // the persisted credential is what agents were last baked with.
    const reloaded = await loadCredential(profile.name);
    // Signed out meanwhile (`aiand logout` elsewhere): the token this session
    // holds was revoked with it, and rotating it would sign the profile back in.
    if (!reloaded) throw new NotLoggedInError();
    // Never bindingFor(profile): that includes this run's overrides, and a refresh
    // token follows the binding. No record means no rotation.
    const binding = storedBinding(stored) ?? storedBinding(reloaded);
    if (!binding) throw notBoundError(profile.name, null, [normalizeBaseUrl(profile.authUrl)]);
    // The refresh token only goes back to where it was issued, and only
    // while this profile still points there. A credential replaced under us
    // by a sign-in elsewhere is not ours to rotate either.
    assertBoundTo(profile, { ...stored, bound_to: binding });
    if (!sameBinding(storedBinding(reloaded) ?? legacyBinding(profile.name), binding)) {
      throw notBoundError(profile.name, storedBinding(reloaded), [binding.api_url]);
    }
    const current: LoadedCredential = { ...reloaded, bound_to: binding };
    if (
      expiring &&
      current.access_token !== stored.access_token &&
      (current.expires_at ?? 0) - nowSeconds() > ROTATE_BEFORE_SECONDS
    ) {
      return { token: current.access_token, credential: current };
    }
    const refreshToken = current.refresh_token ?? stored.refresh_token;
    if (!refreshToken) throw new CliError("This credential has no refresh token.");

    const { rotateTokens } = await import("./device.js");
    // The issuer, never profile.authUrl: openSession checked they agree, and
    // this keeps a refresh token from following any override that slips past.
    const tokens = await rotateTokens(binding.auth_url, refreshToken);
    const next: LoadedCredential = {
      ...current,
      bound_to: binding,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: nowSeconds() + tokens.expires_in,
    };
    await saveCredential(profile.name, next);
    // Rebake: agents wired with the rotated key get the new one, or they would
    // keep a key that expires (or is revoked) while the CLI moves on. Only those
    // wired for this credential's own API origin, and only where the config still
    // holds exactly the key it replaced.
    const { printRebakeNotes, rebakeForBinding } = await import("../agents/rebake.js");
    printRebakeNotes(
      await rebakeForBinding(next.access_token, profile.name, binding, {
        previousKey: current.access_token,
      }),
    );
    return { token: next.access_token, credential: next };
  });

  refreshInflight.set(profile.name, promise);
  try {
    return await promise;
  } finally {
    refreshInflight.delete(profile.name);
  }
}

export type RequestOptions = {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  baseUrl?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

function buildUrl(baseUrl: string, path: string, query?: RequestOptions["query"]): string {
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function request(session: Session, options: RequestOptions): Promise<Response> {
  const send = async (token: string): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": userAgent(),
      ...options.headers,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const base = options.baseUrl ?? session.profile.apiUrl;
    assertTargetBound(session, base);
    const url = buildUrl(base, options.path, options.query);
    return fetchOrFail(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  };

  let response = await send(session.token);

  if (response.status === 401 && session.credential?.refresh_token) {
    if (response.body?.cancel) {
      await response.body.cancel();
    } else {
      await response.arrayBuffer().catch(() => {});
    }
    const rotated = await refresh(session.profile, session.credential);
    session.token = rotated.token;
    session.credential = rotated.credential;
    response = await send(session.token);
  }

  if (!response.ok) throw await toApiError(response, session.credential === null);
  return response;
}

export async function requestJson<T>(session: Session, options: RequestOptions): Promise<T> {
  const response = await request(session, options);
  return parseJsonResponse<T>(response);
}

export async function publicJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await publicRequest(url, init);
  if (!response.ok) throw await toApiError(response);
  return parseJsonResponse<T>(response);
}

/** The 502 for a 2xx gateway body that is not the JSON (or SSE) we expect. */
export function gatewayNotJsonError(response: Response, detail: string): ApiError {
  return new ApiError(
    SYNTHETIC_STATUS.BAD_GATEWAY,
    `The gateway returned a response that is not valid JSON (${redactSecrets(detail)}).`,
    {
      requestId: response.headers.get(HEADERS.REQUEST_ID) ?? undefined,
      hint: "The gateway may be down, or a middlebox may be intercepting requests. Retry, or check --base-url / AIAND_BASE_URL.",
    },
  );
}

/**
 * Classify a mid-body-read connection failure (#104). When the gateway cuts
 * the response body, undici surfaces `TypeError: terminated`,
 * `TypeError: fetch failed`, or an errno cause (ECONNRESET etc.); rethrowing
 * that raw hits the top-level handler as exit 70 (a CLI bug). A lost
 * connection is a retryable network condition instead. Narrow on purpose:
 * only clearly-network shapes classify; anything else rethrows raw so
 * genuine bugs keep exiting 70. AbortError is never seen here — callers map
 * it to cancelled() first so Ctrl-C still exits 130.
 */
export function midStreamAbortError(url: string, cause: unknown): unknown {
  if (cause instanceof Error && cause.name === "AbortError") return cause;
  const isNetwork =
    (cause instanceof TypeError &&
      (cause.message === "terminated" || cause.message === "fetch failed")) ||
    (cause instanceof Error &&
      cause.cause instanceof Error &&
      /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE)$/.test(
        (cause.cause as NodeJS.ErrnoException).code ?? "",
      ));
  if (!isNetwork) return cause;
  // Same credential scrubbing as fetchOrFail: undici reasons may echo the
  // request URL (userinfo included) and a rejected header value.
  const reason = redactSecrets(cause instanceof Error ? cause.message : String(cause));
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return "the gateway";
    }
  })();
  return new ApiError(
    SYNTHETIC_STATUS.UNREACHABLE,
    origin === "the gateway"
      ? `The connection was lost mid-response (${reason}).`
      : `The connection to ${origin} was lost mid-response (${reason}).`,
    {
      hint: "Re-run the command; if it keeps happening, check your network or the gateway status.",
    },
  );
}

/**
 * Parse a 2xx body as JSON. A gateway (or middlebox) answering 200 with
 * HTML/text is a gateway failure: report it as a 502 ApiError so `status`
 * files it under unreachable instead of crashing on a raw SyntaxError.
 */
export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text().catch((cause) => {
    throw midStreamAbortError(response.url, cause);
  });
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw gatewayNotJsonError(response, cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * A sessionless request with no Authorization header — the auth flow's
 * device endpoints (start/poll/rotate/revoke) and paste-key validation live
 * here. Network failures surface as ApiError with the same "Could not reach"
 * framing as every other request; the raw Response is returned so callers
 * can branch on status/error bodies before unwrapping.
 */
export async function publicRequest(url: string, init: RequestInit = {}): Promise<Response> {
  const { headers, ...rest } = init;
  assertSendableAuth(headers);
  let merged: Headers;
  try {
    merged = new Headers(headers);
  } catch (cause) {
    throw requestBuildError(url, cause);
  }
  if (!merged.has("Accept")) merged.set("Accept", "application/json");
  if (!merged.has("User-Agent")) merged.set("User-Agent", userAgent());
  return fetchOrFail(url, { ...rest, headers: merged });
}

/** Hard cap on gateway round-trips: an unroutable host otherwise hangs ~11s+ (OS TCP give-up). */
const FETCH_TIMEOUT_MS = 10_000;

async function fetchOrFail(url: string, init: RequestInit): Promise<Response> {
  assertSendableAuth(init.headers);
  let guarded = false;
  let response: Response;
  // Explicit caller signals win; otherwise apply the module timeout.
  const signal = init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    // A 307/308 resends the body, and fetch keeps Authorization on a
    // same-origin hop, so a request carrying a key, refresh token, device
    // code or PKCE verifier never follows a redirect: it reports one.
    guarded = carriesSecret(init);
    response = await fetch(
      url,
      guarded ? { ...init, signal, redirect: "manual" } : { ...init, signal },
    );
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      // A caller-provided signal aborting is a user Esc — propagate as
      // cancelled(). A timeout abort is indistinguishable by name (same
      // AbortError, TimeoutError cause), so only init.signal counts.
      if (init.signal?.aborted) throw cancelled();
      throw unreachable(url, "timed out after 10s");
    }
    // Only "fetch failed" is the network; any other TypeError is a request
    // fetch refused to build, which no retry or network fix will change.
    if (cause instanceof TypeError && cause.message !== "fetch failed") {
      throw requestBuildError(url, cause);
    }
    throw unreachable(url, cause instanceof Error ? cause.message : String(cause));
  }
  if (guarded && response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw redirectRefused(url, response);
  }
  return response;
}

function unreachable(url: string, reason: string): ApiError {
  // Undici interpolates the request URL (userinfo included) and a rejected
  // header value into its reasons, so the reason is scrubbed. The origin
  // below never carries userinfo (WHATWG origin is scheme + host + port).
  const scrubbed = redactSecrets(reason);
  return new ApiError(
    SYNTHETIC_STATUS.UNREACHABLE,
    `Could not reach ${new URL(url).origin}: ${scrubbed}`,
    {
      hint: "Check your network, or point at another environment with --base-url / AIAND_BASE_URL.",
    },
  );
}

function requestBuildError(url: string, cause: unknown): CliError {
  const reason = redactSecrets(cause instanceof Error ? cause.message : String(cause));
  return new CliError(`Could not build the request to ${new URL(url).origin}: ${reason}`);
}

function carriesSecret(init: RequestInit): boolean {
  if (init.body !== undefined && init.body !== null) return true;
  return new Headers(init.headers).has("Authorization");
}

function redirectRefused(url: string, response: Response): CliError {
  const from = new URL(url).origin;
  let to = "";
  try {
    const location = response.headers.get("Location");
    if (location) to = ` to ${new URL(location, url).origin}`;
  } catch {
    // An unparsable Location names nothing worth printing.
  }
  return new CliError(
    `${from} answered with a redirect (HTTP ${response.status}${to}); refusing to resend credentials to follow it.`,
    {
      hint: "Point --base-url / AIAND_BASE_URL (and AIAND_AUTH_URL) at the endpoint itself, not at an address that redirects.",
    },
  );
}

/** Error bodies are read this far and no further: a hostile or broken
 * endpoint can stream forever, and only the first lines are ever shown. */
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const ERROR_MESSAGE_MAX_CHARS = 500;

/** Read at most `maxBytes` of a body as text, then cancel the rest. */
export async function readBoundedText(
  response: Response,
  maxBytes = ERROR_BODY_MAX_BYTES,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.subarray(0, maxBytes - total);
      chunks.push(take);
      total += take.byteLength;
    }
  } catch {
    // A body that dies mid-read still has its first bytes worth showing.
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const clip = (text: string): string =>
  text.length > ERROR_MESSAGE_MAX_CHARS ? `${text.slice(0, ERROR_MESSAGE_MAX_CHARS)}…` : text;

async function toApiError(response: Response, envKey = false): Promise<ApiError> {
  const requestId = response.headers.get(HEADERS.REQUEST_ID) ?? undefined;
  const text = await readBoundedText(response);

  let message: string | undefined;
  let type: string | undefined;

  try {
    const body = JSON.parse(text) as {
      error?: string | { message?: string; type?: string };
      error_description?: string;
    };
    if (typeof body.error === "string") {
      message = body.error_description ?? body.error;
      type = body.error_description ? body.error : undefined;
    } else if (body.error?.message) {
      message = body.error.message;
      type = body.error.type;
    }
  } catch {
    // Not JSON (or cut off at the cap): the status line plus the body's first line below.
  }
  if (typeof message !== "string") {
    // The caller already prints "HTTP <status>: ", so the status text leads.
    const status = response.statusText || `HTTP ${response.status}`;
    const firstLine = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
    message = firstLine ? `${status}: ${firstLine}` : status;
  }

  return new ApiError(response.status, redactSecrets(clip(message)), {
    requestId,
    type,
    hint: hintFor(response, envKey),
  });
}

function hintFor(response: Response, envKey = false): string | undefined {
  if (response.status === 401) {
    // Under an env key `aiand login` is a no-op: the fix is the variable.
    return envKey
      ? "Your AIAND_API_KEY was rejected. Check the key, or unset it to use your stored login instead."
      : "Your key may have expired. Run `aiand login` again.";
  }
  if (response.status === 402) return "Top up credits at https://console.aiand.com/billing.";
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const policy = response.headers.get(HEADERS.RATE_LIMIT_POLICY);
    const parts = [
      retryAfter ? `Retry after ${retryAfter}s.` : "Slow down and retry.",
      policy ? `Policy: ${policy}.` : undefined,
    ];
    return parts.filter(Boolean).join(" ");
  }
  return undefined;
}

function userAgent(): string {
  return `aiand-cli/${VERSION} (node ${process.versions.node})`;
}

export const VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require("../../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
