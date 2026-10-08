import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  assertNoLegacyAiand,
  buildHermesWrites,
  hasHermesMarker,
  hasLegacyAiandEntry,
  hasProviderAiand,
  hermesReasoningLevels,
  INVALID_CONFIG_HINT,
  pinHermesModel,
  pinHermesProvider,
  readModelField,
  readProviderField,
  restoreHermesModelLine,
  setHermesModelProvider,
  stripHermesProvider,
} from "../dist/agents/hermes/routing.js";
import {
  aiandBlockSpan,
  modelScalar,
  parseDoubleQuoted,
  sectionRange,
  splitYamlLines,
} from "../dist/agents/hermes/yaml.js";
import { CliError } from "../dist/cli/errors.js";

// Pure routing bytes: no temp homes, no env isolation needed.

describe("column-0 comment inside a block", () => {
  test("pin rewrites the child in place, comment preserved", () => {
    const seed = 'model:\n# divider at column 0\n  provider: "auto"\n  default: "user-model"\n';
    const pinned = pinHermesModel(seed, "m-1");
    assert.equal(pinned, 'model:\n# divider at column 0\n  provider: aiand\n  default: "m-1"\n');
  });

  test("delete under a column-0 comment keeps parent key + comment + sibling", () => {
    const seed = 'model:\n# divider at column 0\n  provider: aiand\n  default: "m-1"\n';
    const out = restoreHermesModelLine(seed, "default", undefined);
    assert.equal(out, "model:\n# divider at column 0\n  provider: aiand\n");
  });

  test("provider pin preserves a column-0 comment inside providers:", () => {
    const seed = "providers:\n# divider at column 0\n  other:\n    k: v\n";
    const pinned = pinHermesProvider(seed, "https://api.aiand.com", "m-1");
    assert.ok(pinned.includes("# divider at column 0"), "comment kept");
    assert.ok(pinned.includes("  aiand:"), "block added");
    assert.ok(pinned.includes("  other:\n    k: v"), "sibling kept");
  });
});
describe("YAML-only double-quote escapes", () => {
  test("YAML-only escapes decode", () => {
    assert.equal(parseDoubleQuoted('"\\x41"'), "A");
    assert.equal(parseDoubleQuoted('"\\u00ff"').codePointAt(0), 0xff);
    assert.equal(parseDoubleQuoted('"\\U0001F600"').codePointAt(0), 0x1f600);
    assert.equal(parseDoubleQuoted('"\\a"').codePointAt(0), 0x07);
    assert.equal(parseDoubleQuoted('"\\N"').codePointAt(0), 0x85);
    assert.equal(parseDoubleQuoted('"x\\_y"').codePointAt(1), 0xa0);
    assert.equal(parseDoubleQuoted('"x\\Lz"').codePointAt(1), 0x2028);
    assert.equal(parseDoubleQuoted('"\\t"'), "\t");
  });

  test("bad escape and unterminated quote throw", () => {
    assert.throws(() => parseDoubleQuoted('"x\\qy"'), SyntaxError);
    assert.throws(() => parseDoubleQuoted('"unterminated'), SyntaxError);
  });

  test("reads decode YAML escapes through the edit functions", () => {
    const text =
      'providers:\n  aiand:\n    base_url: "https://a.com/x\\_y"\n    managed_by: "aiand"\n';
    assert.equal(readProviderField(text, "base_url").codePointAt("https://a.com/x".length), 0xa0);
  });
});

describe("empty flow containers", () => {
  test("inline providers: {} takes the block", () => {
    const pinned = pinHermesProvider("providers: {}\n", "https://api.aiand.com", "m-1");
    assert.equal(pinned.includes("{}"), false);
    assert.match(pinned, /^providers:\n {2}aiand:/m);
    assert.equal(hasHermesMarker(pinned), true);
    assert.equal(readProviderField(pinned, "base_url"), "https://api.aiand.com");
  });

  test("lone {} line under providers: drops the line and takes the block", () => {
    const pinned = pinHermesProvider("providers:\n  {}\n", "https://api.aiand.com", "m-1");
    assert.equal(pinned.includes("{}"), false);
    assert.match(pinned, /^providers:\n {2}aiand:/m);
    assert.equal(hasHermesMarker(pinned), true);
  });

  test("inline model: {} takes the pinned provider", () => {
    const pinned = pinHermesModel("model: {}\n", "m-1");
    assert.equal(pinned.includes("{}"), false);
    assert.equal(readModelField(pinned, "provider"), "aiand");
    assert.equal(readModelField(pinned, "default"), "m-1");
  });

  test("removal round-trips through the read path", () => {
    const pinned = pinHermesProvider("providers: {}\n", "https://api.aiand.com", "m-1");
    const stripped = stripHermesProvider(pinned);
    assert.equal(hasHermesMarker(stripped), false);
    const repinned = pinHermesProvider(
      stripped === "" ? "" : stripped,
      "https://api.aiand.com",
      "m-1",
    );
    assert.equal(hasHermesMarker(repinned), true);
    const modelPinned = pinHermesModel("model: {}\n", "m-1");
    const modelRemoved = restoreHermesModelLine(modelPinned, "default", undefined);
    assert.equal(readModelField(modelRemoved, "default"), undefined);
    assert.equal(readModelField(modelRemoved, "provider"), "aiand");
  });
});

describe("block-scalar guard", () => {
  test("set over a multi-line default refuses", () => {
    assert.throws(
      () => pinHermesModel("model:\n  default: |\n    keep me\n", "m-1"),
      (error) => error instanceof CliError && /multi-line/.test(error.message),
    );
    assert.throws(
      () => pinHermesModel("model:\n  default: >-\n    folded text\n", "m-1"),
      (error) => error instanceof CliError && /multi-line/.test(error.message),
    );
  });

  test("delete over a multi-line default refuses", () => {
    assert.throws(
      () =>
        restoreHermesModelLine(
          'model:\n  provider: "aiand"\n  default: |\n    keep me\n',
          "default",
          undefined,
        ),
      (error) => error instanceof CliError && /multi-line/.test(error.message),
    );
  });

  test("a block-scalar default reads undefined, not its body", () => {
    assert.equal(readModelField("model:\n  default: |\n    literal text\n", "default"), undefined);
  });
});

describe("trailing comments survive every edit", () => {
  test("providers: header comment survives the pin", () => {
    const pinned = pinHermesProvider(
      "providers:  # note\n  other:\n    k: v\n",
      "https://x",
      "m-1",
    );
    assert.ok(pinned.includes("# note"), "header comment kept");
    assert.ok(pinned.includes("  aiand:"), "block added");
  });

  test("model: header comment survives the pin", () => {
    const pinned = pinHermesModel('model:  # note\n  provider: "auto"\n', "m-1");
    assert.ok(pinned.includes("# note"), "header comment kept");
    assert.match(pinned, /provider: aiand/);
  });

  test("provider child comment survives the rewrite", () => {
    const pinned = pinHermesModel('model:\n  provider: auto  # keep me\n  default: "u"\n', "m-1");
    assert.ok(pinned.includes("provider: aiand  # keep me"), "provider comment kept");
  });

  test("dropped default comment rides onto the fresh pin", () => {
    const pinned = pinHermesModel('model:\n  provider: auto\n  default: "u"  # keep\n', "m-1");
    assert.ok(pinned.includes('default: "m-1"  # keep'), "default comment carried");
  });

  test("setHermesModelProvider keeps the provider comment", () => {
    const out = setHermesModelProvider("model:\n  provider: auto  # keep\n  default: u\n");
    assert.ok(out.includes("provider: aiand  # keep"), "provider comment kept");
    assert.ok(out.includes("model:"), "header kept");
  });

  test("reads ignore trailing comments", () => {
    assert.equal(
      readProviderField(
        'providers:\n  aiand:\n    base_url: "https://x"  # note\n    managed_by: "aiand"  # note\n',
        "base_url",
      ),
      "https://x",
    );
    assert.equal(hasHermesMarker('providers:\n  aiand:\n    managed_by: "aiand"  # note\n'), true);
    assert.equal(readModelField("model:\n  provider: aiand  # keep\n", "provider"), "aiand");
    assert.equal(readModelField('model:\n  default: "u"  # keep\n', "default"), "u");
  });

  test("a quoted hash is data, not a comment", () => {
    assert.equal(readModelField('model:\n  default: "a#b"\n', "default"), "a#b");
    const pinned = pinHermesModel('model:\n  provider: auto\n  default: "a#b"\n', "m-1");
    assert.ok(pinned.includes('default: "m-1"'), "pin replaces the quoted value");
  });
});

describe("commented section headers still read as mappings", () => {
  test("sectionRange: providers: with a trailing comment spans the body", () => {
    const lines = ["providers:  # keep providers", "  other:", "    k: v"];
    assert.deepEqual(sectionRange(lines, "providers"), { at: 0, end: 3 });
  });

  test("sectionRange: model: with a trailing comment spans the body", () => {
    const lines = ["model:  # keep model", '  provider: "auto"'];
    assert.deepEqual(sectionRange(lines, "model"), { at: 0, end: 2 });
  });

  test("sectionRange: a scalar value with a comment is still a scalar", () => {
    assert.deepEqual(sectionRange(['model: ""  # fresh sentinel'], "model"), { at: 0, end: 1 });
    assert.deepEqual(sectionRange(["model:"], "model"), { at: 0, end: 1 });
  });

  test("modelScalar: a commented bare header is not a scalar", () => {
    assert.equal(modelScalar("model:  # keep\n  provider: aiand\n"), undefined);
    assert.equal(modelScalar('model: ""  # fresh sentinel\n'), "");
  });

  test("aiandBlockSpan and the readers survive a commented providers: header", () => {
    const text =
      'providers:  # keep providers\n  aiand:\n    base_url: "https://x"\n    managed_by: "aiand"\n';
    const span = aiandBlockSpan(text.split("\n"));
    assert.ok(span !== null, "block found");
    assert.equal(readProviderField(text, "base_url"), "https://x");
    assert.equal(hasHermesMarker(text), true);
  });

  test("readModelField survives a commented model: header", () => {
    const text = 'model:  # keep model\n  provider: aiand\n  default: "m-1"\n';
    assert.equal(readModelField(text, "provider"), "aiand");
    assert.equal(readModelField(text, "default"), "m-1");
  });
});

describe("empty sequence and sequence bodies refuse", () => {
  for (const seed of ["providers: []\n", "providers:\n  []\n"]) {
    test(`lone [] refuses: ${JSON.stringify(seed)}`, () => {
      assert.throws(
        () => pinHermesProvider(seed, "https://x", "m-1"),
        (error) =>
          error instanceof CliError &&
          error.hint === INVALID_CONFIG_HINT &&
          /sequence/.test(error.message),
      );
    });
  }

  test("sequence-shaped providers: refuses with the shared hint", () => {
    assert.throws(
      () => pinHermesProvider("providers:\n  - a\n  - b\n", "https://x", "m-1"),
      (error) =>
        error instanceof CliError &&
        error.hint === INVALID_CONFIG_HINT &&
        /sequence/.test(error.message),
    );
  });

  for (const seed of ["model: []\n", "model:\n  []\n", "model:\n  - a\n  - b\n"]) {
    test(`model sequence refuses: ${JSON.stringify(seed)}`, () => {
      assert.throws(
        () => pinHermesModel(seed, "m-1"),
        (error) => error instanceof CliError && error.hint === INVALID_CONFIG_HINT,
      );
    });
  }
});

describe("legacy custom_providers list", () => {
  // #17: upstream once read a legacy list; aiand only writes the dict, so an
  // entry naming aiand counts as presence and refuses the dict write instead
  // of gaining a duplicate block beside it.
  test("list entries count by name: or id:, dict absent", () => {
    assert.equal(
      hasProviderAiand("custom_providers:\n  - name: aiand\n    base_url: https://x\n"),
      true,
    );
    assert.equal(hasProviderAiand("custom_providers:\n  - id: aiand\n"), true);
    assert.equal(hasProviderAiand("custom_providers:\n  - name: other\n"), false);
    // A legacy entry carries no stamp.
    assert.equal(
      hasHermesMarker("custom_providers:\n  - name: aiand\n    managed_by: aiand\n"),
      false,
    );
  });

  test("column-0 list items count (PyYAML block-sequence style)", () => {
    assert.equal(
      hasProviderAiand("custom_providers:\n- name: aiand\n  base_url: https://x\n"),
      true,
    );
    assert.equal(hasProviderAiand("custom_providers:\n- name: other\n"), false);
    assert.throws(
      () => pinHermesProvider("custom_providers:\n- name: aiand\n", "https://api.aiand.com", "m"),
      (error) => error instanceof CliError && /custom_providers/.test(error.message),
    );
  });

  test("plain-string entries count (bare and quoted)", () => {
    assert.equal(hasProviderAiand("custom_providers:\n  - aiand\n"), true);
    assert.equal(hasProviderAiand('custom_providers:\n  - "aiand"\n'), true);
    assert.equal(hasProviderAiand("custom_providers:\n  - other\n"), false);
  });

  test("a deeper nested aiand: key is not the entry", () => {
    const text = "custom_providers:\n  - name: other\n    nested:\n      aiand: nope\n";
    assert.equal(hasProviderAiand(text), false);
    assert.equal(hasLegacyAiandEntry(text), false);
  });

  test("a non-aiand list leaves the pin alone", () => {
    const pinned = pinHermesProvider(
      "custom_providers:\n  - name: other\n",
      "https://api.aiand.com",
      "m",
    );
    assert.ok(pinned.includes("  aiand:"), "dict block added");
    assert.ok(pinned.includes("- name: other"), "legacy list kept");
  });

  test("assertNoLegacyAiand is the pin path's own guard", () => {
    // #17: the exported guard throws on a foreign entry and passes a
    // clean file, so the pin path never splices beside a legacy block.
    assert.throws(
      () => assertNoLegacyAiand(splitYamlLines("custom_providers:\n  - aiand\n").lines),
      (error) => error instanceof CliError && /custom_providers/.test(error.message),
    );
    assert.doesNotThrow(() => assertNoLegacyAiand(splitYamlLines("theme: dark\n").lines));
  });
});

describe("CRLF config.yaml", () => {
  // #17: `$`-anchored parses fail on lines ending in \r, so the split
  // strips the EOL and the join restores it — every edited line keeps the
  // file's endings instead of mixing LF into a CRLF file.
  const crlf = (body) => body.replace(/\n/g, "\r\n");

  test("a marked CRLF config probes active and reads fields", () => {
    const text = crlf(
      [
        "providers:",
        "  aiand:",
        '    base_url: "https://api.aiand.com"',
        "    key_env: AIAND_HERMES_API_KEY",
        '    managed_by: "aiand"',
        "",
      ].join("\n"),
    );
    assert.equal(hasHermesMarker(text), true);
    assert.equal(hasProviderAiand(text), true);
    assert.equal(readProviderField(text, "base_url"), "https://api.aiand.com");
  });

  test("a marked CRLF config strips to CRLF bytes", () => {
    const text = crlf('theme: dark\nproviders:\n  aiand:\n    managed_by: "aiand"\n');
    assert.equal(stripHermesProvider(text), "theme: dark\r\n");
  });

  test("pin on a CRLF file yields CRLF lines and round-trips", () => {
    const pinned = pinHermesProvider("theme: dark\r\n", "https://api.aiand.com", "m-1");
    const lines = pinned.split("\n");
    // Every terminated line ends with \r — no bare LF crept in.
    assert.ok(lines.slice(0, -1).every((line) => line.endsWith("\r")));
    assert.equal(stripHermesProvider(pinned), "theme: dark\r\n");
  });
});

describe("reasoning levels", () => {
  test("keeps published levels and drops null/empty ones", () => {
    const levels = hermesReasoningLevels([
      { id: "a/model", reasoning_efforts: ["low", "high"] },
      { id: "b/model", reasoning_efforts: null },
      { id: "c/model", reasoning_efforts: [] },
    ]);
    assert.deepEqual([...levels], [["a/model", ["low", "high"]]]);
    assert.equal(levels.has("b/model"), false);
    assert.equal(levels.has("c/model"), false);
  });

  test("an empty catalog yields an empty map", () => {
    assert.equal(hermesReasoningLevels([]).size, 0);
  });

  test("insertion order never leaks into the rendered literal", () => {
    // The generated file's bytes must be stable for the same catalog, so the
    // builder sorts keys itself instead of trusting Map insertion order.
    const render = (entries) =>
      buildHermesWrites({
        apiKey: "sk-test-levels",
        baseUrl: "https://api.aiand.com/v1",
        model: undefined,
        reasoningLevels: new Map(entries),
        envText: "",
        configText: "",
      }).initPy;
    const forward = render([
      ["zai-org/glm-5.3", ["low", "high", "max"]],
      ["other/model", ["low", "high"]],
    ]);
    const reverse = render([
      ["other/model", ["low", "high"]],
      ["zai-org/glm-5.3", ["low", "high", "max"]],
    ]);
    const line = (initPy) => initPy.split("\n").find((l) => l.startsWith("AIAND_REASONING_LEVELS"));
    assert.equal(
      line(forward),
      'AIAND_REASONING_LEVELS = {"other/model":["low","high"],"zai-org/glm-5.3":["low","high","max"]}',
    );
    assert.equal(line(reverse), line(forward));
  });
});
