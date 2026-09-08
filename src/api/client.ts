import { createRequire } from "node:module";
import { ApiError, CliError, NotLoggedInError } from "../cli/errors.js";
import {
  loadCredential,
  saveCredential,
  type ResolvedProfile,
  type Credential,
  type LoadedCredential,
} from "../config.js";
import { rotateTokens } from "./device.js";

const ROTATE_BEFORE_SECONDS = 60 * 60 * 24 * 3;

export const HEADERS = {
  METRICS: "X-Aiand-Metrics",
  MODEL: "X-Model",
  COST: "X-Cost",
  COST_CURRENCY: "X-Cost-Currency",
  INFERENCE_MS: "X-Inference-Ms",
  REASONING_EFFORT: "X-Reasoning-Effort",
  EMPTY_COMPLETION: "X-Empty-Completion",
  REQUEST_ID: "X-Request-ID",
  RATE_LIMIT_LIMIT: "X-RateLimit-Limit",
  RATE_LIMIT_REMAINING: "X-RateLimit-Remaining",
  RATE_LIMIT_POLICY: "X-RateLimit-Policy",
} as const;

export type Session = {
  profile: ResolvedProfile;

  token: string;

  credential: LoadedCredential | null;
};

export async function openSession(profile: ResolvedProfile): Promise<Session> {
  const fromEnv = process.env.AIAND_API_KEY;
  if (fromEnv) return { profile, token: fromEnv, credential: null };

  const stored = await loadCredential(profile.name);
  if (!stored) throw new NotLoggedInError();

  // A pasted key has no refresh token: rotation is impossible and a 401 must
  // surface as the plain hint, so hand it back as-is regardless of expiry.
  if (!stored.refresh_token) {
    return { profile, token: stored.access_token, credential: stored };
  }

  const secondsLeft = (stored.expires_at ?? 0) - Math.floor(Date.now() / 1000);
  if (secondsLeft > ROTATE_BEFORE_SECONDS) {
    return { profile, token: stored.access_token, credential: stored };
  }
  return { profile, ...(await refresh(profile, stored)) };
}
async function refresh(
  profile: ResolvedProfile,
  stored: LoadedCredential
): Promise<{ token: string; credential: LoadedCredential }> {
  // Callers guard on refresh_token existing; this is the rotation path only.
  const refreshToken = stored.refresh_token;
  if (!refreshToken) throw new CliError("This credential has no refresh token.");
  const tokens = await rotateTokens(profile.authUrl, refreshToken);
  const next: LoadedCredential = {
    ...stored,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
  };
  await saveCredential(profile.name, next);
  return { token: next.access_token, credential: next };
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
    const rotated = await refresh(session.profile, session.credential);
    session.token = rotated.token;
    session.credential = rotated.credential;
    response = await send(session.token);
  }

  if (!response.ok) throw await toApiError(response);
  return response;
}

export async function requestJson<T>(session: Session, options: RequestOptions): Promise<T> {
  const response = await request(session, options);
  return (await response.json()) as T;
}

export async function publicJson<T>(url: string): Promise<T> {
  const response = await fetchOrFail(url, {
    headers: { Accept: "application/json", "User-Agent": userAgent() },
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
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
  return fetchOrFail(url, {
    ...rest,
    headers: {
      Accept: "application/json",
      "User-Agent": userAgent(),
      ...(rest.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers as Record<string, string>),
    },
  });
}

async function fetchOrFail(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new CliError("Cancelled.", { exitCode: 130 });
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ApiError(0, `Could not reach ${new URL(url).origin}: ${reason}`, {
      hint: "Check your network, or point at another environment with --env / AIAND_BASE_URL.",
    });
  }
}

async function toApiError(response: Response): Promise<ApiError> {
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
  }

  return new ApiError(response.status, message, {
    requestId,
    type,
    hint: hintFor(response),
  });
}

function hintFor(response: Response): string | undefined {
  if (response.status === 401) return "Your key may have expired. Run `aiand login` again.";
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

export function userAgent(): string {
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

