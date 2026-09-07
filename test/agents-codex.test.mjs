import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir;
const originalEnv = { ...process.env };

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-codex-test-"));
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_HOME = join(dir, "home");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const { patchRouting, stripRouting, applyFirstRunDefaults, tomlString } = await import(
  "../dist/agents/toml.js"
);
const { codexAdapter, codexModelCatalogJson, CODEX_SHARED_NOTE } = await import(
  "../dist/agents/codex.js"
);

const home = () => process.env.AIAND_HOME;

// A planted config mixing an `[[mcp_servers]]` array, an unrelated root key,
// and a second provider table — everything that must survive the surgery.
function plantedConfig() {
  return [
    "trusted = 5",
    'model_reasoning_effort = "medium"',
    "",
    "[[mcp_servers]]",
    'name = "docs"',
    'command = "mcp-docs"',
    "",
    "[model_providers.openai]",
    'base_url = "https://api.openai.com/v1"',
    "",
  ].join("\n");
}

function fixtureModels() {
  return [
    {
      id: "zai-org/glm-5.3",
      name: "GLM 5.3",
      object: "model",
      created: 0,
      owned_by: "zai",
      provider: "zai",
      context_window: 100000,
      capabilities: ["text"],
      reasoning_efforts: ["minimal", "low", "medium"],
      reasoning_effort_default: "medium",
      description: null,
      currency: "usd",
      input_per_1m: "1",
      output_per_1m: "2",
      cached_input_per_1m: null,
    },
    {
      id: "vision-model",
      name: "Vision",
      object: "model",
      created: 0,
      owned_by: "x",
      provider: "x",
      context_window: 50000,
      capabilities: ["text", "vision"],
      reasoning_efforts: null,
      reasoning_effort_default: null,
      description: null,
      currency: "usd",
      input_per_1m: "1",
      output_per_1m: "1",
      cached_input_per_1m: null,
    },
  ];
}

const CATALOG_PATH = `${home()}/.codex/aiand-models.json`;

const ROUTING_OPTS = {
  providerId: "aiand",
  baseUrl: "https://api.aiand.com/v1",
  modelId: "zai-org/glm-5.3",
  catalogPath: CATALOG_PATH,
  apiKey: "sk-test-123",
};

describe("toml patchRouting", () => {
  test("preserves [[mcp_servers]] and unrelated root keys, rewriting routing on top", () => {
    const out = patchRouting(plantedConfig(), ROUTING_OPTS);
    assert.match(out, /^model_provider = "aiand"/m);
    assert.match(out, /^model_catalog_json = ".*aiand-models\.json"/m);
    assert.match(out, /^model = "zai-org\/glm-5\.3"/m);
    assert.match(out, /\[model_providers\.aiand\]/);
    assert.match(out, /name = "ai&"/);
    assert.match(out, /base_url = "https:\/\/api\.aiand\.com\/v1"/);
    assert.match(out, /wire_api = "responses"/);
    assert.match(out, /experimental_bearer_token = "sk-test-123"/);
    assert.match(out, /requires_openai_auth = false/);

    assert.match(out, /^trusted = 5$/m);
    assert.match(out, /^model_reasoning_effort = "medium"$/m);
    assert.match(out, /\[\[mcp_servers\]\]/);
    assert.match(out, /^name = "docs"$/m);
    assert.match(out, /\[model_providers\.openai\]/);
  });

  test("empty config first-run gets defaults + routing + provider table", () => {
    const out = patchRouting(applyFirstRunDefaults(""), ROUTING_OPTS);
    assert.match(out, /^approval_policy = "on-request"$/m);
    assert.match(out, /^sandbox_mode = "workspace-write"$/m);
    assert.match(out, /^model_provider = "aiand"$/m);
    assert.match(out, /\[model_providers\.aiand\]/);
  });

  test("bearer literal is present in the provider table", () => {
    const out = patchRouting("", ROUTING_OPTS);
    assert.match(out, /experimental_bearer_token = "sk-test-123"/);
  });

  test("tomlString escapes backslashes and quotes", () => {
    assert.equal(tomlString("a\\b\"c"), '"a\\\\b\\"c"');
  });
});

describe("toml stripRouting", () => {
  test("removes exactly our root keys and table, preserving the rest", () => {
    const patched = patchRouting(plantedConfig(), ROUTING_OPTS);
    const stripped = stripRouting(patched);

    assert.doesNotMatch(stripped, /^model_provider\s*=/m);
    assert.doesNotMatch(stripped, /^model_catalog_json\s*=/m);
    assert.doesNotMatch(stripped, /^model\s*=/m);
    assert.doesNotMatch(stripped, /\[model_providers\.aiand\]/);
    assert.doesNotMatch(stripped, /ai&/);

    assert.match(stripped, /^trusted = 5$/m);
    assert.match(stripped, /^model_reasoning_effort = "medium"$/m);
    assert.match(stripped, /\[\[mcp_servers\]\]/);
    assert.match(stripped, /^name = "docs"$/m);
    assert.match(stripped, /\[model_providers\.openai\]/);
  });

  test("round-trip: strip(patch(x)) leaves unrelated file content intact", () => {
    const original = plantedConfig();
    const patched = patchRouting(original, ROUTING_OPTS);
    const restored = stripRouting(patched);
    for (const piece of [
      "trusted = 5",
      "model_reasoning_effort",
      "[[mcp_servers]]",
      "mcp-docs",
      "[model_providers.openai]",
    ]) {
      assert.ok(restored.includes(piece), `expected "${piece}" to survive round-trip`);
    }
  });
});

describe("first-run defaults", () => {
  test("blank and whitespace configs get defaults; non-empty is untouched", () => {
    assert.match(applyFirstRunDefaults(""), /approval_policy = "on-request"/);
    assert.match(applyFirstRunDefaults("   \n  "), /sandbox_mode = "workspace-write"/);
    const existing = "trusted = 5\n";
    assert.equal(applyFirstRunDefaults(existing), existing);
  });
});

describe("codex adapter", () => {
  test("aliases include chatgpt", () => {
    assert.ok(codexAdapter.aliases.includes("chatgpt"));
  });

  test("managedFiles covers config.toml and models_cache.json", () => {
    const files = codexAdapter.managedFiles();
    assert.deepEqual(files, [
      join(home(), ".codex", "config.toml"),
      join(home(), ".codex", "models_cache.json"),
    ]);
  });

  test("probe(): absent config is inactive with no model", async () => {
    const result = await codexAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
    assert.equal(result.foreignTool, null);
  });

  test("probe(): active when our provider table + base_url present; reads root model", async () => {
    const configPath = join(home(), ".codex", "config.toml");
    mkdirSync(join(home(), ".codex"), { recursive: true });
    writeFileSync(
      configPath,
      'model_provider = "aiand"\nmodel = "zai-org/glm-5.3"\n\n[model_providers.aiand]\nname = "ai&"\nbase_url = "https://api.aiand.com/v1"\n'
    );
    const result = await codexAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, "zai-org/glm-5.3");
    assert.equal(result.foreignTool, null);
  });

  test("probe(): garbage text is inactive, no throw", async () => {
    const configPath = join(home(), ".codex", "config.toml");
    writeFileSync(configPath, "not really toml {{{}}");
    const result = await codexAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("enable() writes config (0600) + catalog, deletes stale models_cache", async () => {
    const codexDir = join(home(), ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "models_cache.json"), '{"stale":true}\n');

    const result = await codexAdapter.enable({
      apiKey: "sk-enable-1",
      model: "zai-org/glm-5.3",
      slots: {},
      catalog: fixtureModels(),
      home: home(),
    });

    assert.equal(result.model, "zai-org/glm-5.3");
    assert.equal(result.filesWritten.length, 2);

    const configText = readFileSync(join(codexDir, "config.toml"), "utf8");
    assert.match(configText, /experimental_bearer_token = "sk-enable-1"/);
    assert.match(configText, /\[model_providers\.aiand\]/);
    assert.equal(statSync(join(codexDir, "config.toml")).mode & 0o777, 0o600);

    const catalog = JSON.parse(readFileSync(join(codexDir, "aiand-models.json"), "utf8"));
    assert.equal(catalog.models.length, 2);

    assert.throws(() => statSync(join(codexDir, "models_cache.json")), /ENOENT/);
  });

  test("disable() removes the aiand catalog", async () => {
    const codexDir = join(home(), ".codex");
    writeFileSync(join(codexDir, "aiand-models.json"), '{"models":[]}');
    await codexAdapter.disable();
    assert.throws(() => statSync(join(codexDir, "aiand-models.json")), /ENOENT/);
  });

  test("sessionLaunch passes -c args with aiand provider, empty env", () => {
    const launch = codexAdapter.sessionLaunch("zai-org/glm-5.3");
    assert.deepEqual(launch.args, [
      "-c",
      'model_provider="aiand"',
      "-c",
      'model="zai-org/glm-5.3"',
    ]);
    assert.deepEqual(launch.env, {});
    assert.deepEqual(launch.clear, []);
  });

  test("CODEX_SHARED_NOTE is exported", () => {
    assert.equal(typeof CODEX_SHARED_NOTE, "string");
    assert.ok(CODEX_SHARED_NOTE.length > 0);
  });
});

describe("codex model catalog", () => {
  test("builds entries with slug, display_name, truncation margin, and vision modalities", () => {
    const models = fixtureModels();
    const parsed = JSON.parse(codexModelCatalogJson(models));
    assert.equal(parsed.models.length, 2);

    const [plain, vision] = parsed.models;
    assert.equal(plain.slug, "zai-org/glm-5.3");
    assert.equal(plain.display_name, "GLM 5.3");
    assert.equal(plain.default_reasoning_level, "medium");
    assert.equal(plain.truncation_policy.limit, Math.floor(100000 / 1.8));
    assert.equal(plain.auto_compact_token_limit, Math.floor(100000 / 1.8));
    assert.equal(plain.context_window, 100000);
    assert.equal(plain.max_context_window, 100000);
    assert.deepEqual(plain.input_modalities, ["text"]);
    assert.equal(plain.supports_search_tool, false);
    assert.equal(plain.use_responses_lite, false);
    assert.equal(plain.priority, 0);

    assert.equal(vision.slug, "vision-model");
    assert.equal(vision.default_reasoning_level, "none");
    assert.deepEqual(vision.input_modalities, ["text", "image"]);
    assert.equal(vision.priority, 1);
  });
});