import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

// Piped stdin reaches the CLI however the parent provides it: real shells
// hand over a FIFO, redirections a file — and Node's child_process hands over
// an AF_UNIX socketpair, which fstat reports as neither. readStdin() must
// accept all three, or piped context from a Node parent is silently dropped
// (`run` answers without it, `login --with-token` dies asking for a pipe).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist", "index.js");

function childEnv(dir) {
  const env = { ...process.env };
  delete env.AIAND_API_KEY;
  delete env.AIAND_PROFILE;
  env.AIAND_HOME = join(dir, "home");
  env.AIAND_CONFIG_DIR = join(dir, "cfg");
  env.NO_UPDATE_CHECK = "1";
  env.CI = "1";
  return env;
}

// Spawn like a Node parent would: async pipes. On POSIX the stdin pipe is a
// socket, which is exactly the shape hasPipedInput() used to reject.
function runCli(args, { env, input, stdinFd } = {}) {
  return new Promise((resolve, reject) => {
    const stdio = stdinFd !== undefined ? [stdinFd, "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdinFd === undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

describe("piped stdin across stdio shapes", () => {
  test("socket stdin (Node-spawned pipe) reaches the prompt", async () => {
    // No positionals: the prompt can only come from stdin. Exit 2
    // (NotLoggedInError, before any network) proves buildPrompt() saw it;
    // exit 1 "No prompt given." would prove it was dropped.
    const dir = mkdtempSync(join(tmpdir(), "aiand-stdin-test-"));
    try {
      const r = await runCli(["run"], { env: childEnv(dir), input: "piped marker" });
      assert.equal(r.code, 2, `expected NotLoggedIn, got ${r.code}: ${r.stderr}`);
      assert.match(r.stderr, /Not logged in/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file-redirected stdin reaches the prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-stdin-test-"));
    const marker = join(dir, "prompt.txt");
    writeFileSync(marker, "piped marker");
    const fd = openSync(marker, "r");
    try {
      const r = await runCli(["run"], { env: childEnv(dir), stdinFd: fd });
      assert.equal(r.code, 2, `expected NotLoggedIn, got ${r.code}: ${r.stderr}`);
      assert.match(r.stderr, /Not logged in/);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no stdin still refuses with a usage error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-stdin-test-"));
    try {
      const r = await runCli(["run"], {
        env: childEnv(dir),
        input: "",
      });
      // Empty input closes immediately: readStdin sees no text.
      assert.equal(r.code, 1, `expected usage error, got ${r.code}: ${r.stderr}`);
      assert.match(r.stderr, /No prompt given/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("login --with-token rejects leftover stdin lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-stdin-test-"));
    try {
      const r = await runCli(["login", "--with-token"], {
        env: childEnv(dir),
        input: "sk-abc123\nleftover line\n",
      });
      assert.equal(r.code, 1, `expected leftover reject, got ${r.code}: ${r.stderr}`);
      assert.match(r.stderr, /single-line key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
