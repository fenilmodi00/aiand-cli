// Shared scaffolding for the auth behavioral tests (auth-login, auth-logout,
// auth-identity): a localhost stub server standing in for the device/API
// seams, per-test isolation hooks, and output/TTY capture. The profile's
// authUrl/apiUrl point at the stub via AIAND_BASE_URL/AIAND_AUTH_URL. No real
// network, no real TTY, no subprocess.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { captureStdio } from "./helpers.mjs";

/** What the stub gateway mints on every successful sign-in, and whom it signs in. */
export const MINTED_ACCESS_TOKEN = "sk-minted";
export const MINTED_REFRESH_TOKEN = "rt-minted";
export const STUB_USER_EMAIL = "dev@example.com";

// deviceLogin's wait between token polls. The real floor is 1s per poll; the
// stub server answers instantly, so a short tick keeps the loop honest
// without paying wall time.
export const fastSleep = () => new Promise((resolve) => setTimeout(resolve, 10));

/** The stub auth/API server: identity endpoints plus device-login endpoints. */
function stubServer() {
  const state = {
    /** Device-poll interval the stub advertises (seconds). */
    pollInterval: 0,
    revocations: [],
    /** Refresh tokens /auth/device/logout answers 500 for, to fail one profile's revoke alone. */
    rejectRefresh: [],
    /** /api/orgs payload; tests set two orgs to reach the picker. */
    orgs: [],
    /** org minted into the device-code grant; null omits it. */
    tokenOrg: null,
    /** last key_name seen on /auth/device/code. */
    keyName: null,
    /** /auth/authorize behavior: "redirect" 302s, "missing" 404s. */
    authorizeMode: "redirect",
    /** When "down", the device endpoints 500 — the device-to-paste fallback
     * path: service torn down, identity API still serving. */
    deviceMode: "up",
    /** When set, the device-code poll answers this RFC 8628 error (e.g. "access_denied"): a
     * sign-in that fails while every other endpoint, revoke included, still works. */
    tokenError: null,
    /** An HTTP status /auth/device/logout answers instead of 200 (a host that does not serve it: 404). */
    logoutStatus: null,
    /** Runs when a /auth/device/logout request arrives, before it is answered: a slow revoke's window. */
    onLogout: null,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/user") {
      // Paste-key validation: the bearer key decides acceptance.
      const auth = req.headers.authorization ?? "";
      if (auth === "Bearer sk-abc123" || auth === "Bearer sk-bad") {
        if (auth === "Bearer sk-bad") return reply(401, { error: "That key was rejected." });
        return reply(200, { id: "u1", email: "paste@example.com" });
      }
      return reply(200, { id: "u1", email: STUB_USER_EMAIL });
    }
    if (url.pathname === "/api/orgs") return reply(200, state.orgs);
    if (url.pathname === "/auth/authorize") {
      if (state.authorizeMode === "missing") return reply(404, { error: "not found" });
      const redirectUri = url.searchParams.get("redirect_uri");
      const requestState = url.searchParams.get("state");
      // The paramless GET is the CLI's pre-flight probe; only real authorize
      // requests (which carry state) get the 302.
      if (!requestState || !redirectUri) return reply(400, { error: "authorize needs params" });
      const target = new URL(redirectUri);
      target.searchParams.set("code", "ac_123");
      target.searchParams.set("state", requestState);
      res.writeHead(302, { Location: target.toString() });
      res.end();
      return;
    }
    if (state.deviceMode === "down" && url.pathname.startsWith("/auth/device/")) {
      return reply(500, { error: "device service is down" });
    }
    if (url.pathname === "/auth/device/code") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        state.keyName = JSON.parse(raw || "{}").key_name ?? null;
        reply(200, {
          device_code: "dc",
          user_code: "BCDF-GHJK",
          verification_uri: "/auth/device?user_code=BCDF-GHJK",
          verification_uri_complete: "",
          expires_in: 600,
          // The device spec says wait `interval` before polling; the harness
          // has no reason to pay that in wall time (state.pollInterval=0).
          interval: state.pollInterval ?? 0,
        });
      });
      return;
    }
    if (url.pathname === "/auth/device/logout") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const params = JSON.parse(raw || "{}");
        state.onLogout?.();
        if (state.logoutStatus !== null) {
          return reply(state.logoutStatus, { error: "not served here" });
        }
        if (state.rejectRefresh.includes(params.refresh_token)) {
          return reply(500, { error: "revoke failed" });
        }
        state.revocations.push(params.refresh_token ?? null);
        reply(200, { ok: true });
      });
      return;
    }
    if (url.pathname === "/auth/device/token") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (res.writableEnded) return;
        const params = JSON.parse(raw || "{}");
        if (params.grant_type === "authorization_code") {
          return reply(200, {
            access_token: MINTED_ACCESS_TOKEN,
            refresh_token: MINTED_REFRESH_TOKEN,
            token_type: "Bearer",
            expires_in: 2592000,
            org: { id: "org_2", name: "Second" },
          });
        }
        if (params.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
          if (state.tokenError) return reply(400, { error: state.tokenError });
          return reply(200, {
            access_token: MINTED_ACCESS_TOKEN,
            refresh_token: MINTED_REFRESH_TOKEN,
            token_type: "Bearer",
            expires_in: 2592000,
            ...(state.tokenOrg ? { org: state.tokenOrg } : {}),
          });
        }
        reply(400, { error: "unsupported_grant_type" });
      });
      return;
    }
    reply(404, { error: "not found" });
  });
  return { server, state };
}

// Live bindings: registerAuthStub()'s hooks reassign these per test, and
// importers read the current value.
export let dir;
export let server;
export let state;
export let baseUrl;

/** Register the per-test stub server + env isolation hooks in the calling file. */
export function registerAuthStub() {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "aiand-auth-"));
    process.env.AIAND_CONFIG_DIR = dir;
    process.env.AIAND_HOME = join(dir, "home");
    delete process.env.AIAND_API_KEY;
    delete process.env.AIAND_PROFILE;
    delete process.env.AIAND_KEY_STORAGE;
    ({ server, state } = stubServer());
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.AIAND_BASE_URL = baseUrl;
    process.env.AIAND_AUTH_URL = baseUrl;
  });
  afterEach(() => {
    server.closeAllConnections?.();
    server.close();
    delete process.env.AIAND_KEY_STORAGE;
    delete process.env.AIAND_BASE_URL;
    delete process.env.AIAND_AUTH_URL;
    rmSync(dir, { recursive: true, force: true });
  });
}

/** The binding a sign-in against the stub records (login passes it to saveCredential). */
export const stubBinding = () => ({ auth_url: baseUrl, api_url: baseUrl });

/** Capture CLI output; node:test's own frames pass through (captureStdio). */
export function captureOutput() {
  return captureStdio();
}

/** CLI stdout as one string. */
export function cliStdout(captured) {
  return captured.log.out.join("");
}

/** Stub the real TTYs so isInteractive() is true without a terminal. */
export function stubTTY() {
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
  });
  return () => {
    if (stdinDesc) Object.defineProperty(process.stdin, "isTTY", stdinDesc);
    else delete process.stdin.isTTY;
    if (stdoutDesc) Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
    else delete process.stdout.isTTY;
  };
}

/** Fake opener mirroring test/browser-flow.test.mjs: follow the 302 into loopback. */
export function browserOpener() {
  return async (url) => {
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 302);
    await fetch(res.headers.get("location"));
    return true;
  };
}

export const TWO_ORGS = [
  { id: "org_1", name: "First" },
  { id: "org_2", name: "Second" },
];
