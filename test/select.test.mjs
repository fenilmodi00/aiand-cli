import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
  splitKeys,
  createKeyParser,
  promptSelect,
  promptCheckbox,
  promptSearch,
  KEY,
} from "../dist/cli/select.js";

/**
 * A PassThrough-style fake input: a real EventEmitter that emits "data" and
 * "end" events, holds a stubbed setRawMode, and looks like a TTY. This is the
 * seam the prompts drive, so no real stdin or pty is needed.
 */
class FakeInput extends EventEmitter {
  constructor({ tty = true } = {}) {
    super();
    this.isTTY = tty;
    this.resumed = false;
    this.paused = false;
    this.raw = false;
    this.encoding = null;
  }
  setRawMode(mode) {
    this.raw = mode;
    return this;
  }
  resume() {
    this.resumed = true;
  }
  pause() {
    this.paused = true;
  }
  setEncoding(enc) {
    this.encoding = enc;
  }
  /** Feed a raw chunk exactly as stdin "data" would deliver it. */
  send(chunk) {
    this.emit("data", chunk);
    return this;
  }
  finish() {
    this.emit("end");
  }
}

class FakeOutput {
  constructor() {
    this.lines = "";
    this.columns = 80;
  }
  write(chunk) {
    this.lines += chunk;
  }
  get text() {
    // Strip all control/ANSI so assertions read the visible summary line.
    return this.lines.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  }
}

// --- splitKeys / createKeyParser -------------------------------------------

test("splitKeys: arrows come out whole, printable chars char-by-char", () => {
  assert.deepEqual([...splitKeys("ab\x1b[B")], ["a", "b", "\x1b[B"]);
  assert.deepEqual([...splitKeys("\x1b[A\r")], ["\x1b[A", "\r"]);
});

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

// --- promptSelect -----------------------------------------------------------

test("promptSelect: arrow keys move and Enter confirms the highlighted row", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptSelect({
    message: "Pick a color",
    choices: [
      { value: "red", label: "Red" },
      { value: "green", label: "Green" },
      { value: "blue", label: "Blue" },
    ],
    input,
    output,
  });
  // Down -> Blue, Down wraps to Red... then Down -> Green, Enter.
  input.send(KEY.DOWN);
  input.send(KEY.DOWN);
  input.send(KEY.ENTER_CR);
  assert.equal(await promise, "blue");
  assert.match(output.text, /✓.*Pick a color.*blue/i);
});

test("promptSelect: a digit shortcut picks directly", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptSelect({
    message: "Pick",
    choices: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
      { value: "c", label: "C" },
    ],
    input,
    output,
  });
  input.send("2");
  assert.equal(await promise, "b");
  assert.match(output.text, /✓.*Pick.*B/);
});

test("promptSelect: Ctrl-C restores terminal and exits 130", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
  };
  try {
    const promise = promptSelect({
      message: "Pick",
      choices: [{ value: "a", label: "A" }],
      input,
      output,
    });
    input.send(KEY.CTRL_C);
    // runPrompt never resolves on Ctrl-C (process.exit is stubbed), but the
    // handler runs synchronously, so assert right after the send.
    assert.equal(exitCode, 130);
    assert.equal(input.raw, false, "raw mode restored on Ctrl-C");
    assert.equal(output.text.includes("^C"), true, "prints ^C marker");
    void promise;
  } finally {
    process.exit = originalExit;
  }
});

test("promptSelect: Esc cancels with empty string", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptSelect({
    message: "Pick",
    choices: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    input,
    output,
  });
  input.send(KEY.ESC);
  assert.equal(await promise, "");
});

test("promptSelect: non-TTY input throws CliError instead of hanging", async () => {
  const input = new FakeInput({ tty: false });
  await assert.rejects(
    promptSelect({ message: "Pick", choices: [{ value: "a", label: "A" }], input }),
    (err) => err && err.name === "CliError"
  );
});

// --- promptCheckbox ---------------------------------------------------------

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

// --- promptSearch -----------------------------------------------------------

test("promptSearch: type to filter, arrow to target, Enter picks", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const items = ["claude", "codex", "cursor", "opencode"];
  const promise = promptSearch({
    message: "Search agents",
    items,
    filter: (all, term) => all.filter((n) => n.includes(term)),
    toChoice: (item) => ({ value: item, label: item }),
    input,
    output,
  });
  input.send("c");
  input.send("u"); // narrows to claude, cursor
  input.send(KEY.DOWN); // -> cursor
  input.send(KEY.ENTER_CR);
  assert.equal(await promise, "cursor");
  assert.match(output.text, /✓.*Search agents.*cursor/);
});

test("promptSearch: no matches keeps Enter a no-op until widened", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptSearch({
    message: "Search",
    items: ["claude", "codex"],
    filter: (all, term) => all.filter((n) => n.includes(term)),
    toChoice: (item) => ({ value: item, label: item }),
    input,
    output,
  });
  input.send("z"); // no matches
  input.send(KEY.ENTER_CR); // no-op
  input.send("\x7f"); // backspace: back to all
  input.send(KEY.ENTER_CR);
  assert.equal(await promise, "claude");
});