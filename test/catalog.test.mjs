import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { withTestEnv, catalogModel } from "./helpers.mjs";

withTestEnv("aiand-catalog-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  delete process.env.AIAND_BASE_URL;
});

const catalog = await import("../dist/agents/catalog.js");

// Model objects shaped exactly like GET /v1/models returns.
const fixtureModels = [
  catalogModel("openai/gpt-5", { input: "1.20", output: "10.00", capabilities: ["tools"] }),
  catalogModel("zai-org/glm-5.3", { input: "0.60", output: "2.20", capabilities: ["tools"] }),
  catalogModel("google/gemma-4-31b-it", { input: "0.05", output: "0.20", capabilities: ["vision"] }),
  catalogModel("deepseek-ai/r1", { input: "0.40", output: "1.60", capabilities: ["tool-calling"] }),
  catalogModel("qwen/qwen3.8-27b", { input: "0.30", output: "1.00", capabilities: ["tool_calling"] }),
];

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
    const unknown = [catalogModel("a/model", { input: "1.00", output: "2.00", capabilities: [] })];
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
    const cachedList = [catalogModel("cached/only-model", { input: "1", output: "2", capabilities: ["tools"] })];
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
      const models = await catalog.getCatalog("https://api.aiand.com");
      assert.equal(models.length, 1);
      assert.equal(models[0].id, "cached/only-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a failed fetch falls back to a stale cache", async () => {
    const cachedList = [catalogModel("stale/model", { input: "1", output: "2", capabilities: ["tools"] })];
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
      const models = await catalog.getCatalog("https://api.aiand.com");
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
        () => catalog.getCatalog("https://api.aiand.com"),
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

describe("withContextTag", () => {
  const big = catalogModel("big/model", { input: "1", output: "2", capabilities: ["tools"] });
  big.context_window = 1_048_576;

  const boundaryMillion = catalogModel("million/model", {
    input: "1",
    output: "2",
    capabilities: ["tools"],
  });
  boundaryMillion.context_window = 1_000_000;

  const justUnder = catalogModel("under/model", {
    input: "1",
    output: "2",
    capabilities: ["tools"],
  });
  justUnder.context_window = 999_999;

  test("tags an id whose catalog entry has a >=1M context window", () => {
    assert.equal(catalog.withContextTag("big/model", [big]), "big/model[1m]");
  });

  test("boundary: exactly 1,000,000 is tagged; 999,999 is not", () => {
    assert.equal(catalog.withContextTag("million/model", [boundaryMillion]), "million/model[1m]");
    assert.equal(catalog.withContextTag("under/model", [justUnder]), "under/model");
  });

  test("unknown id passes through unchanged", () => {
    assert.equal(catalog.withContextTag("ghost/model", [big]), "ghost/model");
  });

  test("a sub-million entry is written bare", () => {
    assert.equal(catalog.withContextTag("openai/gpt-5", fixtureModels), "openai/gpt-5");
  });
});
