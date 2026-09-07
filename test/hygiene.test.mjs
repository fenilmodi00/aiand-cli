import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// Zero-mention rule: neither upstream tool's name may appear anywhere in
// shipped text — source, build output, tests, or docs. The foreign-writer
// detector satisfies the one functional need by assembling its probe strings
// at runtime from fragments; this test enforces the rest. This file never
// spells the forbidden vocabulary: the regex below is itself fragment-built.
const FORBIDDEN = new RegExp([["fire", "works"].join("")].join("") + "|firecon" + "nect|neb" + "ius", "i");

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else {
      files.push(full);
    }
  }
  return files;
}

describe("zero-mention hygiene", () => {
  const root = join(import.meta.dirname, "..");

  test("src/, dist/, and test/ carry no upstream vocabulary", () => {
    const files = [
      ...walk(join(root, "src")),
      ...(existsSync(join(root, "dist")) ? walk(join(root, "dist")) : []),
      ...walk(join(root, "test")),
    ].filter((file) => /\.(ts|mjs|js)$/.test(file));

    assert.ok(files.length > 0, "expected to scan a real file set");
    const hits = files.filter((file) => FORBIDDEN.test(readFileSync(file, "utf8")));
    assert.deepEqual(hits, [], `forbidden vocabulary found in: ${hits.join(", ")}`);
  });

  test("README.md and CHANGELOG.md carry no upstream vocabulary", () => {
    const docs = ["README.md", "CHANGELOG.md"]
      .map((name) => join(root, name))
      .filter((file) => existsSync(file));

    const hits = docs.filter((file) => FORBIDDEN.test(readFileSync(file, "utf8")));
    assert.deepEqual(hits, [], `forbidden vocabulary found in: ${hits.join(", ")}`);
  });

  test("foreign.ts exposes foreignMarkerFixtures with working probes", async () => {
    const foreign = await import("../dist/agents/foreign.js");
    assert.equal(typeof foreign.foreignMarkerFixtures, "function");

    // The fixtures are realistic foreign configs — they must actually trip
    // the detector, proving the fragment-assembled probes match real bytes.
    // Keys are computed at runtime (zero-mention), so read them positionally.
    const [settingsFixture, codexFixture] = Object.values(foreign.foreignMarkerFixtures());

    const detected = await foreign.detectForeign(["/unused/path"], {
      read: async () => settingsFixture,
    });
    assert.ok(detected, "settings fixture must be detected as foreign");

    const codexDetected = await foreign.detectForeign(["/unused/path"], {
      read: async () => codexFixture,
    });
    assert.ok(codexDetected, "codex fixture must be detected as foreign");

    assert.equal(
      await foreign.detectForeign(["/unused/path"], { read: async () => "clean config" }),
      null,
      "a clean config must not be flagged"
    );
  });
});
