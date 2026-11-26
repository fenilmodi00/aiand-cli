import assert from "node:assert/strict";
import test from "node:test";

const { sqlite3Command } = await import("../dist/agents/copilot-app/sqlite.js");

// spawnSync cannot run a .cmd or .bat since the CVE-2024-27980 fix, and going
// through cmd.exe would put the SQL we pass on a command line. Only a real
// sqlite3.exe is a usable fallback, wherever on PATH it sits.
const present = (...files) => ({ isFile: (path) => files.includes(path) });
const env = { PATH: "C:\\shims;C:\\tools" };

test("on Windows a sqlite3.cmd or sqlite3.bat on PATH is not used", () => {
  for (const shim of ["sqlite3.cmd", "sqlite3.bat"]) {
    assert.equal(sqlite3Command("win32", env, present(`C:\\shims\\${shim}`)), null);
  }
});

test("on Windows a sqlite3.exe later on PATH wins over a shim earlier on it", () => {
  const lookup = present("C:\\shims\\sqlite3.cmd", "C:\\tools\\sqlite3.exe");
  assert.equal(sqlite3Command("win32", env, lookup), "C:\\tools\\sqlite3.exe");
});

test("elsewhere the bare name is used", () => {
  assert.equal(sqlite3Command("linux", { PATH: "/usr/bin" }), "sqlite3");
});
