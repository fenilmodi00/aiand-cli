import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  HERMES_KEY_ENV,
  HERMES_PROVIDER_ID,
  hasHermesMarker,
  hasProviderAiand,
  pinHermesModel,
  pinHermesProvider,
  readEnvValue,
  readModelField,
  readProviderField,
  removeEnvPair,
  restoreHermesModelProvider,
  setHermesModelProvider,
  stripHermesProvider,
  upsertEnvPair,
} from "../dist/agents/hermes/routing.js";
import { CliError } from "../dist/cli/errors.js";

// Pure routing bytes: no temp homes, no env isolation needed.

describe("hermes routing constants", () => {
  test("provider id and key env name", () => {
    assert.equal(HERMES_PROVIDER_ID, "aiand");
    assert.equal(HERMES_KEY_ENV, "AIAND_HERMES_API_KEY");
    // #17 P17-7: no base-URL var — the overlay .env carries the key alone
    // and the base URL travels in the provider block, so the constant is
    // removed rather than kept as an unused export.
  });
});

describe("dotenv pairs", () => {
  test("readEnvValue finds bare, quoted, and export-prefixed values", () => {
    const text = 'OTHER=1\nAIAND_HERMES_API_KEY=sk-live-1\nQUOTED="a=b"\n';
    assert.equal(readEnvValue(text, "AIAND_HERMES_API_KEY"), "sk-live-1");
    assert.equal(readEnvValue(text, "QUOTED"), "a=b");
    assert.equal(
      readEnvValue("export AIAND_HERMES_API_KEY=sk-x\n", "AIAND_HERMES_API_KEY"),
      "sk-x",
    );
    assert.equal(readEnvValue(text, "MISSING"), undefined);
  });

  test("readEnvValue ignores name prefixes and takes the last duplicate", () => {
    assert.equal(
      readEnvValue("AIAND_HERMES_API_KEY_EXTRA=no\n", "AIAND_HERMES_API_KEY"),
      undefined,
    );
    const text = "AIAND_HERMES_API_KEY=sk-old\nAIAND_HERMES_API_KEY_EXTRA=no\n";
    assert.equal(readEnvValue(text, "AIAND_HERMES_API_KEY"), "sk-old");
    assert.equal(
      readEnvValue(`${text}AIAND_HERMES_API_KEY=sk-new\n`, "AIAND_HERMES_API_KEY"),
      "sk-new",
    );
  });

  test("upsertEnvPair appends to empty and existing files", () => {
    assert.equal(upsertEnvPair("", "AIAND_HERMES_API_KEY", "sk-1"), "AIAND_HERMES_API_KEY=sk-1\n");
    assert.equal(
      upsertEnvPair("OTHER=1\n", "AIAND_HERMES_API_KEY", "sk-1"),
      "OTHER=1\nAIAND_HERMES_API_KEY=sk-1\n",
    );
  });

  test("upsertEnvPair replaces in place, others byte-identical, drops duplicates", () => {
    const text = "A=1\nAIAND_HERMES_API_KEY=sk-old\nB=2\nAIAND_HERMES_API_KEY=sk-dup\n";
    assert.equal(
      upsertEnvPair(text, "AIAND_HERMES_API_KEY", "sk-new"),
      "A=1\nAIAND_HERMES_API_KEY=sk-new\nB=2\n",
    );
  });

  test("removeEnvPair drops only our lines", () => {
    assert.equal(
      removeEnvPair("A=1\nAIAND_HERMES_API_KEY=sk-1\nB=2\n", "AIAND_HERMES_API_KEY"),
      "A=1\nB=2\n",
    );
    assert.equal(removeEnvPair("A=1\n", "AIAND_HERMES_API_KEY"), "A=1\n");
    assert.equal(removeEnvPair("AIAND_HERMES_API_KEY=sk-1\n", "AIAND_HERMES_API_KEY"), "");
    assert.equal(removeEnvPair("", "AIAND_HERMES_API_KEY"), "");
  });
});

describe("provider presence and marker", () => {
  test("empty text has neither provider nor marker", () => {
    assert.equal(hasProviderAiand(""), false);
    assert.equal(hasHermesMarker(""), false);
    assert.equal(readProviderField("", "base_url"), undefined);
    assert.equal(readModelField("", "provider"), undefined);
  });

  test("dict block counts, with or without the stamp", () => {
    const marked =
      'providers:\n  aiand:\n    base_url: "https://api.aiand.com"\n    managed_by: "aiand"\n';
    assert.equal(hasProviderAiand(marked), true);
    assert.equal(hasHermesMarker(marked), true);
    const foreign = "providers:\n  aiand:\n    base_url: https://foreign.example.com\n";
    assert.equal(hasProviderAiand(foreign), true);
    assert.equal(hasHermesMarker(foreign), false);
  });

  test("bare managed_by stamp reads marked", () => {
    assert.equal(hasHermesMarker("providers:\n  aiand:\n    managed_by: aiand\n"), true);
  });

  test("legacy list entries count by name: or id:, dict absent", () => {
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

  test("column-0 legacy list items count (PyYAML block-sequence style)", () => {
    assert.equal(
      hasProviderAiand("custom_providers:\n- name: aiand\n  base_url: https://x\n"),
      true,
    );
    assert.equal(hasProviderAiand("custom_providers:\n- name: other\n"), false);
    assert.throws(
      () =>
        pinHermesProvider("custom_providers:\n- name: aiand\n", {
          baseUrl: "https://api.aiand.com",
        }),
      (error) => error instanceof CliError && /custom_providers/.test(error.message),
    );
  });

  test("a deeper nested aiand: key is not the providers entry", () => {
    const text = "providers:\n  other:\n    aiand: nope\n";
    assert.equal(hasProviderAiand(text), false);
    assert.equal(hasHermesMarker(text), false);
  });

  test("tab indentation throws with a by-hand hint", () => {
    assert.throws(
      () => hasProviderAiand("providers:\n\taiand:\n"),
      (error) => error instanceof CliError && /by hand/.test(error.hint ?? ""),
    );
  });

  test("flow-style providers: throws with a by-hand hint", () => {
    assert.throws(
      () => hasProviderAiand("providers: {aiand: {}}\n"),
      (error) => error instanceof CliError && /by hand/.test(error.hint ?? ""),
    );
  });
  test("legacy plain-string aiand entries count (bare and quoted)", () => {
    assert.equal(hasProviderAiand("custom_providers:\n  - aiand\n"), true);
    assert.equal(hasProviderAiand('custom_providers:\n  - "aiand"\n'), true);
    assert.equal(hasProviderAiand("custom_providers:\n  - other\n"), false);
  });
});

describe("provider field reads", () => {
  const text = [
    "providers:",
    "  aiand:",
    '    name: "aiand"',
    '    base_url: "https://api.aiand.com"',
    "    key_env: AIAND_HERMES_API_KEY",
    '    default_model: "zai-org/glm-5.3"',
    '    managed_by: "aiand"',
    "",
  ].join("\n");

  test("quoted and bare scalars read back", () => {
    assert.equal(readProviderField(text, "base_url"), "https://api.aiand.com");
    assert.equal(readProviderField(text, "key_env"), "AIAND_HERMES_API_KEY");
    assert.equal(readProviderField(text, "default_model"), "zai-org/glm-5.3");
    assert.equal(readProviderField(text, "missing"), undefined);
  });

  test("sequence values read as undefined", () => {
    assert.equal(
      readProviderField(`${text}    models: ["zai-org/glm-5.3"]\n`, "models"),
      undefined,
    );
  });
});

describe("pinHermesProvider", () => {
  test("pins a stamped block from empty text", () => {
    assert.equal(
      pinHermesProvider("", { baseUrl: "https://api.aiand.com", model: "zai-org/glm-5.3" }),
      [
        "providers:",
        "  aiand:",
        '    name: "aiand"',
        '    base_url: "https://api.aiand.com"',
        '    key_env: "AIAND_HERMES_API_KEY"',
        '    default_model: "zai-org/glm-5.3"',
        '    models: ["zai-org/glm-5.3"]',
        '    managed_by: "aiand"',
        "",
      ].join("\n"),
    );
  });

  test("native (no model) omits default_model/models; no unconfirmed keys", () => {
    const pinned = pinHermesProvider("", { baseUrl: "https://api.aiand.com" });
    assert.match(pinned, /managed_by: "aiand"/);
    assert.equal(pinned.includes("default_model"), false);
    assert.equal(pinned.includes("models:"), false);
    assert.equal(pinned.includes("transport:"), false);
    assert.equal(pinned.includes("discover_models"), false);
  });

  test("unrelated keys and comments survive; repeat pin is byte-identical", () => {
    const before = "# user comment\ntheme: dark\nmodel:\n  provider: other\n";
    const once = pinHermesProvider(before, {
      baseUrl: "https://api.aiand.com",
      model: "m-1",
    });
    assert.match(once, /# user comment/);
    assert.match(once, /theme: dark/);
    assert.match(once, /provider: other/);
    assert.equal(pinHermesProvider(once, { baseUrl: "https://api.aiand.com", model: "m-1" }), once);
  });

  test("re-pin swaps base_url and model on a marked block", () => {
    const once = pinHermesProvider("", { baseUrl: "https://a.example.com", model: "m-1" });
    const twice = pinHermesProvider(once, { baseUrl: "https://b.example.com", model: "m-2" });
    assert.equal(readProviderField(twice, "base_url"), "https://b.example.com");
    assert.equal(readProviderField(twice, "default_model"), "m-2");
  });

  test("foreign dict block throws and leaves bytes untouched", () => {
    const foreign = "providers:\n  aiand:\n    base_url: https://foreign.example.com\n";
    assert.throws(
      () => pinHermesProvider(foreign, { baseUrl: "https://api.aiand.com" }),
      (error) =>
        error instanceof CliError &&
        /does not manage/.test(error.message) &&
        /by hand/.test(error.hint ?? ""),
    );
  });

  test("foreign legacy list entry refuses the dict write", () => {
    const legacy = "custom_providers:\n  - name: aiand\n    base_url: https://x\n";
    assert.throws(
      () => pinHermesProvider(legacy, { baseUrl: "https://api.aiand.com" }),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
  });
  test("legacy plain-string aiand entry refuses the dict write", () => {
    // #17 P17r-rt-4: a plain-string item names the provider
    // directly; without the presence check `on` would splice a
    // dict item beside the user's string entry.
    for (const legacy of ["custom_providers:\n  - aiand\n", 'custom_providers:\n  - "aiand"\n']) {
      assert.throws(
        () => pinHermesProvider(legacy, { baseUrl: "https://api.aiand.com" }),
        (error) =>
          error instanceof CliError &&
          /does not manage/.test(error.message) &&
          /by hand/.test(error.hint ?? ""),
      );
    }
  });

  test("flow-style providers: refuses the pin with a by-hand hint", () => {
    // #17 P17r-rt-5: the read path already refused flow values;
    // the pin path must too, or it splices a block beside the flow map.
    assert.throws(
      () =>
        pinHermesProvider("providers: {openai: {}}\n", {
          baseUrl: "https://api.aiand.com",
        }),
      (error) => error instanceof CliError && /by hand/.test(error.hint ?? ""),
    );
  });

  test("sequence-valued providers: refuses the pin with a by-hand hint", () => {
    // #17 P17r-rt-1: splicing `aiand:` beside dash items yields
    // unmappable YAML and corrupts the config, so refuse up front.
    assert.throws(
      () =>
        pinHermesProvider("providers:\n  - openai\n", {
          baseUrl: "https://api.aiand.com",
        }),
      (error) => error instanceof CliError && /by hand/.test(error.hint ?? ""),
    );
    // Column-0 dash items are the PyYAML sequence style — same shape.
    assert.throws(
      () =>
        pinHermesProvider("providers:\n- openai\n", {
          baseUrl: "https://api.aiand.com",
        }),
      (error) => error instanceof CliError && /by hand/.test(error.hint ?? ""),
    );
  });

  test("quoted child keys refuse the pin with a by-hand hint", () => {
    // #17 P17r-rt-6: an appended unquoted `aiand:` beside a
    // quoted "aiand": is a duplicate key, so quoted keys are foreign.
    assert.throws(
      () =>
        pinHermesProvider('providers:\n  "aiand":\n    base_url: "https://x"\n', {
          baseUrl: "https://api.aiand.com",
        }),
      (error) => error instanceof CliError && /by hand/.test(error.hint ?? ""),
    );
  });

  test("sibling providers keep their bytes; nested aiand keys untouched", () => {
    const before = "providers:\n  other:\n    base_url: https://other.example.com\n";
    const pinned = pinHermesProvider(before, { baseUrl: "https://api.aiand.com" });
    assert.ok(pinned.includes("other:\n    base_url: https://other.example.com"));
    assert.equal(hasHermesMarker(pinned), true);
  });
});

describe("stripHermesProvider", () => {
  test("strips the marked block and drops an emptied providers:", () => {
    const pinned = pinHermesProvider("theme: dark\n", {
      baseUrl: "https://api.aiand.com",
      model: "m-1",
    });
    assert.equal(stripHermesProvider(pinned), "theme: dark\n");
  });

  test("keeps sibling providers", () => {
    const pinned = pinHermesProvider("providers:\n  other:\n    base_url: https://o\n", {
      baseUrl: "https://api.aiand.com",
    });
    const stripped = stripHermesProvider(pinned);
    assert.match(stripped, /other:/);
    assert.equal(hasProviderAiand(stripped), false);
  });

  test("absent block returns the text untouched; legacy list survives", () => {
    assert.equal(stripHermesProvider("theme: dark\n"), "theme: dark\n");
    const legacy = "custom_providers:\n  - name: aiand\n";
    assert.equal(stripHermesProvider(legacy), legacy);
  });

  test("foreign dict block throws, never strips", () => {
    const foreign = "providers:\n  aiand:\n    base_url: https://foreign.example.com\n";
    assert.throws(
      () => stripHermesProvider(foreign),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
  });

  test("allowUnmarked strips a stamp-dropped block for the record backstop", () => {
    // #17 P17-5: disable() verifies the record plus the dedicated key_env
    // before passing allowUnmarked — the record alone never reaches the
    // strip, and the default still throws on foreign blocks (above).
    const dropped =
      "providers:\n  aiand:\n    base_url: https://api.aiand.com\n    key_env: AIAND_HERMES_API_KEY\n";
    assert.equal(stripHermesProvider(dropped, { allowUnmarked: true }), "");
    assert.throws(
      () => stripHermesProvider(dropped),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
  });
  test("keeps a sibling comment at the providers indent byte-identical", () => {
    // #17 P17r-rt-3: the comment belongs to the next provider,
    // not to our block, and must survive the splice.
    const text = 'providers:\n  aiand:\n    managed_by: "aiand"\n  # about b\n  b:\n    y: 2\n';
    assert.equal(stripHermesProvider(text), "providers:\n  # about b\n  b:\n    y: 2\n");
  });

  test("quoted child keys refuse the strip with a by-hand hint", () => {
    assert.throws(
      () => stripHermesProvider('providers:\n  "aiand":\n    base_url: "https://x"\n'),
      (error) => error instanceof CliError && /by hand/.test(error.hint ?? ""),
    );
  });
});

describe("CRLF config.yaml", () => {
  const crlf = (body) => body.replace(/\n/g, "\r\n");

  test("a marked CRLF config probes active and reads fields", () => {
    // #17 P17r-rt-2: `$`-anchored regexes fail on lines ending
    // in \r, so the split must normalize and the join restore it.
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
    const pinned = pinHermesProvider("theme: dark\r\n", {
      baseUrl: "https://api.aiand.com",
      model: "m-1",
    });
    const lines = pinned.split("\n");
    // Every terminated line ends with \r — no bare LF crept in.
    assert.ok(lines.slice(0, -1).every((line) => line.endsWith("\r")));
    assert.equal(stripHermesProvider(pinned), "theme: dark\r\n");
  });
});

describe("model section", () => {
  test("readModelField reads provider and default", () => {
    const text = 'model:\n  provider: "aiand"\n  default: bare-model\n';
    assert.equal(readModelField(text, "provider"), "aiand");
    assert.equal(readModelField(text, "default"), "bare-model");
  });

  test("pinHermesModel creates and updates the section", () => {
    assert.equal(pinHermesModel("", "m-1"), 'model:\n  provider: "aiand"\n  default: "m-1"\n');
    const repinned = pinHermesModel(pinHermesModel("", "m-1"), "m-2");
    assert.equal(readModelField(repinned, "default"), "m-2");
    assert.equal(pinHermesModel(repinned, "m-2"), repinned);
  });

  test("pinHermesModel keeps other model keys", () => {
    const text = "model:\n  provider: other\n  base_url: https://keep.example.com\n";
    const pinned = pinHermesModel(text, "m-1");
    assert.match(pinned, /base_url: https:\/\/keep\.example\.com/);
    assert.equal(readModelField(pinned, "provider"), "aiand");
  });

  test("native pin sets provider only and drops default", () => {
    const pinned = pinHermesModel('model:\n  provider: "aiand"\n  default: "m-1"\n', undefined);
    assert.equal(pinned, 'model:\n  provider: "aiand"\n');
  });

  test("setHermesModelProvider keeps a servable default, flips provider", () => {
    const text = "model:\n  provider: other\n  default: m-keep\n";
    const flipped = setHermesModelProvider(text);
    assert.equal(readModelField(flipped, "provider"), "aiand");
    assert.equal(readModelField(flipped, "default"), "m-keep");
  });

  test("restoreHermesModelProvider puts back a named previous provider", () => {
    const flipped = 'model:\n  provider: "aiand"\n  default: "m-keep"\n';
    const restored = restoreHermesModelProvider(flipped, "other");
    assert.equal(readModelField(restored, "provider"), "other");
    assert.equal(readModelField(restored, "default"), "m-keep");
  });

  test("restoreHermesModelProvider drops the line when there was none, keeps default", () => {
    const flipped = 'model:\n  provider: "aiand"\n  default: "m-keep"\n';
    const restored = restoreHermesModelProvider(flipped, undefined);
    assert.equal(readModelField(restored, "provider"), undefined);
    assert.equal(readModelField(restored, "default"), "m-keep");
  });

  test("restoreHermesModelProvider drops an emptied model section", () => {
    const flipped = 'model:\n  provider: "aiand"\n';
    assert.equal(restoreHermesModelProvider(flipped, undefined), "");
  });

  test("restoreHermesModelProvider keeps sibling model keys", () => {
    const flipped = 'model:\n  provider: "aiand"\n  base_url: https://keep.example.com\n';
    const restored = restoreHermesModelProvider(flipped, "other");
    assert.equal(readModelField(restored, "provider"), "other");
    assert.match(restored, /base_url: https:\/\/keep\.example\.com/);
    const dropped = restoreHermesModelProvider(flipped, undefined);
    assert.equal(readModelField(dropped, "provider"), undefined);
    assert.match(dropped, /base_url: https:\/\/keep\.example\.com/);
  });

  test("restoreHermesModelProvider on an absent section: builds or no-ops", () => {
    assert.equal(
      restoreHermesModelProvider("theme: dark\n", "other"),
      'theme: dark\nmodel:\n  provider: "other"\n',
    );
    assert.equal(restoreHermesModelProvider("theme: dark\n", undefined), "theme: dark\n");
  });

  test("inline model: value throws with a by-hand hint", () => {
    assert.throws(
      () => pinHermesModel("model: foo\n", "m-1"),
      (error) => error instanceof CliError && /by hand/.test(error.hint ?? ""),
    );
    assert.throws(
      () => readModelField("model: foo\n", "provider"),
      (error) => error instanceof CliError && /by hand/.test(error.hint ?? ""),
    );
  });
  test("pinHermesModel refuses a sequence-valued model: with a by-hand hint", () => {
    // #17 P17r-rt-1: splicing `provider:` beside dash items
    // corrupts the section, so refuse up front.
    assert.throws(
      () => pinHermesModel("model:\n  - gpt-4\n", "m-1"),
      (error) => error instanceof CliError && /by hand/.test(error.hint ?? ""),
    );
  });
});
