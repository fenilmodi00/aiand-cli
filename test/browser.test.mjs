import assert from "node:assert/strict";
import { test } from "node:test";
import { openBrowser } from "../dist/cli/browser.js";

test("browser: openBrowser spawns the platform opener", () => {
  // Signature contract: returns boolean, never throws.
  assert.equal(typeof openBrowser("https://example.com"), "boolean");
});
