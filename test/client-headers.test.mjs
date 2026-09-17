import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-client-headers-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
});

const client = await import("../dist/api/client.js");
const config = await import("../dist/config.js");
const { publicRequest, request, openSession } = client;
const { startDeviceAuthorization, verificationUrl } = await import("../dist/api/device.js");

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

test("network failure hint mentions --base-url", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  try {
    await assert.rejects(publicRequest("https://example.test/api/user"), (error) => {
      assert.match(error.hint, /--base-url/);
      assert.ok(!/--env/.test(error.hint ?? ""));
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("two overlapping 401s send exactly one refresh_token grant", async () => {
  const cfg = process.env.AIAND_CONFIG_DIR;
  writeFileSync(
    join(cfg, "credentials.json"),
    JSON.stringify({
      default: {
        origin: "device",
        expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        storage: "plaintext",
      },
    }) + "\n",
  );
  writeFileSync(
    join(cfg, "credentials-plaintext.json"),
    JSON.stringify({
      default: JSON.stringify({
        access_token: "sk-stale",
        refresh_token: "rt-stale",
      }),
    }) + "\n",
  );
  process.env.AIAND_BASE_URL = "https://api.example.test";
  process.env.AIAND_AUTH_URL = "https://auth.example.test";
  process.env.AIAND_KEY_STORAGE = "plaintext";

  const originalFetch = globalThis.fetch;
  let refreshGrants = 0;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/auth/device/token") {
      refreshGrants += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(
        JSON.stringify({
          access_token: "sk-new",
          refresh_token: "rt-new",
          token_type: "Bearer",
          expires_in: 2592000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth === "Bearer sk-new") {
      if (path === "/api/user") {
        return new Response(JSON.stringify({ id: "u1", email: "ok@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path === "/api/orgs") {
        return new Response(JSON.stringify([{ id: "org_1", name: "Org" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("{}", { status: 401 });
  };

  try {
    const profile = config.resolveProfile("default");
    const session = await openSession(profile);
    await Promise.all([
      request(session, { path: "/api/user" }),
      request(session, { path: "/api/orgs" }),
    ]);
    assert.equal(refreshGrants, 1);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AIAND_BASE_URL;
    delete process.env.AIAND_AUTH_URL;
    delete process.env.AIAND_KEY_STORAGE;
  }
});

{
  const device = (over = {}) => ({
    device_code: "dc",
    user_code: "ABCD",
    verification_uri: "/auth/device",
    verification_uri_complete: "",
    expires_in: 600,
    interval: 5,
    ...over,
  });

  test("verificationUrl: relative path stays on the auth origin", () => {
    assert.equal(
      verificationUrl("https://console.aiand.com", device()),
      "https://console.aiand.com/auth/device",
    );
  });

  test("verificationUrl: absolute same-origin https is accepted", () => {
    assert.equal(
      verificationUrl(
        "https://console.aiand.com",
        device({ verification_uri_complete: "https://console.aiand.com/auth/device?user_code=ABCD" }),
      ),
      "https://console.aiand.com/auth/device?user_code=ABCD",
    );
  });

  test("verificationUrl: foreign origin is refused", () => {
    assert.throws(
      () =>
        verificationUrl(
          "https://console.aiand.com",
          device({ verification_uri_complete: "https://phishing.example/x" }),
        ),
      /not on this gateway/,
    );
  });

  test("verificationUrl: plain http off-loopback is refused", () => {
    assert.throws(
      () =>
        verificationUrl(
          "https://console.aiand.com",
          device({ verification_uri_complete: "http://console.aiand.com/x" }),
        ),
      /not on this gateway/,
    );
  });
}
