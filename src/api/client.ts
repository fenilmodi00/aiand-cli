import { createRequire } from "node:module";
import { join } from "node:path";
import {
  ApiError,
  CliError,
  cancelled,
  NotLoggedInError,
  SYNTHETIC_STATUS,
} from "../cli/errors.js";
import { err, style } from "../cli/output.js";
import {
  type LoadedCredential,
  loadCredential,
  type ResolvedProfile,
  saveCredential,
} from "../config.js";
import { configDir, withFileLock } from "../fsutil.js";
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
  token: string;
  /** null under AIAND_API_KEY: nothing stored, nothing to rotate. */
  credential: LoadedCredential | null;
};

export async function openSession(profile: ResolvedProfile): Promise<Session> {
  // Whitespace-only is unset: a truthy read would wire a literal all-spaces
  // key into agent configs. Padding wires trimmed (like login's stdin read)
  // instead of baking whitespace that 401s every request.
  const fromEnv = process.env.AIAND_API_KEY?.trim() || undefined;
  if (fromEnv) return { profile, token: fromEnv, credential: null };

  const stored = await loadCredential(profile.name);
  if (!stored) throw new NotLoggedInError();

  // A pasted key has no refresh token: rotation is impossible and a 401 must
  // surface as the plain hint, so hand it back as-is regardless of expiry.
  if (!stored.refresh_token) {
    return { profile, token: stored.access_token, credential: stored };
  }

  const secondsLeft = (stored.expires_at ?? 0) - nowSeconds();
  if (secondsLeft > ROTATE_BEFORE_SECONDS) {
    return { profile, token: stored.access_token, credential: stored };
  }
  return { profile, ...(await refresh(profile, stored, { expiring: true })) };
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
  const lock = join(configDir(), "locks", `refresh-${profile.name}`);
  const promise = withFileLock(lock, async () => {
    // Another process may have rotated since this session loaded `stored`;
    // the persisted credential is what agents were last baked with.
    const current = (await loadCredential(profile.name)) ?? stored;
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
    const tokens = await rotateTokens(profile.authUrl, refreshToken);
    const next: LoadedCredential = {
      ...current,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: nowSeconds() + tokens.expires_in,
    };
    await saveCredential(profile.name, next);
    // Rebake: agents wired with the rotated key get the new one, or they would
    // keep a key that expires (or is revoked) while the CLI moves on.
    const { rebakeAgentKeys } = await import("../agents/rebake.js");
    for (const note of await rebakeAgentKeys(next.access_token, {
      previousKey: current.access_token,
    })) {
      err(style.dim(`[${note.agent}] ${note.note}`));
    }
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

    const url = buildUrl(options.baseUrl ?? session.profile.apiUrl, options.path, options.query);
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
    `The gateway returned a response that is not valid JSON (${detail}).`,
    {
      requestId: response.headers.get(HEADERS.REQUEST_ID) ?? undefined,
      hint: "The gateway may be down, or a middlebox may be intercepting requests. Retry, or check --base-url / AIAND_BASE_URL.",
    },
  );
}

/**
 * Parse a 2xx body as JSON. A gateway (or middlebox) answering 200 with
 * HTML/text is a gateway failure: report it as a 502 ApiError so `status`
 * files it under unreachable instead of crashing on a raw SyntaxError.
 */
export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
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
  const merged = new Headers(headers);
  if (!merged.has("Accept")) merged.set("Accept", "application/json");
  if (!merged.has("User-Agent")) merged.set("User-Agent", userAgent());
  return fetchOrFail(url, { ...rest, headers: merged });
}

async function fetchOrFail(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      throw cancelled();
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    // Undici interpolates the request URL into its refusal reasons, so a
    // credential-embedded base URL would echo userinfo here: scrub it.
    // The origin below never carries userinfo (WHATWG origin is
    // scheme + host + port), so only the reason needs scrubbing.
    throw new ApiError(
      SYNTHETIC_STATUS.UNREACHABLE,
      `Could not reach ${new URL(url).origin}: ${scrubCredentials(reason)}`,
      {
        hint: "Check your network, or point at another environment with --base-url / AIAND_BASE_URL.",
      },
    );
  }
}

/**
 * Redact `://user:pass@` userinfo from an error string (undici refusal
 * reasons carry the full request URL). The replacement names the redaction
 * so a scrubbed message is recognizable as one.
 */
export function scrubCredentials(text: string): string {
  return text.replace(/:\/\/[^/\s@]+@/g, "://[redacted]@");
}

async function toApiError(response: Response, envKey = false): Promise<ApiError> {
  const requestId = response.headers.get(HEADERS.REQUEST_ID) ?? undefined;
  const text = await response.text().catch(() => "");

  let message = text.trim() || response.statusText || `HTTP ${response.status}`;
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
    // Not JSON: keep the raw text (or status line) as the message.
  }

  return new ApiError(response.status, message, {
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
