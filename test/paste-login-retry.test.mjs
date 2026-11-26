import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { captureStdio, FakeInput, FakeOutput, withEnv, withTestEnv } from "./helpers.mjs";

// The masked paste prompt gives three attempts; a key that is the wrong shape
// (a stray space inside it, say) is one of those attempts, not a fatal error.

withTestEnv("aiand-paste-retry-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_KEY_STORAGE = "plaintext";
  process.env.NO_COLOR = "1";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_AUTH_URL;
});

const { pasteLogin } = await import("../dist/auth/login.js");
const config = await import("../dist/config.js");

let server;
let url;
before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/user") return res.end(JSON.stringify({ id: "u1", email: "a@x.com" }));
      if (req.url === "/api/orgs") return res.end(JSON.stringify([{ id: "o1", name: "Org" }]));
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

async function paste(...lines) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const muted = captureStdio({ mute: true });
  let result;
  try {
    await withEnv({ AIAND_BASE_URL: url }, async () => {
      const settled = pasteLogin({ interactive: true, input, output }).then(
        () => "signed-in",
        (error) => error,
      );
      for (const line of lines) {
        for (let i = 0; i < 500 && input.listenerCount("data") === 0; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        input.send(`${line}\r`);
        await new Promise((r) => setTimeout(r, 5));
      }
      result = await settled;
    });
  } finally {
    muted.restore();
  }
  return { result, output: output.text };
}

test("a key with a space inside it costs one attempt, and the next paste signs in", async () => {
  const { result } = await paste("sk-ab cd", "sk-good");
  assert.equal(result, "signed-in");
  assert.equal((await config.loadCredential("default")).access_token, "sk-good");
});

test("a key padded with whitespace is trimmed and accepted", async () => {
  const { result } = await paste("   sk-padded \t ");
  assert.equal(result, "signed-in");
  assert.equal((await config.loadCredential("default")).access_token, "sk-padded");
});

test("three malformed keys in a row give up with the attempts message", async () => {
  const { result } = await paste("sk-a b", "sk-c d", "sk-e f");
  assert.match(result.message, /Three invalid keys in a row/);
});
