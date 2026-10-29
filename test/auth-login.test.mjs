import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { KEY } from "../dist/cli/select.js";
import {
  baseUrl,
  browserOpener,
  captureOutput,
  cliStdout,
  fastSleep,
  MINTED_ACCESS_TOKEN,
  MINTED_REFRESH_TOKEN,
  pickSecondRow,
  registerAuthStub,
  STUB_USER_EMAIL,
  state,
  stubTTY,
  TWO_ORGS,
} from "./auth-stub.mjs";
import { FakeInput, FakeOutput, waitForListener } from "./helpers.mjs";

// Behavioral tests through the real src/auth modules (dist build), against
// the localhost stub server in ./auth-stub.mjs.
// Sign-in: device, browser, and paste flows, the org picker, and the
// device-to-paste fallback.

// Browser-callback cap for tests whose callback arrives (or fails) at once.
const CALLBACK_WAIT_MS = 2_000;

const authLogin = await import("../dist/auth/login.js");
const authIdentity = await import("../dist/auth/identity.js");
const device = await import("../dist/api/device.js");
const config = await import("../dist/config.js");

registerAuthStub();

describe("auth login integration (serial)", { concurrency: 1 }, () => {
  describe("deviceLogin happy path (real modules, stub server)", () => {
    beforeEach(() => delete process.env.AIAND_API_KEY);

    test("mints a credential, activates the profile, and prints Signed in", async () => {
      const captured = captureOutput();
      try {
        // test/setup.mjs sets AIAND_NO_BROWSER=1, so openBrowser returns false
        // without launching anything and the URL is printed.
        await authLogin.deviceLogin({ sleep: fastSleep, profile: "default" });

        const cred = await config.loadCredential("default");
        assert.equal(cred.origin, "device");
        assert.equal(cred.access_token, MINTED_ACCESS_TOKEN);
        assert.equal(cred.refresh_token, MINTED_REFRESH_TOKEN);

        // The stored user/org ride the credential metadata.
        assert.equal(cred.user.email, STUB_USER_EMAIL);

        const outText = captured.log.out.join("");
        assert.ok(outText.includes("Signed in."));
        assert.ok(outText.includes("sk-***"), "masked key printed, full key never");
        assert.ok(
          !captured.log.err.join("").includes(MINTED_ACCESS_TOKEN),
          "full key never leaks to stderr",
        );
      } finally {
        captured.restore();
      }
    });

    test("json: stdout is only JSON; the device code/URL go to stderr", async () => {
      const captured = captureOutput();
      try {
        await authLogin.deviceLogin({ sleep: fastSleep, profile: "default", json: true });
        const stdout = cliStdout(captured);
        // Throws on any leading prose — the --json stdout contract.
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.profile, "default");
        assert.equal(parsed.user.email, STUB_USER_EMAIL);
        assert.ok(!stdout.includes("Your code"), "no code block on stdout");
        assert.ok(!stdout.includes("Approve at"), "no URL block on stdout");
        const stderr = captured.log.err.join("");
        assert.ok(stderr.includes("BCDF-GHJK"), "user code still shown, on stderr");
        assert.ok(stderr.includes("Approve at"), "approval URL still shown, on stderr");
        // Success still persists the Minted key Credential.
        const cred = await config.loadCredential("default");
        assert.equal(cred.origin, "device");
        assert.equal(cred.access_token, MINTED_ACCESS_TOKEN);
      } finally {
        captured.restore();
      }
    });

    test("non-json device login still shows the code/URL on stdout", async () => {
      const captured = captureOutput();
      try {
        await authLogin.deviceLogin({ sleep: fastSleep, profile: "default" });
        const stdout = captured.log.out.join("");
        assert.ok(stdout.includes("BCDF-GHJK"), "user code on stdout");
        assert.ok(stdout.includes("Approve at"), "approval URL on stdout");
      } finally {
        captured.restore();
      }
    });

    test("passes an onSlowDown handler that prints the back-off line", async () => {
      // Drive the real pollForToken with a stubbed global fetch so the
      // slow_down branch fires deterministically. The sleep seam records the
      // waits instead of paying them: 1s floor, then 6s after the +5 bump.
      const realFetch = globalThis.fetch;
      const deviceStart = {
        device_code: "dc",
        user_code: "BCDF-GHJK",
        verification_uri: "/auth/device?user_code=BCDF-GHJK",
        verification_uri_complete: "",
        expires_in: 600,
        interval: 0,
      };
      let fetchCount = 0;
      const slowDowns = [];
      globalThis.fetch = async () => {
        fetchCount++;
        if (fetchCount === 1) {
          return new Response(JSON.stringify({ error: "authorization_pending" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (fetchCount === 2) {
          return new Response(JSON.stringify({ error: "slow_down" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            access_token: "sk-ok",
            refresh_token: "rt-ok",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };
      const waits = [];
      try {
        const tokens = await device.pollForToken(baseUrl, deviceStart, {
          onSlowDown: (interval) => slowDowns.push(interval),
          sleep: async (ms) => {
            waits.push(ms);
          },
        });
        assert.equal(tokens.access_token, "sk-ok");
        assert.equal(fetchCount, 3);
        assert.deepEqual(slowDowns, [6], "slow_down bumps the interval by 5 (1+5)");
        assert.deepEqual(
          waits,
          [1000, 1000, 6000],
          "the bumped interval is what the next poll waits",
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    test("an already-expired device code rejects before any poll", async () => {
      // entries with an already-expired code throw the expired hint without
      // polling: expires_in: 0 makes the deadline pass instantly, before any
      // sleep or fetch — deterministic and network-free.
      const expired = {
        device_code: "dc",
        user_code: "BCDF-GHJK",
        verification_uri: "",
        verification_uri_complete: "",
        expires_in: 0,
        interval: 5,
      };
      await assert.rejects(device.pollForToken(baseUrl, expired), /expired before it was approved/);
    });
  });

  describe("pasteLogin validation (real modules, stub server)", () => {
    beforeEach(() => delete process.env.AIAND_API_KEY);

    test("a sk- key is validated, stored as paste, and rebaked", async () => {
      const captured = captureOutput();
      try {
        await authLogin.pasteLogin({ profile: "default", key: "sk-abc123" });

        const cred = await config.loadCredential("default");
        assert.equal(cred.origin, "paste");
        assert.equal(cred.access_token, "sk-abc123");
        assert.ok(captured.log.out.join("").includes("Signed in with a pasted key."));
      } finally {
        captured.restore();
      }
    });

    test("json: true still rebakes agent config keys", async () => {
      const home = process.env.AIAND_HOME;
      const configPath = join(home, ".config", "opencode", "opencode.json");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(
        configPath,
        `${JSON.stringify({
          provider: {
            aiand: {
              options: { baseURL: "https://api.aiand.com/v1", apiKey: "sk-old", "x-aiand": true },
            },
          },
          model: "aiand/m-default",
        })}\n`,
      );

      const captured = captureOutput();
      try {
        await authLogin.pasteLogin({
          profile: "default",
          key: "sk-abc123",
          json: true,
        });
        const cfg = JSON.parse(readFileSync(configPath, "utf8"));
        assert.equal(cfg.provider.aiand.options.apiKey, "sk-abc123");
        assert.ok(captured.log.out.join("").includes('"source": "pasted-key"'));
      } finally {
        captured.restore();
      }
    });

    test("a malformed key is rejected before any API call", async () => {
      const captured = captureOutput();
      try {
        await assert.rejects(
          authLogin.pasteLogin({ profile: "default", key: "not-a-key" }),
          /Keys start with "sk-"/,
        );
      } finally {
        captured.restore();
      }
      assert.equal(await config.loadCredential("default"), null);
    });

    test("a 401 from the API surfaces as a rejected-key hint", async () => {
      const captured = captureOutput();
      try {
        await assert.rejects(
          authLogin.pasteLogin({ profile: "default", key: "sk-bad" }),
          /rejected/,
        );
      } finally {
        captured.restore();
      }
      assert.equal(await config.loadCredential("default"), null);
    });

    // #141: pressing Enter on an empty prompt is a user-input mistake, not a
    // missing credential — it must exit 1 with the env-key hint, not 2.
    test("an empty paste on a TTY exits 1 with the env-key hint, not 2", async () => {
      delete process.env.AIAND_API_KEY;
      const restoreTTY = stubTTY();
      const input = new FakeInput();
      const output = new FakeOutput();
      const captured = captureOutput();
      try {
        const pasting = assert.rejects(
          authLogin.pasteLogin({ profile: "default", interactive: true, input, output }),
          (error) => {
            assert.equal(error.exitCode, 1);
            assert.match(error.message, /Input required/);
            assert.match(error.hint, /AIAND_API_KEY/);
            return true;
          },
        );
        // Enter only once the prompt is listening: keys sent earlier are lost.
        await waitForListener(input);
        input.send(KEY.ENTER_CR);
        await pasting;
        assert.equal(await config.loadCredential("default"), null);
      } finally {
        captured.restore();
        restoreTTY();
      }
    });

    test("a genuinely missing credential still exits not-signed-in (2)", async () => {
      delete process.env.AIAND_API_KEY;
      const { NotLoggedInError } = await import("../dist/cli/errors.js");
      await assert.rejects(
        (await import("../dist/api/client.js")).openSession(
          (await import("../dist/config.js")).resolveProfile("default"),
        ),
        (error) => {
          assert.ok(error instanceof NotLoggedInError);
          assert.equal(error.exitCode, 2);
          return true;
        },
      );
    });
  });

  describe("org selection on sign-in (real modules, stub server)", () => {
    test("(a) device login stores the minted-key org and labels the key", async () => {
      state.tokenOrg = { id: "org_2", name: "Second" };
      const captured = captureOutput();
      try {
        await authLogin.deviceLogin({ sleep: fastSleep, profile: "default" });
        const cred = await config.loadCredential("default");
        assert.equal(cred.org.name, "Second");
        assert.match(state.keyName ?? "", /^aiand@/);
      } finally {
        captured.restore();
      }
    });

    test("(b) two orgs without a minted org picks the row chosen interactively", async () => {
      state.orgs = [...TWO_ORGS];
      const restoreTTY = stubTTY();
      const input = new FakeInput();
      const output = new FakeOutput();
      const captured = captureOutput();
      try {
        const login = authLogin.deviceLogin({
          sleep: fastSleep,
          profile: "default",
          input,
          output,
        });
        await pickSecondRow(input);
        await login;
        const cred = await config.loadCredential("default");
        assert.equal(cred.org.id, "org_2");
      } finally {
        captured.restore();
        restoreTTY();
      }
    });

    test("(c) two orgs non-interactively keeps orgs[0] with a stderr note", async () => {
      state.orgs = [...TWO_ORGS];
      const captured = captureOutput();
      try {
        await authLogin.deviceLogin({ sleep: fastSleep, profile: "default" });
        const cred = await config.loadCredential("default");
        assert.equal(cred.org.id, "org_1");
        assert.match(captured.log.err.join(""), /multiple organizations/);
      } finally {
        captured.restore();
      }
    });

    test("(cancel-device) Esc at the org picker throws 130 and stores no Credential", async () => {
      state.orgs = [...TWO_ORGS];
      const restoreTTY = stubTTY();
      const input = new FakeInput();
      const output = new FakeOutput();
      const captured = captureOutput();
      try {
        const login = authLogin.deviceLogin({
          sleep: fastSleep,
          profile: "default",
          input,
          output,
        });
        await waitForListener(input);
        input.send(KEY.ESC);
        await assert.rejects(login, /Login cancelled/);
        assert.equal(await config.loadCredential("default"), null);
      } finally {
        captured.restore();
        restoreTTY();
      }
    });

    test("(cancel-paste) Esc at the org picker stores no Credential on the paste path", async () => {
      state.orgs = [...TWO_ORGS];
      const restoreTTY = stubTTY();
      const input = new FakeInput();
      const output = new FakeOutput();
      const captured = captureOutput();
      try {
        const login = authLogin.pasteLogin({
          profile: "default",
          key: "sk-abc123",
          input,
          output,
        });
        await waitForListener(input);
        input.send(KEY.ESC);
        await assert.rejects(login, /Login cancelled/);
        assert.equal(await config.loadCredential("default"), null);
      } finally {
        captured.restore();
        restoreTTY();
      }
    });
  });

  describe("browserLogin (real modules, stub server)", () => {
    test("(d) end-to-end sign-in stores the minted key with origin device", async () => {
      state.orgs = [...TWO_ORGS];
      const captured = captureOutput();
      try {
        await authLogin.browserLogin({
          profile: "default",
          open: browserOpener(),
          timeoutMs: CALLBACK_WAIT_MS,
        });
        const cred = await config.loadCredential("default");
        assert.ok(captured.log.out.join("").includes("Signed in."));
        assert.equal(cred.access_token, MINTED_ACCESS_TOKEN);
        assert.equal(cred.origin, "device");
        assert.equal(cred.org.name, "Second");
      } finally {
        captured.restore();
      }
    });

    test("(e) a 404 authorize page falls back silently to the device flow", async () => {
      state.authorizeMode = "missing";
      state.tokenOrg = { id: "org_2", name: "Second" };
      const captured = captureOutput();
      try {
        await authLogin.browserLogin({
          profile: "default",
          open: browserOpener(),
          timeoutMs: CALLBACK_WAIT_MS,
        });
        const cred = await config.loadCredential("default");
        assert.ok(captured.log.out.join("").includes("Signed in."));
        assert.equal(cred.access_token, MINTED_ACCESS_TOKEN);
        assert.ok(!captured.log.err.join("").includes("didn't complete"));
      } finally {
        captured.restore();
      }
    });

    test("(f) probeIdentity prefers the cached org when the orgs list has it", async () => {
      await config.saveCredential("default", {
        access_token: MINTED_ACCESS_TOKEN,
        refresh_token: MINTED_REFRESH_TOKEN,
        expires_at: Math.floor(Date.now() / 1000) + 2592000,
        origin: "device",
        storage: "plaintext",
        user: { id: "u1", email: STUB_USER_EMAIL },
        org: { id: "org_2", name: "Second" },
      });
      state.orgs = [...TWO_ORGS];
      const identity = await authIdentity.probeIdentity("default");
      assert.equal(identity.org.id, "org_2");
    });
  });

  describe("deviceLogin degrades to paste (device-to-paste fallback)", () => {
    test("(g) device endpoints down + interactive TTY falls through to the paste prompt and signs in", async () => {
      state.deviceMode = "down";
      const restoreTTY = stubTTY();
      const input = new FakeInput();
      const output = new FakeOutput();
      const captured = captureOutput();
      try {
        const login = authLogin.deviceLogin({
          sleep: fastSleep,
          profile: "default",
          input,
          output,
        });
        for (let i = 0; i < 3000 && !output.text.includes("Paste a key instead?"); i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.ok(output.text.includes("Paste a key instead?"), "confirm never appeared");
        input.send("y");
        input.send(KEY.ENTER_CR);
        for (let i = 0; i < 3000 && !output.text.includes("Paste your ai& API key"); i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.ok(output.text.includes("Paste your ai& API key"), "paste prompt never started");
        input.send("sk-abc123");
        input.send(KEY.ENTER_CR);
        await login;

        const cred = await config.loadCredential("default");
        assert.equal(cred.origin, "paste");
        assert.equal(cred.access_token, "sk-abc123");
        const errText = captured.log.err.join("");
        assert.match(errText, /Device sign-in failed while starting/);
        assert.match(errText, /paste a key instead/);
        assert.ok(captured.log.out.join("").includes("Signed in with a pasted key."));
      } finally {
        captured.restore();
        restoreTTY();
        state.deviceMode = "up";
      }
    });

    test("(g2) device endpoints down + confirm no rethrows the original error", async () => {
      state.deviceMode = "down";
      const restoreTTY = stubTTY();
      const input = new FakeInput();
      const output = new FakeOutput();
      const captured = captureOutput();
      try {
        const login = authLogin.deviceLogin({
          sleep: fastSleep,
          profile: "default",
          input,
          output,
        });
        for (let i = 0; i < 3000 && !output.text.includes("Paste a key instead?"); i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        input.send("n");
        input.send(KEY.ENTER_CR);
        await assert.rejects(login, /device service|HTTP 5|start a device/i);
        assert.equal(await config.loadCredential("default"), null);
        assert.ok(!captured.log.out.join("").includes("Signed in with a pasted key."));
      } finally {
        captured.restore();
        restoreTTY();
        state.deviceMode = "up";
      }
    });

    test("(h) device endpoints down non-interactively keeps the original error", async () => {
      state.deviceMode = "down";
      const captured = captureOutput();
      try {
        await assert.rejects(
          authLogin.deviceLogin({ sleep: fastSleep, profile: "default" }),
          /start a device login|Could not reach|HTTP 5/i,
        );
        assert.equal(await config.loadCredential("default"), null);
      } finally {
        captured.restore();
        state.deviceMode = "up";
      }
    });
    test("(i) a browser deny stays fatal (no paste fallback)", async () => {
      const realFetch = globalThis.fetch;
      // Device code starts fine; every poll after it is denied in the browser.
      globalThis.fetch = async (url) => {
        if (String(url).endsWith("/auth/device/code")) {
          return new Response(
            JSON.stringify({
              device_code: "dc",
              user_code: "BCDF-GHJK",
              verification_uri: "/auth/device?user_code=BCDF-GHJK",
              verification_uri_complete: "",
              expires_in: 600,
              interval: 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "access_denied" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      };
      const restoreTTY = stubTTY();
      const captured = captureOutput();
      try {
        await assert.rejects(
          authLogin.deviceLogin({
            sleep: fastSleep,
            profile: "default",
            keyName: "k",
            input: new FakeInput(),
            output: new FakeOutput(),
          }),
          /denied in the browser/,
        );
        const errText = captured.log.err.join("");
        assert.ok(!errText.includes("paste a key instead"));
        assert.equal(await config.loadCredential("default"), null);
      } finally {
        captured.restore();
        restoreTTY();
        globalThis.fetch = realFetch;
      }
    });

    test("(i2) poll expiry stays fatal (no paste fallback)", async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        if (String(url).endsWith("/auth/device/code")) {
          return new Response(
            JSON.stringify({
              device_code: "dc",
              user_code: "BCDF-GHJK",
              verification_uri: "/auth/device?user_code=BCDF-GHJK",
              verification_uri_complete: "",
              expires_in: 600,
              interval: 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "expired_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      };
      const restoreTTY = stubTTY();
      const captured = captureOutput();
      try {
        await assert.rejects(
          authLogin.deviceLogin({
            sleep: fastSleep,
            profile: "default",
            keyName: "k",
            input: new FakeInput(),
            output: new FakeOutput(),
          }),
          /expired before it was approved/,
        );
        const errText = captured.log.err.join("");
        assert.ok(!errText.includes("paste a key instead"));
        assert.equal(await config.loadCredential("default"), null);
      } finally {
        captured.restore();
        restoreTTY();
        globalThis.fetch = realFetch;
      }
    });

    test("(i3) 4xx from startDeviceAuth stays fatal (no paste fallback)", async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        if (String(url).endsWith("/auth/device/code")) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return realFetch(url);
      };
      const restoreTTY = stubTTY();
      const captured = captureOutput();
      try {
        await assert.rejects(
          authLogin.deviceLogin({
            sleep: fastSleep,
            profile: "default",
            keyName: "k",
            input: new FakeInput(),
            output: new FakeOutput(),
          }),
          /Could not start a device login/,
        );
        const errText = captured.log.err.join("");
        assert.ok(!errText.includes("paste a key instead"));
        assert.equal(await config.loadCredential("default"), null);
      } finally {
        captured.restore();
        restoreTTY();
        globalThis.fetch = realFetch;
      }
    });
  });
});
