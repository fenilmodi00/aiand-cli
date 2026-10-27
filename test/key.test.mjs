import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { cliEnv, runCli, withTestEnv } from "./helpers.mjs";

const env = withTestEnv("aiand-key-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_KEY_STORAGE = "plaintext";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
  process.env.CI = "1"; // keep housekeeping lines off the stderr path
});

/**
 * Seed a pasted-key credential (no refresh_token, so openSession never
 * rotates/network-calls) in the plaintext tier of the temp config dir.
 */
function seedCredential(profile, key) {
  writeFileSync(
    join(env.dir, "credentials.json"),
    `${JSON.stringify({
      [profile]: { origin: "paste", storage: "plaintext", user: { id: "u1", email: "a@b.c" } },
    })}\n`,
  );
  writeFileSync(
    join(env.dir, "credentials-plaintext.json"),
    `${JSON.stringify({ [profile]: JSON.stringify({ access_token: key }) })}\n`,
  );
}

const cli = (args, overrides = {}) => runCli(args, { env: cliEnv(overrides) });

describe("aiand key export", () => {
  test("signed-out non-interactive run exits 2 with the NotLoggedInError message", async () => {
    const { code, stdout, stderr } = await cli(["key", "export"]);
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /Not logged in\./);
  });

  test("env key wins and stdout is exactly the key + newline", async () => {
    const KEY = "sk-key-env-12345";
    const { code, stdout, stderr } = await cli(["key", "export"], {
      AIAND_API_KEY: KEY,
    });
    assert.equal(code, 0);
    assert.equal(stdout, `${KEY}\n`);
    assert.equal(stderr, "");
  });

  test("stored credential prints the seeded key", async () => {
    const KEY = "sk-key-stored-67890";
    seedCredential("default", KEY);
    const { code, stdout } = await cli(["key", "export"]);
    assert.equal(code, 0);
    assert.equal(stdout, `${KEY}\n`);
  });

  test("--profile routes to the seeded profile", async () => {
    const KEY = "sk-key-profiles-111";
    seedCredential("work", KEY);
    const { code, stdout } = await cli(["key", "export", "--profile", "work"]);
    assert.equal(code, 0);
    assert.equal(stdout, `${KEY}\n`);
  });

  test("--help prints help", async () => {
    const { code, stdout } = await cli(["key", "export", "--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /aiand key export/);
    assert.match(stdout, /Usage/);
  });

  test("unknown verb errors with the verbs list", async () => {
    const { code, stderr } = await cli(["key", "rotate"]);
    assert.equal(code, 1);
    assert.match(stderr, /Unknown verb "rotate"\./);
    assert.match(stderr, /Verbs: export/);
  });

  test("missing verb errors, naming the verb and a copy-pasteable example", async () => {
    const { code, stderr } = await cli(["key"]);
    assert.equal(code, 1);
    assert.match(stderr, /No verb given\./);
    assert.match(stderr, /Verbs: export -- prints the active session key/);
    assert.match(stderr, /Try: aiand key export/);
  });
});
