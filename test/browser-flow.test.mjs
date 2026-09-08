import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests for the browser (localhost-callback PKCE) sign-in through the
// compiled dist build, against a stub auth server. No real network beyond
// loopback, no real browser.

const browser = await import("../dist/auth/browser.js");

const TOKENS = {
  access_token: "sk-browser",
  refresh_token: "rt-browser",
  token_type: "Bearer",
  expires_in: 2592000,
  org: { id: "org_1", name: "Acme" },
};

/**
 * Stub auth server. `mode` selects the /auth/authorize behavior; every mode
 * records authorize query params and token-exchange bodies in `state` for
 * assertions.
 */
function stubServer(mode) {
  const state = {
    authorizeParams: [],
    tokenBodies: [],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, headers);
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (url.pathname === "/auth/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const requestState = url.searchParams.get("state");
      state.authorizeParams.push(Object.fromEntries(url.searchParams));
      if (mode === "unsupported") return reply(404, { error: "not found" });
      // Paramless GET is the CLI's pre-flight probe; only real authorize
      // requests (which carry state) get the 302.
      if (!requestState) return reply(200, { ok: true });
      const target = new URL(redirectUri);
      if (mode === "denied") {
        target.searchParams.set("error", "access_denied");
        target.searchParams.set("state", requestState);
      } else {
        target.searchParams.set("code", "ac_123");
        target.searchParams.set("state", requestState);
      }
      return reply(302, undefined, { Location: target.toString() });
    }
    if (url.pathname === "/auth/device/token") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const params = JSON.parse(raw || "{}");
        state.tokenBodies.push(params);
        if (params.grant_type === "authorization_code")
          return reply(200, TOKENS);
        reply(400, { error: "unsupported_grant_type" });
      });
      return;
    }
    reply(404, { error: "not found" });
  });
  return { server, state };
}

let dir;
let server;
let state;
let authUrl;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aiand-browser-flow-"));
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_HOME = join(dir, "home");
  ({ server, state } = stubServer("happy"));
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  authUrl = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => {
  server.closeAllConnections?.();
  server.close();
  delete process.env.AIAND_CONFIG_DIR;
  delete process.env.AIAND_HOME;
  rmSync(dir, { recursive: true, force: true });
});

/** Fake opener: follows the authorize 302 into the callback server. */
function browserOpener() {
  return async (url) => {
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 302);
    await fetch(res.headers.get("location"));
    return true;
  };
}

describe("signInViaLocalhostCallback", () => {
  test("end-to-end: authorize 302 -> callback -> token exchange", async () => {
    const statuses = [];
    const result = await browser.signInViaLocalhostCallback({
      authUrl,
      keyName: "aiand@testhost",
      open: browserOpener(),
      onStatus: (line) => statuses.push(line),
    });
    assert.equal(result.ok, true);
    assert.equal(result.tokens.access_token, "sk-browser");
    assert.deepEqual(result.tokens.org, { id: "org_1", name: "Acme" });

    // Authorize request carried PKCE S256, loopback redirect_uri, state,
    // and the key name.
    // Pre-flight probe is params-less; the real authorize request carries state.
    const params = state.authorizeParams.find((p) => p.state);
    assert.equal(params.client_id, "aiand-cli");
    assert.equal(params.response_type, "code");
    assert.equal(params.code_challenge_method, "S256");
    assert.match(params.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.match(params.state, /^[A-Za-z0-9_-]{22}$/);
    assert.match(params.redirect_uri, /^http:\/\/localhost:\d+$/);
    assert.equal(params.key_name, "aiand@testhost");

    // Exchange carried the code and a valid base64url verifier.
    assert.equal(state.tokenBodies.length, 1);
    const exchange = state.tokenBodies[0];
    assert.equal(exchange.grant_type, "authorization_code");
    assert.equal(exchange.code, "ac_123");
    assert.equal(exchange.client_id, "aiand-cli");
    assert.equal(exchange.redirect_uri, params.redirect_uri);
    assert.match(exchange.code_verifier, /^[A-Za-z0-9_-]{43}$/);

    // Opened-browser status lines went through onStatus.
    assert.ok(statuses.some((line) => line.includes("Opened your browser")));
    assert.ok(statuses.some((line) => line.includes("/auth/authorize?")));
  });

  test("mismatched-state callback is ignored; matching state resolves", async () => {
    let callbackPort;
    let ourState;
    const result = await browser.signInViaLocalhostCallback({
      authUrl,
      open: async (url) => {
        const authorize = new URL(url);
        ourState = authorize.searchParams.get("state");
        callbackPort = new URL(authorize.searchParams.get("redirect_uri")).port;
        // Forged callback with the wrong state must not settle the flow.
        await fetch(`http://127.0.0.1:${callbackPort}/?code=first&state=WRONG`);
        await fetch(
          `http://127.0.0.1:${callbackPort}/?code=good&state=${ourState}`,
        );
        return false;
      },
      timeoutMs: 5000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.tokens.access_token, "sk-browser");
    assert.equal(state.tokenBodies[0].code, "good");
  });

  test("timeout -> non-fatal failure", async () => {
    const result = await browser.signInViaLocalhostCallback({
      authUrl,
      open: async () => false,
      timeoutMs: 50,
    });
    assert.deepEqual(result, {
      ok: false,
      failure: "Timed out waiting for the browser sign-in.",
      fatal: false,
    });
  });

  test("throwing opener settles at the timeout, never strands the wait", async () => {
    // Regression: an exception from the opener seam was swallowed by the
    // status-line catch, leaving the 300s callback timer as the only thing
    // keeping a --test worker alive past its run. Must settle at timeoutMs.
    const result = await browser.signInViaLocalhostCallback({
      authUrl,
      open: async () => {
        throw new Error("opener exploded");
      },
      timeoutMs: 100,
    });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, false);
    assert.match(result.failure, /Timed out|opener exploded/);
  });

  test("pre-flight 404 -> unsupported, no token exchange", async () => {
    server.close();
    ({ server, state } = stubServer("unsupported"));
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    authUrl = `http://127.0.0.1:${server.address().port}`;

    const result = await browser.signInViaLocalhostCallback({
      authUrl,
      open: async () => {
        assert.fail("browser must not be opened when unsupported");
      },
    });
    assert.deepEqual(result, {
      ok: false,
      failure: "Browser sign-in is not supported by this server.",
      fatal: false,
      unsupported: true,
    });
    assert.equal(state.authorizeParams.length, 1); // pre-flight probe only
    assert.equal(state.tokenBodies.length, 0);
  });

  test("browser denial (access_denied) -> fatal failure", async () => {
    server.closeAllConnections?.();
    server.close();
    ({ server, state } = stubServer("denied"));
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    authUrl = `http://127.0.0.1:${server.address().port}`;

    const result = await browser.signInViaLocalhostCallback({
      authUrl,
      open: browserOpener(),
    });
    assert.deepEqual(result, {
      ok: false,
      failure: "Sign-in was cancelled in the browser.",
      fatal: true,
    });
    assert.equal(state.tokenBodies.length, 0);
  });
});
