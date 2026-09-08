import { ApiError, CliError } from "../cli/errors.js";
import { publicRequest } from "./client.js";

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

function devicePost(url: string, body: unknown): Promise<Response> {
  return publicRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

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
  return (await response.json()) as DeviceCodeResponse;
}

export function verificationUrl(
  authUrl: string,
  device: DeviceCodeResponse,
): string {
  const path = device.verification_uri_complete || device.verification_uri;
  return path.startsWith("http") ? path : `${authUrl}${path}`;
}

export type PollOptions = {
  onSlowDown?: (intervalSeconds: number) => void;
  signal?: AbortSignal;
};

export async function pollForToken(
  authUrl: string,
  device: DeviceCodeResponse,
  options: PollOptions = {},
): Promise<TokenResponse> {
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = Math.max(1, device.interval);

  for (;;) {
    if (options.signal?.aborted)
      throw new CliError("Login cancelled.", { exitCode: 130 });
    if (Date.now() >= deadline) {
      throw new CliError("The login code expired before it was approved.", {
        hint: "Run `aiand login` again.",
      });
    }

    await sleep(interval * 1000, options.signal);

    const response = await devicePost(`${authUrl}/auth/device/token`, {
      grant_type: DEVICE_GRANT,
      device_code: device.device_code,
    });

    if (response.ok) return (await response.json()) as TokenResponse;

    const body = (await response
      .json()
      .catch(() => ({}))) as Partial<TokenErrorBody>;
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        options.onSlowDown?.(interval);
        continue;
      case "access_denied":
        throw new CliError("Login was denied in the browser.", { exitCode: 3 });
      case "expired_token":
        throw new CliError("The login code expired before it was approved.", {
          hint: "Run `aiand login` again.",
        });
      default:
        throw new ApiError(
          response.status,
          body.error_description ?? body.error ?? "Device login failed.",
          { hint: "Run `aiand login` again." },
        );
    }
  }
}

export async function rotateTokens(
  authUrl: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const response = await devicePost(`${authUrl}/auth/device/token`, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (!response.ok) {
    throw new CliError("Your CLI session could not be refreshed.", {
      exitCode: 2,
      hint: "Run `aiand login` to sign in again.",
    });
  }
  return (await response.json()) as TokenResponse;
}

export async function revokeTokens(
  authUrl: string,
  refreshToken: string,
): Promise<boolean> {
  try {
    const response = await devicePost(`${authUrl}/auth/device/logout`, {
      refresh_token: refreshToken,
    });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    reject(new CliError("Login cancelled.", { exitCode: 130 }));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}
