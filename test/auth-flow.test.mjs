import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY } from "../dist/cli/select.js";

// Behavioral tests through the real src/auth flow modules (dist build). The
// device/API seams live behind a localhost stub HTTP server: the profile's
// authUrl/apiUrl point at it via AIAND_BASE_URL/AIAND_AUTH_URL. No real
// network, no real TTY, no subprocess.

const flow = await import("../dist/auth/flow.js");
const device = await import("../dist/api/device.js");
const config = await import("../dist/config.js");

/** The stub auth/API server: identity endpoints plus device-login endpoints. */
function stubServer() {
  const state = {
    revocations: [],
    /** /api/orgs payload; tests set two orgs to reach the picker. */
    orgs: [],
    /** org minted into the device-code grant; null omits it. */
    tokenOrg: null,
    /** last key_name seen on /auth/device/code. */
    keyName: null,
    /** /auth/authorize behavior: "redirect" 302s, "missing" 404s. */
    authorizeMode: "redirect",
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
      return reply(200, { id: "u1", email: "dev@example.com" });
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
          interval: 5,
        });
      });
      return;
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
        if (params.grant_type === "authorization_code") {
          return reply(200, {
            access_token: "sk-minted",
            refresh_token: "rt-minted",
            token_type: "Bearer",
            expires_in: 2592000,
            org: { id: "org_2", name: "Second" },
          });
        }
        if (params.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
          return reply(200, {
            access_token: "sk-minted",
            refresh_token: "rt-minted",
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

/**
 * Fake prompt streams copied from test/select.test.mjs: a real EventEmitter
 * the prompt drives, so the multi-org picker runs its genuine keypress path
 * with no real terminal.
 */
class FakeInput extends EventEmitter {
  constructor({ tty = true } = {}) {
    super();
    this.tty = tty;
    this.raw = false;
  }
  get isTTY() {
    return this.tty;
  }
  setRawMode(mode) {
    this.raw = mode;
  }
  resume() {}
  pause() {}
  setEncoding() {}
  send(seq) {
    this.emit("data", seq);
  }
  end() {
    this.emit("end");
  }
}

class FakeOutput {
  constructor() {
    this.text = "";
  }
  write(chunk) {
    this.text += chunk;
  }
}

/** Stub the real TTYs so isInteractive() is true without a terminal. */
function stubTTY() {
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  return () => {
    if (stdinDesc) Object.defineProperty(process.stdin, "isTTY", stdinDesc);
    else delete process.stdin.isTTY;
    if (stdoutDesc) Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
    else delete process.stdout.isTTY;
  };
}

/** Fake opener mirroring test/browser-flow.test.mjs: follow the 302 into loopback. */
function browserOpener() {
  return async (url) => {
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 302);
    await fetch(res.headers.get("location"));
    return true;
  };
}

/** Wait until the picker is listening, then drive DOWN + ENTER through it.
 * deviceLogin polls ~5s before the prompt appears, so this must out-wait it
 * and never send blindly: keys emitted with no listener are lost forever. */
async function pickSecondRow(input) {
  for (let i = 0; i < 3000 && input.listenerCount("data") === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(input.listenerCount("data") > 0, "org picker never started listening");
  input.send(KEY.DOWN);
  input.send(KEY.ENTER_CR);
}

const TWO_ORGS = [
  { id: "org_1", name: "First" },
  { id: "org_2", name: "Second" },
];

describe("org selection on sign-in (real modules, stub server)", () => {
  test("(a) device login stores the minted-key org and labels the key", async () => {
    state.tokenOrg = { id: "org_2", name: "Second" };
    const captured = captureOutput();
    try {
      await flow.deviceLogin({ profile: "default", noBrowser: true });
      const cred = await config.loadCredential("default");
      assert.equal(cred.org.name, "Second");
      assert.match(state.keyName ?? "", /^aiand@/);
    } finally {
      captured.restore();
    }
  });

  test("(b) two orgs without a minted org picks the row chosen interactively", async () => {
    state.orgs = [...TWO_ORGS];
    const restoreTTY = stubTTY();
    const input = new FakeInput();
    const output = new FakeOutput();
    const captured = captureOutput();
    try {
      const login = flow.deviceLogin({ profile: "default", noBrowser: true, input, output });
      await pickSecondRow(input);
      await login;
      const cred = await config.loadCredential("default");
      assert.equal(cred.org.id, "org_2");
    } finally {
      captured.restore();
      restoreTTY();
    }
  });

  test("(c) two orgs non-interactively keeps orgs[0] with a stderr note", async () => {
    state.orgs = [...TWO_ORGS];
    const captured = captureOutput();
    try {
      await flow.deviceLogin({ profile: "default", noBrowser: true });
      const cred = await config.loadCredential("default");
      assert.equal(cred.org.id, "org_1");
      assert.match(captured.log.err.join(""), /multiple organizations/);
    } finally {
      captured.restore();
    }
  });
});

describe("browserLogin (real modules, stub server)", () => {
  test("(d) end-to-end sign-in stores the minted key with origin device", async () => {
    state.orgs = [...TWO_ORGS];
    const captured = captureOutput();
    try {
      await flow.browserLogin({ profile: "default", open: browserOpener() });
      const cred = await config.loadCredential("default");
      assert.ok(captured.log.out.join("").includes("Signed in."));
      assert.equal(cred.access_token, "sk-minted");
      assert.equal(cred.origin, "device");
      assert.equal(cred.org.name, "Second");
    } finally {
      captured.restore();
    }
  });

  test("(e) a 404 authorize page falls back silently to the device flow", async () => {
    state.authorizeMode = "missing";
    state.tokenOrg = { id: "org_2", name: "Second" };
    const captured = captureOutput();
    try {
      await flow.browserLogin({ profile: "default", noBrowser: true, open: browserOpener() });
      const cred = await config.loadCredential("default");
      assert.ok(captured.log.out.join("").includes("Signed in."));
      assert.equal(cred.access_token, "sk-minted");
      assert.ok(!captured.log.err.join("").includes("didn't complete"));
    } finally {
      captured.restore();
    }
  });

  test("(f) probeIdentity prefers the cached org when the orgs list has it", async () => {
    await config.saveCredential("default", {
      access_token: "sk-minted",
      refresh_token: "rt-minted",
      expires_at: Math.floor(Date.now() / 1000) + 2592000,
      origin: "device",
      storage: "plaintext",
      user: { id: "u1", email: "dev@example.com" },
      org: { id: "org_2", name: "Second" },
    });
    state.orgs = [...TWO_ORGS];
    const identity = await flow.probeIdentity("default");
    assert.equal(identity.org.id, "org_2");
  });
});
