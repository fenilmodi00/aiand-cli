import assert from "node:assert/strict";
import test, { describe } from "node:test";

const {
  table,
  sparkline,
  delta,
  relativeTime,
  num,
  style,
  isStyleEnabled,
  _setColorEnabled,
  clipToWidth,
  spinner,
  out,
} = await import("../dist/cli/output.js");

function capture(fn) {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  // `out()` appends os.EOL, so on win32 every row ends "\r\n": drop the CR
  // before splitting, or each row's measured width is one column too wide.
  return lines.join("").replace(/\r\n/g, "\n").split("\n").filter(Boolean);
}

function columns(s) {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let n = 0;
  for (const { segment } of new Intl.Segmenter().segment(plain)) {
    const cp = segment.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f000 && /\p{Extended_Pictographic}/u.test(segment)) ||
      segment.includes("️");
    n += wide ? 2 : 1;
  }
  return n;
}

describe("table", () => {
  test("aligns a column across ASCII, CJK, and emoji cells", () => {
    const rows = [
      { name: "Acme", id: "org_1" },
      { name: "株式会社テスト", id: "org_2" },
      { name: "emoji 🚀 org", id: "org_3" },
      { name: "café", id: "org_4" },
    ];
    const lines = capture(() =>
      table(rows, [
        { header: "name", value: (r) => r.name },
        { header: "id", value: (r) => r.id },
      ]),
    );

    const starts = lines.map((line) => columns(line.slice(0, line.indexOf("org_"))));
    const header = columns(lines[0].slice(0, lines[0].indexOf("ID")));
    for (const start of starts.slice(1)) {
      assert.equal(start, header, `misaligned row in:\n${lines.join("\n")}`);
    }
  });

  test("right-aligns numeric columns on their last character", () => {
    const rows = [{ n: "1" }, { n: "1000" }];
    const lines = capture(() => table(rows, [{ header: "n", value: (r) => r.n, align: "right" }]));
    assert.deepEqual(
      lines.slice(1).map((l) => columns(l)),
      [4, 4],
    );
  });

  test("renders nothing for no rows, rather than a bare header", () => {
    assert.deepEqual(
      capture(() => table([], [{ header: "x", value: () => "" }])),
      [],
    );
  });

  test("omits the header row when every header is blank", () => {
    const lines = capture(() => table([{ a: "1" }], [{ header: "", value: (r) => r.a }]));
    assert.deepEqual(lines, ["1"]);
  });
});

describe("sparkline", () => {
  test("is one glyph per value", () => {
    assert.equal([...sparkline([1, 2, 3, 4])].length, 4);
  });

  test("survives an all-zero series without dividing by zero", () => {
    assert.equal(sparkline([0, 0, 0]), "▁▁▁");
  });

  test("is empty for no data", () => {
    assert.equal(sparkline([]), "");
  });
});

describe("delta", () => {
  test("reports direction against a baseline", () => {
    assert.match(delta(150, 100), /\+50\.0%/);
    assert.match(delta(50, 100), /-50\.0%/);
  });

  test("does not divide by a zero baseline", () => {
    assert.match(delta(10, 0), /new/);
    assert.doesNotMatch(delta(0, 0), /%/);
  });
});

describe("relativeTime", () => {
  test("scales the unit to the age", () => {
    const ago = (ms) => relativeTime(new Date(Date.now() - ms).toISOString());
    assert.match(ago(5_000), /^\d+s ago$/);
    assert.match(ago(300_000), /^\d+m ago$/);
    assert.match(ago(7_200_000), /^\d+h ago$/);
    assert.match(ago(172_800_000), /^\d+d ago$/);
  });

  test("passes through an unparseable value instead of printing NaN", () => {
    assert.equal(relativeTime("not a date"), "not a date");
  });
});

describe("num", () => {
  test("groups thousands", () => {
    assert.equal(num(1234567), "1,234,567");
  });
});

describe("style", () => {
  test("is a no-op when stdout is not a TTY, so piped output stays clean", () => {
    // Pin the disabled state: the module snapshots colorsEnabled() at import,
    // so an ambient FORCE_COLOR=1 would otherwise colorize this assert.
    const was = isStyleEnabled();
    _setColorEnabled(false);
    try {
      assert.equal(style.red("x"), "x");
    } finally {
      _setColorEnabled(was);
    }
  });
});

describe("clipToWidth", () => {
  test("returns the line unchanged when it already fits", () => {
    assert.equal(clipToWidth("short", 40), "short");
  });

  test("truncates with an ellipsis when it overflows", () => {
    const out = clipToWidth("a much longer line than the budget allows", 12);
    assert.ok(out.length < 40, `expected a short line, got ${JSON.stringify(out)}`);
    assert.match(out, /…$/);
  });

  test("counts a wide code point as two columns", () => {
    // "全" is two columns wide, so at a budget of 3 only one fits plus the
    // ellipsis, and the clip must not split it.
    const out = clipToWidth("全全全全", 3);
    assert.match(out, /…$/);
    assert.ok(visible(out) <= 3, `expected <=3 columns, got ${JSON.stringify(out)}`);
  });
});

describe("spinner", () => {
  test("a non-TTY stderr gets no frames and still prints the final line", async () => {
    const chunks = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    try {
      const spin = spinner("working");
      spin.stop("done");
    } finally {
      process.stderr.write = original;
      Object.defineProperty(process.stderr, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
    // No frame bytes, just the final line.
    assert.doesNotMatch(chunks.join(""), /⠋|⠙|⠹/);
    assert.match(chunks.join(""), /done/);
  });

  test("a TTY stderr gets frames, and stop clears them", async () => {
    const chunks = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    try {
      const spin = spinner("working");
      // One frame lands within the first tick interval.
      await new Promise((resolve) => setTimeout(resolve, 120));
      spin.stop();
    } finally {
      process.stderr.write = original;
      Object.defineProperty(process.stderr, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
    assert.match(chunks.join(""), /working/);
    assert.match(chunks.join(""), /\r\x1b\[2K/, "each frame clears the line first");
    assert.match(chunks.join(""), /\x1b\[\?25l/, "cursor hidden while spinning");
    assert.match(chunks.join(""), /\x1b\[\?25h/, "stop shows the cursor");
    assert.match(chunks.join(""), /2K/, "stop clears the line");
  });

  test("payload written during a spinner lands below it, spinner redraws after", async () => {
    const chunks = [];
    const originalErr = process.stderr.write;
    process.stderr.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    const originalOut = process.stdout.write;
    const outChunks = [];
    process.stdout.write = (chunk) => {
      outChunks.push(String(chunk));
      return true;
    };
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    try {
      const spin = spinner("working");
      await new Promise((resolve) => setTimeout(resolve, 120));
      out("payload");
      spin.stop();
    } finally {
      process.stderr.write = originalErr;
      process.stdout.write = originalOut;
      Object.defineProperty(process.stderr, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
    const stream = chunks.join("");
    // A frame ran, then the payload suspended the spinner: clear + newline.
    assert.match(stream, /\r\x1b\[2K\n/);
    // After that clear, exactly one frame redraw follows (before stop's clear).
    const afterPayload = stream.slice(stream.search(/\r\x1b\[2K\n/));
    const redraws = afterPayload
      .slice(0, afterPayload.lastIndexOf("\r\x1b[2K"))
      .match(/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/g);
    assert.equal(redraws.length, 1, "spinner redraws exactly once after the payload");
    // The spec reporter shares stdout, so only the payload's presence and
    // integrity can be asserted, not exclusive ownership of the stream.
    // out() terminates with EOL (\r\n on Windows), so match the payload text.
    assert.ok(
      outChunks.some((c) => c.startsWith("payload")),
      "payload printed on stdout, untouched",
    );
    assert.match(stream, /\x1b\[\?25h/, "stop shows the cursor");
  });
});

/** Visible width of a string, ignoring ANSI, for the clip assertions. */
const visible = (line) => line.replace(/\x1b\[[0-9;?]*m/g, "").length;
