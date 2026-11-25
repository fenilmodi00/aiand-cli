import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import {
  captureStdio,
  cliEnv,
  runCli,
  withEnv,
  withFetch,
  withTestEnv,
  writeConfigMarker,
} from "./helpers.mjs";

// A stored credential is bound to the endpoints that issued it: a later
// --base-url, AIAND_BASE_URL, AIAND_AUTH_URL or `config set` pointing
// elsewhere must never receive its key or its refresh token. Two recording
// loopback servers stand in for the real gateway (A) and the override (B).

const env = withTestEnv("aiand-binding-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_KEY_STORAGE = "plaintext";
  process.env.CI = "1";
  process.env.NO_COLOR = "1";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
});

const config = await import("../dist/config.js");
const { openSession, request } = await import("../dist/api/client.js");
const { logout } = await import("../dist/auth/logout.js");
const { pasteLogin } = await import("../dist/auth/login.js");

/** A loopback server answering like the gateway and logging every request. */
async function recordingServer() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization ?? null,
        body,
      });
      const reply = (status, value) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/auth/device/token") {
        return reply(200, {
          access_token: "sk-other-host",
          refresh_token: "rt-other-host",
          token_type: "Bearer",
          expires_in: 2592000,
        });
      }
      if (req.url === "/auth/device/logout") return reply(200, {});
      // A 401 on everything else would trigger the refresh path if the key got here.
      if (server.reject401) return reply(401, { error: "unauthorized" });
      if (req.url === "/api/user") return reply(200, { id: "u1", email: "a@example.com" });
      if (req.url === "/api/orgs") return reply(200, [{ id: "org_1", name: "Org" }]);
      return reply(200, { object: "list", data: [] });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    set reject401(value) {
      server.reject401 = value;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let A;
let B;
before(async () => {
  A = await recordingServer();
  B = await recordingServer();
});
after(async () => {
  await A?.close();
  await B?.close();
});

/** A fresh config dir holding one device credential for `default`. */
function seed({ boundTo, expiresInDays = 30, profiles } = {}) {
  const cfg = mkdtempSync(join(env.dir, "cfg-"));
  // What aiand drops in the first time it writes here; logout --all wipes only a dir with it.
  writeConfigMarker(cfg);
  writeFileSync(
    join(cfg, "credentials.json"),
    `${JSON.stringify({
      default: {
        origin: "device",
        ...(boundTo === undefined ? {} : { bound_to: boundTo }),
        expires_at: Math.floor(Date.now() / 1000) + expiresInDays * 24 * 3600,
        storage: "plaintext",
        user: { id: "u1", email: "a@example.com" },
      },
    })}\n`,
  );
  writeFileSync(
    join(cfg, "credentials-plaintext.json"),
    `${JSON.stringify({
      default: JSON.stringify({ access_token: "sk-real", refresh_token: "rt-real" }),
    })}\n`,
  );
  if (profiles) {
    writeFileSync(
      join(cfg, "config.json"),
      `${JSON.stringify({ profile: "default", profiles })}\n`,
    );
  }
  return cfg;
}

const boundToA = () => ({ auth_url: A.url, api_url: A.url });
const credentialsOf = (cfg) => JSON.parse(readFileSync(join(cfg, "credentials.json"), "utf8"));
const secretOf = (cfg) =>
  JSON.parse(JSON.parse(readFileSync(join(cfg, "credentials-plaintext.json"), "utf8")).default);

function cli(cfg, args, overrides = {}) {
  return runCli(args, {
    env: cliEnv({
      AIAND_CONFIG_DIR: cfg,
      AIAND_HOME: join(cfg, "home"),
      AIAND_API_KEY: undefined,
      AIAND_BASE_URL: undefined,
      AIAND_AUTH_URL: undefined,
      ...overrides,
    }),
  });
}

/**
 * Run `fn`, then assert nothing carrying a credential reached B: no
 * Authorization header, no body (refresh/revoke posts). A bare GET is not
 * checked, since a parallel test file probing a recycled loopback port can
 * land one here.
 */
async function nothingReachesB(fn) {
  const before = B.seen.length;
  await fn();
  const leaked = B.seen.slice(before).filter((r) => r.authorization !== null || r.body !== "");
  assert.deepEqual(leaked, [], "no credential may reach the override origin");
}

describe("recording a binding", { concurrency: 1 }, () => {
  test("waits for the credentials lock, so it cannot overwrite a sign-in saved meanwhile", async () => {
    const cfg = mkdtempSync(join(env.dir, "cfg-lock-"));
    await withEnv({ AIAND_CONFIG_DIR: cfg, AIAND_HOME: join(cfg, "home") }, async () => {
      await config.saveCredential("default", {
        access_token: "sk-before-lock",
        refresh_token: "rt-before-lock",
        origin: "device",
        bound_to: boundToA(),
      });
      const lock = join(cfg, "credentials.lock");
      // Another aiand process mid-update: a live pid, a fresh lock.
      writeFileSync(lock, String(process.pid));
      const binding = { auth_url: B.url, api_url: B.url };
      let done = false;
      const pending = config.bindCredential("default", binding).then(() => {
        done = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(done, false, "held back by the lock");
      assert.deepEqual(credentialsOf(cfg).default.bound_to, boundToA(), "nothing written yet");
      rmSync(lock);
      await pending;
      assert.deepEqual(credentialsOf(cfg).default.bound_to, binding);
    });
  });
});

describe("a stored credential stays with its issuer", { concurrency: 1 }, () => {
  test("logged in on A, --base-url B: refused, and nothing reaches B", async () => {
    // B answers 401, which before the fix sent the refresh token there too.
    B.reject401 = true;
    try {
      const cfg = seed({ boundTo: boundToA() });
      await nothingReachesB(async () => {
        const { code, stderr } = await cli(cfg, ["whoami", "--base-url", B.url], {
          AIAND_AUTH_URL: B.url,
        });
        assert.equal(code, 2);
        assert.match(stderr, /issued for http:\/\/127\.0\.0\.1:\d+; refusing to send it to/);
        assert.match(stderr, /aiand login --profile <name> --base-url/);
      });
      assert.deepEqual(secretOf(cfg), { access_token: "sk-real", refresh_token: "rt-real" });
    } finally {
      B.reject401 = false;
    }
  });

  test("an expiring credential is not rotated against the override", async () => {
    const cfg = seed({ boundTo: boundToA(), expiresInDays: 1 });
    await nothingReachesB(async () => {
      const { code } = await cli(cfg, ["whoami"], { AIAND_BASE_URL: B.url });
      assert.equal(code, 2);
    });
    assert.deepEqual(secretOf(cfg), { access_token: "sk-real", refresh_token: "rt-real" });
  });

  test("AIAND_AUTH_URL alone pointing elsewhere is refused too", async () => {
    const cfg = seed({ boundTo: boundToA() });
    await nothingReachesB(async () => {
      const { code } = await cli(cfg, ["whoami"], {
        AIAND_BASE_URL: undefined,
        AIAND_AUTH_URL: B.url,
        // api-url still points at A through the stored profile
      });
      assert.equal(code, 2);
    });
  });

  test("`config set api-url` to another host is refused at the next request", async () => {
    const cfg = seed({
      boundTo: boundToA(),
      profiles: { default: { apiUrl: A.url, authUrl: A.url } },
    });
    assert.equal((await cli(cfg, ["config", "set", "api-url", B.url])).code, 0);
    await nothingReachesB(async () => {
      const { code, stderr } = await cli(cfg, ["whoami"]);
      assert.equal(code, 2);
      assert.match(stderr, /refusing to send it/);
    });
  });

  test("`key export` (what agents bake) refuses under --base-url B", async () => {
    const cfg = seed({ boundTo: boundToA() });
    const { code, stdout } = await cli(cfg, ["key", "export", "--base-url", B.url]);
    assert.equal(code, 2);
    assert.doesNotMatch(stdout, /sk-real/);
  });

  test("`models --base-url B` while signed in on A reads B's public catalog, key unsent", async () => {
    const cfg = seedOnA();
    const before = B.seen.length;
    await nothingReachesB(async () => {
      const { code, stderr } = await cli(cfg, ["models", "--json", "--base-url", B.url]);
      assert.equal(code, 0, stderr);
      assert.match(stderr, /for another endpoint/);
    });
    const reached = B.seen.slice(before).filter((r) => r.path === "/v1/models");
    assert.ok(reached.length > 0, "the public catalog is still fetched from B");
  });

  test("the issuing endpoint still gets the key", async () => {
    const cfg = seed({ boundTo: boundToA() });
    const before = A.seen.length;
    const { code } = await cli(cfg, ["whoami", "--json"], {
      AIAND_BASE_URL: A.url,
      AIAND_AUTH_URL: `${A.url}/`,
    });
    assert.equal(code, 0);
    const sent = A.seen.slice(before).map((r) => r.authorization);
    assert.ok(sent.length > 0);
    assert.ok(sent.every((h) => h === "Bearer sk-real"));
  });

  test("AIAND_API_KEY is the user's per-run choice and goes where they point it", async () => {
    const cfg = seed({ boundTo: boundToA() });
    const before = B.seen.length;
    const { code } = await cli(cfg, ["whoami", "--json"], {
      AIAND_API_KEY: "sk-from-env",
      AIAND_BASE_URL: B.url,
    });
    assert.equal(code, 0);
    // Only what `whoami` itself sends: any other process on the machine can
    // land an unsolicited bare request (a probe, a recycled port) on B.
    const sent = B.seen
      .slice(before)
      .filter((r) => r.path.startsWith("/api/"))
      .map((r) => r.authorization);
    assert.ok(sent.length > 0);
    assert.ok(sent.every((h) => h === "Bearer sk-from-env"));
  });
});

/** A Codex profile as `aiand codex on` writes it; `authArgs` is the TOML array body. */
function writeCodexProfile(cfg, baseUrl, authArgs) {
  const home = join(cfg, "codex");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "aiand.config.toml"),
    `model = "m"
model_provider = "aiand"

[model_providers.aiand]
name = "ai&"
base_url = "${baseUrl}/v1"
wire_api = "responses"

[model_providers.aiand.auth]
command = "aiand"
args = [${authArgs}]
`,
  );
  return home;
}

/** The profile as Codex's own environment resolves it: stored on A, no overrides. */
const seedOnA = () =>
  seed({ boundTo: boundToA(), profiles: { default: { apiUrl: A.url, authUrl: A.url } } });

describe("Codex pulls the key with `key export`", { concurrency: 1 }, () => {
  test("--for an origin the credential was not issued for is refused", async () => {
    const cfg = seedOnA();
    const { code, stdout, stderr } = await cli(cfg, ["key", "export", "--for", B.url]);
    assert.equal(code, 2);
    assert.doesNotMatch(stdout, /sk-real/);
    assert.match(stderr, /issued for http:\/\/127\.0\.0\.1:\d+; refusing to send it to/);
  });

  test("--for with a username or password is refused before anything is quoted", async () => {
    const cfg = seedOnA();
    for (const url of [
      `http://me:hunter2-pw@127.0.0.1:9`,
      `http://:hunter2-pw@127.0.0.1:9`,
      "https://hunter2-pw@example.com",
    ]) {
      const { code, stdout, stderr } = await cli(cfg, ["key", "export", "--for", url]);
      assert.equal(code, 1, url);
      assert.equal(stdout, "");
      assert.match(stderr, /--for takes an origin/);
      assert.doesNotMatch(stderr, /hunter2-pw/);
    }
  });

  test("a refusal prints the endpoints without credentials, query or fragment", async () => {
    const cfg = seedOnA();
    const { code, stderr } = await cli(cfg, [
      "key",
      "export",
      "--for",
      `${B.url}/v1?token=qs-secret#frag-secret`,
    ]);
    assert.equal(code, 2);
    assert.match(stderr, /refusing to send it to http:\/\/127\.0\.0\.1:\d+\/v1\./);
    assert.doesNotMatch(stderr, /qs-secret|frag-secret/);
  });

  test("--for the issuing origin prints the key", async () => {
    const cfg = seedOnA();
    const { code, stdout } = await cli(cfg, ["key", "export", "--for", `${A.url}/`]);
    assert.equal(code, 0);
    assert.equal(stdout, "sk-real\n");
  });

  test("an env key goes wherever Codex is wired, --for or not", async () => {
    const cfg = seedOnA();
    const { code, stdout } = await cli(cfg, ["key", "export", "--for", B.url], {
      AIAND_API_KEY: "sk-from-env",
    });
    assert.equal(code, 0);
    assert.equal(stdout, "sk-from-env\n");
  });

  test("a config wired to B with no --for (pre-0.8 or an env-key `on`) never gets the stored key", async () => {
    const cfg = seedOnA();
    const codexHome = writeCodexProfile(cfg, B.url, '"key", "export"');
    const { code, stdout, stderr } = await cli(cfg, ["key", "export"], { CODEX_HOME: codexHome });
    assert.equal(code, 2);
    assert.doesNotMatch(stdout, /sk-real/);
    assert.match(stderr, /refusing to send it to/);
  });

  test("a config without --for wired to the issuing origin keeps working", async () => {
    const cfg = seedOnA();
    const codexHome = writeCodexProfile(cfg, A.url, '"key", "export"');
    const { code, stdout } = await cli(cfg, ["key", "export"], { CODEX_HOME: codexHome });
    assert.equal(code, 0);
    assert.equal(stdout, "sk-real\n");
  });

  test("a config pinned to another profile does not gate this profile's export", async () => {
    const cfg = seedOnA();
    const codexHome = writeCodexProfile(cfg, B.url, '"key", "export", "--profile", "other"');
    const { code, stdout } = await cli(cfg, ["key", "export"], { CODEX_HOME: codexHome });
    assert.equal(code, 0);
    assert.equal(stdout, "sk-real\n");
  });
});

describe("credentials saved before binding existed", { concurrency: 1 }, () => {
  test("with no stored URLs they are pinned to production, not to this run's override", async () => {
    const cfg = seed();
    await nothingReachesB(async () => {
      const { code } = await cli(cfg, ["whoami"], { AIAND_BASE_URL: B.url });
      assert.equal(code, 2);
    });
    assert.deepEqual(credentialsOf(cfg).default.bound_to, {
      auth_url: "https://api.aiand.com",
      api_url: "https://api.aiand.com",
    });
  });

  test("with stored profile URLs they are pinned there and keep working", async () => {
    const cfg = seed({ profiles: { default: { apiUrl: A.url, authUrl: A.url } } });
    const { code } = await cli(cfg, ["whoami", "--json"]);
    assert.equal(code, 0);
    assert.deepEqual(credentialsOf(cfg).default.bound_to, boundToA());
    // Pinned on first use: a later `config set` cannot move the key.
    await cli(cfg, ["config", "set", "auth-url", B.url]);
    await nothingReachesB(async () => {
      assert.equal((await cli(cfg, ["whoami"])).code, 2);
    });
  });
});

describe("an old credential in a dir whose config.json cannot say where it was issued", {
  concurrency: 1,
}, () => {
  /** A config.json copied from another install: aiand's shape, B as the issuer, another id. */
  const copyForeignConfig = (cfg) =>
    writeFileSync(
      join(cfg, "config.json"),
      `${JSON.stringify({
        profile: "default",
        profiles: { default: { apiUrl: B.url, authUrl: B.url } },
        config_id: "0".repeat(32),
      })}\n`,
    );

  test("a refused logout stays refused after `aiand models` and a config save write in the dir", async () => {
    const cfg = seed();
    copyForeignConfig(cfg);
    const marker = readFileSync(join(cfg, ".aiand-config"), "utf8");
    await nothingReachesB(async () => {
      const first = await cli(cfg, ["logout", "--revoke"]);
      assert.notEqual(first.code, 0);
      assert.match(first.stderr, /does not record where it was issued/);
      const models = await cli(cfg, ["models"]);
      assert.equal(models.code, 0, models.stderr);
      // Any write in the dir runs the marker code; a config save is one.
      assert.equal((await cli(cfg, ["config", "set", "model", "m"])).code, 0);
      const again = await cli(cfg, ["logout", "--revoke"]);
      assert.notEqual(again.code, 0);
      assert.match(again.stderr, /does not record where it was issued/);
    });
    assert.equal(
      readFileSync(join(cfg, ".aiand-config"), "utf8"),
      marker,
      "the marker is evidence",
    );
    assert.equal(credentialsOf(cfg).default.bound_to, undefined, "nothing was pinned");
    assert.deepEqual(secretOf(cfg), { access_token: "sk-real", refresh_token: "rt-real" });
  });

  test("with no config.json, first use and `config set` pin nothing", async () => {
    const cfg = seed();
    rmSync(join(cfg, "config.json"));
    const whoami = await cli(cfg, ["whoami"]);
    assert.equal(whoami.code, 2);
    assert.match(whoami.stderr, /its key was not sent/);
    const set = await cli(cfg, ["config", "set", "api-url", A.url]);
    assert.notEqual(set.code, 0);
    assert.match(set.stderr, /its endpoints were not changed/);
    assert.equal(credentialsOf(cfg).default.bound_to, undefined);
    assert.equal(existsSync(join(cfg, "config.json")), false);
  });

  test("`config use` bakes its key nowhere", async () => {
    const cfg = seed();
    copyForeignConfig(cfg);
    const { code, stderr } = await cli(cfg, ["config", "use", "default"]);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /its key was not baked into agent configs/);
  });
});

describe("`config set` before an old credential's first use", { concurrency: 1 }, () => {
  test("cannot move where its key and refresh token go", async () => {
    const cfg = seed({ profiles: { default: { apiUrl: A.url, authUrl: A.url } } });
    assert.equal((await cli(cfg, ["config", "set", "api-url", B.url])).code, 0);
    assert.equal((await cli(cfg, ["config", "set", "auth-url", B.url])).code, 0);
    assert.deepEqual(credentialsOf(cfg).default.bound_to, boundToA());
    B.reject401 = true;
    try {
      await nothingReachesB(async () => {
        assert.equal((await cli(cfg, ["whoami"])).code, 2);
        // logout still clears locally, but the refresh token goes to A only.
        assert.equal((await cli(cfg, ["logout", "--revoke"])).code, 0);
      });
    } finally {
      B.reject401 = false;
    }
  });

  test("warns about agents wired for the old API endpoint", async () => {
    const cfg = seed({ profiles: { default: { apiUrl: A.url, authUrl: A.url } } });
    writeFileSync(
      join(cfg, "wired.json"),
      `${JSON.stringify({ opencode: { profile: "default", api_url: A.url } })}\n`,
    );
    const { code, stderr } = await cli(cfg, ["config", "set", "api-url", B.url]);
    assert.equal(code, 0);
    assert.match(stderr, /\[opencode\] Still wired to http:\/\/127\.0\.0\.1:\d+/);
    const quiet = await cli(cfg, ["config", "set", "api-url", A.url]);
    assert.doesNotMatch(quiet.stderr, /Still wired/);
  });
});

describe("in-process gates", { concurrency: 1 }, () => {
  test("request() refuses a baseUrl the credential is not bound to", async () => {
    const credential = {
      access_token: "sk-real",
      refresh_token: "rt-real",
      origin: "device",
      bound_to: boundToA(),
    };
    const session = {
      profile: { name: "default", apiUrl: A.url, authUrl: A.url },
      token: "sk-real",
      credential,
    };
    let fetched = 0;
    await withFetch(
      async () => {
        fetched += 1;
        return new Response("{}");
      },
      () =>
        assert.rejects(request(session, { path: "/api/user", baseUrl: B.url }), /refusing to send/),
    );
    assert.equal(fetched, 0);
  });

  test("request() refusal never quotes a password in the endpoint", async () => {
    const session = {
      profile: { name: "default", apiUrl: A.url, authUrl: A.url },
      token: "sk-real",
      credential: {
        access_token: "sk-real",
        refresh_token: "rt-real",
        origin: "device",
        bound_to: boundToA(),
      },
    };
    const failure = await request(session, {
      path: "/api/user",
      baseUrl: "https://me:hunter2-pw@other.example/api?k=qs-secret",
    }).catch((error) => error);
    assert.match(failure.message, /refusing to send it to https:\/\/other\.example\/api/);
    assert.doesNotMatch(`${failure.message} ${failure.hint}`, /hunter2-pw|qs-secret/);
  });

  test("request() refuses a stored credential that has no bound_to, whatever it is sent to", async () => {
    const session = {
      profile: { name: "default", apiUrl: A.url, authUrl: A.url },
      token: "sk-real",
      credential: { access_token: "sk-real", refresh_token: "rt-real", origin: "device" },
    };
    let fetched = 0;
    await withFetch(
      async () => {
        fetched += 1;
        return new Response("{}");
      },
      async () => {
        await assert.rejects(request(session, { path: "/api/user" }), /never recorded/);
        await assert.rejects(
          request(session, { path: "/api/user", baseUrl: B.url }),
          /refusing to send/,
        );
      },
    );
    assert.equal(fetched, 0);
  });

  test("saveCredential without a binding takes the stored profile's, not this run's overrides", async () => {
    const cfg = seed({ profiles: { default: { apiUrl: A.url, authUrl: A.url } } });
    await withEnv(
      { AIAND_CONFIG_DIR: cfg, AIAND_BASE_URL: B.url, AIAND_AUTH_URL: B.url },
      async () => {
        await config.saveCredential("default", { access_token: "sk-new", origin: "paste" });
        await config.saveCredential("fresh", { access_token: "sk-fresh", origin: "paste" });
      },
    );
    const all = credentialsOf(cfg);
    assert.deepEqual(all.default.bound_to, boundToA());
    assert.equal(all.fresh.bound_to.api_url, "https://api.aiand.com");
  });

  test("`whoami --local` still reads the cached identity of a credential with no binding", async () => {
    const cfg = seed({ profiles: { default: { apiUrl: A.url, authUrl: A.url } } });
    const before = A.seen.length;
    const { code, stdout } = await cli(cfg, ["whoami", "--local", "--json"]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /a@example\.com/);
    assert.equal(A.seen.length, before, "--local makes no request");
  });

  test("a rotation never replaces a credential re-bound under it", async () => {
    const cfg = seed({ boundTo: boundToA() });
    await withEnv(
      { AIAND_CONFIG_DIR: cfg, AIAND_BASE_URL: A.url, AIAND_AUTH_URL: A.url },
      async () => {
        const session = await openSession(config.resolveProfile("default"));
        // Another process signs in elsewhere while this session is live.
        const all = credentialsOf(cfg);
        all.default.bound_to = { auth_url: B.url, api_url: B.url };
        writeFileSync(join(cfg, "credentials.json"), JSON.stringify(all));
        let refreshPosts = 0;
        await withFetch(
          async (url) => {
            if (new URL(url).pathname === "/auth/device/token") refreshPosts += 1;
            return new Response("{}", { status: 401 });
          },
          () => assert.rejects(request(session, { path: "/api/user" }), /refusing to send/),
        );
        assert.equal(refreshPosts, 0);
        assert.deepEqual(secretOf(cfg), { access_token: "sk-real", refresh_token: "rt-real" });
      },
    );
  });

  test("logout revokes at the issuer even under an override", async () => {
    const cfg = seed({ boundTo: boundToA() });
    const before = A.seen.length;
    await nothingReachesB(() =>
      withEnv(
        { AIAND_CONFIG_DIR: cfg, AIAND_HOME: join(cfg, "home"), AIAND_AUTH_URL: B.url },
        async () => {
          const muted = captureStdio({ mute: true });
          try {
            await logout({ profile: "default", revoke: true });
          } finally {
            muted.restore();
          }
        },
      ),
    );
    const revokes = A.seen.slice(before).filter((r) => r.path === "/auth/device/logout");
    assert.equal(revokes.length, 1);
    assert.match(revokes[0].body, /rt-real/);
  });

  test("logout --all revokes at the issuer even under an override", async () => {
    const cfg = seed({ boundTo: boundToA() });
    const before = A.seen.length;
    await nothingReachesB(async () => {
      const { code, stderr } = await cli(cfg, ["logout", "--all", "--force"], {
        AIAND_BASE_URL: B.url,
        AIAND_WIPE_OUTSIDE_HOME: "1",
      });
      assert.equal(code, 0, stderr);
    });
    const revokes = A.seen.slice(before).filter((r) => r.path === "/auth/device/logout");
    assert.equal(revokes.length, 1);
    assert.match(revokes[0].body, /rt-real/);
  });

  test("logout --all revokes a pre-0.8 sign-in at the profile's stored endpoint, not the override", async () => {
    const cfg = seed({
      profiles: { default: { authUrl: A.url, apiUrl: A.url } },
    });
    const before = A.seen.length;
    await nothingReachesB(async () => {
      const { code, stderr } = await cli(cfg, ["logout", "--all", "--force"], {
        AIAND_BASE_URL: B.url,
        AIAND_WIPE_OUTSIDE_HOME: "1",
      });
      assert.equal(code, 0, stderr);
    });
    const revokes = A.seen.slice(before).filter((r) => r.path === "/auth/device/logout");
    assert.equal(revokes.length, 1);
    assert.match(revokes[0].body, /rt-real/);
  });

  test("a sign-in left with no config.json: logout --all says to log out first, and logout revokes at the issuer", async () => {
    const cfg = seed({ boundTo: boundToA() });
    rmSync(join(cfg, "config.json"));
    rmSync(join(cfg, ".aiand-config"));
    const before = A.seen.length;
    await nothingReachesB(async () => {
      const refused = await cli(cfg, ["logout", "--all", "--force"], {
        AIAND_WIPE_OUTSIDE_HOME: "1",
      });
      assert.notEqual(refused.code, 0);
      // A login first would replace the sign-in without revoking its key.
      assert.match(
        refused.stderr,
        /first run aiand logout --profile <name>[\s\S]*Then run aiand login/,
      );
      assert.equal(A.seen.length, before, "the refusal sends nothing");
      const { code, stderr } = await cli(cfg, ["logout", "--revoke"], { AIAND_BASE_URL: B.url });
      assert.equal(code, 0, stderr);
    });
    const revokes = A.seen.slice(before).filter((r) => r.path === "/auth/device/logout");
    assert.equal(revokes.length, 1);
    assert.match(revokes[0].body, /rt-real/);
    assert.equal(existsSync(join(cfg, "credentials.json")), false);
  });

  test("a sign-in beside a config.json of another install: logout --all says to log out first", async () => {
    const cfg = seed({ boundTo: boundToA() });
    // config.json carries an id the marker does not: copied from another install.
    writeFileSync(
      join(cfg, "config.json"),
      `${JSON.stringify({ profile: "default", profiles: { default: {} }, config_id: "0".repeat(32) })}\n`,
    );
    const before = A.seen.length;
    await nothingReachesB(async () => {
      const refused = await cli(cfg, ["logout", "--all", "--force"], {
        AIAND_WIPE_OUTSIDE_HOME: "1",
      });
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /it is not aiand's config directory\./);
      // aiand never rewrites the marker, so a login alone would not make the two agree.
      assert.match(
        refused.stderr,
        /records another id[\s\S]*first run aiand logout --profile <name>[\s\S]*Then delete its \.aiand-config file, run aiand login/,
      );
      assert.equal(A.seen.length, before, "the refusal sends nothing");
    });
    assert.equal(existsSync(join(cfg, "credentials.json")), true);
  });

  test("logout sends an unbound sign-in nowhere when no config.json says where it was issued", async () => {
    const cfg = seed();
    rmSync(join(cfg, "config.json"));
    let fetched = 0;
    await withEnv({ AIAND_CONFIG_DIR: cfg, AIAND_HOME: join(cfg, "home") }, () =>
      withFetch(
        async () => {
          fetched += 1;
          return new Response("{}");
        },
        async () => {
          const muted = captureStdio({ mute: true });
          try {
            await assert.rejects(
              logout({ profile: "default", revoke: true }),
              /does not record where it was issued/,
            );
            assert.deepEqual(secretOf(cfg), { access_token: "sk-real", refresh_token: "rt-real" });
            await logout({ profile: "default", keepRemote: true });
          } finally {
            muted.restore();
          }
        },
      ),
    );
    assert.equal(fetched, 0);
    assert.equal(existsSync(join(cfg, "credentials.json")), false);
  });

  test("logout sends an unbound sign-in nowhere when config.json's id is not the marker's", async () => {
    const cfg = seed();
    // A config.json copied from another install: aiand's shape, an issuer, another id.
    writeFileSync(
      join(cfg, "config.json"),
      `${JSON.stringify({
        profile: "default",
        profiles: { default: { apiUrl: A.url, authUrl: A.url } },
        config_id: "0".repeat(32),
      })}\n`,
    );
    let fetched = 0;
    await withEnv({ AIAND_CONFIG_DIR: cfg, AIAND_HOME: join(cfg, "home") }, () =>
      withFetch(
        async () => {
          fetched += 1;
          return new Response("{}");
        },
        async () => {
          const muted = captureStdio({ mute: true });
          try {
            await assert.rejects(
              logout({ profile: "default", revoke: true }),
              /does not record where it was issued/,
            );
          } finally {
            muted.restore();
          }
        },
      ),
    );
    assert.equal(fetched, 0);
    assert.deepEqual(secretOf(cfg), { access_token: "sk-real", refresh_token: "rt-real" });
  });

  test("a pasted key records the endpoint it was validated against", async () => {
    const cfg = mkdtempSync(join(env.dir, "cfg-paste-"));
    await withEnv(
      {
        AIAND_CONFIG_DIR: cfg,
        AIAND_HOME: join(cfg, "home"),
        AIAND_BASE_URL: A.url,
        AIAND_AUTH_URL: undefined,
      },
      async () => {
        const muted = captureStdio({ mute: true });
        try {
          await pasteLogin({ key: "sk-pasted" });
        } finally {
          muted.restore();
        }
      },
    );
    assert.deepEqual(credentialsOf(cfg).default.bound_to, boundToA());
  });
});
