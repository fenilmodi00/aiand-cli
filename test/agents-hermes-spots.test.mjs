import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  dropStaleModelBaseUrl,
  modelBaseUrlSpot,
  modelFieldLine,
  modelFieldLineAt,
  pinHermesModel,
  pinHermesProvider,
  restoreHermesModelLine,
  setHermesModelProvider,
  stripHermesProvider,
} from "../dist/agents/hermes/routing.js";
import { joinYamlLines, splitYamlLines } from "../dist/agents/hermes/yaml.js";

// PR #35 rework: the restore must hand a dropped `model:` line back at the
// spot it occupied, byte-identical, or `off` rewrites the user's file.

const BASE_URL = '  base_url: "https://openrouter.ai/api/v1"';

describe("modelFieldLineAt", () => {
  test("reports the raw line, its body index, and the section indent", () => {
    const text =
      "model:\n" +
      '  provider: "auto"\n' +
      '  default: "user-model"\n' +
      '  base_url: "https://openrouter.ai/api/v1"\n' +
      "  api_mode: chat_completions\n";
    assert.deepEqual(modelFieldLineAt(text, "provider"), {
      line: '  provider: "auto"',
      at: 0,
      indent: "  ",
    });
    assert.deepEqual(modelFieldLineAt(text, "default"), {
      line: '  default: "user-model"',
      at: 1,
      indent: "  ",
    });
    assert.deepEqual(modelFieldLineAt(text, "base_url"), {
      line: BASE_URL,
      at: 2,
      indent: "  ",
    });
    // The raw line stays the source of truth for the old API.
    assert.equal(modelFieldLine(text, "base_url"), BASE_URL);
    assert.deepEqual(modelBaseUrlSpot(text), modelFieldLineAt(text, "base_url"));
  });

  test("reads a multi-line default's header, not its body", () => {
    assert.deepEqual(modelFieldLineAt("model:\n  default: |\n    keep me\n", "default"), {
      line: "  default: |",
      at: 0,
      indent: "  ",
    });
  });

  test("absent section, absent field, and non-mapping shapes read undefined", () => {
    assert.equal(modelFieldLineAt("theme: dark\n", "provider"), undefined);
    assert.equal(modelFieldLineAt("model:\n  provider: aiand\n", "base_url"), undefined);
    // A flow map holds no line body the surgery could splice back.
    assert.equal(modelFieldLineAt("model: {provider: x}\n", "provider"), undefined);
    // A scalar sentinel carries no field lines.
    assert.equal(modelFieldLineAt('model: ""\n', "default"), undefined);
  });

  test("a deeper indent reads back, so a nested base_url is not confused", () => {
    const text = 'model:\n    provider: aiand\n    base_url: "https://x"\n';
    assert.equal(modelFieldLineAt(text, "base_url")?.line, '    base_url: "https://x"');
  });
});

describe("on/off byte identity on a stock-like section", () => {
  // The stock example's shape: the pinned default first, then the provider
  // flip, the user's base_url in the middle, a trailing comment block that
  // belongs to the section, and a following top-level key.
  const SEED =
    "theme: dark\n" +
    "model:  # keep the section\n" +
    '  default: "user-model"\n' +
    '  provider: "auto"\n' +
    '  base_url: "https://openrouter.ai/api/v1"\n' +
    "  api_mode: chat_completions\n" +
    "  temperature: 0.4\n" +
    "# trailing note block\n" +
    "# another note\n" +
    "kanban:\n" +
    "  k: v\n";
  const spots = () => ({
    base_url: modelBaseUrlSpot(SEED),
    default: modelFieldLineAt(SEED, "default"),
    provider: modelFieldLineAt(SEED, "provider"),
  });
  // A missing capture means the seed is not the shape the cycle expects.
  const assertSpots = (captured) => {
    for (const [field, spot] of Object.entries(captured)) {
      assert.ok(spot !== undefined, `spot captured for ${field}`);
    }
    return captured;
  };

  test("the whole cycle round-trips to the exact seed", () => {
    const {
      base_url: baseUrlSpot,
      default: defaultSpot,
      provider: providerSpot,
    } = assertSpots(spots());
    const on = pinHermesProvider(pinHermesModel(SEED, "m-1"), "https://api.aiand.com/v1", "m-1");
    // on rewrote our values in place and left everything else orbiting.
    assert.equal(on.includes("openrouter.ai"), false);
    let off = stripHermesProvider(on);
    off = restoreHermesModelLine(off, "base_url", baseUrlSpot);
    off = restoreHermesModelLine(off, "default", defaultSpot);
    off = restoreHermesModelLine(off, "provider", providerSpot);
    // Maintainer bug #2: the restored line came back at the end of the
    // section, above `kanban:`, dragging the comment block with it.
    assert.equal(off, SEED);
  });

  test("the base_url spot returns to its original index, not the section end", () => {
    const spot = assertSpots(spots()).base_url;
    const on = pinHermesModel(SEED, "m-1");
    const back = restoreHermesModelLine(on, "base_url", spot);
    // The spot's own index inside the section body, in the rewritten file.
    const body = splitYamlLines(back).lines.slice(
      splitYamlLines(back).lines.indexOf("model:  # keep the section") + 1,
      splitYamlLines(back).lines.indexOf("kanban:"),
    );
    assert.equal(body[spot.at], spot.line);
    // The comment block that follows the section never moved above the key.
    assert.equal(body[spot.at + 1], "  api_mode: chat_completions");
  });

  test("the trailing comment block stays put through the cycle", () => {
    const {
      base_url: baseUrlSpot,
      default: defaultSpot,
      provider: providerSpot,
    } = assertSpots(spots());
    let off = stripHermesProvider(pinHermesModel(SEED, "m-1"));
    off = restoreHermesModelLine(off, "base_url", baseUrlSpot);
    off = restoreHermesModelLine(off, "default", defaultSpot);
    off = restoreHermesModelLine(off, "provider", providerSpot);
    const lines = splitYamlLines(off).lines;
    assert.deepEqual(lines.slice(lines.indexOf("kanban:") - 2, lines.indexOf("kanban:") + 1), [
      "# trailing note block",
      "# another note",
      "kanban:",
    ]);
    // The whole file came back, so the block never moved anywhere.
    assert.equal(off, SEED);
  });
});

describe("base_url is the section's only field", () => {
  // Maintainer bug #1: on emptied the section when it held nothing else, so
  // the base_url restore hit the no-section early return and `off` left
  // config.yaml empty.
  const ONLY = `model:\n${BASE_URL}`;

  test("the section never empties before the last restore", () => {
    const spot = modelBaseUrlSpot(ONLY);
    assert.ok(spot !== undefined);
    const on = pinHermesProvider(pinHermesModel(ONLY, "m-1"), "https://api.aiand.com/v1", "m-1");
    let off = stripHermesProvider(on);
    // base_url comes back first, while our pinned lines still hold the
    // section open — then our own go.
    off = restoreHermesModelLine(off, "base_url", spot);
    assert.ok(off.includes(BASE_URL));
    off = restoreHermesModelLine(off, "default", undefined);
    off = restoreHermesModelLine(off, "provider", undefined);
    assert.equal(off, ONLY);
  });

  test("the drop reports the spot even with no other field beside it", () => {
    const drop = dropStaleModelBaseUrl(ONLY);
    assert.equal(drop.dropped, true);
    assert.deepEqual(drop.spot, { line: BASE_URL, at: 0, indent: "  " });
    assert.equal(restoreHermesModelLine(drop.text, "base_url", drop.spot), ONLY);
    // Nothing to drop records nothing, byte-identical.
    const quiet = dropStaleModelBaseUrl("model:\n  provider: aiand\n");
    assert.deepEqual(quiet, {
      text: "model:\n  provider: aiand\n",
      dropped: false,
      spot: undefined,
    });
  });
});

describe("a dropped base_url's trailing comment", () => {
  // Maintainer bug #3: the drop left the comment as its own line and the
  // restore pushed the full raw line back beside it, so the note appeared
  // twice and the placeholder line survived.
  const SEED =
    "model:\n" +
    "  provider: auto\n" +
    '  base_url: "https://openrouter.ai/api/v1"  # my router\n' +
    "  api_mode: chat_completions\n";
  const line = '  base_url: "https://openrouter.ai/api/v1"  # my router';

  test("on leaves the placeholder, off restores the line exactly once", () => {
    // on flipped the provider (that is what setHermesModelProvider does), so
    // the round trip asserts the restored file minus the provider rewrite:
    // the placeholder is gone, the line is back once, at its own spot.
    const spot = modelBaseUrlSpot(SEED);
    assert.ok(spot !== undefined);
    const routed = setHermesModelProvider(SEED);
    assert.equal(
      routed,
      "model:\n  provider: aiand\n  # my router\n  api_mode: chat_completions\n",
    );
    const back = restoreHermesModelLine(routed, "base_url", spot);
    assert.equal(
      back,
      "model:\n" +
        "  provider: aiand\n" +
        '  base_url: "https://openrouter.ai/api/v1"  # my router\n' +
        "  api_mode: chat_completions\n",
    );
    // Exactly once, and the placeholder line itself did not survive.
    assert.equal(back.split("# my router").length - 1, 1);
    assert.equal(back.includes("\n  # my router\n"), false);
    // Handing the provider line back too closes the round trip exactly.
    const full = restoreHermesModelLine(back, "provider", {
      line: "  provider: auto",
      at: 0,
      indent: "  ",
    });
    assert.equal(full, SEED);
  });

  test("a placeholder the user moved is still found, never duplicated", () => {
    const routed = "model:\n  provider: aiand\n  api_mode: chat_completions\n  # my router\n";
    // The scan is position-agnostic: an unmoved placeholder anywhere in the
    // body takes the recorded line's slot, so the note comes back once.
    const back = restoreHermesModelLine(routed, "base_url", {
      line,
      at: 1,
      indent: "  ",
    });
    assert.equal(
      back,
      "model:\n  provider: aiand\n  api_mode: chat_completions\n" +
        '  base_url: "https://openrouter.ai/api/v1"  # my router\n',
    );
    assert.equal(back.split("# my router").length - 1, 1);
  });
});

describe("a CRLF file round-trips with its own line endings", () => {
  const crlf = (text) => text.replace(/\n/g, "\r\n");
  const SEED = crlf(
    "theme: dark\n" +
      "model:\n" +
      '  provider: "auto"\n' +
      '  default: "user-model"\n' +
      '  base_url: "https://openrouter.ai/api/v1"\n' +
      "kanban:\n" +
      "  k: v\n",
  );

  test("splitYamlLines/joinYamlLines remember the EOL", () => {
    const split = splitYamlLines(SEED);
    assert.deepEqual(split, {
      lines: [
        "theme: dark",
        "model:",
        '  provider: "auto"',
        '  default: "user-model"',
        BASE_URL,
        "kanban:",
        "  k: v",
      ],
      trailingNewline: true,
      eol: "\r\n",
    });
    assert.equal(joinYamlLines(split.lines, split.trailingNewline, split.eol), SEED);
  });

  test("the cycle restores every CRLF byte", () => {
    const baseUrl = modelBaseUrlSpot(SEED);
    assert.ok(baseUrl !== undefined);
    const on = pinHermesModel(SEED, "m-1");
    assert.equal(on.includes("\r\n"), true);
    assert.equal(/\r\n/.test(on.slice(0, on.indexOf("model:"))), true);
    // No bare LF crept into the mixed file.
    assert.equal(on.replace(/\r\n/g, "").includes("\n"), false);
    const provider = modelFieldLineAt(SEED, "provider");
    const default_ = modelFieldLineAt(SEED, "default");
    assert.ok(provider !== undefined && default_ !== undefined);
    let back = restoreHermesModelLine(on, "base_url", baseUrl);
    back = restoreHermesModelLine(back, "default", default_);
    back = restoreHermesModelLine(back, "provider", provider);
    assert.equal(back, SEED);
    // Every line in the restored file is still CRLF-terminated.
    assert.equal(back.replace(/\r\n/g, "").includes("\n"), false);
  });
});

describe("a file with no trailing newline", () => {
  // Maintainer bug #6: the append path passed `false` to joinYamlLines, so
  // `off` handed back a trailing newline the user's file never had.
  const SEED =
    "theme: dark\n" +
    "model:\n" +
    '  provider: "auto"\n' +
    '  base_url: "https://openrouter.ai/api/v1"\n' +
    "kanban:\n" +
    "  k: v";

  test("drop and restore keep the file unterminated", () => {
    const drop = dropStaleModelBaseUrl(SEED);
    assert.equal(drop.text.endsWith("k: v"), true);
    assert.equal(drop.text.endsWith("\n"), false);
    const back = restoreHermesModelLine(drop.text, "base_url", drop.spot);
    assert.equal(back, SEED);
    assert.equal(back.endsWith("\n"), false);
  });

  test("a terminated file stays terminated", () => {
    const terminated = `${SEED}\n`;
    const drop = dropStaleModelBaseUrl(terminated);
    assert.equal(drop.text.endsWith("\n"), true);
    assert.equal(restoreHermesModelLine(drop.text, "base_url", drop.spot), terminated);
  });
});

describe("stale base_url on the already-routed path", () => {
  // Maintainer bug #4: setHermesModelProvider returned early on the
  // idempotent path, so nothing was dropped — yet the endpoint still rode
  // the user's base_url, and off later claimed the user had edited it.
  const SEED =
    "model:\n" +
    "  provider: aiand  # keep\n" +
    '  base_url: "https://openrouter.ai/api/v1"\n' +
    "  api_mode: chat_completions\n";

  test("the drop runs before the idempotent return", () => {
    assert.equal(
      setHermesModelProvider(SEED),
      "model:\n  provider: aiand  # keep\n  api_mode: chat_completions\n",
    );
  });

  test("a routed config with nothing to drop stays byte-identical", () => {
    const quiet = "model:\n  provider: aiand  # keep\n  api_mode: chat_completions\n";
    assert.equal(setHermesModelProvider(quiet), quiet);
  });

  test("the drop reports what off has to put back", () => {
    const drop = dropStaleModelBaseUrl(SEED);
    assert.equal(drop.dropped, true);
    assert.deepEqual(drop.spot, { line: BASE_URL, at: 1, indent: "  " });
    assert.equal(restoreHermesModelLine(drop.text, "base_url", drop.spot), SEED);
  });
});

describe("a base_url restore stays idempotent", () => {
  test("second restore of a live line is a no-op", () => {
    const routed = `model:\n  provider: aiand\n${BASE_URL}\n`;
    const spot = modelBaseUrlSpot(routed);
    assert.ok(spot !== undefined);
    const once = restoreHermesModelLine(routed, "base_url", spot);
    assert.equal(once, routed);
    assert.equal(restoreHermesModelLine(once, "base_url", spot), once);
    assert.equal(modelFieldLine(once, "base_url"), BASE_URL);
  });

  test("a base_url the user wrote in between takes the slot", () => {
    const routed =
      'model:\n  provider: aiand\n  default: "m-1"\n  base_url: "https://user.example/v1"\n';
    const out = restoreHermesModelLine(routed, "base_url", {
      line: BASE_URL,
      at: 2,
      indent: "  ",
    });
    assert.equal(out, `model:\n  provider: aiand\n  default: "m-1"\n${BASE_URL}\n`);
    assert.equal(out.split("base_url:").length - 1, 1);
  });

  test("the legacy string argument still restores", () => {
    // Callers that never captured a spot keep the old positional path.
    const routed = 'model:\n  provider: aiand\n  default: "m-1"\n';
    assert.equal(restoreHermesModelLine(routed, "base_url", BASE_URL), `${routed + BASE_URL}\n`);
  });
});
