import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createKeyParser, promptCheckbox, KEY } from "../dist/cli/select.js";

/**
 * A PassThrough-style fake input: a real EventEmitter that emits "data" and
 * "end" events, holds a stubbed setRawMode, and looks like a TTY. This is the
 * seam the prompt drives, so no real stdin or pty is needed.
 */
class FakeInput extends EventEmitter {
  constructor({ tty = true } = {}) {
    super();
    this.tty = tty;
    this.raw = false;
  }
  get isTTY() {
    return this.tty;
  }
  setRawMode(mode) {
    this.raw = mode;
  }
  resume() {}
  pause() {}
  setEncoding() {}
  send(seq) {
    this.emit("data", seq);
  }
  end() {
    this.emit("end");
  }
}

class FakeOutput {
  constructor() {
    this.text = "";
  }
  write(chunk) {
    this.text += chunk;
  }
}

// --- createKeyParser ---------------------------------------------------------

test("createKeyParser: buffers an arrow split across chunks", () => {
  const parser = createKeyParser();
  assert.deepEqual(parser.push("a\x1b"), ["a"]);
  assert.equal(parser.hasPendingEsc(), true);
  assert.deepEqual(parser.push("[A"), ["\x1b[A"]);
  assert.deepEqual(parser.flush(), []);
});

test("createKeyParser: lone trailing Esc flushes as Esc, printable bytes as-is", () => {
  const parser = createKeyParser();
  assert.deepEqual(parser.push("\x1b"), []);
  assert.equal(parser.hasPendingEsc(), true);
  assert.deepEqual(parser.flush(), ["\x1b"]);
});

// --- promptCheckbox ----------------------------------------------------------

test("promptCheckbox: space toggles, Enter returns selected values", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptCheckbox({
    message: "Which agents?",
    choices: [
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
      { value: "pi", label: "Pi" },
    ],
    input,
    output,
  });
  input.send(" "); // toggle Claude
  input.send(KEY.DOWN);
  input.send(" "); // toggle Codex
  input.send(" "); // untoggle Codex
  input.send(KEY.UP);
  input.send(" "); // toggle Claude again? -> already on, turns off
  input.send(KEY.DOWN);
  input.send(KEY.DOWN);
  input.send(" "); // toggle Pi
  input.send(KEY.ENTER_CR);
  assert.deepEqual(await promise, ["pi"]);
  assert.match(output.text, /✓.*Which agents\?.*Pi/);
});

test("promptCheckbox: empty selection is returnable", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptCheckbox({
    message: "Select",
    choices: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    input,
    output,
  });
  input.send(KEY.ENTER_CR);
  assert.deepEqual(await promise, []);
});

test("promptCheckbox: initial pre-checks the listed values", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptCheckbox({
    message: "Select",
    choices: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    initial: ["a"],
    input,
    output,
  });
  input.send(KEY.ENTER_CR);
  assert.deepEqual(await promise, ["a"]);
});

test("promptCheckbox: non-TTY input throws CliError instead of hanging", async () => {
  const input = new FakeInput({ tty: false });
  await assert.rejects(
    promptCheckbox({ message: "Pick", choices: [{ value: "a", label: "A" }], input }),
    (err) => err && err.name === "CliError"
  );
});
