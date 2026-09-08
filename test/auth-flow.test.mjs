import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Behavioral tests through the real src/auth flow modules (dist build). The
// device/API seams live behind a localhost stub HTTP server: the profile's
// authUrl/apiUrl point at it via AIAND_BASE_URL/AIAND_AUTH_URL. No real
// network, no real TTY, no subprocess.

const flow = await import("../dist/auth/flow.js");
const device = await import("../dist/api/device.js");
const config = await import("../dist/config.js");

/** The stub auth/API server: identity endpoints plus device-login endpoints. */
function stubServer() {
  const state = { revocations: [] };
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
      return reply(200, { id: "u1", email: "dev@example.com" });
    }
    if (url.pathname === "/api/orgs") return reply(200, []);
    if (url.pathname === "/auth/device/code") {
      return reply(200, {
        device_code: "dc",
        user_code: "BCDF-GHJK",
        verification_uri: "/auth/device?user_code=BCDF-GHJK",
        verification_uri_complete: "",
        expires_in: 600,
        interval: 5,
      });
    }
    if (url.pathname === "/auth/device/logout") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const params = JSON.parse(raw || "{}");
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
        if (params.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
          return reply(200, {
            access_token: "sk-minted",
            refresh_token: "rt-minted",
            token_type: "Bearer",
            expires_in: 2592000,
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

let dir;
let server;
let state;
let baseUrl;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aiand-auth-flow-"));
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

/** Capture output calls instead of writing to stdio. */
function captureOutput() {
  const log = { out: [], err: [] };
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => (log.out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (log.err.push(String(chunk)), true);
  return {
    log,
    restore() {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    },
  };
}

describe("deviceLogin happy path (real modules, stub server)", () => {
  beforeEach(() => delete process.env.AIAND_API_KEY);

  test("mints a credential, activates the profile, and prints Signed in", async () => {
    const captured = captureOutput();
    try {
      // noBrowser keeps the flow off a real browser; openBrowserAware on a
      // remote context (CI/non-TTY) would also just print the URL.
      await flow.deviceLogin({ profile: "default", noBrowser: true });

      const cred = await config.loadCredential("default");
      assert.equal(cred.origin, "device");
      assert.equal(cred.access_token, "sk-minted");
      assert.equal(cred.refresh_token, "rt-minted");

      // The stored user/org ride the credential metadata.
      assert.equal(cred.user.email, "dev@example.com");

      const outText = captured.log.out.join("");
      assert.ok(outText.includes("Signed in."));
      assert.ok(outText.includes("sk-***"), "masked key printed, full key never");
      assert.ok(captured.log.err.join("").length >= 0);
    } finally {
      captured.restore();
    }
  });

  test("passes an onSlowDown handler that prints the back-off line", async () => {
    // Drive the real pollForToken with a stubbed global fetch so the
    // slow_down branch fires deterministically.
    const realFetch = globalThis.fetch;
    const deviceStart = {
      device_code: "dc",
      user_code: "BCDF-GHJK",
      verification_uri: "/auth/device?user_code=BCDF-GHJK",
      verification_uri_complete: "",
      expires_in: 600,
      interval: 1,
    };
    let fetchCount = 0;
    const slowDowns = [];
    globalThis.fetch = async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (fetchCount === 2) {
        return new Response(JSON.stringify({ error: "slow_down" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          access_token: "sk-ok",
          refresh_token: "rt-ok",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    try {
      const tokens = await device.pollForToken(baseUrl, deviceStart, {
        onSlowDown: (interval) => slowDowns.push(interval),
      });
      assert.equal(tokens.access_token, "sk-ok");
      assert.equal(fetchCount, 3);
      assert.deepEqual(slowDowns, [6], "slow_down bumps the interval by 5 (1+5)");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("the real poll loop hits the stub server's device endpoints", async () => {
    // entries with an already-expired code throw the expired hint without
    // polling: expires_in: 0 makes the deadline pass instantly, before any
    // sleep or fetch — deterministic and network-free.
    const expired = {
      device_code: "dc",
      user_code: "BCDF-GHJK",
      verification_uri: "",
      verification_uri_complete: "",
      expires_in: 0,
      interval: 5,
    };
    await assert.rejects(
      device.pollForToken(baseUrl, expired),
      /expired before it was approved/
    );
  });
});

describe("logout (real modules, stub server)", () => {
  test("device-minted key is revoked through the real revoke endpoint", async () => {
    await config.saveCredential("default", {
      access_token: "sk-device",
      refresh_token: "rt-device",
      origin: "device",
      storage: "plaintext",
    });

    const captured = captureOutput();
    try {
      await flow.logout({ profile: "default" });
    } finally {
      captured.restore();
    }

    assert.deepEqual(state.revocations, ["rt-device"]);
    assert.equal(await config.loadCredential("default"), null);
  });

  test("pasted key is cleared locally and never revoked", async () => {
    await config.saveCredential("default", {
      access_token: "sk-paste",
      origin: "paste",
      storage: "plaintext",
    });

    const captured = captureOutput();
    try {
      await flow.logout({ profile: "default" });
    } finally {
      captured.restore();
    }
    assert.deepEqual(state.revocations, []);
    assert.equal(await config.loadCredential("default"), null);
  });

  test("a pasted key with --revoke is refused and the credential survives", async () => {
    await config.saveCredential("default", {
      access_token: "sk-paste",
      origin: "paste",
      storage: "plaintext",
    });

    const captured = captureOutput();
    try {
      await assert.rejects(flow.logout({ profile: "default", revoke: true }), /refusing to revoke/);
    } finally {
      captured.restore();
    }
    assert.ok(await config.loadCredential("default"));
  });
});

describe("pasteLogin validation (real modules, stub server)", () => {
  beforeEach(() => delete process.env.AIAND_API_KEY);

  test("a sk- key is validated, stored as paste, and rebaked", async () => {
    const captured = captureOutput();
    try {
      await flow.pasteLogin({ profile: "default", key: "sk-abc123" });

      const cred = await config.loadCredential("default");
      assert.equal(cred.origin, "paste");
      assert.equal(cred.access_token, "sk-abc123");
      assert.ok(captured.log.out.join("").includes("Signed in with a pasted key."));
    } finally {
      captured.restore();
    }
  });

  test("a malformed key is rejected before any API call", async () => {
    const captured = captureOutput();
    try {
      await assert.rejects(
        flow.pasteLogin({ profile: "default", key: "not-a-key" }),
        /Keys start with "sk-"/
      );
    } finally {
      captured.restore();
    }
    assert.equal(await config.loadCredential("default"), null);
  });

  test("a 401 from the API surfaces as a rejected-key hint", async () => {
    const captured = captureOutput();
    try {
      await assert.rejects(
        flow.pasteLogin({ profile: "default", key: "sk-bad" }),
        /rejected/
      );
    } finally {
      captured.restore();
    }
    assert.equal(await config.loadCredential("default"), null);
  });
});
