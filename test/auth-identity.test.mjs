import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  MINTED_ACCESS_TOKEN,
  MINTED_REFRESH_TOKEN,
  registerAuthStub,
  STUB_USER_EMAIL,
  state,
  stubBinding,
} from "./auth-stub.mjs";
import { withEnv } from "./helpers.mjs";

// Behavioral tests through the real src/auth modules (dist build), against
// the localhost stub server in ./auth-stub.mjs.
// The shared sign-in probe and its three states.

const authIdentity = await import("../dist/auth/identity.js");
const config = await import("../dist/config.js");

registerAuthStub();

describe("auth identity integration (serial)", { concurrency: 1 }, () => {
  describe("auth probe three states (verified / signed_out / unreachable)", () => {
    /** A loopback port nothing listens on: bind, read the port, close it, so
     * the gateway dial fails fast with ECONNREFUSED (ApiError status 0). */
    async function deadLoopbackPort() {
      const doomed = createServer();
      doomed.listen(0, "127.0.0.1");
      await new Promise((resolve) => doomed.once("listening", resolve));
      const port = doomed.address().port;
      await new Promise((resolve) => doomed.close(resolve));
      return port;
    }

    test("verified: stored key + live gateway resolves identity", async () => {
      await config.saveCredential("default", {
        access_token: MINTED_ACCESS_TOKEN,
        refresh_token: MINTED_REFRESH_TOKEN,
        bound_to: stubBinding(),
        expires_at: Math.floor(Date.now() / 1000) + 2592000,
        origin: "device",
        storage: "plaintext",
        user: { id: "u1", email: STUB_USER_EMAIL },
        org: { id: "org_1", name: "First" },
      });
      state.orgs = [{ id: "org_1", name: "First" }];
      const identity = await authIdentity.probeIdentity("default");
      assert.equal(identity.reachable, true);
      assert.equal(identity.probeError, null);
      assert.ok(identity.session);
      assert.equal(identity.user.email, STUB_USER_EMAIL);
      const status = await authIdentity.authStatus({ profile: "default" });
      assert.equal(status.signed_in, true);
      assert.equal(status.reachable, true);
    });

    test("local mode with a stored credential stays signed_in (no network)", async () => {
      await config.saveCredential("default", {
        access_token: "sk-abc123",
        origin: "paste",
        storage: "plaintext",
        user: { id: "u1", email: STUB_USER_EMAIL },
        org: { id: "org_1", name: "First" },
      });
      // A dead gateway proves local mode never touches the network.
      const dead = await deadLoopbackPort();
      process.env.AIAND_BASE_URL = `http://127.0.0.1:${dead}`;
      process.env.AIAND_AUTH_URL = `http://127.0.0.1:${dead}`;
      const status = await authIdentity.authStatus({ profile: "default", local: true });
      assert.equal(status.signed_in, true);
      assert.equal(status.reachable, true);
      assert.equal(status.email, STUB_USER_EMAIL);
      assert.equal(status.source, "pasted-key");
    });

    test("status names the file tier for what it is and keeps a stable tier id", async () => {
      const save = () =>
        config.saveCredential("default", {
          access_token: "sk-file-tier",
          origin: "paste",
          user: { id: "u1", email: STUB_USER_EMAIL },
          org: { id: "org_1", name: "First" },
        });
      const fresh = () => mkdtempSync(join(tmpdir(), "aiand-label-"));
      // The key beside the ciphertext: worth an owner-only file, no more.
      await withEnv(
        {
          AIAND_KEY_STORAGE: "file",
          AIAND_SECRET_STORE_MASTER_KEY: undefined,
          AIAND_CONFIG_DIR: fresh(),
        },
        async () => {
          await save();
          const status = await authIdentity.authStatus({ profile: "default", local: true });
          assert.equal(status.storage, "file (owner-only, not encrypted at rest)");
          assert.equal(status.storage_tier, "file");
        },
      );
      // The key held elsewhere: the file is encrypted at rest, and says so.
      await withEnv(
        {
          AIAND_KEY_STORAGE: "file",
          AIAND_SECRET_STORE_MASTER_KEY: "b".repeat(64),
          AIAND_CONFIG_DIR: fresh(),
        },
        async () => {
          await save();
          const status = await authIdentity.authStatus({ profile: "default", local: true });
          assert.equal(status.storage, "file (encrypted; key held outside the config folder)");
          assert.equal(status.storage_tier, "file", "the machine-readable tier id is stable");
        },
      );
      await withEnv({ AIAND_SECRET_STORE_MASTER_KEY: undefined }, () => {
        assert.equal(authIdentity.storageLabel("file"), "file (owner-only, not encrypted at rest)");
        assert.equal(
          authIdentity.storageLabel("file", { owner_only: false }),
          "file (not owner-only, not encrypted at rest)",
        );
      });
      await withEnv({ AIAND_SECRET_STORE_MASTER_KEY: "b".repeat(64) }, () => {
        assert.equal(
          authIdentity.storageLabel("file", { owner_only: false }),
          "file (encrypted; key held outside the config folder; not owner-only)",
        );
      });
      assert.equal(authIdentity.storageLabel("dpapi"), "Windows DPAPI");
      assert.equal(authIdentity.storageLabel("keychain"), "keychain");
    });

    test("signed_out: no credential resolves a null session but stays reachable", async () => {
      const identity = await authIdentity.probeIdentity("default");
      assert.equal(identity.session, null);
      assert.equal(identity.reachable, true);
      const status = await authIdentity.authStatus({ profile: "default" });
      assert.equal(status.signed_in, false);
      assert.equal(status.reachable, true);
    });

    test("unreachable: dead gateway port surfaces reachable=false instead of throwing", async () => {
      // Saved under the dead gateway, so it is bound there and the probe reaches it.
      const dead = await deadLoopbackPort();
      process.env.AIAND_BASE_URL = `http://127.0.0.1:${dead}`;
      process.env.AIAND_AUTH_URL = `http://127.0.0.1:${dead}`;
      await config.saveCredential("default", {
        access_token: "sk-abc123",
        origin: "paste",
        bound_to: { auth_url: `http://127.0.0.1:${dead}`, api_url: `http://127.0.0.1:${dead}` },
        user: { id: "u1", email: "paste@example.com" },
        org: { id: "org_1", name: "First" },
      });
      const identity = await authIdentity.probeIdentity("default");
      assert.equal(identity.reachable, false);
      assert.ok(identity.probeError);
      assert.equal(identity.probeError.status, 0);
      const status = await authIdentity.authStatus({ profile: "default" });
      assert.equal(status.signed_in, false);
      assert.equal(status.reachable, false);
    });

    test("rejected key (401) still throws instead of reporting unreachable", async () => {
      await config.saveCredential("default", {
        access_token: "sk-bad",
        origin: "paste",
        bound_to: stubBinding(),
        user: { id: "u1", email: "paste@example.com" },
        org: { id: "org_1", name: "First" },
      });
      state.orgs = [{ id: "org_1", name: "First" }];
      await assert.rejects(authIdentity.probeIdentity("default"), /rejected/);
    });
  });
});
