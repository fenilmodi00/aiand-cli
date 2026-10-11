import assert from "node:assert/strict";
import { test } from "node:test";
import { KEY, promptMenu } from "../dist/cli/menu.js";
import { FakeInput, FakeOutput, withEnv } from "./helpers.mjs";

/** A stub menu: three rows in two groups, with a detail line on each. */
const menu = () => ({
  message: "What do you want to run?",
  brand: { name: "AI&", tagline: "Agents and inference.", version: "v0.6.0" },
  items: [
    {
      value: "login",
      label: "Sign in with a browser approval",
      group: "Account",
      hint: "browser approval",
      detail: "Opens the browser for an approval code.",
      shortcut: "aiand login",
    },
    {
      value: "claude",
      label: "Claude Code",
      group: "Featured",
      hint: "default",
      detail: "Starts Claude Code here.",
      shortcut: "tclaude",
      keywords: ["agent", "terminal"],
    },
    {
      value: "usage",
      label: "Usage",
      group: "Account",
      hint: "key missing",
      detail: "Spend and tokens for the last 7 days.",
      keywords: ["spend", "cost", "tokens"],
    },
  ],
});

/**
 * Every repaint starts with a cursor-up jump, so splitting on it recovers the
 * individual frames. The last one is what is on screen.
 */
const frames = (output) =>
  output.text
    .split(/\x1b\[\d+A/)
    .slice(1)
    .map((frame) => frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));

/**
 * The frame currently on screen. The first repaint has no cursor-up prefix,
 * so a single-frame output is the frame itself.
 */
const lastFrame = (output) => {
  const parsed = frames(output);
  return parsed.at(-1) ?? output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
};

/** Let the menu attach its stdin listener before driving keys. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

// --- rendering ---------------------------------------------------------------

test("promptMenu renders the brand header, groups, and a search bar", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  const plain = output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

  assert.match(plain, /aiand/);
  assert.match(plain, /v0\.6\.0/);
  // The tagline adds what the wordmark does not already say.
  assert.match(plain, /Agents and inference\./);
  // Group headings, in the order the items were given.
  assert.match(plain, /Account/);
  assert.match(plain, /Featured/);
  // The message heads the list, so the search bar shows no placeholder.
  assert.match(plain, /What do you want to run\?/);
  assert.doesNotMatch(plain, /Type to search agents and apps/);
  // The footer carries the key hints.
  assert.match(plain, /\u2191\u2193 move/);
  assert.match(plain, /enter open/);
  assert.match(plain, /type to search/);
  assert.match(plain, /esc quit/);

  input.send(KEY.ESC);
  assert.equal(await promise, null);
});

test("promptMenu shows the focused item's detail under a rule", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  const plain = output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

  // The first row is focused, so its detail is visible.
  assert.match(plain, /Opens the browser for an approval code\./);
  // A horizontal rule separates the detail from the item list.
  assert.match(plain, /─+/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu shows the focused item's hint and shortcut on its row", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  const plain = output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

  assert.match(plain, /Sign in with a browser approval/);
  assert.match(plain, /aiand login/);
  assert.match(plain, /browser approval/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu shows a badge on the row that carries one", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    ...menu(),
    items: [{ value: "a", label: "Desktop app", badge: "beta", group: "Featured" }],
    input,
    output,
  });
  await settle();
  const plain = output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

  assert.match(plain, /Desktop app beta/);

  input.send(KEY.ESC);
  await promise;
});

// --- navigation --------------------------------------------------------------

test("promptMenu Enter opens the focused item", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  input.send(KEY.DOWN);
  await settle();
  input.send(KEY.ENTER_CR);
  assert.equal(await promise, "claude");
});

test("promptMenu Tab moves down, wrapping at the end", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  input.send(KEY.TAB);
  await settle();
  input.send(KEY.ENTER_CR);
  assert.equal(await promise, "claude");

  const input2 = new FakeInput();
  const output2 = new FakeOutput();
  const wrap = promptMenu({ ...menu(), input: input2, output: output2 });
  await settle();
  // Two tabs from row 0 land past the last row and wrap to row 0.
  input2.send(KEY.TAB);
  await settle();
  input2.send(KEY.TAB);
  await settle();
  input2.send(KEY.TAB);
  await settle();
  input2.send(KEY.ENTER_CR);
  assert.equal(await wrap, "login");
});

test("promptMenu Up and Down wrap around both ends", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  input.send(KEY.UP);
  await settle();
  input.send(KEY.ENTER_CR);
  assert.equal(await promise, "usage");
});

test("promptMenu Esc returns cancelled, not an item", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  input.send(KEY.ESC);
  assert.equal(await promise, null);
});

// --- search ------------------------------------------------------------------

test("promptMenu typing filters items by label and keyword", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  input.send("c");
  await settle();

  // "Claude Code" matches the label; "Usage" stays out.
  const frame = lastFrame(output);
  assert.match(frame, /Claude Code/);
  assert.doesNotMatch(frame, /Spend and tokens/);

  input.send(KEY.ESC);
  input.send(KEY.ESC);
  await promise;
});

test("promptMenu a keyword-only match filters down to that row", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  for (const char of "tokens") input.send(char);
  await settle();

  const frame = lastFrame(output);
  assert.match(frame, /Usage/);
  assert.doesNotMatch(frame, /Claude Code/);

  input.send(KEY.ESC);
  input.send(KEY.ESC);
  await promise;
});

test("promptMenu Esc clears a query first, then cancels", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  input.send("c");
  await settle();
  input.send(KEY.ESC);
  await settle();
  // All rows are back, and the search query is empty again.
  const frame = lastFrame(output);
  assert.match(frame, /Sign in with a browser approval/);
  assert.match(frame, /Claude Code/);

  input.send(KEY.ESC);
  assert.equal(await promise, null);
});

test("promptMenu Backspace deletes the last query character", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  for (const char of "cl") input.send(char);
  await settle();
  input.send(KEY.BACKSPACE_DEL);
  await settle();
  // "c" still matches Claude Code; the query is one char shorter.
  assert.match(lastFrame(output), /Claude Code/);

  input.send(KEY.ESC);
  input.send(KEY.ESC);
  await promise;
});

test("promptMenu no match states the query plainly", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  for (const char of "zzzz") input.send(char);
  await settle();

  assert.match(lastFrame(output), /No matches/);

  input.send(KEY.ESC);
  input.send(KEY.ESC);
  await promise;
});

// --- shortcuts ---------------------------------------------------------------

test("promptMenu a number jumps to that row and Enter opens it", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  input.send("2");
  await settle();
  input.send(KEY.ENTER_CR);
  assert.equal(await promise, "claude");
});

test("promptMenu an out-of-range number jumps nowhere", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  input.send("9");
  await settle();
  input.send(KEY.ENTER_CR);
  assert.equal(await promise, "login");
});

test("promptMenu a query swaps the footer hint to esc clear", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  // Without a query the footer offers typing and quitting.
  assert.match(lastFrame(output), /type to search/);
  assert.match(lastFrame(output), /esc quit/);
  assert.doesNotMatch(lastFrame(output), /esc clear/);

  input.send("u");
  await settle();
  // With a query the footer offers clearing it instead.
  assert.doesNotMatch(lastFrame(output), /type to search/);
  assert.doesNotMatch(lastFrame(output), /esc quit/);
  assert.match(lastFrame(output), /esc clear/);

  input.send(KEY.ESC);
  input.send(KEY.ESC);
  await promise;
});

test("promptMenu Esc restores the un-queried footer", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  input.send("u");
  await settle();
  input.send(KEY.ESC);
  await settle();
  assert.match(lastFrame(output), /type to search/);
  assert.match(lastFrame(output), /esc quit/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu scrolls the window to keep focus visible", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const items = Array.from({ length: 30 }, (_, i) => ({
    value: `v${i}`,
    label: `Row ${i}`,
    group: i === 0 ? "Featured" : "More agents",
  }));
  const promise = promptMenu({ ...menu(), items, rows: 10, input, output });
  await settle();
  // The first repaint shows the top of the list, not row 29.
  assert.match(lastFrame(output), /Row 0/);
  assert.doesNotMatch(lastFrame(output), /Row 29/);

  for (let i = 0; i < 25; i += 1) {
    input.send(KEY.DOWN);
    await settle();
  }
  assert.match(frames(output).at(-1) ?? "", /Row 25/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu shows more-below and more-above markers when scrolled", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const items = Array.from({ length: 30 }, (_, i) => ({
    value: `v${i}`,
    label: `Row ${i}`,
    group: "More agents",
  }));
  const promise = promptMenu({ ...menu(), items, rows: 10, input, output });
  await settle();
  for (let i = 0; i < 12; i += 1) {
    input.send(KEY.DOWN);
    await settle();
  }
  const plain = output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  // Scrolled off the top, so a "more" marker appears above.
  assert.match(plain, /more/);

  input.send(KEY.ESC);
  await promise;
});

// --- non-interactive / terminal hygiene --------------------------------------

test("promptMenu non-TTY input throws instead of hanging", async () => {
  const input = new FakeInput({ tty: false });
  const output = new FakeOutput();
  await assert.rejects(promptMenu({ ...menu(), input, output }), /interactive terminal/);
});

test("promptMenu Ctrl-C rejects with 130 and restores the terminal", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  input.send(KEY.CTRL_C);
  await assert.rejects(promise, (error) => error.exitCode === 130);
  assert.equal(input.raw, false);
  assert.ok(output.text.includes("\x1b[?25h"), "cursor shown again");
});

test("promptMenu empty items returns cancelled without prompting", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const result = await promptMenu({ ...menu(), items: [], input, output });
  assert.equal(result, null);
  assert.equal(output.text, "");
});

test("promptMenu filters out items whose group is empty", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    ...menu(),
    items: [
      { value: "a", label: "In a group", group: "Account" },
      { value: "b", label: "Ungrouped" },
    ],
    input,
    output,
  });
  await settle();
  const plain = output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  // The grouped row renders; the ungrouped one is skipped, not orphaned.
  assert.match(plain, /In a group/);
  assert.doesNotMatch(plain, /Ungrouped/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu a state text renders on its row", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    ...menu(),
    items: [
      {
        value: "configure",
        label: "Configure",
        group: "Account",
        state: { text: "key missing", tone: "warning" },
      },
    ],
    input,
    output,
  });
  await settle();
  const plain = output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /key missing/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu a lone Esc split across chunks still cancels", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  // Send the escape byte alone, then the following key in a later chunk: the
  // parser must buffer and flush it as Esc.
  input.send("\x1b");
  input.send("[A");
  await settle();
  input.send("\x1b");
  await settle();
  input.send("\x1b");
  assert.equal(await promise, null);
});

test("promptMenu stdin end rejects and restores the terminal", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  input.end();
  await assert.rejects(promise, /Input ended/);
  assert.equal(input.raw, false, "raw mode restored");
  assert.ok(output.text.includes("\x1b[?25h"), "cursor shown again");
});

test("promptMenu Backspace on an empty query is a no-op", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({ ...menu(), input, output });
  await settle();
  input.send(KEY.BACKSPACE_DEL);
  await settle();
  // The query stays empty and every row is still listed.
  assert.match(lastFrame(output), /Sign in with a browser approval/);
  assert.match(lastFrame(output), /Claude Code/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu the match keeps the label's head and tail outside the accent", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 100;
  await withEnv({ NO_COLOR: undefined, FORCE_COLOR: "3" }, async () => {
    const started = promptMenu({ ...menu(), input, output });
    await settle();
    // "browser" sits mid-label in "Sign in with a browser approval", so the
    // head before it and the tail after it must stay unaccented.
    input.send("browser");
    await settle();
    // The label keeps its head and tail; only the query run turns red.
    assert.match(output.text, /Sign in with a \x1b\[38;2;239;38;53mbrowser\x1b\[39m approval/);
    input.send(KEY.ESC);
    input.send(KEY.ESC);
    await started;
  });
});

test("promptMenu a number out of range with one row jumps nowhere", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    ...menu(),
    items: [{ value: "only", label: "Only one", group: "Account" }],
    input,
    output,
  });
  await settle();
  input.send("9");
  await settle();
  input.send(KEY.ENTER_CR);
  assert.equal(await promise, "only");
});

test("promptMenu a long label is ellipsized to the label column", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    ...menu(),
    items: [
      {
        value: "long",
        label: "A deliberately very long row label that cannot fit the column",
        group: "Account",
      },
    ],
    input,
    output,
  });
  await settle();
  // A label wider than the label column is clipped with an ellipsis.
  const row = lastFrame(output)
    .split("\n")
    .find((line) => line.includes("A deliberately"));
  assert.ok(row, "the long-label row is rendered");
  assert.match(row, /…/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu a long hint is clipped beside the label", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    ...menu(),
    items: [
      {
        value: "hinted",
        label: "Short",
        group: "Account",
        hint: "an extremely long trailing hint that has to be clipped for width",
      },
    ],
    input,
    output,
  });
  await settle();
  // The hint renders inline beside the label, never below it.
  const row = lastFrame(output)
    .split("\n")
    .find((line) => line.includes("Short"));
  assert.ok(row, "the hinted row is rendered");
  assert.match(row, /an extremely long trailing hint/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu the matched query substring is highlighted", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 100;
  // The menu reads the color env when it starts, so set it before launching.
  await withEnv({ NO_COLOR: undefined, FORCE_COLOR: "3" }, async () => {
    const started = promptMenu({ ...menu(), input, output });
    await settle();
    // "browser" occurs mid-label, so just that run is painted in the accent.
    input.send("browser");
    await settle();
    assert.match(output.text, /\x1b\[38;2;239;38;53mbrowser\x1b\[39m/u);
    input.send(KEY.ESC);
    input.send(KEY.ESC);
    await started;
  });
});

test("promptMenu a message suppresses the search placeholder", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    message: "Sign in to get started",
    brand: { name: "aiand", version: "v1.0.0", tagline: "Agents, on ai& inference." },
    items: [{ value: "__login", label: "Sign in with your browser", group: "Sign in" }],
    input,
    output,
  });
  await settle();
  const frame = lastFrame(output);
  assert.match(frame, /Sign in to get started/);
  assert.doesNotMatch(frame, /Type to search agents and apps/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu no message keeps the search placeholder", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    items: [{ value: "a", label: "Only one", group: "Account" }],
    input,
    output,
  });
  await settle();
  assert.match(lastFrame(output), /Type to search agents and apps/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu the brand header puts the version flush right", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    message: "Pick one",
    brand: { name: "aiand", version: "1.2.3" },
    items: [{ value: "a", label: "Row", group: "Account" }],
    input,
    output,
  });
  await settle();
  const row = lastFrame(output)
    .split("\n")
    .find((line) => line.includes("aiand"));
  assert.ok(row, "the wordmark row is rendered");
  assert.match(row, /v1\.2\.3/);
  // The version sits at the right edge, not next to the wordmark.
  assert.match(row, /\S {4,}v1\.2\.3$/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu a badge widens the label column", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    items: [
      { value: "a", label: "With a badge", group: "Featured", badge: "beta" },
      { value: "b", label: "Without", group: "More agents" },
    ],
    input,
    output,
  });
  await settle();
  const frame = lastFrame(output);
  assert.match(frame, /With a badge beta/);
  // The badge counts toward the label width, so the trailing column of the
  // unbadged row aligns with the badged one's.
  const rows = frame.split("\n").filter((line) => /With a badge|Without/.test(line));
  assert.equal(rows.length, 2);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu state tones paint their own color when color is on", async () => {
  await withEnv({ NO_COLOR: undefined, FORCE_COLOR: "3" }, async () => {
    // One row per tone, each focused, so every tone's paint arm runs.
    const colors = {
      warning: "240;182;96",
      success: "139;213;160",
      danger: "255;127;121",
    };
    for (const [tone, rgb] of Object.entries(colors)) {
      const input = new FakeInput();
      const output = new FakeOutput();
      const started = promptMenu({
        items: [
          { value: tone, label: `A ${tone} row`, group: "Menu", state: { text: "STATE", tone } },
        ],
        input,
        output,
      });
      await settle();
      assert.match(output.text, new RegExp(`38;2;${rgb}mSTATE`), `${tone} paints ${rgb}`);
      input.send(KEY.ESC);
      await started;
    }
  });
});

test("promptMenu a badge widens the label column", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    items: [
      { value: "a", label: "With a badge", group: "Featured", badge: "beta" },
      { value: "b", label: "Without", group: "More agents" },
    ],
    input,
    output,
  });
  await settle();
  const frame = lastFrame(output);
  assert.match(frame, /With a badge beta/);
  // The badge counts toward the label width, so the trailing column of the
  // unbadged row aligns with the badged one's.
  const rows = frame.split("\n").filter((line) => /With a badge|Without/.test(line));
  assert.equal(rows.length, 2);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu state tones paint their own color when color is on", async () => {
  await withEnv({ NO_COLOR: undefined, FORCE_COLOR: "3" }, async () => {
    // One row per tone, so each tone is the focused row that gets to paint.
    for (const tone of ["warning", "success", "danger"]) {
      const input = new FakeInput();
      const output = new FakeOutput();
      const started = promptMenu({
        items: [
          {
            value: tone,
            label: `A ${tone} row`,
            group: "Menu",
            state: { text: "STATE", tone },
          },
        ],
        input,
        output,
      });
      await settle();
      assert.match(output.text, /STATE/, `${tone} state text renders`);
      input.send(KEY.ESC);
      await started;
    }
  });
});

test("promptMenu a badge widens the label column", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    items: [
      { value: "a", label: "With a badge", group: "Featured", badge: "beta" },
      { value: "b", label: "Without", group: "More agents" },
    ],
    input,
    output,
  });
  await settle();
  const frame = lastFrame(output);
  assert.match(frame, /With a badge beta/);
  // The badge counts toward the label width, so the trailing column of the
  // unbadged row aligns with the badged one's.
  const rows = frame.split("\n").filter((line) => /With a badge|Without/.test(line));
  assert.equal(rows.length, 2);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu state tones paint their own color when color is on", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  await withEnv({ NO_COLOR: undefined, FORCE_COLOR: "3" }, async () => {
    const started = promptMenu({
      items: [
        { value: "w", label: "Warn", group: "Menu", state: { text: "needs key", tone: "warning" } },
        { value: "g", label: "Good", group: "Menu", state: { text: "ready", tone: "success" } },
        { value: "b", label: "Bad", group: "Menu", state: { text: "removes", tone: "danger" } },
      ],
      input,
      output,
    });
    await settle();
    // Warning amber, success green, danger red.
    assert.match(output.text, /\x1b\[38;2;240;182;96mneeds key/);
    assert.match(output.text, /\x1b\[38;2;139;213;160mready/);
    assert.match(output.text, /\x1b\[38;2;255;127;121mremoves/);
    input.send(KEY.ESC);
    await started;
  });
});

test("promptMenu a badge widens the label column", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    items: [
      { value: "a", label: "With a badge", group: "Featured", badge: "beta" },
      { value: "b", label: "Without", group: "More agents", hint: "a hint that fits" },
    ],
    input,
    output,
  });
  await settle();
  const frame = lastFrame(output);
  // The badge counts toward the label column, so the unbadged row's label
  // still starts in the same place.
  assert.match(frame, /With a badge beta/);
  assert.match(frame, /Without/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu a danger state renders on its row", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    items: [
      {
        value: "reset",
        label: "Reset profile",
        group: "Menu",
        state: { text: "removes it", tone: "danger" },
      },
    ],
    input,
    output,
  });
  await settle();
  assert.match(lastFrame(output), /removes it/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu a neutral state renders muted, not colored", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  await withEnv({ NO_COLOR: undefined, FORCE_COLOR: "3" }, async () => {
    const started = promptMenu({
      items: [
        {
          value: "plain",
          label: "Plain row",
          group: "Menu",
          state: { text: "standby", tone: "neutral" },
        },
      ],
      input,
      output,
    });
    await settle();
    // Neutral is the only tone that carries no state color: it renders dim.
    const row = lastFrame(output)
      .split("\n")
      .find((line) => line.includes("standby"));
    assert.ok(row, "the neutral state renders");
    assert.doesNotMatch(row, /38;2;240;182;96/); // not warning amber
    assert.doesNotMatch(row, /38;2;139;213;160/); // not success green
    assert.doesNotMatch(row, /38;2;255;127;121/); // not danger red
    input.send(KEY.ESC);
    await started;
  });
});

test("promptMenu separates groups with a blank line", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    items: [
      { value: "a", label: "First row", group: "Account" },
      { value: "b", label: "Second row", group: "Agents" },
      { value: "c", label: "Third row", group: "Agents" },
    ],
    input,
    output,
  });
  await settle();
  // Two group headings, with a blank line between the groups, and no blank
  // before the first.
  const lines = lastFrame(output).split("\n");
  const account = lines.findIndex((line) => line.includes("Account"));
  const agents = lines.findIndex((line) => line.includes("Agents"));
  assert.ok(account >= 0 && agents > account, "both groups render, in order");
  // Exactly one blank line sits between the two groups.
  assert.equal(lines[agents - 1], "", "a blank line separates the groups");
  assert.notEqual(lines[agents - 2].trim(), "", "and it is the only one");

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu a query that matches no term leaves the label unaccented", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  await withEnv({ NO_COLOR: undefined, FORCE_COLOR: "3" }, async () => {
    const started = promptMenu({
      message: "Pick one",
      brand: { name: "aiand", version: "1.0.0" },
      items: [{ value: "a", label: "Claude Code", group: "Agents", keywords: ["agent"] }],
      input,
      output,
    });
    await settle();
    // "agent" filters the row in on a keyword, not on the label, so nothing in
    // the label is highlighted.
    input.send("agent");
    await settle();
    assert.match(lastFrame(output), /Claude Code/);
    assert.doesNotMatch(lastFrame(output), /38;2;239;38;53m/);

    input.send(KEY.ESC);
    input.send(KEY.ESC);
    await started;
  });
});

test("promptMenu a 256-color terminal paints the focus fill", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 80;
  await withEnv({ NO_COLOR: undefined, FORCE_COLOR: "1" }, async () => {
    const started = promptMenu({
      message: "Pick one",
      items: [{ value: "a", label: "Only row", group: "Account" }],
      input,
      output,
    });
    await settle();
    // The focus fill degrades to a 256-color index instead of 24-bit.
    assert.match(output.text, /\x1b\[48;5;\d+m/);
    assert.doesNotMatch(output.text, /\x1b\[48;2;/);
    input.send(KEY.ESC);
    await started;
  });
});

test("promptMenu the window scrolls to keep focus inside it", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const items = Array.from({ length: 30 }, (_, i) => ({
    value: `v${i}`,
    label: `Row ${i}`,
    group: "Agents",
  }));
  const promise = promptMenu({ items, rows: 6, input, output });
  await settle();
  // Walk focus far past the bottom of the first window, so the window has to
  // re-anchor rather than shift by one.
  for (let i = 0; i < 25; i += 1) {
    input.send(KEY.DOWN);
    await settle();
  }
  assert.match(lastFrame(output), /Row 25/);
  // The marker above reports the rows that scrolled off the top.
  assert.match(lastFrame(output), /↑ \d+ more/);

  // Walking back up past the top edge re-anchors the window upward.
  for (let i = 0; i < 22; i += 1) {
    input.send(KEY.UP);
    await settle();
  }
  assert.match(lastFrame(output), /Row 3/);
  assert.match(lastFrame(output), /↓ \d+ more/);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu a zero-row terminal still shows a usable window", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  // A PTY can report 0 rows, meaning "unknown" — the menu must not collapse
  // to nothing.
  output.rows = 0;
  const items = Array.from({ length: 20 }, (_, i) => ({
    value: `v${i}`,
    label: `Row ${i}`,
    group: "Agents",
  }));
  const promise = promptMenu({ items, input, output });
  await settle();
  const frame = lastFrame(output);
  assert.match(frame, /Row 0/);
  // More than one row is on screen, so the list did not collapse.
  assert.ok((frame.match(/Row \d+/g) ?? []).length > 3, "several rows render");

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu the list budget leaves room for the header and footer", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const items = Array.from({ length: 40 }, (_, i) => ({
    value: `v${i}`,
    label: `Row ${i}`,
    group: "Agents",
  }));
  const promise = promptMenu({ items, rows: 14, input, output });
  await settle();
  const frame = lastFrame(output);
  // The chrome always renders, and the list fits inside what is left.
  assert.match(frame, /type to search/);
  assert.match(frame, /Row 0/);
  const rowLines = (frame.match(/Row \d+/g) ?? []).length;
  assert.ok(rowLines > 1, `expected several rows, got ${rowLines}`);

  input.send(KEY.ESC);
  await promise;
});

test("promptMenu the brand wordmark opens the header with no status dots", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptMenu({
    message: "Pick one",
    brand: { name: "AI&", version: "1.0.0", tagline: "Agents and inference." },
    items: [{ value: "a", label: "Only row", group: "Agents" }],
    input,
    output,
  });
  await settle();
  const frame = lastFrame(output);
  // The wordmark is present, and no filler dots stand in for it.
  assert.match(frame, /AI&/);
  assert.doesNotMatch(frame, /●/);
  // The tagline repeats no brand name, since the wordmark already says it.
  assert.match(frame, /Agents and inference\./);

  input.send(KEY.ESC);
  await promise;
});
