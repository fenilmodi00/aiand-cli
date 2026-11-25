import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { browserCommand, LAUNCH_OK_MS, openBrowser } from "../dist/cli/browser.js";
import { withOpener } from "./helpers.mjs";

const skip = process.platform === "win32";

// An exit-code test must see the opener exit inside the launch window however
// loaded the machine is: spawning a shell can take longer than the real 2 s.
const WIDE = { launchOkMs: 60_000 };

// Signature contract: async, resolves boolean, never throws.
test("browser: openBrowser spawns the platform opener", { skip }, () =>
  withOpener(
    () => "exit 0",
    async () => {
      assert.equal(await openBrowser("https://example.com", WIDE), true);
    },
  ),
);

test("browser: openBrowser reports a nonzero opener exit as failure", { skip }, () =>
  withOpener(
    () => "exit 1",
    async () => {
      assert.equal(await openBrowser("https://example.com", WIDE), false);
    },
  ),
);

test("browser: openBrowser treats a slow exit 0 as success", { skip }, () =>
  withOpener(
    () => "sleep 0.1\nexit 0",
    async () => {
      assert.equal(await openBrowser("https://example.com", WIDE), true);
    },
  ),
);

test("browser: openBrowser treats a slow exit 1 as failure", { skip }, () =>
  withOpener(
    () => "sleep 0.1\nexit 1",
    async () => {
      assert.equal(await openBrowser("https://example.com", WIDE), false);
    },
  ),
);

test("browser: openBrowser does not wait for a long-lived opener", { skip }, () =>
  withOpener(
    (dir) => `echo $$ > "${join(dir, "opener.pid")}"\nsleep 30`,
    async (dir) => {
      const pidfile = join(dir, "opener.pid");
      try {
        const started = Date.now();
        assert.equal(await openBrowser("https://example.com"), true);
        // The bound only has to prove we did not wait out the 30 s opener, so
        // leave headroom over LAUNCH_OK_MS for a loaded runner.
        assert.ok(
          Date.now() - started < LAUNCH_OK_MS + 8_000,
          "openBrowser waited for the opener lifetime",
        );
      } finally {
        try {
          if (existsSync(pidfile))
            process.kill(Number(readFileSync(pidfile, "utf8").trim()), "SIGTERM");
        } catch {
          // opener may already have exited
        }
      }
    },
  ),
);

test("browser: AIAND_NO_BROWSER=1 never spawns the opener", { skip }, () =>
  withOpener(
    (dir) => `touch "${join(dir, "ran")}"\nexit 0`,
    async (dir) => {
      process.env.AIAND_NO_BROWSER = "1";
      assert.equal(await openBrowser("https://example.com"), false);
      assert.equal(existsSync(join(dir, "ran")), false, "opener must not run");
    },
  ),
);

test("browserCommand: Windows opens through System32's rundll32 with the URL as one argument", () => {
  const url = "https://example.com/a?b=1&c=^|<>";
  assert.deepEqual(browserCommand(url, "win32", { SystemRoot: "C:\\Windows" }), [
    "C:\\Windows\\System32\\rundll32.exe",
    ["url.dll,FileProtocolHandler", url],
  ]);
  assert.deepEqual(browserCommand(url, "darwin", {}), ["open", [url]]);
  assert.deepEqual(browserCommand(url, "linux", {}), ["xdg-open", [url]]);
});
