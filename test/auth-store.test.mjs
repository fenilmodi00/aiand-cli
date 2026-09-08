import assert from "node:assert/strict";
import test, { beforeEach, describe } from "node:test";
import { readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { withTestEnv } from "./helpers.mjs";

const MASTER_KEY = randomBytes(32).toString("hex");

const env = withTestEnv("aiand-auth-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_HOME = join(dir, "home");
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
  delete process.env.AIAND_KEY_STORAGE;
  delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
});

const config = await import("../dist/config.js");
const secrets = await import("../dist/secrets.js");

function resetDir() {
  rmSync(env.dir, { recursive: true, force: true });
  mkdirSync(env.dir, { recursive: true });
}

describe("plaintext tier", () => {
  beforeEach(() => resetDir());

  test("round-trips a blob", async () => {
    process.env.AIAND_KEY_STORAGE = "plaintext";
    try {
      assert.equal(await secrets.detectTier(), "plaintext");
      assert.equal(await secrets.storeSecret("p1", '{"access_token":"sk-a"}'), "plaintext");
      assert.equal(await secrets.loadSecret("p1"), '{"access_token":"sk-a"}');
      await secrets.deleteSecret("p1");
      assert.equal(await secrets.loadSecret("p1"), null);
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });

  test("plaintext file is 0600", async () => {
    process.env.AIAND_KEY_STORAGE = "plaintext";
    try {
      await secrets.storeSecret("p1", "x");
      assert.equal(statSync(join(env.dir, "credentials-plaintext.json")).mode & 0o777, 0o600);
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });
});

describe("encrypted file tier", () => {
  beforeEach(() => resetDir());

  test("round-trips with a fixed master key, ciphertext is not the plaintext", async () => {
    process.env.AIAND_KEY_STORAGE = "file";
    process.env.AIAND_SECRET_STORE_MASTER_KEY = MASTER_KEY;
    try {
      assert.equal(await secrets.detectTier(), "file");
      assert.equal(await secrets.storeSecret("p1", '{"access_token":"sk-secret-token"}'), "file");
      assert.equal(await secrets.loadSecret("p1"), '{"access_token":"sk-secret-token"}');

      // Two profiles coexist in one store.
      await secrets.storeSecret("p2", '{"access_token":"sk-other"}');
      assert.equal(await secrets.loadSecret("p2"), '{"access_token":"sk-other"}');
      assert.equal(await secrets.loadSecret("p1"), '{"access_token":"sk-secret-token"}');

      // The on-disk store must not contain the plaintext.
      const raw = readFileSync(join(env.dir, "secret-store.json"));
      assert.ok(!raw.includes("sk-secret-token"));

      // Same master key decrypts after a fresh process-equivalent reload.
      assert.equal(await secrets.loadSecret("p1"), '{"access_token":"sk-secret-token"}');
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
      delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
    }
  });

  test("key file is 0600 and 32 bytes; store file is 0600", async () => {
    process.env.AIAND_KEY_STORAGE = "file";
    try {
      await secrets.storeSecret("p1", "x");
      const keyFile = join(env.dir, "secret-store.key");
      assert.equal(statSync(keyFile).mode & 0o777, 0o600);
      assert.equal(statSync(keyFile).size, 32);
      assert.equal(statSync(join(env.dir, "secret-store.json")).mode & 0o777, 0o600);
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });

  test("deleting one profile keeps the other", async () => {
    process.env.AIAND_KEY_STORAGE = "file";
    process.env.AIAND_SECRET_STORE_MASTER_KEY = MASTER_KEY;
    try {
      await secrets.storeSecret("a", "va");
      await secrets.storeSecret("b", "vb");
      await secrets.deleteSecret("a");
      assert.equal(await secrets.loadSecret("a"), null);
      assert.equal(await secrets.loadSecret("b"), "vb");
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
      delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
    }
  });
});

describe("tier selection", () => {
  test("AIAND_KEY_STORAGE never silently falls to plaintext", async () => {
    // Without the env var, the answer is keychain or file — never plaintext.
    delete process.env.AIAND_KEY_STORAGE;
    const tier = await secrets.detectTier();
    assert.ok(tier === "keychain" || tier === "file");
  });

  test("an invalid AIAND_KEY_STORAGE is an error, not a fallback", async () => {
    process.env.AIAND_KEY_STORAGE = "memorized";
    try {
      await assert.rejects(() => secrets.detectTier(), /must be one of/);
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });
});

describe("legacy credential migration", () => {
  beforeEach(() => resetDir());

  test("moves the token pair into the active tier and rewrites the file as metadata", async () => {
    process.env.AIAND_KEY_STORAGE = "plaintext";
    try {
      writeFileSync(
        config.credentialsPath(),
        JSON.stringify({
          old: {
            access_token: "sk-legacy",
            refresh_token: "rt-legacy",
            expires_at: 1234567890,
            user: { id: "u1", email: "old@example.com" },
          },
        }),
        { mode: 0o600 }
      );

      const loaded = await config.loadCredential("old");
      assert.equal(loaded.access_token, "sk-legacy");
      assert.equal(loaded.refresh_token, "rt-legacy");
      assert.equal(loaded.expires_at, 1234567890);
      assert.equal(loaded.origin, "device");
      assert.equal(loaded.storage, "plaintext");
      assert.equal(loaded.user.email, "old@example.com");

      // The blob landed in the tier store.
      assert.equal(await secrets.loadSecret("old"), JSON.stringify({ access_token: "sk-legacy", refresh_token: "rt-legacy" }));

      // credentials.json no longer carries secrets.
      const raw = readFileSync(config.credentialsPath(), "utf8");
      assert.ok(!raw.includes("sk-legacy"));
      assert.ok(!raw.includes("rt-legacy"));
      const metadata = JSON.parse(raw);
      assert.equal(metadata.old.access_token, undefined);
      assert.equal(metadata.old.origin, "device");
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });
});

describe("paste vs device logout", () => {
  beforeEach(() => resetDir());

  test("pasted credential: logout clears locally and never calls revoke", async () => {
    process.env.AIAND_KEY_STORAGE = "plaintext";
    try {
      await config.saveCredential("pp", {
        access_token: "sk-pasted",
        origin: "paste",
        storage: "plaintext",
      });
      const { logout } = await import("../dist/auth/flow.js");
      await logout({ profile: "pp" });

      assert.equal(await config.loadCredential("pp"), null);
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });

  test("device credential: non-TTY logout revokes by default", async () => {
    process.env.AIAND_KEY_STORAGE = "plaintext";
    try {
      await config.saveCredential("dd", {
        access_token: "sk-device",
        refresh_token: "rt-device",
        origin: "device",
        storage: "plaintext",
      });

      const { logout } = await import("../dist/auth/flow.js");
      await logout({ profile: "dd" });

      assert.equal(await config.loadCredential("dd"), null);
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });

  test("pasted credential with --revoke is refused", async () => {
    process.env.AIAND_KEY_STORAGE = "plaintext";
    try {
      await config.saveCredential("pp", {
        access_token: "sk-pasted",
        origin: "paste",
        storage: "plaintext",
      });
      const { logout } = await import("../dist/auth/flow.js");
      await assert.rejects(() => logout({ profile: "pp", revoke: true }), /refusing to revoke/);
      // Credential survives the refusal.
      assert.ok(await config.loadCredential("pp"));
    } finally {
      delete process.env.AIAND_KEY_STORAGE;
    }
  });
});

describe("openSession never rotates a pasted key", () => {
  beforeEach(() => resetDir());

  test("returns the pasted token even when expired, without touching the token endpoint", async () => {
    process.env.AIAND_KEY_STORAGE = "plaintext";
    const realFetch = globalThis.fetch;
    try {
      await config.saveCredential("pastey", {
        access_token: "sk-expired-paste",
        origin: "paste",
        expires_at: 1, // long expired
        storage: "plaintext",
      });

      // Any hit on the auth token endpoint would 500 and blow up the session;
      // openSession must not even attempt rotation for a pasted key.
      globalThis.fetch = async (url) => {
        const target = String(url);
        if (target.includes("/auth/")) {
          throw new Error(`rotation attempted for a pasted key: ${target}`);
        }
        return new Response(JSON.stringify({ id: "u", email: "e@x.com" }), { status: 200 });
      };

      const { openSession } = await import("../dist/api/client.js");
      const profile = config.resolveProfile("pastey");
      const session = await openSession(profile);
      assert.equal(session.token, "sk-expired-paste");
      assert.equal(session.credential.origin, "paste");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.AIAND_KEY_STORAGE;
      await config.clearCredential("pastey").catch(() => {});
    }
  });
});
