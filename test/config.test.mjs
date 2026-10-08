import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { withEnv, withTestEnv } from "./helpers.mjs";

const MASTER_KEY = "a".repeat(64);

let dir;
withTestEnv("aiand-cli-test-", (tmp) => {
  dir = join(tmp, "cfg");
  mkdirSync(dir, { recursive: true });
  process.env.AIAND_HOME = join(tmp, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  // The file tier with a fixed master key: nothing here reaches the keychain.
  process.env.AIAND_KEY_STORAGE = "file";
  process.env.AIAND_SECRET_STORE_MASTER_KEY = MASTER_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
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

  test("a stored profile overrides the default", async () => {
    await config.updateProfile("default", { apiUrl: "https://stored.example" });
    assert.equal(config.resolveProfile().apiUrl, "https://stored.example");
  });

  test("AIAND_BASE_URL overrides the stored profile", () =>
    withEnv({ AIAND_BASE_URL: "https://env.example" }, () => {
      assert.equal(config.resolveProfile().apiUrl, "https://env.example");
    }));

  test("AIAND_AUTH_URL narrows to the auth endpoint only", () =>
    withEnv(
      { AIAND_BASE_URL: "https://both.example", AIAND_AUTH_URL: "https://auth.example" },
      () => {
        const profile = config.resolveProfile();
        assert.equal(profile.authUrl, "https://auth.example");
        assert.equal(profile.apiUrl, "https://both.example");
      },
    ));

  test("strips a trailing slash so paths do not double up", () =>
    withEnv({ AIAND_BASE_URL: "https://slash.example/" }, () => {
      assert.equal(config.resolveProfile().apiUrl, "https://slash.example");
    }));
});

describe("profiles", () => {
  beforeEach(() => resetCredentialState());

  test("keep separate credentials", async () => {
    await withEnv({ AIAND_KEY_STORAGE: "plaintext" }, async () => {
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
    });
  });

  test("clearing one leaves the other intact", async () => {
    await withEnv({ AIAND_KEY_STORAGE: "plaintext" }, async () => {
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
    });
  });

  test("clearing the last one removes the file rather than leaving an empty object", async () => {
    await withEnv({ AIAND_KEY_STORAGE: "plaintext" }, async () => {
      await config.saveCredential("home", {
        access_token: "sk-home",
        refresh_token: "rt-home",
        expires_at: 2,
      });
      await config.clearCredential("home");
      assert.throws(() => statSync(config.credentialsPath()), { code: "ENOENT" });
    });
  });
  test("saveCredential rejects a __proto__ profile name", async () => {
    await assert.rejects(
      () =>
        config.saveCredential("__proto__", {
          access_token: "sk-a",
          refresh_token: "r",
          expires_at: 1,
        }),
      /not allowed/,
    );
  });

  test("updateProfile rejects a __proto__ profile name", async () => {
    await assert.rejects(
      () => config.updateProfile("__proto__", { authUrl: "https://x.example" }),
      /not allowed/,
    );
  });

  test("saveCredential rejects constructor and toString profile names", async () => {
    await assert.rejects(
      () =>
        config.saveCredential("constructor", {
          access_token: "sk-a",
          refresh_token: "r",
          expires_at: 1,
        }),
      /not allowed/,
    );
    await assert.rejects(
      () =>
        config.saveCredential("toString", {
          access_token: "sk-a",
          refresh_token: "r",
          expires_at: 1,
        }),
      /not allowed/,
    );
  });
});

describe("credential file permissions", () => {
  beforeEach(() => resetCredentialState());

  test("is created 0600", async () => {
    await withEnv({ AIAND_KEY_STORAGE: "plaintext" }, async () => {
      await config.saveCredential("p", { access_token: "sk-a", refresh_token: "r", expires_at: 1 });
      assert.equal(statSync(config.credentialsPath()).mode & 0o777, 0o600);
    });
  });

  test("is re-tightened on rewrite, not left at whatever it was", async () => {
    await withEnv({ AIAND_KEY_STORAGE: "plaintext" }, async () => {
      await config.saveCredential("p", { access_token: "sk-b", refresh_token: "r", expires_at: 2 });
      const path = config.credentialsPath();
      chmodSync(path, 0o644);
      await config.saveCredential("p", { access_token: "sk-b", refresh_token: "r", expires_at: 2 });
      assert.equal(statSync(path).mode & 0o777, 0o600);
    });
  });
});

describe("credential storage", () => {
  beforeEach(() => resetCredentialState());

  test("file tier round-trips a blob and stores metadata only", async () => {
    await withEnv(
      { AIAND_KEY_STORAGE: "file", AIAND_SECRET_STORE_MASTER_KEY: MASTER_KEY },
      async () => {
        await config.saveCredential("p", {
          access_token: "sk-a",
          refresh_token: "r",
          expires_at: 1,
        });
        const loaded = await config.loadCredential("p");
        assert.equal(loaded.access_token, "sk-a");
        assert.equal(loaded.refresh_token, "r");
        assert.equal(loaded.storage, "file");

        // credentials.json holds metadata only.
        const raw = readFileSync(config.credentialsPath(), "utf8");
        assert.ok(!raw.includes("sk-a"));
      },
    );
  });

  test("credentials.json is created 0600 and the secret store key file too", async () => {
    // No master-key env here, so the key file path is exercised.
    await withEnv(
      { AIAND_KEY_STORAGE: "file", AIAND_SECRET_STORE_MASTER_KEY: undefined },
      async () => {
        await config.saveCredential("p", {
          access_token: "sk-a",
          refresh_token: "r",
          expires_at: 1,
        });
        assert.equal(statSync(config.credentialsPath()).mode & 0o777, 0o600);
        assert.equal(statSync(join(dir, "secret-store.key")).mode & 0o777, 0o600);
      },
    );
  });

  test("is re-tightened on rewrite, not left at whatever it was", async () => {
    await withEnv(
      { AIAND_KEY_STORAGE: "file", AIAND_SECRET_STORE_MASTER_KEY: MASTER_KEY },
      async () => {
        await config.saveCredential("p", {
          access_token: "sk-b",
          refresh_token: "r",
          expires_at: 2,
        });
        const path = config.credentialsPath();
        chmodSync(path, 0o644);
        await config.saveCredential("p", {
          access_token: "sk-b",
          refresh_token: "r",
          expires_at: 2,
        });
        assert.equal(statSync(path).mode & 0o777, 0o600);
      },
    );
  });
});

describe("malformed config", () => {
  test("fails with a readable message instead of a JSON parse trace", () => {
    writeFileSync(config.configPath(), "{ not json", { mode: 0o600 });
    assert.throws(() => config.loadConfig(), /not valid JSON/);
  });
});

const cmd = await import("../dist/commands/config.js");

describe("config set --profile", () => {
  test("writes the named profile instead of default", async () => {
    resetCredentialState();
    await config.saveConfig({
      profile: "default",
      profiles: { default: {}, work: {} },
    });
    await cmd.run(["set", "model", "picked", "--profile", "work"]);
    const stored = config.loadConfig();
    assert.equal(stored.profiles.work.model, "picked");
    assert.equal(stored.profiles.default?.model, undefined);
  });
});

describe("trust boundaries", () => {
  beforeEach(() => {
    resetCredentialState();
    delete process.env.AIAND_BASE_URL;
    delete process.env.AIAND_AUTH_URL;
    delete process.env.AIAND_PROFILE;
  });

  test("assertHttpsBaseUrl rejects leading/trailing whitespace at set time", () => {
    assert.throws(() => config.assertHttpsBaseUrl("https://example.com "), /whitespace/);
    assert.throws(() => config.assertHttpsBaseUrl("  https://example.com"), /whitespace/);
  });

  test("stored URL with trailing space fails readable at resolve time", async () => {
    await config.updateProfile("default", { apiUrl: "https://example.com " });
    assert.throws(
      () => config.resolveProfile(),
      (err) => err.name === "CliError" && /whitespace/.test(err.message),
    );
  });

  test("loopback/http rules unchanged: http loopback allowed, http remote rejected", () => {
    config.assertHttpsBaseUrl("http://localhost:8080");
    config.assertHttpsBaseUrl("http://127.0.0.1:8080");
    config.assertHttpsBaseUrl("http://[::1]:8080");
    assert.throws(() => config.assertHttpsBaseUrl("http://example.com"), /https/);
  });

  test("remote base URL with a path is refused at set time (double-append guard)", () => {
    assert.throws(
      () => config.assertHttpsBaseUrl("https://api.aiand.com/v1"),
      (err) => err.name === "CliError" && /origin without a path/.test(err.message),
    );
    // Loopback keeps paths: the mock gateway and test doubles live under one.
    config.assertHttpsBaseUrl("http://127.0.0.1:8080/stub/429");
    config.assertHttpsBaseUrl("https://api.aiand.com");
  });

  test("base URL with embedded credentials is refused without echoing them", () => {
    assert.throws(
      () => config.assertHttpsBaseUrl("https://user:secret-pass@api.aiand.com"),
      (err) =>
        err.name === "CliError" &&
        /embed credentials/.test(err.message) &&
        !JSON.stringify(err).includes("secret-pass"),
    );
  });

  test("credential-embedded base URLs refuse without echoing the secret", () => {
    // Fuzz E5: undici refuses to construct the request and its reason echoes
    // the URL, so userinfo would land in terminal output. Refuse at set time
    // — and the refusal itself must never carry the secret.
    const fake = "fake-secret-xyz";
    for (const url of [
      `https://user:${fake}@host.example/`,
      `https://user:${fake}@host.example/v1`,
      `https://${fake}@host.example/`,
    ]) {
      assert.throws(
        () => config.assertHttpsBaseUrl(url),
        (error) => {
          assert.equal(error.name, "CliError");
          assert.match(error.message, /must not embed credentials/);
          assert.ok(!`${error.message}${error.hint ?? ""}`.includes(fake), "no echo");
          return true;
        },
      );
    }
    config.assertHttpsBaseUrl("https://host.example/");
  });

  test("/v1-suffixed base URLs refuse with the origin advice", () => {
    // Fuzz E4: adapters append /v1 themselves, so a suffixed URL doubles to
    // /v1/v1 and the gateway misdiagnoses a 401 as an expired key.
    for (const url of [
      "https://api.aiand.com/v1",
      "https://api.aiand.com/v1/",
      "https://host.example/api/v1",
    ]) {
      assert.throws(
        () => config.assertNoV1Suffix(url),
        (error) => {
          assert.equal(error.name, "CliError");
          assert.match(error.message, /must not end in "\/v1"/);
          assert.match(error.hint ?? "", /origin/);
          return true;
        },
      );
    }
    // Origins, deeper paths, and lookalike hosts pass.
    for (const url of [
      "https://api.aiand.com",
      "https://api.aiand.com/",
      "https://host.example/api/v2",
      "https://v1",
      "http://127.0.0.1:9/stub/401",
    ]) {
      config.assertNoV1Suffix(url);
    }
  });

  test("null credential entry fails readable instead of TypeError", async () => {
    writeFileSync(config.credentialsPath(), JSON.stringify({ default: null }), { mode: 0o600 });
    await assert.rejects(
      () => config.loadAllCredentials(),
      (err) => err.name === "CliError" && /not valid/.test(err.message),
    );
  });

  test("non-object credential entry fails readable", async () => {
    writeFileSync(config.credentialsPath(), JSON.stringify({ default: "sk-x" }), { mode: 0o600 });
    await assert.rejects(() => config.loadAllCredentials(), /not valid/);
  });

  test("non-string stored apiUrl fails with a fix hint", async () => {
    await config.saveConfig({ profile: "default", profiles: { default: { apiUrl: 123 } } });
    assert.throws(
      () => config.resolveProfile(),
      (err) => err.name === "CliError" && /aiand config set api-url/.test(err.hint ?? ""),
    );
  });

  test("non-string stored authUrl fails with a fix hint", async () => {
    await config.saveConfig({ profile: "default", profiles: { default: { authUrl: 123 } } });
    assert.throws(
      () => config.resolveProfile(),
      (err) => err.name === "CliError" && /aiand config set auth-url/.test(err.hint ?? ""),
    );
  });

  test("env override still masks a broken stored URL", async () => {
    await config.saveConfig({ profile: "default", profiles: { default: { apiUrl: 123 } } });
    await withEnv({ AIAND_BASE_URL: "https://env.example" }, () => {
      assert.equal(config.resolveProfile().apiUrl, "https://env.example");
    });
  });

  test("reads reject prototype-polluting profile names", () => {
    assert.throws(() => config.resolveProfile("__proto__"), /not allowed/);
    assert.throws(() => config.resolveProfile("constructor"), /not allowed/);
    assert.throws(() => config.activeProfileName("__proto__"), /not allowed/);
  });

  test("unsafe AIAND_PROFILE is rejected on read", () =>
    withEnv({ AIAND_PROFILE: "__proto__" }, () => {
      assert.throws(() => config.activeProfileName(), /not allowed/);
    }));
});
