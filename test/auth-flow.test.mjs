import assert from "node:assert/strict";
import test, { beforeEach, describe } from "node:test";

// Behavioral tests through the deep src/auth flow interface (dist build). All
// seams are in-memory adapters — no network, no real TTY, no subprocess.

const flow = await import("../dist/auth/flow.js");
const device = await import("../dist/api/device.js");

/** In-memory credential store keyed by profile. */
function memoryStore(initial = {}) {
  const creds = new Map(Object.entries(initial));
  return {
    async saveCredential(profile, credential) {
      // Mimic the real store: `storage` records the tier that held the blob.
      creds.set(profile, { ...credential, storage: credential.storage ?? "plaintext" });
    },
    async loadCredential(profile) {
      return creds.get(profile) ?? null;
    },
    async clearCredential(profile) {
      creds.delete(profile);
    },
  };
}

/** Capture ui/output calls instead of writing to stdio. */
function memoryUi() {
  const log = { out: [], err: [] };
  const style = {
    bold: (s) => s,
    dim: (s) => s,
    red: (s) => s,
    green: (s) => s,
    yellow: (s) => s,
    blue: (s) => s,
    magenta: (s) => s,
    cyan: (s) => s,
  };
  return {
    log,
    ui: {
      style,
      out: (line = "") => log.out.push(line),
      err: (line = "") => log.err.push(line),
      fields: () => {},
      link: (url) => url,
      spinner: () => ({ stop: () => {} }),
      confirm: async () => true,
      isInteractive: () => false,
      copyToClipboard: async () => false,
      openBrowserAware: () => "opened",
      isRemoteContext: () => false,
    },
  };
}

const PROFILE = {
  name: "default",
  authUrl: "https://auth.example",
  apiUrl: "https://api.example",
};

function defaultConfig() {
  return {
    loadConfig: () => ({ profile: "default", profiles: { default: {} } }),
    saveConfig: () => {},
    updateProfile: () => {},
    resolveProfile: () => PROFILE,
    maskKey: (k) => `${k.slice(0, 3)}…`,
  };
}

function baseDevice() {
  return {
    device_code: "dc",
    user_code: "BCDF-GHJK",
    verification_uri: "/auth/device?user_code=BCDF-GHJK",
    verification_uri_complete: "",
    expires_in: 600,
    interval: 5,
  };
}

function sessionFrom(key, origin, extra = {}) {
  return {
    profile: PROFILE,
    token: key,
    credential: { access_token: key, origin, storage: "plaintext", ...extra },
  };
}

function identityApi() {
  return {
    async openSession() {
      return sessionFrom("sk", "device", { refresh_token: "rt" });
    },
    async getUser() {
      return { id: "u1", email: "dev@example.com" };
    },
    async listOrgs() {
      return [];
    },
    async validateKey() {
      return { id: "u1", email: "dev@example.com" };
    },
  };
}

describe("deviceLogin happy path", () => {
  beforeEach(() => delete process.env.AIAND_API_KEY);

  test("mints a credential, activates the profile, rebakes, and prints Signed in", async () => {
    const store = memoryStore();
    const { ui, log } = memoryUi();
    const calls = [];
    const deviceApi = {
      async startDeviceAuthorization() {
        calls.push("start");
        return baseDevice();
      },
      verificationUrl: (_a, d) => `https://auth.example${d.verification_uri}`,
      async pollForToken() {
        calls.push("poll");
        return {
          access_token: "sk-minted",
          refresh_token: "rt-minted",
          token_type: "Bearer",
          expires_in: 2592000,
        };
      },
    };
    const rebaked = [];
    const api = {
      ...identityApi(),
      // The freshly-minted device token is what openSession returns.
      async openSession() {
        return sessionFrom("sk-minted", "device", { refresh_token: "rt-minted" });
      },
    };

    await flow.deviceLogin({
      deps: {
        deviceApi,
        api,
        store,
        config: defaultConfig(),
        rebake: async (key) => {
          rebaked.push(key);
          return [];
        },
        ui,
      },
    });

    assert.deepEqual(calls, ["start", "poll"]);
    assert.deepEqual(rebaked, ["sk-minted"]);
    assert.ok(log.out.join("\n").includes("Signed in."));
    const cred = await store.loadCredential("default");
    assert.equal(cred.origin, "device");
    assert.equal(cred.access_token, "sk-minted");
    assert.equal(cred.refresh_token, "rt-minted");
  });

  test("passes an onSlowDown handler that prints the back-off line", async () => {
    const store = memoryStore();
    const { ui, log } = memoryUi();
    let sawSlowDown = false;
    const deviceApi = {
      async startDeviceAuthorization() {
        return baseDevice();
      },
      verificationUrl: (a) => a,
      async pollForToken(_url, _dev, options = {}) {
        assert.equal(typeof options.onSlowDown, "function", "flow must pass onSlowDown");
        options.onSlowDown(10);
        sawSlowDown = true;
        return {
          access_token: "sk-slow",
          refresh_token: "rt-slow",
          token_type: "Bearer",
          expires_in: 2592000,
        };
      },
    };

    await flow.deviceLogin({
      deps: { deviceApi, api: identityApi(), store, config: defaultConfig(), rebake: async () => [], ui },
    });

    assert.ok(sawSlowDown, "onSlowDown was invoked");
    assert.ok(
      log.err.join("\n").includes("Server asked us to back off; polling every 10s."),
      "back-off message printed to stderr"
    );
    assert.ok(log.out.join("\n").includes("Signed in."));
  });
});

describe("device.pollForToken branches (real module)", () => {
  test("entries with an already-expired code throw the expired hint without polling", async () => {
    // expires_in: 0 makes the deadline pass instantly, before any sleep or
    // fetch — deterministic and network-free.
    const expired = { ...baseDevice(), expires_in: 0 };
    await assert.rejects(
      device.pollForToken("https://auth.example/api.device.com", expired),
      /expired before it was approved/
    );
  });

  test("slow_down returns a pending response then succeeds with the token", async () => {
    // Drive the real poll loop with a mocked global fetch. A 1s interval keeps
    // each sleep short; the slow_down bump pushes the retry to a fast second
    // success path.
    const realFetch = globalThis.fetch;
    const deviceStart = { ...baseDevice(), interval: 1 };
    let fetchCount = 0;
    const slowDowns = [];
    try {
      globalThis.fetch = async (url, init) => {
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
          JSON.stringify({ access_token: "sk-ok", refresh_token: "rt-ok", token_type: "Bearer", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const tokens = await device.pollForToken("https://auth.example", deviceStart, {
        onSlowDown: (interval) => slowDowns.push(interval),
      });

      assert.equal(tokens.access_token, "sk-ok");
      assert.equal(fetchCount, 3);
      assert.deepEqual(slowDowns, [6], "slow_down bumps the interval by 5 (1+5)");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("logout", () => {
  test("device-minted key is revoked through the injected revoke seam", async () => {
    const store = memoryStore({
      default: {
        access_token: "sk-device",
        refresh_token: "rt-device",
        origin: "device",
        storage: "plaintext",
      },
    });
    const { ui } = memoryUi();
    const revoked = [];

    await flow.logout({
      profile: "default",
      deps: {
        store,
        config: defaultConfig(),
        revoke: async (_authUrl, token) => {
          revoked.push(token);
          return true;
        },
        ui: { ...ui, isInteractive: () => false },
      },
    });

    assert.deepEqual(revoked, ["rt-device"]);
    assert.equal(await store.loadCredential("default"), null);
  });

  test("pasted key is cleared locally and never revoked", async () => {
    const store = memoryStore({
      default: { access_token: "sk-paste", origin: "paste", storage: "plaintext" },
    });
    const { ui } = memoryUi();
    let revokeCalls = 0;

    await flow.logout({
      profile: "default",
      deps: {
        store,
        config: defaultConfig(),
        revoke: async () => {
          revokeCalls++;
          return true;
        },
        ui,
      },
    });

    assert.equal(revokeCalls, 0);
    assert.equal(await store.loadCredential("default"), null);
  });

  test("a pasted key with --revoke is refused and the credential survives", async () => {
    const store = memoryStore({
      default: { access_token: "sk-paste", origin: "paste", storage: "plaintext" },
    });
    const { ui } = memoryUi();

    await assert.rejects(
      flow.logout({
        profile: "default",
        revoke: true,
        deps: { store, config: defaultConfig(), ui },
      }),
      /refusing to revoke/
    );
    assert.ok(await store.loadCredential("default"));
  });
});

describe("pasteLogin validation", () => {
  beforeEach(() => delete process.env.AIAND_API_KEY);

  test("a sk- key is validated, stored as paste, and rebaked", async () => {
    const store = memoryStore();
    const { ui, log } = memoryUi();
    const validated = [];
    const rebaked = [];

    await flow.pasteLogin({
      key: "sk-abc123",
      deps: {
        api: {
          ...identityApi(),
          async validateKey(key) {
            validated.push(key);
            return { id: "u1", email: "paste@example.com" };
          },
        },
        store,
        config: defaultConfig(),
        rebake: async (key) => {
          rebaked.push(key);
          return [];
        },
        ui,
      },
    });

    assert.deepEqual(validated, ["sk-abc123"]);
    assert.deepEqual(rebaked, ["sk-abc123"]);
    const cred = await store.loadCredential("default");
    assert.equal(cred.origin, "paste");
    assert.equal(cred.access_token, "sk-abc123");
    assert.ok(log.out.join("\n").includes("Signed in with a pasted key."));
  });

  test("a malformed key is rejected before any API call", async () => {
    const store = memoryStore();
    const { ui } = memoryUi();
    let apiCalls = 0;

    await assert.rejects(
      flow.pasteLogin({
        key: "not-a-key",
        deps: {
          api: {
            ...identityApi(),
            async validateKey() {
              apiCalls++;
              return { id: "u1", email: "x" };
            },
          },
          store,
          config: defaultConfig(),
          rebake: async () => [],
          ui,
        },
      }),
      /Keys start with "sk-"/
    );
    assert.equal(apiCalls, 0);
    assert.equal(await store.loadCredential("default"), null);
  });

  test("a 401 from the API surfaces as a rejected-key hint", async () => {
    const store = memoryStore();
    const { ui } = memoryUi();

    await assert.rejects(
      flow.pasteLogin({
        key: "sk-bad",
        deps: {
          api: {
            ...identityApi(),
            async validateKey() {
              const err = new Error("That key was rejected.");
              err.status = 401;
              err.hint = "Check the key and try again.";
              throw err;
            },
          },
          store,
          config: defaultConfig(),
          rebake: async () => [],
          ui,
        },
      }),
      /rejected/
    );
    assert.equal(await store.loadCredential("default"), null);
  });
});