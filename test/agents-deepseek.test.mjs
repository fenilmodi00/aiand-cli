import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;
const originalEnv = { ...process.env };

const BASE_KEY = "sk-test-key-for-deepseek-adapter-slice";
const BASE_URL = "https://api.aiand.com/v1";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-deepseek-test-"));
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_API_KEY = BASE_KEY;
  delete process.env.DSH_HOME;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const { deepseekAdapter } = await import("../dist/agents/deepseek.js");
const {
  parseYamlDeepseek,
  serializeYamlDeepseek,
  withoutPersistedModel,
  buildDeepseekModelEntry,
  dshHome,
  settingsPath,
  credentialsPath,
  createDeepseekHomeOverlay,
} = await import("../dist/agents/deepseek.js");

const MODEL_A = {
  id: "org-alpha/one",
  name: "Alpha One",
  object: "model",
  created: 1,
  owned_by: "org-alpha",
  provider: "aiand",
  context_window: 128000,
  capabilities: ["text"],
  reasoning_efforts: ["minimal", "medium"],
  reasoning_effort_default: "medium",
  description: null,
  currency: "usd",
  input_per_1m: "0.60",
  output_per_1m: "2.40",
  cached_input_per_1m: "0.12",
};
const MODEL_VISION = {
  ...MODEL_A,
  id: "org-beta/vision-x",
  name: "Vision X",
  capabilities: ["text", "vision"],
  reasoning_efforts: null,
  input_per_1m: "1.00",
  output_per_1m: "3.00",
  cached_input_per_1m: null,
};

function enableInput(overrides = {}) {
  return {
    apiKey: BASE_KEY,
    model: MODEL_A.id,
    slots: {},
    catalog: [MODEL_A, MODEL_VISION],
    home: process.env.AIAND_HOME,
    baseUrl: BASE_URL,
    ...overrides,
  };
}

const setPath = () => settingsPath();
const credPath = () => credentialsPath();

// A planted settings.yaml carrying unrelated keys + a foreign provider, the
// shape the merge-preserve path must survive.
function plantedSettings(extra = "") {
  const base = [
    "llm-pi-ai:",
    "  providers:",
    "    local-ollama:",
    "      displayName: Local",
    "      api: openai-completions",
    "      baseURL: http://127.0.0.1:11434/v1",
    "      models:",
    "        - id: llama3",
    "          name: Llama 3",
    "theme: dark",
    "loglevel: info",
  ].join("\n");
  return base + extra + "\n";
}

describe("deepseek home resolution", () => {
  test("dshHome honors DSH_HOME over the aiand home default", () => {
    process.env.DSH_HOME = join(dir, "custom-dsh");
    assert.equal(dshHome(), join(dir, "custom-dsh"));
    delete process.env.DSH_HOME;
    assert.equal(dshHome(), join(dir, "home", ".dsh"));
  });
});

describe("deepseek yaml parse/serialize", () => {
  test("round-trips a flat provider doc", () => {
    const doc = {
      llm: {
        providers: {
          aiand: {
            displayName: "ai&",
            apiKeyEnv: "AIAND_API_KEY",
            api: "openai-completions",
            baseURL: BASE_URL,
            models: [{ id: "a/b", name: "A B", cost: { input: 0.6 } }],
          },
        },
      },
      agent: { provider: "p", model: "m" },
    };
    const raw = serializeYamlDeepseek(doc);
    assert.deepEqual(parseYamlDeepseek(raw, "settings.yaml"), doc);
  });

  test("serializes list-of-maps and scalars", () => {
    const doc = {
      models: [{ id: "x", name: "X" }, { id: "y" }],
      flag: true,
      num: 3,
      text: "plain",
      quoted: "has: colon and # hash",
      empty: null,
    };
    const raw = serializeYamlDeepseek(doc);
    assert.deepEqual(parseYamlDeepseek(raw, "settings.yaml"), doc);
  });

  test("empty doc serializes to empty string and parses to empty map", () => {
    assert.equal(serializeYamlDeepseek({}), "");
    assert.deepEqual(parseYamlDeepseek("", "settings.yaml"), {});
    assert.deepEqual(parseYamlDeepseek("  \n# only comment\n", "settings.yaml"), {});
  });

  test("invalid yaml surfaces as a CliError naming the file", () => {
    assert.throws(() => parseYamlDeepseek("a: 1\n\tbad-indent: [unclosed", "settings.yaml"), /Invalid DeepSeek Harness settings\.yaml/);
    assert.throws(() => parseYamlDeepseek("- just a list", ".credentials.yaml"), /Invalid DeepSeek Harness \.credentials\.yaml/);
  });

  test("model ids are used verbatim without ref-shortening", () => {
    const entry = buildDeepseekModelEntry(MODEL_A);
    assert.equal(entry.id, MODEL_A.id);
    assert.equal(entry.name, MODEL_A.name);
    assert.equal(entry.reasoning, true);
    assert.deepEqual(entry.input, ["text"]);
    assert.equal(entry.contextWindow, MODEL_A.context_window);
    assert.equal(entry.maxTokens, 16384);
    assert.deepEqual(entry.cost, { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 });

    const vision = buildDeepseekModelEntry(MODEL_VISION);
    assert.deepEqual(vision.input, ["text", "image"]);
    assert.equal(vision.reasoning, false);
    assert.deepEqual(vision.cost, { input: 1, output: 3, cacheRead: 1, cacheWrite: 0 });
  });
});

// Local proxy to reach the model-entry builder through dist's exports.
function buildModelEntryProxy() {
  // The builder is exercised via enable(); assert its observable shape there.
  return { id: MODEL_A.id };
}

describe("deepseek enable", () => {
  test("writes provider block + agent-default-model, preserving unrelated keys", async () => {
    mkdirSync(process.env.AIAND_HOME, { recursive: true });
    mkdirSync(join(process.env.AIAND_HOME, ".dsh"), { recursive: true });
    writeFileSync(setPath(), plantedSettings());

    const result = await deepseekAdapter.enable(enableInput());
    assert.deepEqual(result.filesWritten, [setPath(), credPath()]);
    assert.equal(result.model, MODEL_A.id);

    const settings = parseYamlDeepseek(readFileSync(setPath(), "utf8"), setPath());
    // unrelated top-level keys + foreign provider survive
    assert.equal(settings.theme, "dark");
    assert.equal(settings.loglevel, "info");
    const providers = settings["llm-pi-ai"].providers;
    assert.ok(providers["local-ollama"], "non-aiand provider entry preserved");

    // our provider block
    const prov = providers.aiand;
    assert.equal(prov.displayName, "ai&");
    assert.equal(prov.apiKeyEnv, "AIAND_API_KEY");
    assert.equal(prov.api, "openai-completions");
    assert.equal(prov.baseURL, BASE_URL);
    assert.deepEqual(prov.compat, { supportsDeveloperRole: false, supportsReasoningEffort: true });

    // models come from the live catalog, verbatim ids + per-1M cost numbers
    assert.equal(prov.models.length, 2);
    const m0 = prov.models.find((m) => m.id === MODEL_A.id);
    assert.equal(m0.name, MODEL_A.name);
    assert.equal(m0.reasoning, true);
    assert.deepEqual(m0.input, ["text"]);
    assert.equal(m0.contextWindow, MODEL_A.context_window);
    assert.equal(m0.maxTokens, 16384);
    assert.deepEqual(m0.cost, { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 });
    const mv = prov.models.find((m) => m.id === MODEL_VISION.id);
    assert.deepEqual(mv.input, ["text", "image"]);
    assert.equal(mv.reasoning, false);
    assert.deepEqual(mv.cost, { input: 1, output: 3, cacheRead: 1, cacheWrite: 0 });

    // agent-default-model
    assert.deepEqual(settings["agent-default-model"], { provider: "aiand", model: MODEL_A.id });
  });

  test("provider block + agent-default-model are replaced in place on re-on", async () => {
    // First enable (as above) then plant a settings carrying a stale
    // agent-default-model + same provider; re-enable must overwrite both.
    await deepseekAdapter.enable(enableInput());
    const stale = plantedSettings() + "\nagent-default-model:\n  provider: aiand\n  model: stale-old-model\n";
    writeFileSync(setPath(), stale);

    await deepseekAdapter.enable(enableInput({ model: MODEL_VISION.id }));
    const settings = parseYamlDeepseek(readFileSync(setPath(), "utf8"), setPath());
    assert.deepEqual(settings["agent-default-model"], { provider: "aiand", model: MODEL_VISION.id });
    const provs = settings["llm-pi-ai"].providers;
    assert.deepEqual(provs.aiand.models.map((m) => m.id), [MODEL_A.id, MODEL_VISION.id]);
    assert.ok(provs["local-ollama"], "foreign provider survives re-on");
  });

  test("creates both files from scratch when none exist", async () => {
    const fresh = mkdtempSync(join(dir, "fresh-"));
    const result = await deepseekAdapter.enable(
      enableInput({ home: fresh }),
    );
    const s = join(fresh, ".dsh", "settings.yaml");
    const c = join(fresh, ".dsh", ".credentials.yaml");
    assert.deepEqual(result.filesWritten, [s, c]);
    assert.equal(statSync(c).mode & 0o777, 0o600);
    assert.equal(statSync(s).mode & 0o777, 0o600);
    const settings = parseYamlDeepseek(readFileSync(s, "utf8"), s);
    assert.deepEqual(settings["agent-default-model"], { provider: "aiand", model: MODEL_A.id });
  });
});

describe("deepseek credentials", () => {
  test("writes the literal key, merge-preserving existing entries, mode 0600", async () => {
    mkdirSync(join(process.env.AIAND_HOME, ".dsh"), { recursive: true });
    writeFileSync(credPath(), "DEEPSEEK_NATIVE_KEY: some-user-key\n");

    await deepseekAdapter.enable(enableInput());

    const creds = parseYamlDeepseek(readFileSync(credPath(), "utf8"), credPath());
    assert.equal(creds["AIAND_API_KEY"], BASE_KEY);
    assert.equal(creds["DEEPSEEK_NATIVE_KEY"], "some-user-key");
    assert.equal(statSync(credPath()).mode & 0o777, 0o600);
  });
});

describe("deepseek probe", () => {
  function freshDshWorkspace(label) {
    const ws = mkdtempSync(join(dir, label + "-"));
    const saved = process.env.DSH_HOME;
    process.env.DSH_HOME = ws;
    return { ws, saved };
  }

  test("inactive before enable", async () => {
    const { saved } = freshDshWorkspace("probe-fresh");
    try {
      const p = await deepseekAdapter.probe();
      assert.equal(p.active, false);
      assert.equal(p.model, null);
      assert.equal(p.foreignTool, null);
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = saved;
    }
  });

  test("active with model after enable", async () => {
    const { ws, saved } = freshDshWorkspace("probe-active");
    try {
      await deepseekAdapter.enable(enableInput({ home: ws }));
      const p = await deepseekAdapter.probe();
      assert.equal(p.active, true);
      assert.equal(p.model, MODEL_A.id);
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = saved;
    }
  });

  test("inactive when provider block exists but defaults point elsewhere", async () => {
    const { ws, saved } = freshDshWorkspace("probe-defaults");
    try {
      mkdirSync(join(ws, ".dsh"), { recursive: true });
      writeFileSync(
        join(ws, ".dsh", "settings.yaml"),
        plantedSettings() +
          "\nllm-pi-ai:\n  providers:\n    aiand:\n      apiKeyEnv: AIAND_API_KEY\n      api: openai-completions\n      baseURL: https://api.aiand.com/v1\nagent-default-model:\n  provider: local\n  model: other\n",
      );
      const p = await deepseekAdapter.probe();
      assert.equal(p.active, false);
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = saved;
    }
  });

  test("inactive on corrupt yaml, does not throw", async () => {
    const { ws, saved } = freshDshWorkspace("probe-corrupt");
    try {
      mkdirSync(join(ws, ".dsh"), { recursive: true });
      writeFileSync(join(ws, ".dsh", "settings.yaml"), "llm-pi-ai:\n  providers: [broken\n");
      const p = await deepseekAdapter.probe();
      assert.equal(p.active, false);
      assert.equal(p.model, null);
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = saved;
    }
  });
});

describe("withoutPersistedModel", () => {
  test("strips the agent-default-model block only", () => {
    const input = [
      "llm-pi-ai:",
      "  providers:",
      "    aiand:",
      "      displayName: ai&",
      "theme: dark",
      "agent-default-model:",
      "  provider: aiand",
      "  model: ui-remembered",
      "loglevel: info",
      "",
    ].join("\n");
    const out = withoutPersistedModel(input);
    assert.equal(out.includes("agent-default-model:"), false);
    assert.ok(out.includes("theme: dark"));
    assert.ok(out.includes("loglevel: info"));
    assert.ok(out.includes("displayName: ai&"));
  });

  test("returns input unchanged when no block", () => {
    const input = "a: 1\nb: 2\n";
    assert.equal(withoutPersistedModel(input), input);
  });
});

describe("deepseek sessionLaunch overlay", () => {
  const OVERLAY_KEY = "sk-session-key-overlay-42";

  function plantNativeHome() {
    const home = join(dir, "native-dsh");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "settings.yaml"),
      "llm-pi-ai:\n  providers:\n    aiand:\n      displayName: ai&\ntheme: dark\nagent-default-model:\n  provider: aiand\n  model: ui-remembered\n",
    );
    writeFileSync(join(home, ".credentials.yaml"), "AIAND_API_KEY: stale-persistent\nDEEPSEEK_NATIVE_KEY: user\n");
    writeFileSync(join(home, "sessions.db"), "session-bytes\n");
    mkdirSync(join(home, "profiles"), { recursive: true });
    writeFileSync(join(home, "profiles", "active.yaml"), "profile\n");
    return home;
  }

  test("builds a throwaway overlay: symlinks, stripped settings, real key", async () => {
    const nativeHome = plantNativeHome();
    const savedDsh = process.env.DSH_HOME;
    process.env.DSH_HOME = nativeHome;

    const launch = await deepseekAdapter.sessionLaunch({
      apiKey: OVERLAY_KEY,
      model: MODEL_A.id,
      catalog: [MODEL_A],
    });
    const overlay = launch.env.DSH_HOME;
    if (savedDsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDsh;

    try {
      // settings.yaml is a real copy, model block stripped
      const settings = readFileSync(join(overlay, "settings.yaml"), "utf8");
      assert.equal(settings.includes("agent-default-model:"), false);
      assert.ok(settings.includes("theme: dark"));
      assert.ok(settings.includes("displayName: ai&"));

      // symlinked entries point at the originals
      for (const name of ["sessions.db", "profiles"]) {
        const target = join(overlay, name);
        assert.equal(lstatSync(target).isSymbolicLink(), true, `${name} should be a symlink`);
        assert.equal(readlinkSync(target), join(nativeHome, name));
      }

      // overlay credentials carry the real session key, preserving user keys
      const creds = parseYamlDeepseek(readFileSync(join(overlay, ".credentials.yaml"), "utf8"), ".credentials.yaml");
      assert.equal(creds["AIAND_API_KEY"], OVERLAY_KEY);
      assert.equal(creds["DEEPSEEK_NATIVE_KEY"], "user");
      assert.equal(statSync(join(overlay, ".credentials.yaml")).mode & 0o777, 0o600);
      assert.equal(existsSync(join(nativeHome, "settings.yaml")), true, "native settings untouched");
    } finally {
      if (savedDsh === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = savedDsh;
      await launch.cleanup?.();
    }
  });

  test("sessionLaunch env + clear, cleanup removes the overlay", async () => {
    const nativeHome = plantNativeHome();
    const savedDsh = process.env.DSH_HOME;
    process.env.DSH_HOME = nativeHome;
    const launch = await deepseekAdapter.sessionLaunch({
      apiKey: OVERLAY_KEY,
      model: MODEL_A.id,
      catalog: [MODEL_A],
    });
    if (savedDsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDsh;

    assert.equal(typeof launch.env.DSH_HOME, "string");
    assert.ok(launch.env.DSH_HOME.includes("aiand-dsh-"), "overlay dir uses the aiand tmp prefix");
    assert.equal(launch.env.AIAND_API_KEY, OVERLAY_KEY);
    assert.deepEqual(launch.clear, ["DEEPSEEK_API_KEY"]);

    const overlay = launch.env.DSH_HOME;
    assert.ok(existsSync(overlay), "overlay exists before launch");
    await launch.cleanup?.();
    assert.equal(existsSync(overlay), false, "overlay dir removed by cleanup");
    assert.equal(existsSync(join(nativeHome, "settings.yaml")), true, "native settings untouched after cleanup");
  });

  test("createDeepseekHomeOverlay works even when no native home exists", () => {
    const emptyNative = join(dir, "nonexistent-dsh");
    const overlay = createDeepseekHomeOverlay(emptyNative, OVERLAY_KEY);
    assert.ok(existsSync(join(overlay, ".credentials.yaml")));
    const creds = parseYamlDeepseek(readFileSync(join(overlay, ".credentials.yaml"), "utf8"), ".credentials.yaml");
    assert.equal(creds["AIAND_API_KEY"], OVERLAY_KEY);
    rmSync(overlay, { recursive: true, force: true });
  });
});

describe("deepseek managedFiles + adapter shape", () => {
  test("managedFiles lists settings + credentials", () => {
    assert.deepEqual(deepseekAdapter.managedFiles(), [
      join(process.env.AIAND_HOME, ".dsh", "settings.yaml"),
      join(process.env.AIAND_HOME, ".dsh", ".credentials.yaml"),
    ]);
  });

  test("adapter id/label/bin/install", () => {
    assert.equal(deepseekAdapter.id, "deepseek");
    assert.equal(deepseekAdapter.label, "DeepSeek Harness");
    assert.equal(deepseekAdapter.bin, "dsh");
    assert.equal(deepseekAdapter.install.command, "npm install -g @deepseek-ai/dsh");
  });
});