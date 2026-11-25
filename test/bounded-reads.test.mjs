import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { describe } from "node:test";
import { withTestEnv } from "./helpers.mjs";

// A broken or hostile endpoint must not make the CLI buffer without bound or
// loop forever: SSE lines, error bodies, and logs paging are all capped.
// In-process loopback servers; no child CLI.

withTestEnv("aiand-bounded-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_API_KEY;
  process.env.CI = "1";
});

const { streamChatCompletion } = await import("../dist/api/inference.js");
const { requestJson } = await import("../dist/api/client.js");
const { pollForToken } = await import("../dist/api/device.js");
const { getLogsPaged } = await import("../dist/api/logs.js");
const { ApiError } = await import("../dist/cli/errors.js");

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(url);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const sessionFor = (url) => ({
  profile: { name: "t", apiUrl: url, authUrl: url },
  token: "sk-test",
  credential: null,
});

const reject = (promise) =>
  promise.then(
    () => assert.fail("expected a rejection"),
    (e) => e,
  );

/** Write `chunk` until the client hangs up: an endless body. */
function endless(res, chunk) {
  const pump = () => {
    while (!res.destroyed && res.write(chunk));
    if (!res.destroyed) res.once("drain", pump);
  };
  res.on("close", () => res.removeAllListeners("drain"));
  pump();
}

describe("SSE", () => {
  test("a line that never ends is cut off at 1 MiB", () =>
    withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: ");
        endless(res, "x".repeat(64 * 1024));
      },
      async (url) => {
        const { chunks } = await streamChatCompletion(sessionFor(url), {
          model: "m",
          messages: [],
        });
        const error = await reject(
          (async () => {
            for await (const chunk of chunks) void chunk;
          })(),
        );
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502);
        assert.match(error.message, /over 1 MiB/);
      },
    ));
});

describe("error bodies", () => {
  test("an endless non-JSON error body is read only so far and summarized", () =>
    withServer(
      (_req, res) => {
        res.writeHead(503, "Service Unavailable", { "Content-Type": "text/html" });
        res.write("<html>upstream down</html>\n");
        endless(res, "<p>more</p>\n".repeat(1000));
      },
      async (url) => {
        const error = await reject(requestJson(sessionFor(url), { path: "/v1/x" }));
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 503);
        assert.equal(error.message, "Service Unavailable: <html>upstream down</html>");
      },
    ));

  test("an empty error body falls back to the status text", () =>
    withServer(
      (_req, res) => {
        res.writeHead(502, "Bad Gateway");
        res.end();
      },
      async (url) => {
        const error = await reject(requestJson(sessionFor(url), { path: "/v1/x" }));
        assert.equal(error.message, "Bad Gateway");
      },
    ));

  test("a huge JSON error message is clipped to 500 characters", () =>
    withServer(
      (_req, res) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "y".repeat(10_000), type: "bad" } }));
      },
      async (url) => {
        const error = await reject(requestJson(sessionFor(url), { path: "/v1/x" }));
        assert.equal(error.message, `${"y".repeat(500)}…`);
        assert.equal(error.type, "bad");
      },
    ));

  test("a device poll's endless error body does not hang the poll", () =>
    withServer(
      (_req, res) => {
        res.writeHead(400, { "Content-Type": "text/plain" });
        endless(res, "z".repeat(64 * 1024));
      },
      async (url) => {
        const error = await reject(
          pollForToken(
            url,
            {
              device_code: "dc",
              user_code: "U",
              verification_uri: "/v",
              verification_uri_complete: "/v",
              expires_in: 60,
              interval: 1,
            },
            { sleep: async () => {} },
          ),
        );
        assert.ok(error instanceof ApiError);
        assert.equal(error.message, "Device login failed.");
      },
    ));
});

describe("logs paging", () => {
  const row = (id) => ({
    id,
    model: "m",
    api_key: "sk-…",
    status_code: 200,
    ttft_ms: null,
    latency_ms: null,
    input_tokens: null,
    output_tokens: null,
    cached_tokens: null,
    cost: null,
    currency: null,
    created_at: "2026-11-01T00:00:00Z",
  });

  test("an empty page that still claims has_more stops the loop", async () => {
    let pages = 0;
    await withServer(
      (_req, res) => {
        pages += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [],
            has_more: true,
            next_after: `t${pages}`,
            next_after_id: `i${pages}`,
          }),
        );
      },
      async (url) => {
        const result = await getLogsPaged(sessionFor(url), { limit: 1000 });
        assert.deepEqual(result.entries, []);
        assert.equal(pages, 1);
      },
    );
  });

  test("a cursor that repeats stops the loop", async () => {
    let pages = 0;
    await withServer(
      (_req, res) => {
        pages += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [row(`r${pages}`)],
            has_more: true,
            next_after: "same",
            next_after_id: "same-id",
          }),
        );
      },
      async (url) => {
        const result = await getLogsPaged(sessionFor(url), { limit: 1000 });
        assert.equal(pages, 2);
        assert.equal(result.entries.length, 2);
        assert.equal(result.truncated, true);
      },
    );
  });
});
