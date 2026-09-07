import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;
const originalEnv = { ...process.env };

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-catalog-test-"));
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  delete process.env.AIAND_BASE_URL;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const catalog = await import("../dist/agents/catalog.js");

// Model objects shaped exactly like GET /v1/models returns.
const fixtureModels = [
  makeModel("openai/gpt-5", { input: "1.20", output: "10.00", capabilities: ["tools"] }),
  makeModel("zai-org/glm-5.3", { input: "0.60", output: "2.20", capabilities: ["tools"] }),
  makeModel("google/gemma-4-31b-it", { input: "0.05", output: "0.20", capabilities: ["vision"] }),
  makeModel("deepseek-ai/r1", { input: "0.40", output: "1.60", capabilities: ["tool-calling"] }),
  makeModel("qwen/qwen3.8-27b", { input: "0.30", output: "1.00", capabilities: ["tool_calling"] }),
];

function makeModel(id, { input, output, capabilities }) {
  return {
    id,
    name: id,
    object: "model",
    created: 0,
    owned_by: "aiand",
    provider: "aiand",
    context_window: 128000,
    capabilities,
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: input,
    output_per_1m: output,
    cached_input_per_1m: null,
  };
}

describe("resolveDefault", () => {
  test("prefers the curated order that exists in the live catalog", () => {
    assert.equal(catalog.resolveDefault(fixtureModels), "zai-org/glm-5.3");
  });

  test("honors an explicit profile model present in the catalog", () => {
    assert.equal(catalog.resolveDefault(fixtureModels, "deepseek-ai/r1"), "deepseek-ai/r1");
  });

  test("ignores a profile model the catalog no longer serves", () => {
    assert.equal(catalog.resolveDefault(fixtureModels, "retired/old-model"), "zai-org/glm-5.3");
  });

  test("falls back to the first catalog entry when no preferred id matches", () => {
    assert.equal(catalog.resolveDefault([fixtureModels[0]]), "openai/gpt-5");
  });
});

describe("resolveSlots", () => {
  test("opus is the priciest tool-capable output, haiku the cheapest input", () => {
    const slots = catalog.resolveSlots(fixtureModels);
    // gpt-5 output 10.00 beats glm-5.3 (2.20) and r1 (1.60); gemma is vision-only.
    assert.equal(slots.opus, "openai/gpt-5");
    // sonnet mirrors the default model.
    assert.equal(slots.sonnet, "zai-org/glm-5.3");
    // gemma has no tool capability; qwen spells it "tool_calling" the way the
    // live gateway does and undercuts r1 (0.30 vs 0.40).
    assert.equal(slots.haiku, "qwen/qwen3.8-27b");
  });

  test("treats missing capability info as tool-capable", () => {
    const unknown = [makeModel("a/model", { input: "1.00", output: "2.00", capabilities: [] })];
    assert.deepEqual(catalog.resolveSlots(unknown), {
      opus: "a/model",
      sonnet: "a/model",
      haiku: "a/model",
    });
  });
});

describe("getCatalog cache", () => {
  test("a fresh cache short-circuits the network", async () => {
    mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
    const cachedList = [makeModel("cached/only-model", { input: "1", output: "2", capabilities: ["tools"] })];
    writeFileSync(
      join(process.env.AIAND_CONFIG_DIR, "model-catalog.json"),
      JSON.stringify({
        fetchedAt: Date.now(),
        baseUrl: "https://api.aiand.com",
        models: cachedList,
      })
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("network must not be touched when the cache is fresh");
    };
    try {
      const models = await catalog.getCatalog("https://api.aiand.com", null);
      assert.equal(models.length, 1);
      assert.equal(models[0].id, "cached/only-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a failed fetch falls back to a stale cache", async () => {
    const cachedList = [makeModel("stale/model", { input: "1", output: "2", capabilities: ["tools"] })];
    writeFileSync(
      join(process.env.AIAND_CONFIG_DIR, "model-catalog.json"),
      JSON.stringify({
        fetchedAt: Date.now() - 24 * 60 * 60 * 1000, // 24h old: past the 6h TTL
        baseUrl: "https://api.aiand.com",
        models: cachedList,
      })
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    try {
      const models = await catalog.getCatalog("https://api.aiand.com", null);
      assert.equal(models[0].id, "stale/model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a failed fetch with no cache throws a CliError with a hint", async () => {
    rmSync(join(process.env.AIAND_CONFIG_DIR, "model-catalog.json"), { force: true });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    try {
      await assert.rejects(
        () => catalog.getCatalog("https://api.aiand.com", null),
        (error) => {
          assert.equal(error.name, "CliError");
          assert.match(error.message, /model catalog/);
          assert.match(error.hint, /network/);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
