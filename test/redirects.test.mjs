import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { withTestEnv } from "./helpers.mjs";

// A request carrying a key, refresh token, device code or PKCE verifier
// must never follow a redirect: a 307/308 resends the body, so following it
// hands the secret to wherever the Location points. Two loopback servers:
// one redirects everything, the other records whatever reaches it.

withTestEnv("aiand-redirects-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_API_KEY;
  process.env.CI = "1";
});

const { request, publicJson, publicRequest } = await import("../dist/api/client.js");
const { rotateTokens, startDeviceAuthorization, pollForToken } = await import(
  "../dist/api/device.js"
);
const { validateKey } = await import("../dist/api/account.js");
const { CliError, ApiError } = await import("../dist/cli/errors.js");

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const landed = [];
let target;
let redirector;
before(async () => {
  target = await listen((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      landed.push({ path: req.url, authorization: req.headers.authorization ?? null, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  redirector = await listen((req, res) => {
    req.resume();
    const status = req.url?.includes("302") ? 302 : 307;
    res.writeHead(status, { Location: `${target.url}${req.url}` });
    res.end();
  });
});
after(async () => {
  await target?.close();
  await redirector?.close();
});

/** Assert `promise` rejects with the redirect refusal and nothing landed. */
async function refused(promise) {
  const before = landed.length;
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e) => e,
  );
  assert.ok(error instanceof CliError, `got ${error}`);
  assert.ok(!(error instanceof ApiError), "a refusal is not a gateway status");
  assert.match(
    error.message,
    /answered with a redirect \(HTTP 30[27] to http:\/\/127\.0\.0\.1:\d+\)/,
  );
  assert.match(error.hint ?? "", /--base-url/);
  assert.deepEqual(landed.slice(before), []);
}

describe("credential-bearing requests refuse redirects", () => {
  test("an authenticated session request", () =>
    refused(
      request(
        {
          profile: { name: "t", apiUrl: redirector.url, authUrl: redirector.url },
          token: "sk-secret",
          credential: null,
        },
        { path: "/api/user" },
      ),
    ));

  test("paste-key validation", () => refused(validateKey("sk-secret", redirector.url)));

  test("the refresh-token grant", () => refused(rotateTokens(redirector.url, "rt-secret")));

  test("the device-code start and poll", async () => {
    await refused(startDeviceAuthorization(redirector.url));
    await refused(
      pollForToken(
        redirector.url,
        {
          device_code: "dc-secret",
          user_code: "U",
          verification_uri: "/v",
          verification_uri_complete: "/v",
          expires_in: 60,
          interval: 1,
        },
        { sleep: async () => {} },
      ),
    );
  });

  test("a 302 on a POST body (the PKCE exchange shape)", () =>
    refused(
      publicRequest(`${redirector.url}/auth/device/token?302`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code_verifier: "secret" }),
      }),
    ));
});

test("a request with no credential still follows a redirect", async () => {
  const before = landed.length;
  const body = await publicJson(`${redirector.url}/v1/models`);
  assert.deepEqual(body, { ok: true });
  assert.equal(landed.length, before + 1);
  assert.equal(landed.at(-1).authorization, null);
});
