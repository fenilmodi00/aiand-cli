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
const { printBanner } = await import("../dist/cli/ui/banner.js");
const { BANNER_ART } = await import("../dist/cli/ui/banners/art.js");
const { stripBannerMarkup, normalizeBannerArt } = await import(
  "../dist/cli/ui/banner-render.js"
);
const { hyperlinksEnabled, link } = await import("../dist/cli/links.js");

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
  test("banner art fits within 80 columns", () => {
    assert.ok(BANNER_ART.length > 0);
    for (const line of normalizeBannerArt(BANNER_ART).split("\n")) {
      const width = stripBannerMarkup(line).length;
      assert.ok(width <= 80, `line exceeds 80 cols: ${width} — ${stripBannerMarkup(line)}`);
    }
  });

  test("banner art is the ai& wordmark with brand markup and no tagline", () => {
    const plain = stripBannerMarkup(BANNER_ART);
    assert.match(BANNER_ART, /\{brand\}/);
    assert.match(plain, /█████████/);
    assert.match(plain, /█████░░█████░███/);
    assert.doesNotMatch(plain, /Wire any agent/);
  });

  test("prints plain banner art without ANSI when NO_COLOR is set", () => {
    const prev = process.env.NO_COLOR;
    const chunks = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      printBanner({ version: "0.0.0-test" });
      const output = chunks.join("");
      assert.match(output, /█████████/);
      assert.match(output, /█████░░█████░███/);
      assert.match(output, /v0\.0\.0-test/);
      assert.doesNotMatch(output, /\x1b\[/);
    } finally {
      process.stdout.write = originalWrite;
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
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

  test("keeps relative indentation on art lines after normalize", () => {
    const [first, second] = stripBannerMarkup(normalizeBannerArt(BANNER_ART))
      .split("\n");
    assert.match(first, /^\u2588/);
    assert.ok(second.startsWith("  "), "second line keeps its leading spaces");
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
    assert.match(stdout, /█████████/);
    assert.match(stdout, /█████░░█████░███/);
  });

  test("is not listed in aiand help", async () => {
    const { code, stdout } = await runCli(["help"]);
    assert.match(stdout, /█████░░█████░███/);
    // The Commands section must not advertise the hidden banner verb.
    const commandsBlock = stdout.slice(stdout.indexOf("Commands"));
    assert.doesNotMatch(commandsBlock, /^\s*banner\b/m);
  });

  test("bare --help includes the banner", async () => {
    const { code, stdout } = await runCli(["--help"]);
    assert.match(stdout, /█████░░█████░███/);
    assert.match(stdout, /the ai& command line interface/);
  });

  test("--version does not print the banner", async () => {
    const { code, stdout } = await runCli(["--version"]);
    assert.doesNotMatch(stdout, /█████░░█████░███/);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  });
});
