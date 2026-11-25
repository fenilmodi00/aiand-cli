import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { withEnv, withFetch, withTestEnv } from "./helpers.mjs";

// The refresh-<profile> lock is held across a network call, a PowerShell start
// and a rebake. These pin the parts of that which keep two processes from
// rotating one refresh token (the server treats a reused one as theft).

const env = withTestEnv("aiand-refresh-lock-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_KEY_STORAGE = "plaintext";
  process.env.CI = "1";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
});

const { rotateTokens } = await import("../dist/api/device.js");
const { openSession, request } = await import("../dist/api/client.js");
const config = await import("../dist/config.js");

describe("rotateTokens", () => {
  let server;
  let url;
  before(async () => {
    // Accepts the request and never answers.
    server = createServer(() => {});
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  test("gives up on a server that never answers, so the refresh lock is released", async () => {
    const started = Date.now();
    await assert.rejects(() => rotateTokens(url, "rt-hung", { timeoutMs: 150 }), /Could not reach/);
    assert.ok(Date.now() - started < 5_000);
  });
});

describe("a rotation that finds the profile signed out", () => {
  test("does not resurrect it with the stale refresh token", async () => {
    const cfg = mkdtempSync(join(env.dir, "cfg-"));
    const origin = "http://127.0.0.1:9";
    await withEnv(
      {
        AIAND_CONFIG_DIR: cfg,
        AIAND_HOME: join(cfg, "home"),
        AIAND_BASE_URL: origin,
        AIAND_AUTH_URL: origin,
      },
      async () => {
        await config.saveCredential("default", {
          access_token: "sk-live",
          refresh_token: "rt-live",
          origin: "device",
          expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          bound_to: { auth_url: origin, api_url: origin },
        });
        const session = await openSession(config.resolveProfile("default"));
        // Another process runs `aiand logout` while this session is live.
        await config.clearCredential("default");
        const posts = [];
        await withFetch(
          async (url, init) => {
            if (init?.method === "POST") posts.push(String(url));
            return new Response("{}", { status: 401 });
          },
          () =>
            assert.rejects(request(session, { path: "/api/user" }), { name: "NotLoggedInError" }),
        );
        assert.deepEqual(posts, [], "a refresh token for a signed-out profile was sent");
        assert.equal(await config.loadCredential("default"), null, "the profile stays signed out");
      },
    );
  });
});
