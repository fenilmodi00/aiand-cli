import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const bin = join(root, "..", "dist", "index.js");

const { BRAND } = await import("../dist/cli/ui/theme.js");
const { colorsEnabled } = await import("../dist/cli/ui/color.js");
const { loadBannerArt, printBanner } = await import("../dist/cli/ui/banner.js");
const { stripBannerMarkup, normalizeBannerArt } = await import(
  "../dist/cli/ui/banner-render.js"
);
const { sanitize } = await import("../dist/cli/ui/sanitize.js");
const { hyperlinksEnabled, link } = await import("../dist/cli/links.js");
const { _setColorEnabled, symbols, isStyleEnabled, check, paint } = await import(
  "../dist/cli/output.js"
);

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bin, ...args], {
      env: { ...process.env, NO_COLOR: "1", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("ui tokens", () => {
  test("exports ai& brand reds from the site palette", () => {
    assert.equal(BRAND.red, "#C70007");
    assert.equal(BRAND.glow, "#D84D51");
    assert.equal(BRAND.deep, "#7B0004");
    assert.equal(BRAND.mid, "#A30006");
    assert.equal(BRAND.rose, "#B19A9C");
  });
});

describe("ui color", () => {
  test("disables color when NO_COLOR is set", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      assert.equal(colorsEnabled({ isTTY: true }), false);
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  test("enables color when FORCE_COLOR is set on a non-tty stream", () => {
    const prevNo = process.env.NO_COLOR;
    const prevForce = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      assert.equal(colorsEnabled({ isTTY: false }), true);
    } finally {
      if (prevNo === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNo;
      if (prevForce === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prevForce;
    }
  });

  test("disables color on non-tty streams by default", () => {
    const prevNo = process.env.NO_COLOR;
    const prevForce = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    try {
      assert.equal(colorsEnabled({ isTTY: false }), false);
    } finally {
      if (prevNo === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNo;
      if (prevForce === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prevForce;
    }
  });
});

describe("ui banner", () => {
  test("loads banner art within 80 columns", () => {
    const art = loadBannerArt();
    assert.ok(art.length > 0);
    for (const line of normalizeBannerArt(art).split("\n")) {
      const width = stripBannerMarkup(line).length;
      assert.ok(width <= 80, `line exceeds 80 cols: ${width} — ${stripBannerMarkup(line)}`);
    }
  });

  test("includes the logo slash mark, brand markup, and Wire any agent tagline", () => {
    const art = loadBannerArt();
    const plain = stripBannerMarkup(art);
    assert.match(art, /\{brand\}/);
    assert.match(plain, /█████/);
    assert.match(plain, /Wire any agent/);
  });

  test("prints plain banner art without ANSI when NO_COLOR is set", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    const chunks = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      printBanner({ version: "0.0.0-test" });
      const output = chunks.join("");
      assert.match(output, /█████/);
      assert.match(output, /Wire any agent/);
      assert.match(output, /v0\.0\.0-test/);
      assert.doesNotMatch(output, /\x1b\[/);
    } finally {
      process.stdout.write = originalWrite;
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  test("prints nothing when successOnly is set", () => {
    const chunks = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      printBanner({ version: "0.0.0-test", successOnly: true });
      assert.equal(chunks.join(""), "");
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});

describe("ui normalize", () => {
  test("strips the shared leading indent, keeping relative indentation", () => {
    assert.equal(normalizeBannerArt("  a\n    b\n"), "a\n  b\n");
  });

  test("turns blank lines into empty strings", () => {
    assert.equal(normalizeBannerArt("a\n\nb\n"), "a\n\nb\n");
  });

  test("keeps leading spaces before logo blocks on the first art line", () => {
    const first = stripBannerMarkup(normalizeBannerArt(loadBannerArt()).split("\n")[0]);
    assert.match(first, /^ +/);
  });
});

describe("ui sanitize", () => {
  test("OSC-8 hyperlink keeps only the visible link text", () => {
    const input = "\x1b]8;;https://example.com\x1b\\openai\x1b]8;;\x1b\\";
    assert.equal(sanitize(input), "openai");
  });

  test("strips SGR sequences", () => {
    assert.equal(sanitize("\x1b[31mred\x1b[39m"), "red");
  });

  test("strips ESC-letter controls but not bare ESC+c", () => {
    assert.equal(sanitize("a\u001bMb"), "ab");
    // \u001bc (ESC c — terminal reset) is intentionally NOT stripped by design.
    assert.equal(sanitize("a\u001bcb"), "acb");
  });

  test("keeps unicode content", () => {
    assert.equal(sanitize("héllo ✓"), "héllo ✓");
  });

  test("coerces null, undefined, and numbers", () => {
    assert.equal(sanitize(null), "");
    assert.equal(sanitize(undefined), "");
    assert.equal(sanitize(123), "123");
  });
});

describe("ui style extras", () => {
  test("check paints a cyan glyph when styled, plain glyph otherwise", () => {
    const prev = isStyleEnabled();
    try {
      _setColorEnabled(false);
      assert.equal(check({ isTTY: false }), symbols.ok);
      _setColorEnabled(true);
      assert.equal(check({ isTTY: false }), `\x1b[36m${symbols.ok}\x1b[39m`);
    } finally {
      _setColorEnabled(prev);
    }
  });

  test("paint wraps with reset on tty, passthrough off-tty", () => {
    const saved = {
      prev: isStyleEnabled(),
      no: process.env.NO_COLOR,
      force: process.env.FORCE_COLOR,
      term: process.env.TERM,
    };
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    process.env.TERM = "xterm-256color";
    try {
      // paint reads process.env via colorsEnabled(): no tty -> passthrough.
      assert.equal(paint("\x1b[31m", "hi", { isTTY: false }), "hi");
      _setColorEnabled(true);
      try {
        assert.equal(paint("\x1b[31m", "hi", { isTTY: true }), "\x1b[31mhi\x1b[0m");
        assert.equal(paint("\x1b[31m", "hi", { isTTY: false }), "hi");
      } finally {
        _setColorEnabled(saved.prev);
      }
    } finally {
      if (saved.no === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = saved.no;
      if (saved.force === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved.force;
      if (saved.term === undefined) delete process.env.TERM;
      else process.env.TERM = saved.term;
    }
  });
});

describe("ui links", () => {
  const H_ENV = [
    "FORCE_HYPERLINK",
    "TERM_PROGRAM",
    "TERM",
    "WT_SESSION",
    "KONSOLE_VERSION",
    "VTE_VERSION",
    "NO_COLOR",
    "FORCE_COLOR",
  ];

  function withEnv(changes, fn) {
    const prev = {};
    for (const key of H_ENV) prev[key] = process.env[key];
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return fn();
    } finally {
      for (const key of H_ENV) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  }

  test("hyperlinks disabled off-tty by default", () => {
    withEnv({ FORCE_HYPERLINK: undefined }, () => {
      assert.equal(hyperlinksEnabled({ stream: { isTTY: false }, env: process.env }), false);
    });
  });

  test("FORCE_HYPERLINK overrides both ways", () => {
    withEnv({ FORCE_HYPERLINK: "1" }, () => {
      assert.equal(hyperlinksEnabled({ stream: { isTTY: false }, env: process.env }), true);
    });
    withEnv({ FORCE_HYPERLINK: "0" }, () => {
      assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: process.env }), false);
    });
    withEnv({ FORCE_HYPERLINK: "" }, () => {
      assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: process.env }), false);
    });
  });

  test("allowlist: WezTerm yes, plain xterm-256color no", () => {
    withEnv(
      {
        FORCE_HYPERLINK: undefined,
        TERM_PROGRAM: "WezTerm",
        TERM: "xterm-256color",
        WT_SESSION: undefined,
        KONSOLE_VERSION: undefined,
        VTE_VERSION: undefined,
      },
      () => {
        assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: process.env }), true);
      }
    );
    withEnv(
      {
        FORCE_HYPERLINK: undefined,
        TERM_PROGRAM: undefined,
        TERM: "xterm-256color",
        WT_SESSION: undefined,
        KONSOLE_VERSION: undefined,
        VTE_VERSION: undefined,
      },
      () => {
        assert.equal(hyperlinksEnabled({ stream: { isTTY: true }, env: process.env }), false);
      }
    );
  });

  test("link returns plain URL off-tty and OSC-8-wrapped on a WezTerm tty", () => {
    withEnv(
      {
        FORCE_HYPERLINK: undefined,
        TERM_PROGRAM: undefined,
        TERM: "xterm-256color",
        WT_SESSION: undefined,
        KONSOLE_VERSION: undefined,
        VTE_VERSION: undefined,
        NO_COLOR: "1",
        FORCE_COLOR: undefined,
      },
      () => {
        assert.equal(
          link("https://example.com", { stream: { isTTY: false }, env: process.env }),
          "https://example.com"
        );
      }
    );
    withEnv(
      {
        FORCE_HYPERLINK: undefined,
        TERM_PROGRAM: "WezTerm",
        TERM: "xterm-256color",
        WT_SESSION: undefined,
        KONSOLE_VERSION: undefined,
        VTE_VERSION: undefined,
        NO_COLOR: "1",
        FORCE_COLOR: undefined,
      },
      () => {
        assert.equal(
          link("https://example.com", { stream: { isTTY: true }, env: process.env }),
          "\x1b]8;;https://example.com\x1b\\https://example.com\x1b]8;;\x1b\\"
        );
      }
    );
  });
});

describe("aiand banner command", () => {
  test("prints banner art (hidden command, not in help)", async () => {
    const { code, stdout } = await runCli(["banner"]);
    assert.equal(code, 0);
    assert.match(stdout, /█████/);
    assert.match(stdout, /Wire any agent/);
  });

  test("is not listed in aiand help", async () => {
    const { code, stdout } = await runCli(["help"]);
    assert.equal(code, 0);
    assert.match(stdout, /Wire any agent/);
    // The Commands section must not advertise the hidden banner verb.
    const commandsBlock = stdout.slice(stdout.indexOf("Commands"));
    assert.doesNotMatch(commandsBlock, /^\s*banner\b/m);
  });

  test("bare --help includes the banner", async () => {
    const { code, stdout } = await runCli(["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /Wire any agent/);
    assert.match(stdout, /the ai& command line interface/);
  });

  test("--version does not print the banner", async () => {
    const { code, stdout } = await runCli(["--version"]);
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /Wire any agent/);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  });
});
