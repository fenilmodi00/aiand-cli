// The installers are served as raw release assets. `irm | iex` hands
// PowerShell the text of install.ps1: a byte-order mark on line 1 runs as a
// command, and Windows PowerShell 5.1 decodes bytes it cannot place as Latin-1,
// which garbles any non-ASCII text. So no PowerShell script carries a BOM or a
// non-ASCII byte, and the shell installer carries no BOM either.
// #58 review: install.ps1 started with a UTF-8 BOM.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

const all = walk(root);
const powershell = all.filter((file) => /\.ps(m|d)?1$/i.test(file));
const rel = (file) => relative(root, file);

const BOMS = [
  ["UTF-8", [0xef, 0xbb, 0xbf]],
  ["UTF-16 LE", [0xff, 0xfe]],
  ["UTF-16 BE", [0xfe, 0xff]],
];

function bomOf(bytes) {
  return BOMS.find(([, mark]) => mark.every((byte, i) => bytes[i] === byte))?.[0];
}

test("install.ps1 is among the PowerShell scripts checked", () => {
  assert.ok(powershell.map(rel).includes("install.ps1"), powershell.map(rel).join(", "));
});

for (const file of [...powershell, join(root, "install.sh")]) {
  test(`${rel(file)} has no byte-order mark`, () => {
    const bytes = readFileSync(file);
    assert.equal(bomOf(bytes), undefined, `${rel(file)} starts with a ${bomOf(bytes)} BOM`);
    assert.notEqual(bytes[0], 0, `${rel(file)} looks like UTF-16`);
  });
}

for (const file of powershell) {
  test(`${rel(file)} is ASCII`, () => {
    const bytes = readFileSync(file);
    const at = bytes.findIndex((byte) => byte > 0x7f);
    if (at !== -1) {
      const line = bytes.subarray(0, at).toString("latin1").split("\n").length;
      assert.fail(`${rel(file)} has a non-ASCII byte 0x${bytes[at].toString(16)} on line ${line}`);
    }
  });
}
