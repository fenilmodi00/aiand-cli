import assert from "node:assert/strict";
import test, { describe } from "node:test";

const { table, sparkline, delta, relativeTime, num, style, isStyleEnabled, _setColorEnabled } =
  await import("../dist/cli/output.js");

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
  // out() writes EOL, which is \r\n on Windows: normalize so assertions
  // see the same lines on every platform.
  return lines.join("").replaceAll("\r\n", "\n").split("\n").filter(Boolean);
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
