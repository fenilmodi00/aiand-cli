import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { describe } from "node:test";
import { CLOSED_URL, cliEnv, runCli, withFetch, withTestEnv } from "./helpers.mjs";

// A key with a line break or space must be refused before it reaches a
// header (Headers rejects it by quoting the value whole), and any error text
// that could echo a key or bearer token is scrubbed.

const env = withTestEnv("aiand-key-hygiene-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_KEY_STORAGE = "plaintext";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  process.env.CI = "1";
  process.env.NO_COLOR = "1";
});

const { request, publicRequest, requestJson } = await import("../dist/api/client.js");
const { validateKey } = await import("../dist/api/account.js");
const { pasteLogin } = await import("../dist/auth/login.js");
const config = await import("../dist/config.js");
const { redactSecrets } = await import("../dist/cli/redact.js");
const { ApiError, CliError } = await import("../dist/cli/errors.js");

const INVALID = /^API key contains invalid characters \(check for a line break or space\)$/;
const TWO_LINES = "sk-firstline1234\nsk-secondline5678";

const reject = (promise) =>
  promise.then(
    () => assert.fail("expected a rejection"),
    (e) => e,
  );

const noFetch = (fn) => withFetch(() => assert.fail("nothing may be sent"), fn);

describe("invalid keys never reach a header", () => {
  test("AIAND_API_KEY spanning two lines is refused without echoing it", async () => {
    const { code, stderr, stdout } = await runCli(["whoami"], {
      env: cliEnv({
        AIAND_CONFIG_DIR: env.dir,
        AIAND_HOME: join(env.dir, "home"),
        AIAND_API_KEY: TWO_LINES,
        AIAND_BASE_URL: CLOSED_URL,
      }),
    });
    assert.equal(code, 1);
    assert.match(stderr, /API key contains invalid characters/);
    assert.doesNotMatch(stderr + stdout, /firstline|secondline/);
    assert.doesNotMatch(stderr, /Could not reach/);
  });

  test("login --with-token refuses a key with an inner space", async () => {
    const { code, stderr } = await runCli(["login", "--with-token"], {
      env: cliEnv({
        AIAND_CONFIG_DIR: env.dir,
        AIAND_HOME: join(env.dir, "home"),
        AIAND_API_KEY: undefined,
        AIAND_BASE_URL: CLOSED_URL,
      }),
      input: "sk-abc def\n",
    });
    assert.equal(code, 1);
    assert.match(stderr, /API key contains invalid characters/);
  });

  test("paste login and validateKey refuse before any request", async () => {
    await noFetch(async () => {
      for (const promise of [
        pasteLogin({ key: "sk-abc\tdef" }),
        validateKey("sk-abc\r\ndef", CLOSED_URL),
      ]) {
        const error = await reject(promise);
        assert.ok(error instanceof CliError);
        assert.match(error.message, INVALID);
      }
    });
  });

  test("saveCredential refuses to store one", async () => {
    const error = await reject(config.saveCredential("default", { access_token: TWO_LINES }));
    assert.match(error.message, INVALID);
  });

  test("request() and publicRequest() refuse one as a CliError, not a TypeError", async () => {
    await noFetch(async () => {
      const session = {
        profile: { name: "t", apiUrl: CLOSED_URL, authUrl: CLOSED_URL },
        token: TWO_LINES,
        credential: null,
      };
      for (const promise of [
        request(session, { path: "/api/user" }),
        publicRequest(`${CLOSED_URL}/x`, { headers: { authorization: `Bearer ${TWO_LINES}` } }),
        publicRequest(`${CLOSED_URL}/x`, { headers: [["Authorization", "Bearer sk-a b"]] }),
      ]) {
        const error = await reject(promise);
        assert.ok(error instanceof CliError, `got ${error}`);
        assert.match(error.message, INVALID);
        assert.doesNotMatch(error.message, /firstline/);
      }
    });
  });

  test("a header fetch refuses to build is not reported as unreachable, and is redacted", async () => {
    // Not Authorization, so it passes the key check and fails in Headers.
    const error = await reject(
      publicRequest(`${CLOSED_URL}/x`, { headers: [["X-Token", "Bearer sk-leak123\nrest"]] }),
    );
    assert.ok(error instanceof CliError);
    assert.ok(!(error instanceof ApiError), "not an unreachable ApiError");
    assert.match(error.message, /^Could not build the request to http:\/\/127\.0\.0\.1:9: /);
    assert.doesNotMatch(error.message, /sk-leak123/);

    // The same through request(), where fetch itself is what refuses.
    const viaFetch = await reject(
      request(
        {
          profile: { name: "t", apiUrl: CLOSED_URL, authUrl: CLOSED_URL },
          token: "sk-ok",
          credential: null,
        },
        { path: "/x", headers: { "X-Token": "Bearer sk-leak456\nrest" } },
      ),
    );
    assert.ok(!(viaFetch instanceof ApiError));
    assert.match(viaFetch.message, /^Could not build the request/);
    assert.doesNotMatch(viaFetch.message, /sk-leak456/);
  });
});

describe("redaction", () => {
  test("redactSecrets scrubs bearer values, sk- keys, and URL userinfo", () => {
    assert.equal(
      redactSecrets('Headers.append: "Bearer sk-abc\nrest" is an invalid header value.'),
      'Headers.append: "Bearer [redacted]" is an invalid header value.',
    );
    assert.equal(redactSecrets("auth Bearer abc.def failed"), "auth Bearer [redacted] failed");
    assert.equal(redactSecrets("key sk-live_AbC-123 bad"), "key sk-[redacted] bad");
    assert.equal(
      redactSecrets("https://u:p@example.test/v1"),
      "https://[redacted]@example.test/v1",
    );
    assert.equal(redactSecrets("nothing secret"), "nothing secret");
  });

  test("a server error message echoing the key is redacted", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "key sk-echoed999 is malformed" } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const error = await reject(
        requestJson(
          { profile: { name: "t", apiUrl: url, authUrl: url }, token: "sk-ok", credential: null },
          { path: "/v1/x" },
        ),
      );
      assert.equal(error.message, "key sk-[redacted] is malformed");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
