import assert from "node:assert/strict";
import test from "node:test";
import {
  pollForToken,
  rotateTokens,
  startDeviceAuthorization,
  validDeviceCodeResponse,
  validTokenResponse,
} from "../dist/api/device.js";
import { CliError, EXIT } from "../dist/cli/errors.js";
import { withFetch } from "./helpers.mjs";

const MESSAGE = "The sign-in service returned an incomplete token response.";
const HINT = "Run `aiand login` again.";
const complete = {
  access_token: "access-token-secret",
  refresh_token: "refresh-token-secret",
  token_type: "Bearer",
  expires_in: 3600,
};

const DEVICE_MESSAGE = "The sign-in service returned an incomplete device-code response.";
const completeDevice = {
  device_code: "device-code",
  user_code: "ABCD-EFGH",
  verification_uri: "https://example.test/device",
  expires_in: 600,
  interval: 5,
};

function checkIncompleteError(error, exitCode = EXIT.ERROR) {
  assert.ok(error instanceof CliError, `got ${error}`);
  assert.equal(error.message, MESSAGE);
  assert.equal(error.hint, HINT);
  assert.equal(error.exitCode, exitCode);
  return error;
}

function assertIncomplete(body, exitCode = EXIT.ERROR) {
  let thrown;
  try {
    validTokenResponse(body);
  } catch (error) {
    thrown = error;
  }
  return checkIncompleteError(thrown, exitCode);
}

async function expectIncomplete(promise, exitCode = EXIT.ERROR) {
  const error = await promise.then(
    () => assert.fail("expected the token response to be refused"),
    (reason) => reason,
  );
  return checkIncompleteError(error, exitCode);
}

test("a complete token response is returned unchanged", () => {
  const body = {
    ...complete,
    org: { id: "org-1", name: "Example" },
    scope: "openid offline_access",
  };

  assert.deepEqual(validTokenResponse(body), body);
});

test("a missing or empty refresh_token is refused", async () => {
  const withoutRefresh = { ...complete };
  delete withoutRefresh.refresh_token;

  assertIncomplete(withoutRefresh);
  assertIncomplete({ ...complete, refresh_token: "" });
  assertIncomplete({ ...complete, refresh_token: null });

  const device = {
    device_code: "device-code",
    user_code: "user-code",
    verification_uri: "https://example.test/activate",
    verification_uri_complete: "",
    expires_in: 60,
    interval: 0,
  };
  await withFetch(
    async () =>
      new Response(JSON.stringify(withoutRefresh), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    async () => {
      await expectIncomplete(
        pollForToken("https://example.test", device, { sleep: async () => {} }),
      );
      await expectIncomplete(
        rotateTokens("https://example.test", "refresh-token-secret"),
        EXIT.NOT_SIGNED_IN,
      );
    },
  );
});

test("a missing access_token or a non-positive expires_in is refused", () => {
  const withoutAccess = { ...complete };
  delete withoutAccess.access_token;
  const withoutExpiry = { ...complete };
  delete withoutExpiry.expires_in;
  const withoutType = { ...complete };
  delete withoutType.token_type;

  for (const body of [
    withoutAccess,
    { ...complete, access_token: "" },
    { ...complete, expires_in: 0 },
    { ...complete, expires_in: -1 },
    withoutExpiry,
    { ...complete, expires_in: Number.POSITIVE_INFINITY },
    { ...complete, expires_in: Number.NaN },
    withoutType,
    { ...complete, token_type: "" },
    null,
    [],
  ]) {
    assertIncomplete(body);
  }
});

test("a complete device-code response is returned unchanged", () => {
  assert.deepEqual(validDeviceCodeResponse(completeDevice), completeDevice);
  assert.deepEqual(
    validDeviceCodeResponse({ ...completeDevice, verification_uri_complete: "https://x.test" }),
    { ...completeDevice, verification_uri_complete: "https://x.test" },
  );
});

test("an incomplete device-code response is refused", () => {
  for (const body of [
    null,
    [],
    {},
    { ...completeDevice, device_code: "" },
    { ...completeDevice, user_code: 7 },
    { ...completeDevice, verification_uri: "" },
    { ...completeDevice, verification_uri_complete: 7 },
    { ...completeDevice, expires_in: null },
    { ...completeDevice, expires_in: 0 },
    { ...completeDevice, expires_in: Number.POSITIVE_INFINITY },
    { ...completeDevice, interval: null },
    { ...completeDevice, interval: -1 },
    { ...completeDevice, interval: Number.NaN },
  ]) {
    assert.throws(
      () => validDeviceCodeResponse(body),
      (error) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.message, DEVICE_MESSAGE);
        return true;
      },
    );
  }
});

test("startDeviceAuthorization refuses an incomplete device-code response", async () => {
  await withFetch(
    async () => Response.json({ device_code: "device-code" }),
    async () => {
      await assert.rejects(
        () => startDeviceAuthorization("https://example.test"),
        (error) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.message, DEVICE_MESSAGE);
          return true;
        },
      );
    },
  );
});

test("a malformed org is dropped, not trusted", () => {
  for (const org of [
    undefined,
    null,
    [],
    "org-1",
    { id: "org-1" },
    { id: "org-1", name: 7 },
    { id: 7, name: "Example" },
  ]) {
    const body = { ...complete, org, scope: "openid" };
    const result = validTokenResponse(body);
    assert.deepEqual(result, { ...complete, scope: "openid" });
    assert.equal("org" in result, false);
    assert.deepEqual(body.org, org);
  }
});

test("the error never contains a token value", () => {
  const accessToken = "access-token-value-that-must-not-leak";
  const refreshToken = "refresh-token-value-that-must-not-leak";
  const error = assertIncomplete({
    ...complete,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 0,
  });

  for (const token of [accessToken, refreshToken]) {
    assert.equal(error.message.includes(token), false);
    assert.equal((error.hint ?? "").includes(token), false);
  }
});
