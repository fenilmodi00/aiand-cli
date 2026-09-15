import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { CLIENT_ID, type TokenResponse } from "../api/device.js";
import { publicRequest } from "../api/client.js";
import { openBrowser } from "../cli/browser.js";

const DEFAULT_TIMEOUT_MS = 300_000;

export type BrowserFlowResult =
  | { ok: true; tokens: TokenResponse }
  | { ok: false; failure: string; fatal: boolean; unsupported?: boolean };

const SUCCESS_HTML =
  "<!doctype html><title>Signed in</title>" +
  '<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">' +
  "<p>Signed in &mdash; return to your terminal.</p></body>";

const FAILURE_HTML =
  "<!doctype html><title>Sign-in failed</title>" +
  '<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">' +
  "<p>Sign-in did not complete.</p></body>";

/** Every response closes the connection: a lingering keep-alive socket would
 * outlive server.close() and hang the flow. */
function respond(
  res: ServerResponse,
  success: boolean,
  onFlushed?: () => void
): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    Connection: "close",
  });
  // The deny/error page must reach the browser before settle() tears the
  // listener down — closeAllConnections() can destroy a socket whose write
  // is still queued, leaving the user a blank tab.
  res.end(success ? SUCCESS_HTML : FAILURE_HTML, onFlushed);
}

export type SignInOptions = {
  authUrl: string;
  /** Display name forwarded to the gateway as `key_name`. */
  keyName?: string;
  /** Opens the authorize URL; resolves true when a browser handled it. */
  open?: (url: string) => Promise<boolean>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStatus?: (line: string) => void;
};

/**
 * Browser sign-in: authorization code + PKCE against the gateway, the
 * redirect caught on a loopback HTTP listener. Falls back to the device flow
 * via the `{ok: false, unsupported}` result when the authorize preflight
 * answers 404/501 — the spec's "this server has no browser flow" markers.
 */
export async function signInViaLocalhostCallback(
  opts: SignInOptions,
): Promise<BrowserFlowResult> {
  const { authUrl, signal } = opts;
  const onStatus = opts.onStatus ?? (() => {});

  // Per the server contract: a 404/501 on GET /auth/authorize means this
  // server has no browser flow and the CLI silently falls back to the device
  // flow. Any other response (400/401/5xx…) is treated as an existing
  // authorize page — proceed with the browser attempt.
  let preflight: Response;
  try {
    preflight = await publicRequest(`${authUrl}/auth/authorize`, {
      method: "GET",
    });
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

  if (signal?.aborted)
    return { ok: false, failure: "Login cancelled.", fatal: false };

  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier).digest().toString("base64url");

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
      // closeAllConnections: a keep-alive socket that somehow bypassed the
      // Connection:close respond() path must never outlive the flow.
      server.closeAllConnections?.();
      server.close();
      resolveOutcome(result);
    };
    const onAbort = (): void =>
      settle({ failure: "Login cancelled.", fatal: false });

    // An exception inside the wiring below (a bad `open` seam throwing
    // synchronously, a listen error outside the 'error' handler) must never
    // strand the 300s timer or the listener: settle() always runs.
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const known = req.method === "GET" && url.pathname === "/";
      // The page is chosen before settling so a Deny click renders the
      // failure page. A forged callback (wrong/absent state) or a stray
      // path (favicon, probe) gets the polite landing page but never
      // settles the wait.
      const stateOk = known && url.searchParams.get("state") === state;
      const code = stateOk ? url.searchParams.get("code") : null;
      const error = stateOk ? url.searchParams.get("error") : null;
      let success = true;
      let pending: CallbackOutcome | null = null;
      if (code) {
        pending = { code };
      } else if (error === "access_denied") {
        success = false;
        pending = {
          failure: "Sign-in was cancelled in the browser.",
          fatal: true,
        };
      } else if (error) {
        success = false;
        pending = {
          failure: `Sign-in failed in the browser (${error}).`,
          fatal: false,
        };
      }
      // Settle only after the page is flushed, so teardown never races the
      // browser actually receiving it.
      respond(res, success, () => {
        if (pending && !settled) settle(pending);
      });
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
      () =>
        settle({
          failure: "Timed out waiting for the browser sign-in.",
          fatal: false,
        }),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const actualPort =
          typeof address === "object" && address ? address.port : 0;
        redirectUri = `http://127.0.0.1:${actualPort}`;
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
          opts.open ?? (async (url: string) => openBrowser(url));
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
    } catch (error) {
      settle({ failure: (error as Error).message, fatal: false });
    }
  });

  if ("failure" in outcome) return { ok: false, ...outcome };

  let response: Response;
  try {
    response = await publicRequest(`${authUrl}/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
