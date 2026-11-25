import { ApiError, CliError, EXIT, loginCancelled } from "../cli/errors.js";
import { isLoopbackHost } from "../config.js";
import { SECOND_MS } from "../time.js";
import { parseJsonResponse, publicRequest, readBoundedText } from "./client.js";

export const CLIENT_ID = "aiand-cli";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  org?: { id: string; name: string };
};

type TokenErrorBody = { error: string; error_description?: string };

function devicePost(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return publicRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/** Long enough for a slow gateway, short enough that the refresh lock is not held for good. */
const ROTATE_TIMEOUT_MS = 30_000;

export async function startDeviceAuthorization(
  authUrl: string,
  opts: { keyName?: string } = {},
): Promise<DeviceCodeResponse> {
  const body: Record<string, string> = { client_id: CLIENT_ID };
  if (opts.keyName) body.key_name = opts.keyName;
  const response = await devicePost(`${authUrl}/auth/device/code`, body);
  if (!response.ok) {
    throw new ApiError(response.status, "Could not start a device login.", {
      hint: `${authUrl} did not accept the request (HTTP ${response.status}).`,
    });
  }
  return parseJsonResponse<DeviceCodeResponse>(response);
}

export function verificationUrl(authUrl: string, device: DeviceCodeResponse): string {
  const raw = device.verification_uri_complete || device.verification_uri;
  let resolved: URL;
  let auth: URL;
  try {
    auth = new URL(authUrl);
    resolved = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(raw, `${auth.origin}/`);
  } catch {
    throw new CliError("The login URL from the server was not valid.", {
      hint: "Run `aiand login` again, or pass --base-url if you meant a different gateway.",
    });
  }
  const host = resolved.hostname.replace(/^\[|\]$/g, "");
  const httpsOrLoopback =
    resolved.protocol === "https:" || (resolved.protocol === "http:" && isLoopbackHost(host));
  if (!httpsOrLoopback || resolved.origin !== auth.origin) {
    throw new CliError("The login URL from the server was not on this gateway.", {
      hint: "Run `aiand login` again, or pass --base-url if you meant a different gateway.",
    });
  }
  return resolved.toString();
}

type PollOptions = {
  onSlowDown?: (intervalSeconds: number) => void;
  signal?: AbortSignal;
  /** Test seam: the wait between polls (defaults to a real, abortable timer). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function codeExpired(): CliError {
  return new CliError("The login code expired before it was approved.", {
    exitCode: EXIT.LOGIN_DENIED,
    hint: "Run `aiand login` again.",
  });
}

export async function pollForToken(
  authUrl: string,
  device: DeviceCodeResponse,
  options: PollOptions = {},
): Promise<TokenResponse> {
  const deadline = Date.now() + device.expires_in * SECOND_MS;
  let interval = Math.max(1, device.interval);
  const wait = options.sleep ?? sleep;

  for (;;) {
    if (options.signal?.aborted) throw loginCancelled();
    if (Date.now() >= deadline) throw codeExpired();

    await wait(interval * SECOND_MS, options.signal);

    const response = await devicePost(`${authUrl}/auth/device/token`, {
      grant_type: DEVICE_GRANT,
      device_code: device.device_code,
    });

    if (response.ok) return parseJsonResponse<TokenResponse>(response);

    let body: Partial<TokenErrorBody> = {};
    try {
      // Any JSON parses: `null`, an array or a number must not reach the field reads below.
      const parsed: unknown = JSON.parse(await readBoundedText(response));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const { error, error_description } = parsed as Record<string, unknown>;
        body = {
          error: typeof error === "string" ? error : undefined,
          error_description: typeof error_description === "string" ? error_description : undefined,
        };
      }
    } catch {
      // Not JSON: falls to the default case below.
    }
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        options.onSlowDown?.(interval);
        continue;
      case "access_denied":
        throw new CliError("Login was denied in the browser.", { exitCode: EXIT.LOGIN_DENIED });
      case "expired_token":
        throw codeExpired();
      default:
        throw new ApiError(
          response.status,
          (body.error_description || body.error || "Device login failed.").slice(0, 500),
          { hint: "Run `aiand login` again." },
        );
    }
  }
}

export async function rotateTokens(
  authUrl: string,
  refreshToken: string,
  { timeoutMs = ROTATE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<TokenResponse> {
  const response = await devicePost(
    `${authUrl}/auth/device/token`,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    AbortSignal.timeout(timeoutMs),
  );
  if (!response.ok) {
    throw new CliError("Your CLI session could not be refreshed.", {
      exitCode: EXIT.NOT_SIGNED_IN,
      hint: "Run `aiand login` to sign in again.",
    });
  }
  return parseJsonResponse<TokenResponse>(response);
}

/**
 * Ask the issuer to revoke a refresh token. The gateway answers 200 for a token
 * it does not know or already revoked, so anything else means the key was not
 * revoked: `status` is the HTTP status when the server answered at all, and
 * absent when it could not be reached.
 */
export async function revokeTokens(
  authUrl: string,
  refreshToken: string,
): Promise<{ revoked: boolean; status?: number }> {
  try {
    const response = await devicePost(`${authUrl}/auth/device/logout`, {
      refresh_token: refreshToken,
    });
    return response.ok ? { revoked: true } : { revoked: false, status: response.status };
  } catch {
    return { revoked: false };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    reject(loginCancelled());
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}
