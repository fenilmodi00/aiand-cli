import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-ui-test-", (dir) => {
  const home = join(dir, "home");
  const cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
});

const { colorsEnabled } = await import("../dist/cli/ui/color.js");
const { renderHome } = await import("../dist/cli/ui/home.js");
const { createTheme, hexTo256 } = await import("../dist/cli/ui/theme.js");
const { playSplash } = await import("../dist/cli/ui/splash.js");
const { hyperlinksEnabled, link } = await import("../dist/cli/links.js");

/** A no-color theme, for assert on plain text. */
const plainTheme = () => createTheme({ isTTY: true }, { NO_COLOR: "1", FORCE_COLOR: undefined });

const cli = (args) => runCli(args, { env: cliEnv({ NO_COLOR: "1" }) });

// The terminal vars that decide colorSupport()/colorsEnabled(): clear them so a
// host exporting COLORTERM=truecolor (a Windows terminal does) cannot turn a
// 256-color expectation into a truecolor one.
const TERM_ENV = { NO_COLOR: undefined, FORCE_COLOR: undefined, COLORTERM: undefined };

describe("ui color", () => {
  // colorSupport() reads COLORTERM before the FORCE_COLOR fallback, so a host
  // exporting COLORTERM=truecolor would hand a 256-color test a truecolor
  // resolution. Clear it alongside the vars under test.
  test("disables color when NO_COLOR is set", () =>
    withEnv({ ...TERM_ENV, NO_COLOR: "1" }, () => {
      assert.equal(colorsEnabled({ isTTY: true }), false);
    }));

  test("enables color when FORCE_COLOR is set on a non-tty stream", () =>
    withEnv({ ...TERM_ENV, FORCE_COLOR: "1" }, () => {
      assert.equal(colorsEnabled({ isTTY: false }), true);
    }));

  test("disables color on non-tty streams by default", () =>
    withEnv(TERM_ENV, () => {
      assert.equal(colorsEnabled({ isTTY: false }), false);
    }));
});

describe("ui theme", () => {
  test("truecolor paints the brand red as 24-bit foreground", () =>
    withEnv({ ...TERM_ENV, FORCE_COLOR: "3", AIAND_THEME: "dark" }, () => {
      const theme = createTheme({ isTTY: true });
      assert.equal(theme.color, true);
      assert.equal(theme.support, "truecolor");
      assert.equal(theme.brand("x"), "\x1b[38;2;199;0;7mx\x1b[39m");
    }));

  test("xterm-256 fallback emits a 256-color index, not 24-bit", () =>
    withEnv({ ...TERM_ENV, FORCE_COLOR: "1", AIAND_THEME: "dark" }, () => {
      const theme = createTheme({ isTTY: true });
      assert.equal(theme.support, "256");
      assert.match(theme.brand("x"), /^\x1b\[38;5;\d+mx\x1b\[39m$/);
    }));

  test("NO_COLOR yields plain text for every style", () =>
    withEnv({ ...TERM_ENV, NO_COLOR: "1" }, () => {
      const theme = createTheme({ isTTY: true });
      assert.equal(theme.color, false);
      for (const styled of [theme.brand, theme.accent, theme.success, theme.bold, theme.muted]) {
        assert.equal(styled("x"), "x");
      }
    }));

  test("AIAND_THEME=light picks the light palette", () =>
    withEnv({ ...TERM_ENV, FORCE_COLOR: "3", AIAND_THEME: "light" }, () => {
      assert.equal(createTheme({ isTTY: true }).palette.accent, "#E2091A");
    }));

  test("COLORFGBG light background picks the light palette", () =>
    withEnv({ ...TERM_ENV, FORCE_COLOR: "3", AIAND_THEME: undefined, COLORFGBG: "0;15" }, () => {
      assert.equal(createTheme({ isTTY: true }).palette.fill, "#EEE9E9");
    }));

  test("NO_COLOR leaves every theme style a plain pass-through", () =>
    withEnv({ ...TERM_ENV, NO_COLOR: "1" }, () => {
      const theme = createTheme({ isTTY: true });
      assert.equal(theme.color, false);
      // Every style, curried or not, returns the text unchanged.
      assert.equal(theme.fg("brand")("x"), "x");
      assert.equal(theme.hex("#FF0000")("x"), "x");
    }));

  test("hexTo256 snaps brand red into the cube", () => {
    const index = hexTo256("#C70007");
    assert.ok(Number.isInteger(index) && index >= 16 && index <= 231, `got ${index}`);
  });
});

describe("ui home", () => {
  const model = {
    brand: "aiand",
    version: "1.2.3",
    tagline: "Agents, on ai& inference.",
    sections: [
      { title: "Agents", rows: [["aiand code", "OpenCode on ai&"]] },
      { title: "Commands", rows: [["login", "Sign in"]] },
    ],
    notes: ["Run `aiand help` for the full list."],
  };

  test("renders the brand header, sections, and notes", () => {
    const text = renderHome(model, { theme: plainTheme(), columns: 100 });
    assert.match(text, /aiand\s+v1\.2\.3/);
    assert.match(text, /Agents, on ai& inference\./);
    assert.match(text, /aiand code\s+OpenCode on ai&/);
    assert.match(text, /Run `aiand help` for the full list\./);
  });

  test("narrow widths wrap the description under its command", () => {
    const text = renderHome(
      { sections: [{ title: "Agents", rows: [["aiand code", "a very long description here"]] }] },
      { theme: plainTheme(), columns: 30 },
    );
    assert.match(text, /aiand code\n/);
    assert.match(text, /a very long/);
  });

  test("never emits ANSI when the theme has no color", () => {
    const text = renderHome(model, { theme: plainTheme(), columns: 100 });
    assert.doesNotMatch(text, /\x1b\[/);
  });
});

describe("ui splash", () => {
  const makeStdin = () => ({
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    on() {},
    removeListener() {},
  });
  const makeStdout = (columns = 90) => {
    const chunks = [];
    return {
      isTTY: true,
      columns,
      write(chunk) {
        chunks.push(chunk);
        return true;
      },
      get text() {
        return chunks.join("");
      },
      get frames() {
        return chunks.length;
      },
    };
  };

  test("a non-TTY stdout renders the still mark, not the animation", async () => {
    const stdout = makeStdout();
    await playSplash({
      version: "1.0.0",
      stdin: makeStdin(),
      stdout: { ...stdout, isTTY: false },
    });
    assert.equal(stdout.frames, 1);
    assert.doesNotMatch(stdout.text, /\x1b\[\?1049h/);
    assert.match(stdout.text, /█/);
  });

  test("animation off renders the still wordmark and version", async () => {
    const stdout = makeStdout();
    await playSplash({ version: "9.9.9", stdin: makeStdin(), stdout, animation: false });
    assert.match(stdout.text, /█/);
    assert.match(stdout.text, /v9\.9\.9/);
  });

  test("NO_COLOR skips the alternate buffer entirely", async () => {
    const stdout = makeStdout();
    await withEnv({ NO_COLOR: "1" }, () =>
      playSplash({ version: "9.9.9", stdin: makeStdin(), stdout }),
    );
    assert.equal(stdout.frames, 1);
    assert.doesNotMatch(stdout.text, /\x1b\[\?1049h/);
  });

  test("NO_COLOR still prints the wordmark without color codes", async () => {
    const stdout = makeStdout();
    await withEnv({ NO_COLOR: "1" }, () =>
      playSplash({ version: "9.9.9", stdin: makeStdin(), stdout }),
    );
    assert.doesNotMatch(stdout.text, /\x1b\[[0-9;]*m/);
    assert.match(stdout.text, /█/);
  });

  test("a piped stdout still renders the still wordmark", async () => {
    const stdout = makeStdout();
    await playSplash({ version: "9.9.9", stdin: makeStdin(), stdout: { ...stdout, isTTY: false } });
    assert.match(stdout.text, /█/);
  });

  test("the animation runs the frame sequence and restores the terminal", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    let rawMode = false;
    stdin.setRawMode = (on) => {
      rawMode = on;
    };
    await withEnv({ NO_COLOR: undefined, FORCE_COLOR: "3" }, () =>
      playSplash({ version: "9.9.9", stdin, stdout }),
    );
    // Alt buffer entered, cursor hidden, then both restored on exit.
    assert.match(stdout.text, /\x1b\[\?1049h/);
    assert.match(stdout.text, /\x1b\[\?25l/);
    assert.match(stdout.text, /\x1b\[\?25h/);
    assert.match(stdout.text, /\x1b\[\?1049l/);
    const plain = stdout.text.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain, /press any key to skip/);
    assert.equal(rawMode, false, "raw mode restored");
    // opening + 7 run steps + 2 burst frames + the title = 11 clear-screen draws.
    const clears = stdout.text.split("\x1b[H\x1b[2J").length - 1;
    assert.equal(clears, 11, `expected 11 frames, got ${clears}`);
  });

  test("the runner and logo converge on the center columns", async () => {
    const stdout = makeStdout();
    await withEnv({ NO_COLOR: undefined, FORCE_COLOR: "3" }, () =>
      playSplash({ version: "9.9.9", stdin: makeStdin(), stdout, columns: 64 }),
    );
    const plain = stdout.text.replace(/\x1b\[[0-9;]*m/g, "");
    const frames = plain.split("\x1b[H\x1b[2J").slice(1);
    // The runner block starts at the left edge and the logo mark at the right.
    assert.match(frames[0] ?? "", / {2}██████ {10,}/u);
    // frames[0] is the opening, [1]..[7] the run steps, [8]..[9] the burst.
    assert.match(frames[7] ?? "", / {20,}██████/u);
  });

  test("the title splits white and brand red half and half", async () => {
    const stdout = makeStdout();
    await withEnv({ NO_COLOR: undefined, FORCE_COLOR: "3" }, () =>
      playSplash({ version: "9.9.9", stdin: makeStdin(), stdout }),
    );
    // White for the first word, ai& red for the second.
    assert.match(stdout.text, /\x1b\[38;2;255;255;255m/);
    assert.match(stdout.text, /\x1b\[38;2;199;0;7m/);
  });

  test("a keypress skips the remaining frames", async () => {
    const stdout = makeStdout();
    const listeners = [];
    const stdin = {
      isTTY: true,
      setRawMode() {},
      resume() {},
      pause() {},
      setEncoding() {},
      on(event, listener) {
        listeners.push([event, listener]);
      },
      removeListener() {},
    };
    const running = playSplash({ version: "9.9.9", stdin, stdout });
    // Keypresses resolve every hold immediately, so the run stays short.
    for (const [event, listener] of listeners) {
      if (event === "data") {
        queueMicrotask(() => listener("\r"));
        queueMicrotask(() => listener("\r"));
        queueMicrotask(() => listener("\r"));
      }
    }
    await running;
    assert.match(stdout.text, /█/);
    assert.ok(stdout.frames <= 11, `expected a short run, got ${stdout.frames}`);
  });
});

describe("ui links", () => {
  // Every terminal-sniffing var the link helpers read, cleared unless a test sets it.
  const CLEAR = {
    FORCE_HYPERLINK: undefined,
    TERM_PROGRAM: undefined,
    TERM: undefined,
    WT_SESSION: undefined,
    KONSOLE_VERSION: undefined,
    VTE_VERSION: undefined,
    NO_COLOR: undefined,
    FORCE_COLOR: undefined,
  };
  const withTerm = (changes, fn) => withEnv({ ...CLEAR, ...changes }, fn);
  const enabled = (isTTY) => hyperlinksEnabled({ stream: { isTTY }, env: process.env });

  test("hyperlinks disabled off-tty by default", async () => {
    await withTerm({}, () => assert.equal(enabled(false), false));
  });

  test("FORCE_HYPERLINK overrides both ways", async () => {
    await withTerm({ FORCE_HYPERLINK: "1" }, () => assert.equal(enabled(false), true));
    await withTerm({ FORCE_HYPERLINK: "0" }, () => assert.equal(enabled(true), false));
    await withTerm({ FORCE_HYPERLINK: "" }, () => assert.equal(enabled(true), false));
  });

  test("allowlist: WezTerm yes, plain xterm-256color no", async () => {
    await withTerm({ TERM_PROGRAM: "WezTerm", TERM: "xterm-256color" }, () =>
      assert.equal(enabled(true), true),
    );
    await withTerm({ TERM: "xterm-256color" }, () => assert.equal(enabled(true), false));
  });

  test("link returns plain URL off-tty and OSC-8-wrapped on a WezTerm tty", async () => {
    await withTerm({ TERM: "xterm-256color", NO_COLOR: "1" }, () => {
      assert.equal(
        link("https://example.com", { stream: { isTTY: false }, env: process.env }),
        "https://example.com",
      );
    });
    await withTerm({ TERM_PROGRAM: "WezTerm", TERM: "xterm-256color", NO_COLOR: "1" }, () => {
      assert.equal(
        link("https://example.com", { stream: { isTTY: true }, env: process.env }),
        "\x1b]8;;https://example.com\x1b\\https://example.com\x1b]8;;\x1b\\",
      );
    });
  });
});

describe("aiand welcome command", () => {
  test("prints the animated splash on a replay (hidden command, not in help)", async () => {
    const { code, stdout } = await cli(["welcome"]);
    assert.equal(code, 0);
    // The splash ends on the block-glyph wordmark, not the retired banner art.
    assert.match(stdout, /█/);
    assert.doesNotMatch(stdout, /█████████/);
  });

  test("is not listed in aiand help", async () => {
    const { code, stdout } = await cli(["help"]);
    assert.equal(code, 0);
    // The home screen names the brand and its tagline.
    assert.match(stdout, /aiand/);
    assert.match(stdout, /Agents and inference\./);
    // The Commands section must not advertise the hidden welcome verb.
    const commandsBlock = stdout.slice(stdout.indexOf("Commands"));
    assert.doesNotMatch(commandsBlock, /^\s*welcome\b/m);
  });

  test("bare help renders the home screen with sections", async () => {
    const { code, stdout } = await cli(["help"]);
    assert.equal(code, 0);
    assert.match(stdout, /Agents\n/);
    assert.match(stdout, /Commands\n/);
    assert.match(stdout, /Get started\n/);
  });

  test("--version prints only the version", async () => {
    const { code, stdout } = await cli(["--version"]);
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /█/);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  });
});
