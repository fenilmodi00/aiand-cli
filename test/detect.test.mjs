import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectBinary, pickPosixHit } from "../dist/agents/detect.js";
import { hermeticPath } from "./helpers.mjs";

const REPO = "/srv/src/cloned-repo";
const BIN = "/opt/aiand/bin";

test("POSIX: a relative which hit (from `.` or an empty PATH entry) is refused", () => {
  assert.equal(pickPosixHit("./opencode\n", `.:${BIN}`, REPO), null);
  assert.equal(pickPosixHit("opencode\n", `:${BIN}`, REPO), null);
  assert.equal(pickPosixHit(`./opencode\n${BIN}/opencode\n`, `.:${BIN}`, REPO), `${BIN}/opencode`);
});

test("POSIX: an absolute hit in the cwd is refused unless the cwd is an absolute PATH entry", () => {
  const out = `${REPO}/opencode\n${BIN}/opencode\n`;
  assert.equal(pickPosixHit(out, `.:${BIN}`, REPO), `${BIN}/opencode`);
  assert.equal(pickPosixHit(out, `${REPO}/:${BIN}`, REPO), `${REPO}/opencode`);
  assert.equal(pickPosixHit(`${REPO}/opencode\n`, BIN, REPO), null);
});

test("POSIX: the cwd comparison sees through symlinks", () => {
  const realpath = (path) => path.replace("/link", REPO);
  assert.equal(pickPosixHit("/link/opencode\n", BIN, REPO, realpath), null);
  assert.equal(pickPosixHit("/link/opencode\n", `/link:${BIN}`, REPO, realpath), "/link/opencode");
});

test("POSIX: an ordinary PATH hit passes and an empty probe is not installed", () => {
  assert.equal(pickPosixHit(`${BIN}/claude\n`, BIN, REPO), `${BIN}/claude`);
  assert.equal(pickPosixHit("", BIN, REPO), null);
});

test("detectBinary ignores an agent planted in the working directory", {
  skip: process.platform === "win32",
}, () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "aiand-detect-")));
  const before = { cwd: process.cwd(), path: process.env.PATH };
  try {
    const stub = join(repo, "fixture-agent-x");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);
    process.chdir(repo);
    process.env.PATH = hermeticPath(".", "/usr/bin", "/bin");
    assert.deepEqual(detectBinary("fixture-agent-x"), { installed: false, path: null });
    process.env.PATH = hermeticPath(repo, "/usr/bin", "/bin");
    assert.deepEqual(detectBinary("fixture-agent-x"), { installed: true, path: stub });
  } finally {
    process.chdir(before.cwd);
    process.env.PATH = before.path;
    rmSync(repo, { recursive: true, force: true });
  }
});
