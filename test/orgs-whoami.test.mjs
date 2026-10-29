import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { cliEnv, runCli, startMockGateway, withTestEnv } from "./helpers.mjs";

// Env-key sessions (credential: null) must not borrow the stored credential:
// orgs marks no org active and whoami reports no expiry. The CLI runs as a
// child process against test/mock-gateway.mjs's two-orgs scenario.
const env = withTestEnv("aiand-orgs-whoami-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_KEY_STORAGE = "plaintext";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
  process.env.CI = "1"; // keep housekeeping lines off the stderr path
  process.env.NO_COLOR = "1";
});

// 2030-01-01T00:00:00.000Z — far future so nothing rotates it.
const EXPIRES_AT = 1893456000;

let gateway;
before(async () => {
  gateway = await startMockGateway();
});
after(() => gateway?.stop());

/**
 * Seed a leftover pasted-key credential (no refresh_token, so openSession
 * never rotates over the network) with a stored Org that is NOT first in the
 * stub list, so order-guessing and stored-marking stay distinguishable.
 * `expiresAt: null` is the shape a fresh paste login saves.
 */
function seedCredential({ expiresAt = EXPIRES_AT } = {}) {
  writeFileSync(
    join(env.dir, "credentials.json"),
    `${JSON.stringify({
      default: {
        origin: "paste",
        storage: "plaintext",
        ...(expiresAt === null ? {} : { expires_at: expiresAt }),
        user: { id: "u1", email: "dev@example.com" },
        org: { id: "org_2", name: "Second Org" },
      },
    })}\n`,
  );
  writeFileSync(
    join(env.dir, "credentials-plaintext.json"),
    `${JSON.stringify({ default: JSON.stringify({ access_token: "sk-stored-leftover" }) })}\n`,
  );
}

const cli = (args, overrides = {}) =>
  runCli(args, { env: cliEnv({ AIAND_BASE_URL: `${gateway.url}/stub/two-orgs`, ...overrides }) });

describe("orgs under an Env-key Session", () => {
  test("no Org is marked active despite a leftover stored Credential", async () => {
    seedCredential();
    const { code, stdout } = await cli(["orgs", "--json"], { AIAND_API_KEY: "sk-env-key" });
    assert.equal(code, 0);
    const orgs = JSON.parse(stdout);
    assert.equal(orgs.length, 2);
    assert.deepEqual(
      orgs.map((o) => o.active),
      [false, false],
    );
  });

  test("text mode explains the scope is unknown", async () => {
    seedCredential();
    const { code, stdout } = await cli(["orgs"], { AIAND_API_KEY: "sk-env-key" });
    assert.equal(code, 0);
    assert.match(stdout, /unknown under AIAND_API_KEY/);
    assert.doesNotMatch(stdout, /\*/);
  });

  test("a stray positional is a usage error", async () => {
    const { code, stderr } = await cli(["orgs", "nope"], { AIAND_API_KEY: "sk-env-key" });
    assert.equal(code, 1);
    assert.match(stderr, /Unknown argument "nope"/);
  });
});

describe("orgs under a stored Credential Session", () => {
  test("the stored Org is still marked active", async () => {
    seedCredential();
    const { code, stdout } = await cli(["orgs", "--json"]);
    assert.equal(code, 0);
    const orgs = JSON.parse(stdout);
    assert.deepEqual(
      orgs.map((o) => [o.id, o.active]),
      [
        ["org_1", false],
        ["org_2", true],
      ],
    );
  });
});

describe("whoami under an Env-key Session", () => {
  test("key_expires_at is null and source is env despite leftover Credential", async () => {
    seedCredential();
    const { code, stdout } = await cli(["whoami", "--json"], { AIAND_API_KEY: "sk-env-key" });
    assert.equal(code, 0);
    const identity = JSON.parse(stdout);
    assert.equal(identity.key_expires_at, null);
    assert.equal(identity.source, "AIAND_API_KEY");
    assert.equal(identity.storage, null);
  });

  test("the stored login's Org is not reported as the env key's", async () => {
    seedCredential();
    const { code, stdout } = await cli(["whoami", "--json"], { AIAND_API_KEY: "sk-env-key" });
    assert.equal(code, 0);
    assert.notEqual(JSON.parse(stdout).org?.id, "org_2");
  });

  test("text mode reads expiry from AIAND_API_KEY", async () => {
    seedCredential();
    const { code, stdout } = await cli(["whoami"], { AIAND_API_KEY: "sk-env-key" });
    assert.equal(code, 0);
    assert.match(stdout, /from AIAND_API_KEY/);
    assert.doesNotMatch(stdout, /rotated automatically/);
  });
});

describe("whoami under a stored Credential Session", () => {
  test("stored-only still shows the stored expiry", async () => {
    seedCredential();
    const { code, stdout } = await cli(["whoami", "--json"]);
    assert.equal(code, 0);
    const identity = JSON.parse(stdout);
    assert.equal(identity.key_expires_at, new Date(EXPIRES_AT * 1000).toISOString());
    assert.equal(identity.source, "pasted-key");
  });
});

describe("whoami under a pasted-key Credential without an expiry", () => {
  test("text mode says the key never expires", async () => {
    seedCredential({ expiresAt: null });
    const { code, stdout } = await cli(["whoami"]);
    assert.equal(code, 0);
    assert.match(stdout, /never \(pasted key\)/);
    assert.doesNotMatch(stdout, /from AIAND_API_KEY/);
  });

  test("--json has a null expiry and the pasted-key source", async () => {
    seedCredential({ expiresAt: null });
    const { code, stdout } = await cli(["whoami", "--json"]);
    assert.equal(code, 0);
    const identity = JSON.parse(stdout);
    assert.equal(identity.key_expires_at, null);
    assert.equal(identity.source, "pasted-key");
    assert.equal(identity.storage, "plaintext");
  });
});
