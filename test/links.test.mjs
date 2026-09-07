import assert from "node:assert/strict";
import { test } from "node:test";
import { hyperlinksEnabled, link } from "../dist/cli/links.js";

const OSC8_OPEN = (url) => `\x1b]8;;${url}\x1b\\`;
const OSC8_CLOSE = "\x1b]8;;\x1b\\";

// --- hyperlinksEnabled -------------------------------------------------------

test("links: FORCE_HYPERLINK overrides everything (non-empty)", () => {
  assert.equal(hyperlinksEnabled({ stream: {}, env: { FORCE_HYPERLINK: "1" } }), true);
  assert.equal(
    hyperlinksEnabled({ stream: { isTTY: false }, env: { FORCE_HYPERLINK: "1" } }),
    true
  );
});

test("links: FORCE_HYPERLINK=0 and empty both disable", () => {
  assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: { FORCE_HYPERLINK: "0" } }), false);
  assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: { FORCE_HYPERLINK: "" } }), false);
});

test("links: requires a TTY stream", () => {
  assert.equal(hyperlinksEnabled({ stream: { isTTY: false }, env: {} }), false);
});

test("links: enabled on a TTY under known terminals", () => {
  assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: { TERM: "xterm-kitty" } }), true);
  assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: { TERM: "alacritty" } }), true);
  assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: { TERM_PROGRAM: "WezTerm" } }), true);
  assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: { WT_SESSION: "abc" } }), true);
  assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: { KONSOLE_VERSION: "230000" } }), true);
});

test("links: VTE_VERSION >= 5000 enables", () => {
  assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: { VTE_VERSION: "6000" } }), true);
  assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: { VTE_VERSION: "4000" } }), false);
});

test("links: disabled on a TTY with an unknown TERM_PROGRAM/TERM", () => {
  assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: { TERM_PROGRAM: "RandomApp" } }), false);
  assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: { TERM: "xterm" } }), false);
});

test("links: xterm (dumb) without other signals stays off", () => {
  assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: { TERM: "dumb" } }), false);
});

// --- link --------------------------------------------------------------------

test("links: link emits OSC 8 when enabled", () => {
  const url = "https://a.example/path?x=1";
  const active = { stream: { isTTY: true }, env: { FORCE_HYPERLINK: "1" } };
  assert.equal(link(url, active), `${OSC8_OPEN(url)}${url}${OSC8_CLOSE}`);
});

test("links: link falls back to plain text when disabled", () => {
  const inactive = { stream: { isTTY: false }, env: {} };
  assert.equal(link("https://a.example", inactive), "https://a.example");
});

test("links: link falls back to plain text under FORCE_HYPERLINK=0", () => {
  const off = { stream: { isTTY: true }, env: { FORCE_HYPERLINK: "0" } };
  assert.equal(link("https://a.example", off), "https://a.example");
});

test("links: link reads the default stream/env when no options passed", () => {
  // In the test runner stdout is not a TTY, so plain text.
  assert.equal(link("https://a.example"), "https://a.example");
});