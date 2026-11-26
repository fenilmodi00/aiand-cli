import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import {
  captureStdio,
  cliEnv,
  runCli,
  withEnv,
  withTestEnv,
  writeConfigMarker,
} from "./helpers.mjs";

// `aiand login --base-url X` binds the credential to X; the profile must then
// say X too, or every later command (no flag) reads as an override-free
// mismatch and exits 2 with nowhere to go.

const env = withTestEnv("aiand-login-binding-", (dir) => {
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

const { pasteLogin } = await import("../dist/auth/login.js");

async function gateway() {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/user") return res.end(JSON.stringify({ id: "u1", email: "a@x.com" }));
      if (req.url === "/api/orgs") return res.end(JSON.stringify([{ id: "o1", name: "Org" }]));
      res.end(JSON.stringify({ object: "list", data: [] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
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
  A = await gateway();
  B = await gateway();
});
after(async () => {
  await A?.close();
  await B?.close();
});

const cli = (cfg, args, overrides = {}) =>
  runCli(args, {
    env: cliEnv({
      AIAND_CONFIG_DIR: cfg,
      AIAND_HOME: join(cfg, "home"),
      AIAND_API_KEY: undefined,
      AIAND_BASE_URL: undefined,
      AIAND_AUTH_URL: undefined,
      ...overrides,
    }),
  });

describe("signing in under --base-url", { concurrency: 1 }, () => {
  test("writes the bound URLs onto the profile, so the next command needs no flag", async () => {
    const cfg = mkdtempSync(join(env.dir, "cfg-"));
    await withEnv(
      { AIAND_CONFIG_DIR: cfg, AIAND_HOME: join(cfg, "home"), AIAND_BASE_URL: A.url },
      async () => {
        const muted = captureStdio({ mute: true });
        try {
          await pasteLogin({ key: "sk-pasted" });
        } finally {
          muted.restore();
        }
      },
    );
    const stored = JSON.parse(readFileSync(join(cfg, "config.json"), "utf8")).profiles.default;
    assert.equal(stored.apiUrl, A.url);
    assert.equal(stored.authUrl, A.url);
    const { code, stderr } = await cli(cfg, ["whoami"]);
    assert.equal(code, 0, stderr);
  });
});

describe("the refusal hint", { concurrency: 1 }, () => {
  function seedBoundToA(profiles) {
    const cfg = mkdtempSync(join(env.dir, "cfg-hint-"));
    mkdirSync(join(cfg, "home"), { recursive: true });
    writeConfigMarker(cfg);
    writeFileSync(
      join(cfg, "credentials.json"),
      `${JSON.stringify({
        default: {
          origin: "paste",
          bound_to: { auth_url: A.url, api_url: A.url },
          storage: "plaintext",
          user: { id: "u1", email: "a@x.com" },
        },
      })}\n`,
    );
    writeFileSync(
      join(cfg, "credentials-plaintext.json"),
      `${JSON.stringify({ default: JSON.stringify({ access_token: "sk-real" }) })}\n`,
    );
    writeFileSync(
      join(cfg, "config.json"),
      `${JSON.stringify({ profile: "default", profiles })}\n`,
    );
    return cfg;
  }

  test("names `config set` when no override is set, and does not say to drop one", async () => {
    const cfg = seedBoundToA({ default: { apiUrl: B.url, authUrl: B.url } });
    const { code, stderr } = await cli(cfg, ["whoami"]);
    assert.equal(code, 2);
    assert.match(stderr, /aiand config set api-url /);
    assert.match(stderr, /aiand config set auth-url /);
    assert.doesNotMatch(stderr, /Drop the override/);
  });

  test("says to drop the override when one is set", async () => {
    const cfg = seedBoundToA({ default: { apiUrl: A.url, authUrl: A.url } });
    const { code, stderr } = await cli(cfg, ["whoami", "--base-url", B.url]);
    assert.equal(code, 2);
    assert.match(stderr, /Drop the override/);
  });
});
