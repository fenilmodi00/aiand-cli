import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  captureOutput,
  dir,
  MINTED_ACCESS_TOKEN,
  MINTED_REFRESH_TOKEN,
  registerAuthStub,
  state,
  stubBinding,
} from "./auth-stub.mjs";

// `aiand login` replacing a profile's sign-in: the old minted key is revoked
// where it was issued, after the new sign-in is stored, and never when the
// new sign-in fails. Runs the real command (dist build) against the stub
// server; no TTY here, so the command takes the device path and needs
// --force to replace.

const loginCommand = await import("../dist/commands/login.js");
const config = await import("../dist/config.js");
const replace = await import("../dist/auth/replace.js");

registerAuthStub();

async function seed(credential) {
  await config.saveCredential("default", { storage: "plaintext", ...credential });
}

/** A pre-0.8 sign-in: saveCredential always records a binding, so drop it. */
async function seedUnbound(credential) {
  await seed(credential);
  const path = join(dir, "credentials.json");
  const all = JSON.parse(readFileSync(path, "utf8"));
  delete all.default.bound_to;
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
  assert.equal((await config.loadCredential("default")).bound_to, undefined);
}

async function login(argv) {
  const captured = captureOutput();
  try {
    await loginCommand.run(argv);
  } finally {
    captured.restore();
  }
  const stderr = captured.log.err.join("");
  assert.doesNotMatch(stderr, /aiand\.com\b(?!\/api-keys)/, "a test sign-in reached past the stub");
  return stderr;
}

/** A second issuer, to see where a revoke for the old binding is sent. */
async function otherIssuer() {
  const revocations = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.url === "/auth/device/logout") {
        revocations.push(JSON.parse(raw || "{}").refresh_token ?? null);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end("{}");
      }
      res.writeHead(404);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    revocations,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

describe("login replacing a sign-in (serial)", { concurrency: 1 }, () => {
  test("an unbound sign-in in aiand's own config dir is revoked at the issuer config.json names", async () => {
    await seedUnbound({ access_token: "sk-old", refresh_token: "rt-old", origin: "device" });
    // aiand's config.json, no id yet (pre-0.8), naming the stub as the issuer.
    writeFileSync(
      join(dir, "config.json"),
      `${JSON.stringify({ profile: "default", profiles: { default: { apiUrl: stubBinding().api_url, authUrl: stubBinding().auth_url } } })}\n`,
    );

    await login(["--force"]);

    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
    assert.deepEqual(state.revocations, ["rt-old"]);
  });

  test("--force revokes the replaced minted key after storing the new one", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });

    const stderr = await login(["--force"]);

    const now = await config.loadCredential("default");
    assert.equal(now.access_token, MINTED_ACCESS_TOKEN);
    assert.equal(now.refresh_token, MINTED_REFRESH_TOKEN);
    assert.deepEqual(state.revocations, ["rt-old"], "only the old refresh token is revoked");
    assert.match(stderr, /Revoked the key this profile signed in with before/);
  });

  test("the revoke goes to the issuer the old sign-in recorded, not the new one", async () => {
    const other = await otherIssuer();
    try {
      await seed({
        access_token: "sk-old",
        refresh_token: "rt-old",
        origin: "device",
        bound_to: { auth_url: other.url, api_url: other.url },
      });

      await login(["--force"]);

      assert.deepEqual(other.revocations, ["rt-old"]);
      assert.deepEqual(state.revocations, [], "the new issuer never sees the old refresh token");
    } finally {
      other.close();
    }
  });

  test("--keep-remote replaces the sign-in and leaves the old key valid", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });

    const stderr = await login(["--force", "--keep-remote"]);

    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
    assert.deepEqual(state.revocations, []);
    assert.match(stderr, /still valid/);
  });

  test("a failed revoke warns, and the new sign-in stays", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    state.rejectRefresh.push("rt-old");

    const stderr = await login(["--force"]);

    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
    assert.match(stderr, /Could not revoke the replaced key/);
    assert.match(stderr, /HTTP 500/);
    assert.match(stderr, /still valid/);
  });

  test("a pasted key is replaced but never revoked", async () => {
    await seed({ access_token: "sk-pasted-old", origin: "paste", bound_to: stubBinding() });

    const stderr = await login(["--force"]);

    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
    assert.deepEqual(state.revocations, []);
    assert.match(stderr, /was pasted, so this CLI did not revoke it/);
  });

  test("a minted key with no refresh token is replaced and reported, not revoked", async () => {
    await seed({ access_token: "sk-old", origin: "device", bound_to: stubBinding() });

    const stderr = await login(["--force"]);

    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
    assert.deepEqual(state.revocations, []);
    assert.match(stderr, /No refresh token was stored for the replaced key/);
  });

  test("a failed sign-in keeps the old sign-in and revokes nothing", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    // Denied, not down: the revoke endpoint stays up, so a revoke sent too
    // early would land and show in state.revocations.
    state.tokenError = "access_denied";

    const captured = captureOutput();
    try {
      await assert.rejects(loginCommand.run(["--force"]), /denied/i);
    } finally {
      captured.restore();
    }

    const kept = await config.loadCredential("default");
    assert.equal(kept.access_token, "sk-old");
    assert.equal(kept.refresh_token, "rt-old");
    assert.deepEqual(state.revocations, []);
  });

  test("an unbound sign-in beside another install's config.json is not revoked", async () => {
    // Pre-0.8 shape: no bound_to, so the issuer would come from config.json,
    // and this one carries an id the marker does not: copied from elsewhere.
    await seedUnbound({ access_token: "sk-old", refresh_token: "rt-old", origin: "device" });
    writeFileSync(
      join(dir, "config.json"),
      `${JSON.stringify({ profile: "default", profiles: { default: { apiUrl: stubBinding().api_url, authUrl: stubBinding().auth_url } }, config_id: "0".repeat(32) })}\n`,
    );

    const stderr = await login(["--force"]);

    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
    assert.deepEqual(state.revocations, []);
    assert.match(stderr, /did not record where it was issued/);
  });

  test("a step that fails after the new sign-in is stored still revokes the old key", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    // activateProfile writes config.json (an atomic rename) after the credential is saved.
    const original = fsp.rename;
    fsp.rename = async (from, to, ...rest) => {
      if (String(to).endsWith("config.json"))
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      return original(from, to, ...rest);
    };
    syncBuiltinESMExports();
    const captured = captureOutput();
    try {
      await assert.rejects(loginCommand.run(["--force"]), /no space left/);
    } finally {
      fsp.rename = original;
      syncBuiltinESMExports();
      captured.restore();
    }
    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
    assert.deepEqual(state.revocations, ["rt-old"]);
  });

  test("a stored sign-in that cannot be read back revokes nothing and says so", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    const replaced = await replace.noteReplacedSignIn(
      "default",
      await config.loadCredential("default"),
    );
    writeFileSync(join(dir, "credentials.json"), "{ not json");
    const captured = captureOutput();
    let outcome;
    try {
      outcome = await replace.retireReplacedSignIn(replaced);
    } finally {
      captured.restore();
    }
    assert.equal(outcome, "unconfirmed");
    assert.deepEqual(state.revocations, []);
    assert.match(captured.log.err.join(""), /Could not read the stored sign-in/);
  });

  test("without --force and no terminal, an existing sign-in is refused untouched", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });

    const captured = captureOutput();
    try {
      await assert.rejects(loginCommand.run([]), /already signed in/);
    } finally {
      captured.restore();
    }
    assert.equal((await config.loadCredential("default")).access_token, "sk-old");
    assert.deepEqual(state.revocations, []);
  });
});
