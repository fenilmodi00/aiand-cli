import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { FakeInput, FakeOutput, withEnv, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-welcome-test-", (dir) => {
  const home = join(dir, "home");
  const cfg = join(dir, "cfg");
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
});

const { playWelcome, shouldPlayWelcome, markWelcomePlayed } = await import(
  "../dist/cli/ui/welcome.js"
);

const EXIT_ALT = "\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";

test("plays every frame then restores the screen", async () => {
  await withEnv({ AIAND_NO_WELCOME: undefined }, async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.isTTY = true;
    await playWelcome({ input, output });
    // 7 slide frames + blank gap + sparkle + wordmark = 10 redraws.
    assert.equal(output.text.split("\x1b[H").length - 1, 10);
    assert.ok(output.text.includes("✦"), "sparkle frame present");
    assert.ok(output.text.includes("█"), "wordmark frame present");
    assert.ok(output.text.endsWith(SHOW_CURSOR + EXIT_ALT), "restores cursor + alt screen");
  });
});

test("any key skips instantly but still restores", async () => {
  await withEnv({ AIAND_NO_WELCOME: undefined }, async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.isTTY = true;
    const playing = playWelcome({ input, output });
    await waitForFrameCount(output, 1);
    input.send("x");
    await playing;
    assert.ok(output.text.split("\x1b[H").length - 1 < 10, "skipped before completion");
    assert.ok(output.text.includes(SHOW_CURSOR + EXIT_ALT), "skip path still restores");
    assert.equal(input.raw, false, "raw mode restored");
  });
});

test("non-TTY input writes nothing", async () => {
  const input = new FakeInput({ tty: false });
  const output = new FakeOutput();
  output.isTTY = true;
  await playWelcome({ input, output });
  assert.equal(output.text, "");
});

test("non-TTY output writes nothing", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  await playWelcome({ input, output });
  assert.equal(output.text, "");
});

test("AIAND_NO_WELCOME=1 suppresses the animation", async () => {
  await withEnv({ AIAND_NO_WELCOME: "1" }, async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.isTTY = true;
    await playWelcome({ input, output });
    assert.equal(output.text, "");
  });
});

describe("welcome once-marker", () => {
  test("marks played and flips shouldPlayWelcome", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aiand-welcome-state-"));
    try {
      assert.equal(shouldPlayWelcome(dir), true, "fresh dir plays");
      markWelcomePlayed(dir);
      assert.equal(shouldPlayWelcome(dir), false, "marker suppresses");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merges into an existing state.json without clobbering keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aiand-welcome-merge-"));
    try {
      await writeFile(join(dir, "state.json"), '{"other":2}\n');
      markWelcomePlayed(dir);
      const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
      assert.equal(state.welcome, 1);
      assert.equal(state.other, 2, "unrelated keys survive");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Resolves once the animation has rendered `n` frames. The skip test cannot
 * sleep on wall-clock frames (they are 150ms each); it needs the first frame
 * visible before sending the key, and FakeOutput has no listener to hook.
 */
function waitForFrameCount(output, n, timeoutMs = 2000) {
  const start = Date.now();
  return (function poll() {
    if (output.text.split("\x1b[H").length - 1 >= n) return Promise.resolve();
    if (Date.now() - start > timeoutMs) return Promise.reject(new Error("no frame rendered"));
    return new Promise((r) => setTimeout(r, 10)).then(poll);
  })();
}
