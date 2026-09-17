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

describe("visionLabel", () => {
  test("vision capability labels vision, everything else text-only", () => {
    assert.equal(catalog.visionLabel(fixtureModels[1]), "text-only");
    assert.equal(catalog.visionLabel(fixtureModels[2]), "vision");
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

  test("expired cache plus failed fetch throws instead of serving stale models", async () => {
    const cachedList = [catalogModel("stale/model", { input: "1", output: "2", capabilities: ["tools"] })];
    writeFileSync(
      join(process.env.AIAND_CONFIG_DIR, "model-catalog.json"),
      JSON.stringify({
        fetchedAt: Date.now() - 24 * 60 * 60 * 1000,
        baseUrl: "https://api.aiand.com",
        models: cachedList,
      })
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    try {
      await assert.rejects(() => catalog.getCatalog("https://api.aiand.com"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("failed fetch preserves the original CliError message (401)", async () => {
    const { ApiError } = await import("../dist/cli/errors.js");
    rmSync(join(process.env.AIAND_CONFIG_DIR, "model-catalog.json"), { force: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: { get: () => undefined },
      text: async () => JSON.stringify({ error: { message: "bad key" } }),
    });
    try {
      await assert.rejects(
        () => catalog.getCatalog("https://api.aiand.com"),
        (error) => error instanceof ApiError && error.status === 401 && /bad key/.test(error.message)
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("malformed-but-valid JSON cache is a miss, not a TypeError", async () => {
    mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
    writeFileSync(
      join(process.env.AIAND_CONFIG_DIR, "model-catalog.json"),
      JSON.stringify({
        fetchedAt: Date.now(),
        baseUrl: "https://api.aiand.com",
        models: { not: "an-array" },
      })
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    try {
      await assert.rejects(
        () => catalog.getCatalog("https://api.aiand.com"),
        (error) => {
          assert.match(error.message, /model catalog|Could not reach/);
          return true;
        }
      );
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
          assert.match(error.message, /model catalog|Could not reach/);
          assert.ok(error.hint);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
