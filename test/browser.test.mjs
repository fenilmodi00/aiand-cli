import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openBrowser } from "../dist/cli/browser.js";

test("browser: openBrowser spawns the platform opener", { skip: process.platform === "win32" }, async () => {
  // Hermetic opener first on PATH so no real browser launches on a dev
  // machine; the stub exits 0, which the opener reports as opened=true.
  // Signature contract: async, resolves boolean, never throws.
  const dir = mkdtempSync(join(tmpdir(), "aiand-browser-test-"));
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  writeFileSync(join(dir, opener), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, opener), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = realPath ? `${dir}:${realPath}` : dir;
  try {
    assert.equal(await openBrowser("https://example.com"), true);
  } finally {
    if (realPath === undefined) delete process.env.PATH;
    else process.env.PATH = realPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser: openBrowser reports a nonzero opener exit as failure", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiand-browser-fail-"));
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  writeFileSync(join(dir, opener), "#!/bin/sh\nexit 1\n");
  chmodSync(join(dir, opener), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = realPath ? `${dir}:${realPath}` : dir;
  try {
    assert.equal(await openBrowser("https://example.com"), false);
  } finally {
    if (realPath === undefined) delete process.env.PATH;
    else process.env.PATH = realPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser: openBrowser does not wait for a long-lived opener", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiand-browser-live-"));
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  writeFileSync(join(dir, opener), "#!/bin/sh\nsleep 30\n");
  chmodSync(join(dir, opener), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = realPath ? `${dir}:${realPath}` : dir;
  try {
    const started = Date.now();
    assert.equal(await openBrowser("https://example.com"), true);
    assert.ok(Date.now() - started < 2000, "openBrowser waited for the opener lifetime");
  } finally {
    if (realPath === undefined) delete process.env.PATH;
    else process.env.PATH = realPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
