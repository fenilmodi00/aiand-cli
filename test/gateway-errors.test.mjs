import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { describe } from "node:test";
import { FAKE_API_KEY, withEnv, withFetch, withTestEnv } from "./helpers.mjs";

// Gateway-failure coverage: mid-stream abort, the env-key 401
// hint, and 200 non-JSON bodies. In-process loopback servers plus direct
// dist imports — no child CLI, so no event-loop deadlock, and no
// mock-gateway.mjs. No network beyond 127.0.0.1; no real home.

const { streamChatCompletion, createChatCompletion } = await import("../dist/api/inference.js");
const { publicRequest, requestJson, publicJson, scrubCredentials } = await import(
  "../dist/api/client.js"
);
const { startDeviceAuthorization, pollForToken, rotateTokens } = await import(
  "../dist/api/device.js"
);
const { validateKey } = await import("../dist/api/account.js");
const { ApiError, CliError } = await import("../dist/cli/errors.js");
const { probeIdentity } = await import("../dist/auth/identity.js");

withTestEnv("aiand-gateway-errors-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
  delete process.env.AIAND_KEY_STORAGE;
  delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
  process.env.CI = "1";
});

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Sessions are built by hand: credential null is the env-key shape. */
const sessionFor = (url, credential) => ({
  profile: { name: "test", apiUrl: url, authUrl: url },
  token: FAKE_API_KEY,
  credential,
});

/** Await a promise that must reject; return the error for assertions. */
const capture = (promise) =>
  promise.then(
    () => assert.fail("expected the call to reject"),
    (error) => error,
  );

describe("mid-stream abort", () => {
  test("abort during streaming rejects with CliError 130, not AbortError", async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "X-Model": "m" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
      // Hold the stream open until the client goes away.
      req.on("close", () => {
        try {
          res.end();
        } catch {}
      });
    });
    try {
      const controller = new AbortController();
      const { chunks } = await streamChatCompletion(
        sessionFor(server.url, null),
        { model: "m", messages: [] },
        controller.signal,
      );
      const it = chunks[Symbol.asyncIterator]();
      const first = await it.next();
      assert.equal(first.done, false);
      assert.equal(first.value.text, "hi");
      controller.abort();
      const failure = await capture(it.next());
      assert.ok(failure instanceof CliError);
      assert.equal(failure.name, "CliError");
      assert.equal(failure.exitCode, 130);
      assert.equal(failure.message, "Cancelled.");
    } finally {
      await server.close();
    }
  });
});

describe("401 hint", () => {
  const unauthorized = (_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  };

  test("env key names AIAND_API_KEY, never aiand login", async () => {
    const server = await startServer(unauthorized);
    try {
      const failure = await capture(
        requestJson(sessionFor(server.url, null), { path: "/api/user" }),
      );
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.status, 401);
      assert.match(failure.hint ?? "", /AIAND_API_KEY/);
      assert.doesNotMatch(failure.hint ?? "", /aiand login/);
    } finally {
      await server.close();
    }
  });

  test("stored credential still points at aiand login", async () => {
    const server = await startServer(unauthorized);
    try {
      // Pre-save login Sessions use this shape too (unsaved LoadedCredential).
      // No refresh_token, so no resend is attempted: the 401 surfaces as-is.
      const failure = await capture(
        requestJson(sessionFor(server.url, { access_token: FAKE_API_KEY, origin: "device" }), {
          path: "/api/user",
        }),
      );
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.status, 401);
      assert.match(failure.hint ?? "", /aiand login/);
      assert.doesNotMatch(failure.hint ?? "", /AIAND_API_KEY/);
    } finally {
      await server.close();
    }
  });
});

describe("200 non-JSON", () => {
  test("requestJson wraps an HTML body as ApiError 502 with a parse message", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>gateway down for maintenance</body></html>");
    });
    try {
      const failure = await capture(
        requestJson(sessionFor(server.url, null), { path: "/api/user" }),
      );
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.status, 502);
      assert.match(failure.message, /not valid JSON/);
      assert.match(failure.hint ?? "", /middlebox|base-url/);
    } finally {
      await server.close();
    }
  });

  test("createChatCompletion wraps a text body as ApiError 502", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Service temporarily unavailable");
    });
    try {
      const failure = await capture(
        createChatCompletion(sessionFor(server.url, null), { model: "m", messages: [] }),
      );
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.status, 502);
      assert.match(failure.message, /not valid JSON/);
    } finally {
      await server.close();
    }
  });

  test("publicJson wraps an HTML body the same way", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>cloudflare challenge</html>");
    });
    try {
      const failure = await capture(publicJson(`${server.url}/v1/models`));
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.status, 502);
      assert.match(failure.message, /not valid JSON/);
    } finally {
      await server.close();
    }
  });

  test("valid JSON parses exactly as before", async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/user") {
        res.end(JSON.stringify({ id: "u1", email: "happy@example.com" }));
      } else {
        res.end(
          JSON.stringify({
            choices: [
              { message: { content: "hello", reasoning_content: "" }, finish_reason: "stop" },
            ],
            usage: { total_tokens: 3 },
          }),
        );
      }
    });
    try {
      const user = await requestJson(sessionFor(server.url, null), { path: "/api/user" });
      assert.equal(user.email, "happy@example.com");
      const completion = await createChatCompletion(sessionFor(server.url, null), {
        model: "m",
        messages: [],
      });
      assert.equal(completion.text, "hello");
      assert.equal(completion.finishReason, "stop");
    } finally {
      await server.close();
    }
  });
});

describe("200 HTML on streaming and auth paths", () => {
  const html = "<html><body>gateway down for maintenance</body></html>";

  test("streamChatCompletion rejects a text/html body as ApiError 502, not an empty stream", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    try {
      const failure = await capture(
        streamChatCompletion(sessionFor(server.url, null), { model: "m", messages: [] }),
      );
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.status, 502);
      assert.match(failure.message, /not valid JSON/);
      assert.match(failure.hint ?? "", /middlebox|base-url/);
    } finally {
      await server.close();
    }
  });

  test("streamChatCompletion rejects an HTML body even under an SSE content-type", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(html);
    });
    try {
      const { chunks } = await streamChatCompletion(sessionFor(server.url, null), {
        model: "m",
        messages: [],
      });
      const failure = await capture(
        (async () => {
          for await (const chunk of chunks) void chunk;
        })(),
      );
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.status, 502);
      assert.match(failure.message, /not valid JSON/);
    } finally {
      await server.close();
    }
  });

  test("startDeviceAuthorization maps 200 HTML to ApiError 502, not SyntaxError", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    try {
      const failure = await capture(startDeviceAuthorization(server.url));
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.status, 502);
      assert.match(failure.message, /not valid JSON/);
    } finally {
      await server.close();
    }
  });

  test("pollForToken success with 200 HTML is ApiError 502", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    try {
      const device = {
        device_code: "dc-test",
        verification_uri: `${server.url}/activate`,
        expires_in: 300,
        interval: 0,
      };
      const failure = await capture(pollForToken(server.url, device));
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.status, 502);
      assert.match(failure.message, /not valid JSON/);
    } finally {
      await server.close();
    }
  });

  test("rotateTokens maps 200 HTML to ApiError 502", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    try {
      const failure = await capture(rotateTokens(server.url, "rt-test-not-real"));
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.status, 502);
      assert.match(failure.message, /not valid JSON/);
    } finally {
      await server.close();
    }
  });

  test("validateKey maps 200 HTML to ApiError 502, not SyntaxError", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    try {
      const failure = await capture(validateKey(FAKE_API_KEY, server.url));
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.name, "ApiError");
      assert.equal(failure.status, 502);
      assert.match(failure.message, /not valid JSON/);
    } finally {
      await server.close();
    }
  });
});

describe("probe reachability", () => {
  test("a 200-HTML gateway reports unreachable with the parse error", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>maintenance</html>");
    });
    try {
      await withEnv(
        {
          AIAND_API_KEY: FAKE_API_KEY,
          AIAND_BASE_URL: server.url,
          AIAND_AUTH_URL: server.url,
        },
        async () => {
          const identity = await probeIdentity();
          assert.equal(identity.reachable, false);
          assert.ok(identity.probeError instanceof ApiError);
          assert.equal(identity.probeError.status, 502);
          assert.match(identity.probeError.message, /not valid JSON/);
        },
      );
    } finally {
      await server.close();
    }
  });

  test("a valid-JSON gateway still verifies (reachable)", async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/orgs") {
        res.end(JSON.stringify([{ id: "org_1", name: "Happy Org" }]));
      } else {
        res.end(JSON.stringify({ id: "u1", email: "happy@example.com" }));
      }
    });
    try {
      await withEnv(
        {
          AIAND_API_KEY: FAKE_API_KEY,
          AIAND_BASE_URL: server.url,
          AIAND_AUTH_URL: server.url,
        },
        async () => {
          const identity = await probeIdentity();
          assert.equal(identity.reachable, true);
          assert.equal(identity.user?.email, "happy@example.com");
          assert.equal(identity.org?.name, "Happy Org");
        },
      );
    } finally {
      await server.close();
    }
  });
});

describe("credential scrubbing", () => {
  test("scrubCredentials redacts userinfo, keeps the rest", () => {
    assert.equal(
      scrubCredentials("fetch failed for https://user:s3cret@host.example/v1/models"),
      "fetch failed for https://[redacted]@host.example/v1/models",
    );
    assert.equal(scrubCredentials("fetch failed: no url here"), "fetch failed: no url here");
  });

  test("a network refusal carrying credentials never echoes them", async () => {
    // Fuzz E5: undici interpolates the request URL into its refusal reason.
    const fake = "fake-secret-xyz";
    const throwing = () => {
      throw new Error(`fetch failed: includes credentials: https://user:${fake}@host.example/`);
    };
    await withFetch(throwing, async () => {
      await assert.rejects(publicRequest("https://host.example/v1/models"), (error) => {
        assert.ok(error instanceof ApiError);
        assert.match(error.message, /Could not reach https:\/\/host\.example/);
        assert.ok(!error.message.includes(fake), "the secret is never echoed");
        assert.match(error.message, /\[redacted\]/);
        return true;
      });
    });
  });
});
