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
  dir = mkdtempSync(join(tmpdir(), "aiand-opencode-test-"));
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const { opencodeAdapter, buildOpencodeConfig } = await import("../dist/agents/opencode.js");
const { CliError } = await import("../dist/cli/errors.js");
const { snapshotFiles, restoreSnapshot, hasSnapshot } = await import("../dist/agents/snapshot.js");

const home = () => process.env.AIAND_HOME;
const configPath = () => join(home(), ".config", "opencode", "opencode.json");

/** A minimal opencode api.json response the enable() fetch must receive. */
function apiJsonFixture() {
  return {
    opencode: {
      id: "opencode",
      name: "ai&",
      env: ["OPENCODE_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.aiand.com/v1",
      models: {
        "zai-org/glm-5.3": {
          id: "zai-org/glm-5.3",
          name: "GLM 5.3",
          attachment: false,
          reasoning: true,
          temperature: true,
          tool_call: true,
          cost: { input: 1, output: 4, cache_read: 0.3 },
          limit: { context: 1048576, output: 32000 },
          modalities: { input: ["text"], output: ["text"] },
        },
        "qwen/qwen3.8-27b": {
          id: "qwen/qwen3.8-27b",
          name: "Qwen3.8-27B",
          attachment: true,
          reasoning: true,
          temperature: true,
          tool_call: true,
          cost: { input: 0.4, output: 3, cache_read: 0.2 },
          limit: { context: 262144, output: 32000 },
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      },
    },
  };
}

function enableInput(overrides = {}) {
  return {
    apiKey: "sk-enable-1",
    model: "zai-org/glm-5.3",
    slots: {},
    catalog: [],
    home: home(),
    baseUrl: "https://api.aiand.com",
    ...overrides,
  };
}

function readConfigJson() {
  return JSON.parse(readFileSync(configPath(), "utf8"));
}

describe("opencode adapter", () => {
  test("id/label/bin/install/managedFiles", () => {
    assert.equal(opencodeAdapter.id, "opencode");
    assert.equal(opencodeAdapter.label, "OpenCode");
    assert.equal(opencodeAdapter.bin, "opencode");
    assert.equal(typeof opencodeAdapter.install.command, "string");
    assert.ok(opencodeAdapter.install.url.length > 0);
    assert.deepEqual(opencodeAdapter.managedFiles(), [configPath()]);
  });

  test("probe(): absent config is inactive with no model", async () => {
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): garbage text is inactive, no throw", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), "not json {{{");
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): active when marked + aiand baseURL matches; model extracted", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://api.aiand.com/v1", apiKey: "sk-test-123" } },
        },
        model: "aiand/zai-org/glm-5.3",
        "x-aiand": true,
      })
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, "zai-org/glm-5.3");
  });

  test("probe(): active but foreign model ref → no model", async () => {
    // active routing but a model ref that isn't ours
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://api.aiand.com/v1", apiKey: "sk-test-123" } },
        },
        model: "other-provider/some-model",
        "x-aiand": true,
      })
    );
    const foreign = await opencodeAdapter.probe();
    assert.equal(foreign.active, true);
    assert.equal(foreign.model, null);
  });

  test("probe(): foreign aiand-named provider without our key reads inactive", async () => {
    // Same provider name but no sk- literal: not ours, so `on` snapshots
    // before overwriting it.
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://api.aiand.com/v1" } },
        },
        model: "aiand/zai-org/glm-5.3",
      })
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): staging https baseURL with our key + marker is active", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://staging.example.com/v1", apiKey: "sk-test-123" } },
        },
        model: "aiand/zai-org/glm-5.3",
        "x-aiand": true,
      })
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, "zai-org/glm-5.3");
  });

  test("probe(): loopback http baseURL with our key + marker is active", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "http://127.0.0.1:8080/v1", apiKey: "sk-test-123" } },
        },
        model: "aiand/zai-org/glm-5.3",
        "x-aiand": true,
      })
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, "zai-org/glm-5.3");
  });

  test("enable(): writes aiand provider with literal key + baseURL, roots, lockdown", async () => {
    const self = globalThis;
    const originalFetch = self.fetch;
    self.fetch = async () => ({
      ok: true,
      json: async () => apiJsonFixture(),
    });
    try {
      await opencodeAdapter.enable(enableInput());
    } finally {
      self.fetch = originalFetch;
    }

    const config = readConfigJson();
    const provider = config.provider.aiand;
    assert.equal(provider.npm, "@ai-sdk/openai-compatible");
    assert.equal(provider.name, "ai&");
    assert.equal(provider.options.apiKey, "sk-enable-1");
    assert.equal(provider.options.baseURL, "https://api.aiand.com/v1");
    assert.deepEqual(Object.keys(provider.models).sort(), [
      "qwen/qwen3.8-27b",
      "zai-org/glm-5.3",
    ]);
    assert.equal(config.model, "aiand/zai-org/glm-5.3");
    assert.deepEqual(config.enabled_providers, ["aiand"]);
    assert.deepEqual(config.disabled_providers, ["opencode"]);
    assert.equal(config["x-aiand"], true);
    assert.equal(statSync(configPath()).mode & 0o777, 0o600);
  });

  test("enable(): unreachable api.json falls back to the cached map", async () => {
    // Seed the last-good cache, then fail every fetch: enable must still
    // wire from cache instead of throwing.
    const cachePath = join(process.env.AIAND_CONFIG_DIR, "opencode-api.json");
    const cachedModels = {
      "zai-org/glm-5.3": { id: "zai-org/glm-5.3", name: "GLM 5.3" },
    };
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: 1, baseUrl: "https://api.aiand.com", models: cachedModels })
    );
    const self = globalThis;
    const originalFetch = self.fetch;
    self.fetch = async () => {
      throw new Error("offline");
    };
    try {
      await opencodeAdapter.enable(enableInput());
    } finally {
      self.fetch = originalFetch;
    }
    const config = readConfigJson();
    assert.deepEqual(Object.keys(config.provider.aiand.models), ["zai-org/glm-5.3"]);
  });

  test("enable(): unreachable api.json with no cache still throws", async () => {
    const self = globalThis;
    const originalFetch = self.fetch;
    self.fetch = async () => {
      throw new Error("offline");
    };
    try {
      await assert.rejects(() => opencodeAdapter.enable(enableInput({ baseUrl: "https://no-cache.test" })));
    } finally {
      self.fetch = originalFetch;
    }
  });

  test("enable(): preserves unrelated top-level keys", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ theme: "system", keybinds: { quit: "q" } })
    );
    const self = globalThis;
    const originalFetch = self.fetch;
    self.fetch = async () => ({
      ok: true,
      json: async () => apiJsonFixture(),
    });
    try {
      await opencodeAdapter.enable(enableInput());
    } finally {
      self.fetch = originalFetch;
    }
    const config = readConfigJson();
    assert.equal(config.theme, "system");
    assert.deepEqual(config.keybinds, { quit: "q" });
  });

  test("enable(): invalid planted JSON → CliError with delete hint", async () => {
    writeFileSync(configPath(), "{broken");
    const self = globalThis;
    const originalFetch = self.fetch;
    self.fetch = async () => ({
      ok: true,
      json: async () => apiJsonFixture(),
    });
    try {
      await assert.rejects(
        opencodeAdapter.enable(enableInput()),
        (error) =>
          error instanceof CliError &&
          /is not valid JSON\./.test(error.message) &&
          /delete it and run aiand opencode on again/.test(error.hint ?? "")
      );
    } finally {
      self.fetch = originalFetch;
    }
  });

  test("enable(): repeat on is byte-identical (idempotent)", async () => {
    rmSync(configPath(), { force: true });
    const self = globalThis;
    const originalFetch = self.fetch;
    self.fetch = async () => ({
      ok: true,
      json: async () => apiJsonFixture(),
    });
    try {
      await opencodeAdapter.enable(enableInput());
      const first = readFileSync(configPath(), "utf8");
      await opencodeAdapter.enable(enableInput());
      const second = readFileSync(configPath(), "utf8");
      assert.equal(first, second);
    } finally {
      self.fetch = originalFetch;
    }
  });

  test("disable() strips only our writes, preserves the rest, idempotent, missing no-op", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({
        theme: "system",
        provider: {
          other: { options: { baseURL: "https://other.example.com" } },
          aiand: { options: { baseURL: "https://api.aiand.com/v1", apiKey: "sk-test-123" } },
        },
        model: "aiand/zai-org/glm-5.3",
        enabled_providers: ["aiand"],
        disabled_providers: ["opencode"],
        "x-aiand": true,
      })
    );
    await opencodeAdapter.disable();
    const config = readConfigJson();
    assert.equal(config.provider.aiand, undefined);
    assert.deepEqual(config.provider.other, { options: { baseURL: "https://other.example.com" } });
    assert.equal(config.model, undefined);
    assert.equal(config.enabled_providers, undefined);
    assert.equal(config.disabled_providers, undefined);
    assert.equal(config["x-aiand"], undefined);
    assert.equal(config.theme, "system");
    // probe agrees: no key, no routing
    assert.equal((await opencodeAdapter.probe()).active, false);
    // second run changes nothing
    const first = readFileSync(configPath(), "utf8");
    await opencodeAdapter.disable();
    assert.equal(readFileSync(configPath(), "utf8"), first);
    // missing file is a no-op, never a throw
    rmSync(configPath(), { force: true });
    await opencodeAdapter.disable();
    assert.throws(() => readFileSync(configPath(), "utf8"));
    // garbage file is a no-op, never a throw, bytes untouched
    writeFileSync(configPath(), "{broken");
    await opencodeAdapter.disable();
    assert.equal(readFileSync(configPath(), "utf8"), "{broken");
  });
  test("probe(): foreign aiand-named provider with sk- key at foreign URL, no marker → inactive", async () => {
    // Finding-2 repro: the old sk- prefix + https check read this active and
    // logout/off deleted the foreign block. The marker gate keeps it inactive.
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://foreign.example.com/v1", apiKey: "sk-foreign-1" } },
        },
        model: "aiand/some-model",
      })
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): prod URL without marker reads inactive (marker-only ownership)", async () => {
    // First PR: no shipped users, so ownership is marker-only — a prod URL
    // alone is not enough. Prevents dual-path upgrade debt.
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://api.aiand.com/v1", apiKey: "sk-test-123" } },
        },
        model: "aiand/zai-org/glm-5.3",
      })
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): marked config with garbage baseURL reads inactive, no throw", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: ":::not-a-url", apiKey: "sk-test-123" } },
        },
        model: "aiand/zai-org/glm-5.3",
        "x-aiand": true,
      })
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("disable() leaves a foreign aiand-named provider untouched", async () => {
    const foreign = {
      provider: {
        aiand: { options: { baseURL: "https://foreign.example.com/v1", apiKey: "sk-foreign-1" } },
      },
      model: "aiand/some-model",
    };
    writeFileSync(configPath(), JSON.stringify(foreign));
    const before = readFileSync(configPath(), "utf8");
    await opencodeAdapter.disable();
    assert.equal(readFileSync(configPath(), "utf8"), before);
    assert.deepEqual(readConfigJson().provider.aiand.options.apiKey, "sk-foreign-1");
  });

  test("probe(): reads JSONC with comments + trailing commas; enable() preserves keys", async () => {
    writeFileSync(
      configPath(),
      '{\n  // aiand-owned staging config\n  "provider": {\n    "aiand": {\n      "options": {\n        "baseURL": "https://staging.example.com/v1",\n        "apiKey": "sk-test-123",\n      },\n    },\n  },\n  "model": "aiand/zai-org/glm-5.3",\n  "x-aiand": true,\n}\n'
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, "zai-org/glm-5.3");
    // enable() on a JSONC config succeeds and preserves unrelated keys
    // (comments themselves are lost on write — expected; keys survive).
    writeFileSync(
      configPath(),
      '{\n  // user comment\n  "theme": "system",\n  "provider": {},\n}\n'
    );
    const self = globalThis;
    const originalFetch = self.fetch;
    self.fetch = async () => ({
      ok: true,
      json: async () => apiJsonFixture(),
    });
    try {
      await opencodeAdapter.enable(enableInput());
    } finally {
      self.fetch = originalFetch;
    }
    const config = readConfigJson();
    assert.equal(config.theme, "system");
    assert.equal(config.provider.aiand.options.apiKey, "sk-enable-1");
    assert.equal(config["x-aiand"], true);
  });

  test("refreshKey() leaves a foreign aiand-named provider untouched", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://foreign.example.com/v1", apiKey: "sk-foreign-1" } },
        },
        model: "aiand/some-model",
      })
    );
    const before = readFileSync(configPath(), "utf8");
    await opencodeAdapter.refreshKey({ apiKey: "sk-new-1", home: home() });
    assert.equal(readFileSync(configPath(), "utf8"), before);
  });

  test("refreshKey() swaps the key on an owned marked config", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://staging.example.com/v1", apiKey: "sk-old-1" } },
        },
        model: "aiand/zai-org/glm-5.3",
        "x-aiand": true,
      })
    );
    await opencodeAdapter.refreshKey({ apiKey: "sk-new-1", home: home() });
    const config = readConfigJson();
    assert.equal(config.provider.aiand.options.apiKey, "sk-new-1");
    assert.equal(config.model, "aiand/zai-org/glm-5.3");
  });

  test("buildOpencodeConfig: single helper used for both shapes (apiKey literal + baseURL)", () => {
    const config = buildOpencodeConfig({
      apiKey: "sk-x",
      model: "m-1",
      models: { "m-1": { name: "M1" } },
      options: { npm: "@ai-sdk/openai-compatible", name: "ai&", baseURL: "https://api.aiand.com/v1" },
    });
    assert.equal(config.provider.aiand.options.apiKey, "sk-x");
    assert.equal(config.provider.aiand.options.baseURL, "https://api.aiand.com/v1");
    assert.equal(config.model, "aiand/m-1");
    assert.deepEqual(config.enabled_providers, ["aiand"]);
    assert.deepEqual(config.disabled_providers, ["opencode"]);
    assert.equal(config["x-aiand"], true);
  });
});

describe("opencode sessionLaunch", () => {
  function catalogModels() {
    return [
      {
        id: "zai-org/glm-5.3",
        name: "GLM 5.3",
        object: "model",
        created: 0,
        owned_by: "ai&",
        provider: "zai",
        context_window: 1048576,
        capabilities: ["reasoning", "tool_calling"],
        reasoning_efforts: ["low", "high", "max"],
        reasoning_effort_default: "max",
        description: null,
        currency: "usd",
        input_per_1m: "1",
        output_per_1m: "4",
        cached_input_per_1m: "0.3",
      },
      {
        id: "vision-model",
        name: "Vision",
        object: "model",
        created: 0,
        owned_by: "ai&",
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

  test("OPENCODE_CONFIG_CONTENT parses; key baked; default model resolved from catalog", async () => {
    // default model: run-agent passes undefined → resolveDefault(catalog)
    const launch = await opencodeAdapter.sessionLaunch({
      apiKey: "sk-launch-1",
      model: undefined,
      catalog: catalogModels(),
    });
    assert.deepEqual(launch.clear, []);
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.provider.aiand.options.apiKey, "sk-launch-1");
    assert.equal(config.provider.aiand.options.baseURL, "https://api.aiand.com/v1");
    // model resolved from catalog (first tool-capable / default order)
    assert.match(config.model, /^aiand\//);
    assert.ok(config.model.startsWith("aiand/"));
  });

  test("explicit model used when present", async () => {
    const launch = await opencodeAdapter.sessionLaunch({
      apiKey: "sk-launch-1",
      model: "zai-org/glm-5.3",
      catalog: catalogModels(),
    });
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.model, "aiand/zai-org/glm-5.3");
  });

  test("entries built from Model[]: cost + limit fields derived", async () => {
    const launch = await opencodeAdapter.sessionLaunch({
      apiKey: "sk-launch-1",
      model: "zai-org/glm-5.3",
      catalog: catalogModels(),
    });
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    const glm = config.provider.aiand.models["zai-org/glm-5.3"];
    assert.equal(glm.reasoning, true);
    assert.equal(glm.tool_call, true);
    assert.equal(glm.limit.context, 1048576);
    // cost = per_1m / 1000
    assert.equal(glm.cost.input, 0.001);
    assert.equal(glm.cost.output, 0.004);
    assert.equal(glm.cost.cache_read, 0.0003);
    // vision model gets attachment + image modality
    const vision = config.provider.aiand.models["vision-model"];
    assert.equal(vision.attachment, true);
    assert.deepEqual(vision.modalities.input, ["text", "image"]);
    assert.equal(vision.reasoning, false);
  });
});

describe("opencode snapshot round-trip", () => {
  test("snapshot → enable → restore is byte-identical", async () => {
    const original =
      '{\n  "theme": "system",\n  "keybinds": { "quit": "q" },\n  "unrelated": [1, 2, 3]\n}\n';
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), original);

    const snapshot = await snapshotFiles("opencode", opencodeAdapter.managedFiles());
    assert.ok(snapshot);

    const self = globalThis;
    const originalFetch = self.fetch;
    self.fetch = async () => ({
      ok: true,
      json: async () => apiJsonFixture(),
    });
    let result;
    try {
      result = await opencodeAdapter.enable(enableInput());
    } finally {
      self.fetch = originalFetch;
    }
    assert.equal(result.filesWritten.length, 1);
    assert.notEqual(readFileSync(configPath(), "utf8"), original);

    const restored = await restoreSnapshot("opencode");
    assert.equal(restored, true);
    assert.equal(readFileSync(configPath(), "utf8"), original);
    assert.equal(await hasSnapshot("opencode"), false);
  });
});