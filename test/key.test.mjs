import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const execFileAsync = promisify(execFile);
const BIN = join(dirname(import.meta.dirname), "dist", "index.js");

let dir;
const originalEnv = { ...process.env };

/**
 * Seed a pasted-key credential (no refresh_token, so openSession never
 * rotates/network-calls) in the plaintext tier of the temp config dir.
 */
function seedCredential(profile, key) {
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({
    [profile]: { origin: "paste", storage: "plaintext", user: { id: "u1", email: "a@b.c" } },
  }) + "\n");
  writeFileSync(
    join(dir, "credentials-plaintext.json"),
    JSON.stringify({ [profile]: JSON.stringify({ access_token: key }) }) + "\n"
  );
}

const runCli = async (args, env = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-key-test-"));
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_KEY_STORAGE = "plaintext";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
  process.env.CI = "1"; // keep housekeeping lines off the stderr path
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

describe("aiand key export", () => {
  test("signed-out non-interactive run exits 2 with the NotLoggedInError message", async () => {
    const { code, stdout, stderr } = await runCli(["key", "export"], { CI: "1" });
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /Not logged in\./);
  });

  test("env key wins and stdout is exactly the key + newline", async () => {
    const KEY = "sk-key-env-12345";
    const { code, stdout, stderr } = await runCli(["key", "export"], {
      AIAND_API_KEY: KEY,
      CI: "1",
    });
    assert.equal(code, 0);
    assert.equal(stdout, KEY + "\n");
    assert.equal(stderr, "");
  });

  test("stored credential prints the seeded key", async () => {
    const KEY = "sk-key-stored-67890";
    seedCredential("default", KEY);
    const { code, stdout } = await runCli(["key", "export"], { CI: "1" });
    assert.equal(code, 0);
    assert.equal(stdout, KEY + "\n");
  });

  test("--profile routes to the seeded profile", async () => {
    const KEY = "sk-key-profiles-111";
    seedCredential("work", KEY);
    const { code, stdout } = await runCli(["key", "export", "--profile", "work"], { CI: "1" });
    assert.equal(code, 0);
    assert.equal(stdout, KEY + "\n");
  });

  test("--help prints help", async () => {
    const { code, stdout } = await runCli(["key", "export", "--help"], { CI: "1" });
    assert.equal(code, 0);
    assert.match(stdout, /aiand key export/);
    assert.match(stdout, /Usage/);
  });

  test("unknown verb errors with the verbs list", async () => {
    const { code, stderr } = await runCli(["key", "rotate"], { CI: "1" });
    assert.equal(code, 1);
    assert.match(stderr, /Unknown verb "rotate"\./);
    assert.match(stderr, /Verbs: export/);
  });

  test("missing verb errors, listing export", async () => {
    const { code, stderr } = await runCli(["key"], { CI: "1" });
    assert.equal(code, 1);
    assert.match(stderr, /No verb given\./);
    assert.match(stderr, /Verbs: export/);
  });
});