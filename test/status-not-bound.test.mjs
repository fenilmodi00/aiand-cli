import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CLOSED_URL, cliEnv, runCli, withTestEnv, writeConfigMarker } from "./helpers.mjs";

// status keeps its three states (signed in, signed out, unreachable) when the
// stored sign-in belongs to another endpoint than this run's: it is signed out
// for *this* endpoint, with the reason and the agent table, never a bare exit 2.

const env = withTestEnv("aiand-status-notbound-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
});

const ISSUER = "http://127.0.0.1:1";

function seed() {
  const cfg = mkdtempSync(join(env.dir, "cfg-"));
  writeConfigMarker(cfg);
  writeFileSync(
    join(cfg, "credentials.json"),
    `${JSON.stringify({
      default: {
        origin: "paste",
        bound_to: { auth_url: ISSUER, api_url: ISSUER },
        storage: "plaintext",
        user: { id: "u1", email: "a@x.com" },
      },
    })}\n`,
  );
  writeFileSync(
    join(cfg, "credentials-plaintext.json"),
    `${JSON.stringify({ default: JSON.stringify({ access_token: "sk-real" }) })}\n`,
  );
  return cfg;
}

const status = (cfg, args) =>
  runCli(["status", ...args], {
    env: cliEnv({
      AIAND_CONFIG_DIR: cfg,
      AIAND_HOME: join(cfg, "home"),
      AIAND_API_KEY: undefined,
      AIAND_BASE_URL: undefined,
      AIAND_AUTH_URL: undefined,
    }),
  });

test("status --json under --base-url for another endpoint reports signed out, with a reason", async () => {
  const { code, stdout } = await status(seed(), ["--json", "--base-url", CLOSED_URL]);
  const report = JSON.parse(stdout);
  assert.equal(report.auth.signed_in, false);
  assert.equal(report.auth.reachable, true);
  assert.match(report.auth.reason, /issued for http:\/\/127\.0\.0\.1:1/);
  assert.equal(report.auth.key, null);
  assert.ok(report.agents.length > 0);
  assert.equal(code, 1);
});

test("status in text says why, and still lists the agents", async () => {
  const { code, stdout, stderr } = await status(seed(), ["--base-url", CLOSED_URL]);
  assert.match(stdout, /Not signed in/);
  assert.match(stderr, /issued for http:\/\/127\.0\.0\.1:1/);
  assert.match(stdout, /AGENT\s+STATE/);
  assert.equal(code, 1);
});

test("whoami still refuses with exit 2", async () => {
  const { code } = await runCli(["whoami", "--base-url", CLOSED_URL], {
    env: cliEnv({
      AIAND_CONFIG_DIR: seed(),
      AIAND_API_KEY: undefined,
      AIAND_BASE_URL: undefined,
      AIAND_AUTH_URL: undefined,
    }),
  });
  assert.equal(code, 2);
});
