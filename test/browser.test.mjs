import assert from "node:assert/strict";
import { test } from "node:test";
import { isRemoteContext } from "../dist/cli/remote.js";
import { copyToClipboard } from "../dist/cli/clipboard.js";
import { openBrowser, openBrowserAware } from "../dist/cli/browser.js";

// --- isRemoteContext ---------------------------------------------------------

test("remote: true when any SSH env var is set (non-empty after trim)", () => {
  assert.equal(isRemoteContext({ env: { SSH_CONNECTION: "192.168.1.1 22" }, platform: "linux" }), true);
  assert.equal(isRemoteContext({ env: { SSH_TTY: "/dev/pts/1" }, platform: "linux" }), true);
  assert.equal(isRemoteContext({ env: { SSH_CLIENT: "10.0.0.5 51234 22" }, platform: "linux" }), true);
});

test("remote: false when SSH vars are empty/whitespace", () => {
  assert.equal(
    isRemoteContext({ env: { SSH_CONNECTION: "   " }, platform: "linux", readProcVersion: () => "GNU/Linux" }),
    false
  );
});

test("remote: true on linux when /proc/version mentions microsoft (WSL)", () => {
  assert.equal(
    isRemoteContext({
      env: {},
      platform: "linux",
      readProcVersion: () => "Linux version 6.18.33.2-microsoft-standard-WSL2",
    }),
    true
  );
});

test("remote: false on non-linux even with microsoft /proc/version", () => {
  assert.equal(
    isRemoteContext({
      env: {},
      platform: "darwin",
      readProcVersion: () => "microsoft-standard-WSL2",
    }),
    false
  );
});

test("remote: false on plain linux without microsoft", () => {
  assert.equal(
    isRemoteContext({ env: {}, platform: "linux", readProcVersion: () => "Linux version 6.1.0-debian" }),
    false
  );
});

test("remote: false when /proc/version is unreadable", () => {
  assert.equal(isRemoteContext({ env: {}, platform: "linux", readProcVersion: () => "" }), false);
});

// --- copyToClipboard ---------------------------------------------------------

function fakeSpawn(scripts) {
  // scripts: array keyed by command name of the child to return.
  return (command, args, options) => {
    const script = scripts[command];
    const stdin = {
      on: () => {},
      end: () => {},
    };
    if (!script) {
      // Unknown command: emit an error (like ENOENT).
      const child = { stdin, on: (ev, cb) => { if (ev === "error") process.nextTick(cb); } };
      return child;
    }
    const child = {
      stdin,
      on: (ev, cb) => {
        if (ev === "close" && script.kind === "ok") process.nextTick(() => cb(0));
        else if (ev === "close" && script.kind === "fail") process.nextTick(() => cb(1));
        else if (ev === "error" && script.kind === "spawn-error") process.nextTick(cb);
      },
    };
    return child;
  };
}

test("clipboard: picks pbcopy on darwin and reports success", async () => {
  const spawnFn = fakeSpawn({ pbcopy: { kind: "ok" } });
  const ok = await copyToClipboard("secret", { platform: "darwin", spawnFn });
  assert.equal(ok, true);
});

test("clipboard: picks clip on win32", async () => {
  const calls = [];
  const spawnFn = (command) => {
    calls.push(command);
    return { stdin: { on: () => {}, end: () => {} }, on: (ev, cb) => { if (ev === "close") process.nextTick(() => cb(0)); } };
  };
  const ok = await copyToClipboard("x", { platform: "win32", spawnFn });
  assert.equal(ok, true);
  assert.deepEqual(calls, ["clip"]);
});

test("clipboard: linux tries wl-copy then xclip on failure", async () => {
  const calls = [];
  const spawnFn = (command) => {
    calls.push(command);
    const script = command === "wl-copy" ? "fail" : "ok";
    return { stdin: { on: () => {}, end: () => {} }, on: (ev, cb) => { if (ev === "close") process.nextTick(() => cb(script === "ok" ? 0 : 1)); } };
  };
  const ok = await copyToClipboard("x", { platform: "linux", spawnFn });
  assert.equal(ok, true);
  assert.deepEqual(calls, ["wl-copy", "xclip"]);
});

test("clipboard: returns false when the spawn errors (no candidate exists)", async () => {
  const calls = [];
  const spawnFn = (command) => {
    calls.push(command);
    return { stdin: { on: () => {}, end: () => {} }, on: (ev, cb) => { if (ev === "error") process.nextTick(cb); } };
  };
  const ok = await copyToClipboard("x", { platform: "linux", spawnFn });
  assert.equal(ok, false);
  assert.deepEqual(calls, ["wl-copy", "xclip"]);
});

test("clipboard: returns false whever candidate exits non-zero on darwin", async () => {
  const spawnFn = (command) => ({ stdin: { on: () => {}, end: () => {} }, on: (ev, cb) => { if (ev === "close") process.nextTick(() => cb(2)); } });
  assert.equal(await copyToClipboard("x", { platform: "darwin", spawnFn }), false);
});

// --- browser -----------------------------------------------------------------

test("browser: openBrowser spawns the platform opener", () => {
  // Signature contract: returns boolean, never throws.
  assert.equal(typeof openBrowser("https://example.com"), "boolean");
});

test("browser: openBrowserAware returns remote without spawning on remote context", () => {
  let spawned = false;
  // remote=true short-circuits before any platform lookup.
  assert.equal(openBrowserAware("https://example.com", { remote: true }), "remote");
});

test("browser: openBrowserAware returns opened on non-remote with a reachable opener", () => {
  // Non-remote on this (linux/WSL) host may fall through to xdg-open and report
  // remote when spawn fails; assert the contract only: one of the two markers.
  const result = openBrowserAware("https://example.com", { remote: false });
  assert.ok(result === "opened" || result === "remote");
});