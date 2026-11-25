import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { describe } from "node:test";
import { captureOutput, cliStdout, registerAuthStub, state, stubBinding } from "./auth-stub.mjs";

// Behavioral tests through the real src/auth modules (dist build), against
// the localhost stub server in ./auth-stub.mjs.
// Sign-out: revoke, local clear, and baked-key teardown.

const authLogout = await import("../dist/auth/logout.js");
const config = await import("../dist/config.js");
const snapshot = await import("../dist/agents/snapshot.js");

registerAuthStub();

describe("auth logout integration (serial)", { concurrency: 1 }, () => {
  describe("logout (real modules, stub server)", () => {
    test("device-minted key is revoked through the real revoke endpoint", async () => {
      await config.saveCredential("default", {
        access_token: "sk-device",
        refresh_token: "rt-device",
        origin: "device",
        bound_to: stubBinding(),
        storage: "plaintext",
      });

      const captured = captureOutput();
      try {
        await authLogout.logout({ profile: "default" });
      } finally {
        captured.restore();
      }

      assert.deepEqual(state.revocations, ["rt-device"]);
      assert.equal(await config.loadCredential("default"), null);
    });

    test("pasted key is cleared locally and never revoked", async () => {
      await config.saveCredential("default", {
        access_token: "sk-paste",
        origin: "paste",
        storage: "plaintext",
      });

      const captured = captureOutput();
      try {
        await authLogout.logout({ profile: "default" });
      } finally {
        captured.restore();
      }
      assert.deepEqual(state.revocations, []);
      assert.equal(await config.loadCredential("default"), null);
    });

    test("a pasted key with --revoke is refused and the credential survives", async () => {
      await config.saveCredential("default", {
        access_token: "sk-paste",
        origin: "paste",
        storage: "plaintext",
      });

      const captured = captureOutput();
      try {
        await assert.rejects(
          authLogout.logout({ profile: "default", revoke: true }),
          /refusing to revoke/,
        );
      } finally {
        captured.restore();
      }
      assert.ok(await config.loadCredential("default"));
    });

    test("logout of a non-active profile warns the baked key was left in place", async () => {
      // The pasted key is baked under "other" while "default" stays active.
      const home = process.env.AIAND_HOME;
      const configPath = join(home, ".config", "opencode", "opencode.json");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(
        configPath,
        `${JSON.stringify({
          provider: {
            aiand: {
              options: { baseURL: "https://api.aiand.com/v1", apiKey: "sk-other", "x-aiand": true },
            },
          },
          model: "aiand/m-default",
        })}\n`,
      );
      await config.saveCredential("other", {
        access_token: "sk-other",
        origin: "paste",
        storage: "plaintext",
      });

      const captured = captureOutput();
      try {
        await authLogout.logout({ profile: "other" });
        assert.match(captured.log.err.join(""), /not the active profile.*left in place/);
      } finally {
        captured.restore();
      }

      assert.equal(await config.loadCredential("other"), null);
      assert.deepEqual(state.revocations, []);
      // The strip was skipped: the baked key is still on disk, still valid.
      assert.ok(readFileSync(configPath, "utf8").includes("sk-other"));
    });

    test("logout of the active profile still strips baked keys", async () => {
      const home = process.env.AIAND_HOME;
      const configPath = join(home, ".config", "opencode", "opencode.json");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(
        configPath,
        `${JSON.stringify({
          provider: {
            aiand: {
              options: {
                baseURL: "https://api.aiand.com/v1",
                apiKey: "sk-device",
                "x-aiand": true,
              },
            },
          },
          model: "aiand/m-default",
        })}\n`,
      );
      await config.saveCredential("default", {
        access_token: "sk-device",
        refresh_token: "rt-device",
        origin: "device",
        bound_to: stubBinding(),
        storage: "plaintext",
      });

      const captured = captureOutput();
      try {
        await authLogout.logout({ profile: "default" });
        assert.ok(
          !captured.log.err.join("").includes("left in place"),
          "active-profile logout strips instead of warning",
        );
      } finally {
        captured.restore();
      }

      assert.deepEqual(state.revocations, ["rt-device"]);
      assert.equal(await config.loadCredential("default"), null);
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      assert.ok(!("aiand" in (cfg.provider ?? {})));
      assert.ok(!readFileSync(configPath, "utf8").includes("sk-device"));
    });

    test("logout deletes snapshot copies that hold the logged-out key", async () => {
      const home = process.env.AIAND_HOME;
      const file = join(home, "leaky", "auth.json");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{"aiand":{"key":"sk-device-leaky"}}\n');
      // An older aiand copied the wired file; the copy holds the key.
      await snapshot.snapshotFiles("leaky-agent", [file]);
      await config.saveCredential("default", {
        access_token: "sk-device-leaky",
        refresh_token: "rt-device",
        origin: "device",
        // Unbound, the revoke would go to the production auth URL, not the stub.
        bound_to: stubBinding(),
        storage: "plaintext",
      });
      const captured = captureOutput();
      try {
        await authLogout.logout({ profile: "default" });
      } finally {
        captured.restore();
      }
      const root = join(process.env.AIAND_CONFIG_DIR, "snapshots", "leaky-agent");
      for (const stamp of readdirSync(root)) {
        const dir = join(root, stamp);
        if (!statSync(dir).isDirectory()) continue;
        for (const name of readdirSync(dir)) {
          assert.ok(!readFileSync(join(dir, name), "utf8").includes("sk-device-leaky"));
        }
      }
      assert.deepEqual(state.revocations, ["rt-device"]);
    });

    test("a failed revoke keeps the whole sign-in for a retry, and strips nothing", async () => {
      const home = process.env.AIAND_HOME;
      const configPath = join(home, ".config", "opencode", "opencode.json");
      mkdirSync(dirname(configPath), { recursive: true });
      const wired = `${JSON.stringify({
        provider: {
          aiand: {
            options: { baseURL: "https://api.aiand.com/v1", apiKey: "sk-device", "x-aiand": true },
          },
        },
      })}\n`;
      writeFileSync(configPath, wired);
      await config.saveCredential("default", {
        access_token: "sk-device",
        refresh_token: "rt-device",
        origin: "device",
        bound_to: stubBinding(),
        storage: "plaintext",
      });
      state.deviceMode = "down";
      const captured = captureOutput();
      try {
        await assert.rejects(
          () => authLogout.logout({ profile: "default", revoke: true }),
          (error) =>
            /you are still signed in/.test(error.message) &&
            /--keep-remote/.test(error.hint) &&
            error.hint.includes("https://console.aiand.com/api-keys"),
        );
      } finally {
        captured.restore();
        state.deviceMode = "up";
      }
      assert.equal((await config.loadCredential("default")).refresh_token, "rt-device");
      assert.equal(readFileSync(configPath, "utf8"), wired, "nothing stripped");

      // The retry, once ai& answers, completes normally.
      const again = captureOutput();
      try {
        await authLogout.logout({ profile: "default", revoke: true });
      } finally {
        again.restore();
      }
      assert.deepEqual(state.revocations, ["rt-device"]);
      assert.equal(await config.loadCredential("default"), null);
    });

    test("--keep-remote forgets the sign-in without trying to revoke", async () => {
      await config.saveCredential("default", {
        access_token: "sk-device",
        refresh_token: "rt-device",
        origin: "device",
        bound_to: stubBinding(),
        storage: "plaintext",
      });
      state.deviceMode = "down";
      const captured = captureOutput();
      try {
        await authLogout.logout({ profile: "default", keepRemote: true });
      } finally {
        captured.restore();
        state.deviceMode = "up";
      }
      assert.deepEqual(state.revocations, []);
      assert.equal(await config.loadCredential("default"), null);
    });

    test("pasted and refresh-token-less logouts name the console page", async () => {
      await config.saveCredential("default", { access_token: "sk-paste", origin: "paste" });
      let captured = captureOutput();
      try {
        await authLogout.logout({ profile: "default" });
      } finally {
        captured.restore();
      }
      assert.match(cliStdout(captured), /still valid\. Revoke it at https:\/\/console\.aiand\.com/);

      await config.saveCredential("default", { access_token: "sk-no-rt", origin: "device" });
      captured = captureOutput();
      try {
        await authLogout.logout({ profile: "default" });
      } finally {
        captured.restore();
      }
      assert.match(cliStdout(captured), /No refresh token was stored/);
    });

    test("stored credential + AIAND_API_KEY still clears, then warns the Env key session remains", async () => {
      await config.saveCredential("default", {
        access_token: "sk-paste",
        origin: "paste",
        storage: "plaintext",
      });
      process.env.AIAND_API_KEY = "sk-env-12345";

      const captured = captureOutput();
      try {
        await authLogout.logout({ profile: "default" });
        assert.match(captured.log.err.join(""), /AIAND_API_KEY.*still applies until it is unset/);
        assert.match(captured.log.out.join(""), /Signed out/);
      } finally {
        captured.restore();
        delete process.env.AIAND_API_KEY;
      }

      assert.equal(await config.loadCredential("default"), null);
    });

    test("json not-signed-in emits JSON with no prose", async () => {
      delete process.env.AIAND_API_KEY;
      const captured = captureOutput();
      try {
        await authLogout.logout({ profile: "default", json: true });
        // Throws on any leading prose — the --json stdout contract.
        const parsed = JSON.parse(cliStdout(captured));
        assert.equal(parsed.profile, "default");
        assert.equal(parsed.revoked, false);
        assert.equal(parsed.signed_in, false);
        assert.ok(!("note" in parsed), "no Env-key note without the env var");
      } finally {
        captured.restore();
      }
    });

    test("json not-signed-in with AIAND_API_KEY includes the Env-key note", async () => {
      process.env.AIAND_API_KEY = "sk-env-12345";
      const captured = captureOutput();
      try {
        await authLogout.logout({ profile: "default", json: true });
        const parsed = JSON.parse(cliStdout(captured));
        assert.equal(parsed.profile, "default");
        assert.equal(parsed.revoked, false);
        assert.match(parsed.note ?? "", /AIAND_API_KEY.*unset/);
      } finally {
        captured.restore();
        delete process.env.AIAND_API_KEY;
      }
    });
  });
});
