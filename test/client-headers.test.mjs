import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-client-headers-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
});

const { publicRequest } = await import("../dist/api/client.js");
const { startDeviceAuthorization } = await import("../dist/api/device.js");

test("publicRequest preserves Headers and tuple Authorization", async () => {
  const originalFetch = globalThis.fetch;
  /** @type {Headers | undefined} */
  let seen;
  globalThis.fetch = async (_url, init) => {
    seen = new Headers(init.headers);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await publicRequest("https://example.test/api", {
      headers: new Headers({ Authorization: "Bearer from-headers" }),
    });
    assert.equal(seen.get("Authorization"), "Bearer from-headers");
    assert.equal(seen.get("Accept"), "application/json");

    await publicRequest("https://example.test/api", {
      headers: [["Authorization", "Bearer from-tuples"]],
    });
    assert.equal(seen.get("Authorization"), "Bearer from-tuples");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("JSON POST callers set application/json; FormData and URLSearchParams do not", async () => {
  const originalFetch = globalThis.fetch;
  /** @type {Headers | undefined} */
  let seen;
  globalThis.fetch = async (_url, init) => {
    seen = new Headers(init.headers);
    return new Response(
      JSON.stringify({
        device_code: "dc",
        user_code: "uc",
        verification_uri: "/v",
        verification_uri_complete: "/v",
        expires_in: 60,
        interval: 1,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    await startDeviceAuthorization("https://example.test");
    assert.equal(seen.get("Content-Type"), "application/json");

    await publicRequest("https://example.test/form", {
      method: "POST",
      body: new FormData(),
    });
    assert.notEqual(seen.get("Content-Type"), "application/json");
    assert.equal(seen.has("Content-Type"), false);

    await publicRequest("https://example.test/params", {
      method: "POST",
      body: new URLSearchParams({ a: "1" }),
    });
    assert.notEqual(seen.get("Content-Type"), "application/json");
    assert.equal(seen.has("Content-Type"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
