
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;
const originalEnv = { ...process.env };
const MASTER_KEY = "a".repeat(64);

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-cli-test-"));
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_KEY_STORAGE = "file";
  process.env.AIAND_SECRET_STORE_MASTER_KEY = MASTER_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

function resetCredentialState() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

const config = await import("../dist/config.js");

describe("endpoint resolution", () => {
  test("defaults to the documented public endpoint", () => {
    const profile = config.resolveProfile();
    assert.equal(profile.apiUrl, config.DEFAULT_BASE_URL);
    assert.equal(profile.authUrl, config.DEFAULT_BASE_URL);
  });

  test("a stored profile overrides the default", () => {
    config.updateProfile("default", { apiUrl: "https://stored.example" });
    assert.equal(config.resolveProfile().apiUrl, "https://stored.example");
  });

  test("AIAND_BASE_URL overrides the stored profile", () => {
    process.env.AIAND_BASE_URL = "https://env.example";
    assert.equal(config.resolveProfile().apiUrl, "https://env.example");
    delete process.env.AIAND_BASE_URL;
  });

  test("AIAND_AUTH_URL narrows to the auth endpoint only", () => {
    process.env.AIAND_BASE_URL = "https://both.example";
    process.env.AIAND_AUTH_URL = "https://auth.example";
    const profile = config.resolveProfile();
    assert.equal(profile.authUrl, "https://auth.example");
    assert.equal(profile.apiUrl, "https://both.example");
    delete process.env.AIAND_BASE_URL;
    delete process.env.AIAND_AUTH_URL;
  });

  test("strips a trailing slash so paths do not double up", () => {
    process.env.AIAND_BASE_URL = "https://slash.example/";
    assert.equal(config.resolveProfile().apiUrl, "https://slash.example");
    delete process.env.AIAND_BASE_URL;
  });
});
describe("profiles", () => {
  beforeEach(() => resetCredentialState());

  test("keep separate credentials", async () => {
    process.env.AIAND_KEY_STORAGE = "plaintext";
    try {
      await config.saveCredential("work", {
        access_token: "sk-work",
        refresh_token: "rt-work",
        expires_at: 1,
      });
      await config.saveCredential("home", {
        access_token: "sk-home",
        refresh_token: "rt-home",
        expires_at: 2,
      });
      assert.equal((await config.loadCredential("work")).access_token, "sk-work");
      assert.equal((await config.loadCredential("home")).access_token, "sk-home");
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });

  test("clearing one leaves the other intact", async () => {
    process.env.AIAND_KEY_STORAGE = "plaintext";
    try {
      await config.saveCredential("work", {
        access_token: "sk-work",
        refresh_token: "rt-work",
        expires_at: 1,
      });
      await config.saveCredential("home", {
        access_token: "sk-home",
        refresh_token: "rt-home",
        expires_at: 2,
      });
      await config.clearCredential("work");
      assert.equal(await config.loadCredential("work"), null);
      assert.equal((await config.loadCredential("home")).access_token, "sk-home");
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });

  test("clearing the last one removes the file rather than leaving an empty object", async () => {
    process.env.AIAND_KEY_STORAGE = "plaintext";
    try {
      await config.saveCredential("home", {
        access_token: "sk-home",
        refresh_token: "rt-home",
        expires_at: 2,
      });
      await config.clearCredential("home");
      assert.throws(() => statSync(config.credentialsPath()), { code: "ENOENT" });
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });
});

describe("credential file permissions", () => {
  beforeEach(() => resetCredentialState());

  test("is created 0600", async () => {
    process.env.AIAND_KEY_STORAGE = "plaintext";
    try {
      await config.saveCredential("p", { access_token: "sk-a", refresh_token: "r", expires_at: 1 });
      assert.equal(statSync(config.credentialsPath()).mode & 0o777, 0o600);
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });

  test("is re-tightened on rewrite, not left at whatever it was", async () => {
    process.env.AIAND_KEY_STORAGE = "plaintext";
    try {
      await config.saveCredential("p", { access_token: "sk-b", refresh_token: "r", expires_at: 2 });
      const path = config.credentialsPath();
      chmodSync(path, 0o644);
      await config.saveCredential("p", { access_token: "sk-b", refresh_token: "r", expires_at: 2 });
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });
});

describe("credential storage", () => {
  beforeEach(() => resetCredentialState());

  test("file tier round-trips a blob and stores metadata only", async () => {
    process.env.AIAND_KEY_STORAGE = "file";
    process.env.AIAND_SECRET_STORE_MASTER_KEY = MASTER_KEY;
    try {
      await config.saveCredential("p", { access_token: "sk-a", refresh_token: "r", expires_at: 1 });
      const loaded = await config.loadCredential("p");
      assert.equal(loaded.access_token, "sk-a");
      assert.equal(loaded.refresh_token, "r");
      assert.equal(loaded.storage, "file");

      // credentials.json holds metadata only.
      const raw = readFileSync(config.credentialsPath(), "utf8");
      assert.ok(!raw.includes("sk-a"));
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
      delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
    }
  });

  test("credentials.json is created 0600 and the secret store key file too", async () => {
    process.env.AIAND_KEY_STORAGE = "file";
    // No master-key env here, so the key file path is exercised.
    delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
    try {
      await config.saveCredential("p", { access_token: "sk-a", refresh_token: "r", expires_at: 1 });
      assert.equal(statSync(config.credentialsPath()).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, "secret-store.key")).mode & 0o777, 0o600);
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
      delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
    }
  });

  test("is re-tightened on rewrite, not left at whatever it was", async () => {
    process.env.AIAND_KEY_STORAGE = "file";
    process.env.AIAND_SECRET_STORE_MASTER_KEY = MASTER_KEY;
    try {
      await config.saveCredential("p", { access_token: "sk-b", refresh_token: "r", expires_at: 2 });
      const path = config.credentialsPath();
      chmodSync(path, 0o644);
      await config.saveCredential("p", { access_token: "sk-b", refresh_token: "r", expires_at: 2 });
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
      delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
    }
  });
});

describe("malformed config", () => {
  test("fails with a readable message instead of a JSON parse trace", () => {
    writeFileSync(config.configPath(), "{ not json", { mode: 0o600 });
    assert.throws(() => config.loadConfig(), /not valid JSON/);
  });
});
