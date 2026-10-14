import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readEnvValue, renderHermesEnv, replaceEnvValue } from "../dist/agents/hermes/env.js";
import {
  assertNoLegacyAiand,
  buildHermesWrites,
  hasHermesMarker,
  hasLegacyAiandEntry,
  hasProviderAiand,
  hermesReasoningLevels,
  INVALID_CONFIG_HINT,
  modelFieldLine,
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

describe("inline flow maps and anchors refuse instead of destroying data", () => {
  // #17: `^providers\\s*:\\s*\\S` reads a flow map or an anchor header as a
  // scalar section, so the splice rewrote the header to a bare `providers:`
  // and dropped every provider the value carried — and a foreign flow-form
  // aiand block went undetected, so `on` appended a second one.
  const refuses = (run) =>
    assert.throws(
      run,
      (error) =>
        error instanceof CliError &&
        error.hint === INVALID_CONFIG_HINT &&
        /inline/.test(error.message),
    );

  for (const seed of [
    'providers: {openrouter: {api_key: "sk-x", base_url: "https://openrouter.ai/api/v1"}}\n',
    "providers: &base\n  openrouter:\n    api_key: sk-x\n",
  ]) {
    test(`pinHermesProvider refuses: ${JSON.stringify(seed)}`, () =>
      refuses(() => pinHermesProvider(seed, "https://x", "m-1")));
  }

  for (const seed of [
    'model: {provider: openrouter, default: "user-model"}\n',
    "model: &base\n  provider: openrouter\n",
  ]) {
    test(`pinHermesModel refuses: ${JSON.stringify(seed)}`, () =>
      refuses(() => pinHermesModel(seed, "m-1")));
  }

  test("setHermesModelProvider refuses a flow-map model:", () =>
    refuses(() => setHermesModelProvider("model: {provider: openrouter}\n")));

  test("stripHermesProvider refuses an anchored providers: header", () =>
    // Stripping it would drop `&base` and strand every `*base` alias in the file.
    refuses(() => stripHermesProvider('providers: &base\n  aiand:\n    managed_by: "aiand"\n')));

  test("a foreign flow-form aiand block reads as present, so on refuses", () => {
    const text = 'providers: {aiand: {base_url: "https://x/v1"}}\n';
    assert.equal(hasProviderAiand(text), true);
    refuses(() => pinHermesProvider(text, "https://x", "m-1"));
  });

  test("a nested aiand key under another provider is not our block", () => {
    // Only a key at the flow map's own level counts: a deeper `config:
    // {aiand: …}` is the other provider's own nested config.
    assert.equal(hasProviderAiand("providers: {openrouter: {config: {aiand: x}}}\n"), false);
  });

  test("PyYAML's empty `{}` sentinel is not an inline value: the splice still takes it", () => {
    const pinned = pinHermesProvider("providers: {}\n", "https://api.aiand.com", "m-1");
    assert.match(pinned, /^providers:\n {2}aiand:/m);
    const model = pinHermesModel("model: {}\n", "m-1");
    assert.equal(readModelField(model, "provider"), "aiand");
  });

  test("an anchored wired home still reads on, byte-identical", () => {
    // A Hermes re-dump can anchor the `providers:` map. Reading it as a
    // scalar section made a wired home report off, so a second `on` spliced
    // a duplicate block; reads must span the anchored body.
    const text =
      "providers: &base\n" +
      "  aiand:\n" +
      '    base_url: "https://api.aiand.com/v1"\n' +
      "    key_env: AIAND_HERMES_API_KEY\n" +
      '    managed_by: "aiand"\n' +
      "other:\n  <<: *base\n";
    assert.equal(hasProviderAiand(text), true);
    assert.equal(hasHermesMarker(text), true);
    assert.equal(readProviderField(text, "base_url"), "https://api.aiand.com/v1");
  });

  test("sectionRange spans an anchored header's body", () => {
    const lines = ["providers: &base", "  aiand:", "    k: v"];
    assert.deepEqual(sectionRange(lines, "providers"), { at: 0, end: 3 });
  });

  test("modelScalar: an anchor is not a scalar", () => {
    assert.equal(modelScalar("model: &a\n  provider: aiand\n"), undefined);
  });

  test("a flow-map model: never reads a mapping line back as a model id", () => {
    // The read echoed the flow text as `default`, so enable() believed it
    // had kept a user default it never saw.
    const text = 'model: {provider: openrouter, default: "user-model"}\n';
    assert.equal(readModelField(text, "default"), undefined);
    assert.equal(readModelField(text, "provider"), undefined);
    assert.equal(modelScalar(text), undefined);
    assert.equal(modelFieldLine(text, "default"), undefined);
  });

  test("a scalar model: sentinel still reads through the same path", () => {
    assert.equal(readModelField('model: "m-1"\n', "default"), "m-1");
    assert.equal(modelScalar('model: ""\n'), "");
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

describe("multi-line quoted .env values", () => {
  // #17: a dotenv value whose quote never closes on its own line continues
  // onto the next lines. Line-wise reads and strips truncated it to the
  // header, and a strip left the continuation stranded in the file.
  const MULTI = 'OTHER=keep\nAIAND_HERMES_API_KEY="abc\ndef"\n';

  test("readEnvValue returns the whole value, not its first line", () => {
    assert.equal(readEnvValue(MULTI, "AIAND_HERMES_API_KEY"), "abc\ndef");
  });

  test("a single-line quoted value still reads", () => {
    assert.equal(readEnvValue('K="abc"\n', "K"), "abc");
    assert.equal(readEnvValue("K=abc\n", "K"), "abc");
  });

  test("an absent or empty variable reads undefined", () => {
    assert.equal(readEnvValue(MULTI, "MISSING"), undefined);
    assert.equal(readEnvValue('K=""\n', "K"), undefined);
  });

  test("renderHermesEnv drops the whole multi-line value and keeps other lines", () => {
    const out = renderHermesEnv(MULTI, { apiKey: "sk-new", baseUrl: "https://x/v1" });
    assert.equal(
      out.text,
      'OTHER=keep\nAIAND_HERMES_API_KEY="sk-new"\nAIAND_HERMES_BASE_URL="https://x/v1"\n',
    );
    assert.deepEqual(out.droppedUserLines, []);
  });

  test("replaceEnvValue swaps the whole value without stranding the body", () => {
    assert.equal(
      replaceEnvValue(MULTI, "AIAND_HERMES_API_KEY", "sk-new"),
      'OTHER=keep\nAIAND_HERMES_API_KEY="sk-new"\n',
    );
  });

  test("a multi-line value under a kept key survives every edit untouched", () => {
    const text = 'KEEP="a\nb"\nAIAND_HERMES_API_KEY="x\ny"\nZ=1\n';
    assert.equal(
      replaceEnvValue(text, "AIAND_HERMES_API_KEY", "sk-new"),
      'KEEP="a\nb"\nAIAND_HERMES_API_KEY="sk-new"\nZ=1\n',
    );
  });

  test("a multi-line value under a kept key survives render too", () => {
    const out = renderHermesEnv('KEEP="a\nb"\nANTHROPIC_API_KEY="u\nv"\n', {
      apiKey: "sk-new",
      baseUrl: "https://x/v1",
    });
    assert.ok(out.text.includes('KEEP="a\nb"'), "user multi-line value kept");
    assert.ok(!out.text.includes("u\nv"), "shadowed ANTHROPIC line gone, body included");
    // The dropped report names the header, the way enable() warns about it.
    assert.deepEqual(out.droppedUserLines, ['ANTHROPIC_API_KEY="u']);
  });
});

describe("stale model.base_url is dropped when routing through aiand", () => {
  // A fresh Hermes install copies cli-config.yaml.example, whose model
  // section carries an active OpenRouter base_url. Hermes's
  // _api_key_provider_runtime prefers model.base_url over the provider's own
  // endpoint whenever model.provider matches, so the line must go or the
  // ai& key is sent to OpenRouter (401 "Missing Authentication header").
  const SEED =
    "theme: dark\n" +
    "model:  # keep the section\n" +
    "  # provider pick\n" +
    '  provider: "auto"\n' +
    '  base_url: "https://openrouter.ai/api/v1"\n' +
    "  api_mode: chat_completions\n" +
    "  temperature: 0.4\n" +
    '  default: "user-model"\n';

  test("pinHermesModel drops it and keeps every other line", () => {
    const pinned = pinHermesModel(SEED, "m-1");
    assert.equal(
      pinned,
      "theme: dark\n" +
        "model:  # keep the section\n" +
        "  # provider pick\n" +
        "  provider: aiand\n" +
        '  default: "m-1"\n' +
        "  api_mode: chat_completions\n" +
        "  temperature: 0.4\n",
    );
    assert.ok(!pinned.includes("openrouter.ai"), "the endpoint is gone");
  });

  test("setHermesModelProvider drops it in the same pass as the provider flip", () => {
    const out = setHermesModelProvider(SEED);
    assert.equal(
      out,
      "theme: dark\n" +
        "model:  # keep the section\n" +
        "  # provider pick\n" +
        "  provider: aiand\n" +
        "  api_mode: chat_completions\n" +
        "  temperature: 0.4\n" +
        '  default: "user-model"\n',
    );
  });

  test("routing twice over the routed config is byte-identical", () => {
    const once = pinHermesModel(SEED, "m-1");
    assert.equal(pinHermesModel(once, "m-1"), once);
    assert.equal(setHermesModelProvider(once), once);
    // The persistent `on` path never re-pins a default it kept.
    const kept = setHermesModelProvider(SEED);
    assert.equal(setHermesModelProvider(kept), kept);
  });

  test("a dropped base_url's trailing comment survives its own line", () => {
    const out = setHermesModelProvider(
      'model:\n  provider: auto\n  base_url: "https://openrouter.ai/api/v1"  # keep\n  api_mode: chat_completions\n',
    );
    assert.ok(!out.includes("openrouter.ai"), "the endpoint is gone");
    assert.ok(out.includes("  # keep\n"), "the comment survived as its own line");
    assert.equal(out, "model:\n  provider: aiand\n  # keep\n  api_mode: chat_completions\n");
  });

  test("model.api_key is left alone: no aiand path reads it", () => {
    // Hermes reads model.api_key only behind the bare-custom/openrouter
    // fallback gate (provider auto/custom/openrouter); a registry provider
    // never consults it. Only the endpoint hijack is removed.
    const out = pinHermesModel(
      'model:\n  provider: auto\n  base_url: "https://openrouter.ai/api/v1"\n  api_key: "sk-user"\n',
      "m-1",
    );
    assert.equal(out, 'model:\n  provider: aiand\n  default: "m-1"\n  api_key: "sk-user"\n');
  });

  test("a block-scalar base_url refuses instead of stranding its body", () => {
    const seed = "model:\n  provider: auto\n  base_url: |\n    https://openrouter.ai/api/v1\n";
    for (const edit of [() => pinHermesModel(seed, "m-1"), () => setHermesModelProvider(seed)]) {
      assert.throws(
        () => edit(),
        (err) => err instanceof CliError,
      );
    }
    assert.throws(() => setHermesModelProvider(seed), /multi-line `model.base_url`/);
  });

  test("off hands the dropped line back where the section can take it", () => {
    // on drops the line so the routed request cannot ride the user's own
    // endpoint; off must not lose it. The round trip restores the section's
    // own key order, and a second off is a no-op.
    const seeded =
      'theme: dark\nmodel:\n  provider: "auto"\n  default: "user-model"\n  base_url: "https://openrouter.ai/api/v1"\n';
    const line = modelFieldLine(seeded, "base_url");
    assert.equal(line, '  base_url: "https://openrouter.ai/api/v1"');
    const routed = pinHermesModel(seeded, "m-1");
    assert.ok(!routed.includes("openrouter.ai"), "on dropped the endpoint");
    const restored = restoreHermesModelLine(routed, "base_url", line);
    assert.equal(
      restored,
      'theme: dark\nmodel:\n  provider: aiand\n  default: "m-1"\n  base_url: "https://openrouter.ai/api/v1"\n',
    );
    // The line is back, so a second restore refuses to stack it: it reads as
    // the user's own and the caller notes it instead.
    assert.equal(restoreHermesModelLine(restored, "base_url", line), restored);
    assert.equal(modelFieldLine(restored, "base_url"), line);
  });

  test("off leaves a base_url the user wrote in between", () => {
    // A base_url that appeared while we were wired is theirs: the restore
    // replaces the recorded line's slot rather than stacking a second key.
    const routed =
      'model:\n  provider: aiand\n  default: "m-1"\n  base_url: "https://user.example/v1"\n';
    const out = restoreHermesModelLine(
      routed,
      "base_url",
      '  base_url: "https://openrouter.ai/api/v1"',
    );
    assert.equal(
      out,
      'model:\n  provider: aiand\n  default: "m-1"\n  base_url: "https://openrouter.ai/api/v1"\n',
    );
  });
});
