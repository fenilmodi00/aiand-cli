import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openBrowser } from "../dist/cli/browser.js";

test("browser: openBrowser spawns the platform opener", async () => {
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
