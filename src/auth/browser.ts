import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { CLIENT_ID, type TokenResponse } from "../api/device.js";
import { publicRequest } from "../api/client.js";
import { openBrowserAware } from "../cli/browser.js";

const DEFAULT_TIMEOUT_MS = 300_000;

export type BrowserFlowResult =
  | { ok: true; tokens: TokenResponse }
  | { ok: false; failure: string; fatal: boolean; unsupported?: boolean };

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const SUCCESS_HTML =
  '<!doctype html><title>Signed in</title>' +
  '<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">' +
  "<p>Signed in &mdash; return to your terminal.</p></body>";

const FAILURE_HTML =
  '<!doctype html><title>Sign-in failed</title>' +
  '<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">' +
  "<p>Sign-in did not complete.</p></body>";

/** Every response closes the connection: a lingering keep-alive socket would
 * outlive server.close() and hang the flow. */
function respond(res: ServerResponse, success: boolean): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    Connection: "close",
  });
  res.end(success ? SUCCESS_HTML : FAILURE_HTML);
}

export type SignInOptions = {
  authUrl: string;
  /** Display name forwarded to the gateway as `key_name`. */
  keyName?: string;
  /** Opens the authorize URL; resolves true when a browser handled it. */
  open?: (url: string) => Promise<boolean>;
  /** Callback port; default 0 = pick an ephemeral one. */
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStatus?: (line: string) => void;
};

/**
 * Browser sign-in: authorization code + PKCE against the gateway, the
 * redirect caught on a loopback HTTP listener. Falls back to the device flow
 * via the `{ok: false, unsupported}` result when the server has no authorize
 * endpoint (pre-flight 404/501).
 */
export async function signInViaLocalhostCallback(opts: SignInOptions): Promise<BrowserFlowResult> {
  const { authUrl, signal } = opts;
  const onStatus = opts.onStatus ?? (() => {});

  // Pre-flight: a 404/501 on /auth/authorize means no browser support; any
  // other status (including 400 on the empty probe) proceeds.
  let preflight: Response;
  try {
    preflight = await publicRequest(`${authUrl}/auth/authorize`, { method: "GET" });
  } catch (error) {
    return { ok: false, failure: (error as Error).message, fatal: false };
  }
  if (preflight.status === 404 || preflight.status === 501) {
    return {
      ok: false,
      failure: "Browser sign-in is not supported by this server.",
      fatal: false,
      unsupported: true,
    };
  }

  if (signal?.aborted) return { ok: false, failure: "Login cancelled.", fatal: false };

  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const codeChallenge = base64url(createHash("sha256").update(verifier).digest());

  type CallbackOutcome = { code: string } | { failure: string; fatal: boolean };
  let redirectUri = "";

  const outcome = await new Promise<CallbackOutcome>((resolveOutcome) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let server: Server;

    const settle = (result: CallbackOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      server.close();
      resolveOutcome(result);
    };
    const onAbort = (): void => settle({ failure: "Login cancelled.", fatal: false });

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const known = req.method === "GET" && url.pathname === "/";
      respond(res, known);
      if (!known || settled) return;
      // A forged or foreign callback (wrong/absent state) gets a polite page
      // but must never settle the wait.
      if (url.searchParams.get("state") !== state) return;
      const code = url.searchParams.get("code");
      if (code) return settle({ code });
      const error = url.searchParams.get("error");
      if (error === "access_denied") {
        return settle({ failure: "Sign-in was cancelled in the browser.", fatal: true });
      }
      if (error) return settle({ failure: `Sign-in failed in the browser (${error}).`, fatal: false });
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      settle({
        failure:
          error.code === "EADDRINUSE"
            ? "Port in use (is another sign-in running?)"
            : error.message,
        fatal: false,
      });
    });

    timer = setTimeout(
      () => settle({ failure: "Timed out waiting for the browser sign-in.", fatal: false }),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    signal?.addEventListener("abort", onAbort, { once: true });

    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : 0;
      redirectUri = `http://localhost:${actualPort}`;
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: redirectUri,
        state,
        code_challenge_method: "S256",
        code_challenge: codeChallenge,
      });
      if (opts.keyName) params.set("key_name", opts.keyName);
      const authorizeUrl = `${authUrl}/auth/authorize?${params}`;

      const opener =
        opts.open ?? (async (url: string) => openBrowserAware(url) === "opened");
      opener(authorizeUrl)
        .then((opened) => {
          if (opened) {
            onStatus("Opened your browser — finish signing in there.");
            onStatus(`If it did not open, visit: ${authorizeUrl}`);
          } else {
            onStatus(`Open this URL to sign in: ${authorizeUrl}`);
          }
        })
        .catch(() => onStatus(`Open this URL to sign in: ${authorizeUrl}`));
    });
  });

  if ("failure" in outcome) return { ok: false, ...outcome };

  let response: Response;
  try {
    response = await publicRequest(`${authUrl}/auth/device/token`, {
      method: "POST",
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: outcome.code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
      }),
    });
  } catch (error) {
    return { ok: false, failure: (error as Error).message, fatal: false };
  }
  if (!response.ok) {
    return {
      ok: false,
      failure: `The sign-in service rejected the browser sign-in (HTTP ${response.status}).`,
      fatal: false,
    };
  }
  const tokens = (await response.json()) as TokenResponse;
  return { ok: true, tokens };
}
