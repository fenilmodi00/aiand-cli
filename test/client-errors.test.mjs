import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { withMockGateway, withTestEnv } from "./helpers.mjs";

// Direct coverage for src/api/client.ts error paths (429 Retry-After hint,
// 401→refresh→resend, parsed identity) through the built dist against a
// separate-process mock gateway. A separate process, not an in-process
// server, so child-process CLI runs can never deadlock on a blocked parent
// event loop. No network beyond 127.0.0.1; no real home (fresh temp config
// dir per test under withTestEnv).

const execFileAsync = promisify(execFile);
const BIN = join(dirname(import.meta.dirname), "dist", "index.js");

const env = withTestEnv("aiand-client-errors-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
  delete process.env.AIAND_KEY_STORAGE;
  delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
  process.env.CI = "1"; // keep housekeeping lines off the child stdio paths
});

/** Spawn the built CLI; `undefined` values delete the key so absence is explicit. */
const runCli = async (args, extraEnv = {}) => {
  const childEnv = { ...process.env, NO_COLOR: "1", CI: "1", ...extraEnv };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete childEnv[key];
  }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: childEnv,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
};

/** A fresh config dir per test so seeded credentials never leak across tests. */
function freshCfg(tag) {
  const cfg = mkdtempSync(join(env.dir, `client-errors-${tag}-`));
  return { cfg, home: join(cfg, "home") };
}

/**
 * Seed a device-minted credential (refresh_token present, far from expiry so
 * openSession hands back the old key and the 401 triggers the resend path)
 * in the plaintext tier, following the key.test.mjs seed pattern. The cached
 * org id deliberately differs from the gateway's so probeIdentity surfaces
 * the fresh org instead of the cached one.
 */
function seedRefreshCredential(cfg) {
  writeFileSync(
    join(cfg, "credentials.json"),
    JSON.stringify({
      default: {
        origin: "device",
        expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        storage: "plaintext",
        user: { id: "u1", email: "stale@example.com" },
        org: { id: "org_0", name: "Stale Org" },
      },
    }) + "\n"
  );
  writeFileSync(
    join(cfg, "credentials-plaintext.json"),
    JSON.stringify({
      default: JSON.stringify({
        access_token: "sk-old-mock-token",
        refresh_token: "rt-old-mock-token",
      }),
    }) + "\n"
  );
}

describe("client error paths (mock gateway)", () => {
  test("429 surfaces the Retry-After seconds in the hint and exits 1", async () => {
    await withMockGateway(async ({ url }) => {
      const { cfg, home } = freshCfg("429");
      // Env-key session, so the 429 comes straight from the identity fetch.
      const { code, stderr } = await runCli(["whoami"], {
        AIAND_CONFIG_DIR: cfg,
        AIAND_HOME: home,
        AIAND_API_KEY: "sk-test-not-real",
        AIAND_BASE_URL: `${url}/stub/429`,
      });
      assert.equal(code, 1);
      assert.match(stderr, /HTTP 429/);
      assert.match(stderr, /Retry after 7s\./);
      assert.match(stderr, /Policy: burst;w=60\./);
    });
  });

  test("401-then-200 rotates the stored credential and returns the fresh identity", async () => {
    await withMockGateway(async ({ url }) => {
      const { cfg, home } = freshCfg("refresh");
      seedRefreshCredential(cfg);
      const { code, stdout } = await runCli(["whoami", "--json"], {
        AIAND_CONFIG_DIR: cfg,
        AIAND_HOME: home,
        AIAND_API_KEY: undefined,
        AIAND_BASE_URL: `${url}/stub/401-then-200`,
        AIAND_KEY_STORAGE: "plaintext",
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.user.email, "refreshed@example.com");
      assert.equal(parsed.org.name, "Refreshed Org");
      // The rotation persisted: the stored key is the minted one, not the stale seed.
      const blob = JSON.parse(
        JSON.parse(readFileSync(join(cfg, "credentials-plaintext.json"), "utf8")).default
      );
      assert.equal(blob.access_token, "sk-new-mock-token");
      assert.equal(blob.refresh_token, "rt-new-mock-token");
    });
  });

  test("happy-path 200 returns the parsed identity", async () => {
    await withMockGateway(async ({ url }) => {
      const { cfg, home } = freshCfg("happy");
      const { code, stdout } = await runCli(["whoami", "--json"], {
        AIAND_CONFIG_DIR: cfg,
        AIAND_HOME: home,
        AIAND_API_KEY: "sk-test-not-real",
        AIAND_BASE_URL: url,
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.user.email, "happy@example.com");
      assert.equal(parsed.org.name, "Happy Org");
    });
  });
});

describe("logs 404 on an unpublished gateway route", () => {
  test("aiand logs prints a usage fallback hint", async () => {
    await withMockGateway(async ({ url }) => {
      const { cfg, home } = freshCfg("logs404");
      const { code, stderr } = await runCli(["logs", "--json"], {
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: cfg,
        AIAND_API_KEY: "sk-test-not-real",
        AIAND_BASE_URL: `${url}/stub/logs-404`,
      });
      assert.equal(code, 1);
      assert.match(stderr, /Request logs are not available/);
      assert.match(stderr, /aiand usage/);
    });
  });
});
