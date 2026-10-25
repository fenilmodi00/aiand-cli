import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { buildCacheReport, cacheVerdict } = await import("../dist/api/cache-report.js");

// A /logs row, in the shape the Gateway returns.
function row(overrides = {}) {
  return {
    id: "log-1",
    model: "zai-org/glm-5.3",
    api_key: "sk-aaaa...1111",
    status_code: 200,
    ttft_ms: 10,
    latency_ms: 100,
    input_tokens: 1000,
    output_tokens: 20,
    cached_tokens: 800,
    cost: "0.0004",
    currency: "usd",
    created_at: "2026-10-21T12:00:00.000Z",
    ...overrides,
  };
}

const PRICES = {
  "zai-org/glm-5.3": { inputPer1m: 1, cachedPer1m: 0.3, outputPer1m: 4 },
};

describe("buildCacheReport", () => {
  test("counts requests, tokens and cost", () => {
    const report = buildCacheReport({
      range: "1h",
      entries: [row(), row({ id: "log-2", input_tokens: 500, cached_tokens: 0, cost: "0.0012" })],
      agentByKey: {},
      prices: PRICES,
    });
    assert.equal(report.totals.requests, 2);
    assert.equal(report.totals.inputTokens, 1500);
    assert.equal(report.totals.cachedTokens, 800);
    assert.equal(report.totals.outputTokens, 40);
    assert.ok(Math.abs(report.totals.costUsd - 0.0016) < 1e-12);
  });

  test("counts a zero-cache turn as a miss", () => {
    const report = buildCacheReport({
      range: "1h",
      entries: [row(), row({ id: "log-2", cached_tokens: 0 })],
      agentByKey: {},
      prices: PRICES,
    });
    assert.equal(report.totals.misses, 1);
  });

  test("hit ratio uses input_tokens, which already includes the cached part", () => {
    // 800 of 1000 prompt tokens were cached.
    const report = buildCacheReport({
      range: "1h",
      entries: [row()],
      agentByKey: {},
      prices: PRICES,
    });
    assert.equal(report.hitRatio, 0.8);
  });

  test("prices the uncached baseline at the full input rate", () => {
    // 1000 prompt tokens at $1/1M = $0.001, plus 20 output at $4/1M = $0.00008.
    const report = buildCacheReport({
      range: "1h",
      entries: [row()],
      agentByKey: {},
      prices: PRICES,
    });
    assert.equal(Number(report.costIfUncached.toFixed(8)), 0.00108);
    assert.equal(Number(report.savedUsd.toFixed(8)), 0.00108 - 0.0004);
  });

  test("a model with no catalog price contributes nothing to the baseline", () => {
    const report = buildCacheReport({
      range: "1h",
      entries: [row({ model: "unknown/model" })],
      agentByKey: {},
      prices: PRICES,
    });
    assert.equal(report.costIfUncached, 0);
  });

  test("groups by agent, using the local key map", () => {
    const report = buildCacheReport({
      range: "1h",
      entries: [
        row({ id: "a", api_key: "sk-aaaa...1111" }),
        row({ id: "b", api_key: "sk-bbbb...2222" }),
      ],
      agentByKey: { "sk-aaaa...1111": "claude", "sk-bbbb...2222": "codex" },
      prices: PRICES,
    });
    assert.deepEqual(
      report.byAgent.map((g) => g.key),
      ["claude", "codex"],
    );
    assert.equal(report.unattributedRequests, 0);
  });

  test("a key the map does not know is reported as unknown, never guessed", () => {
    const report = buildCacheReport({
      range: "1h",
      entries: [row({ api_key: "sk-zzzz...9999" })],
      agentByKey: { "sk-aaaa...1111": "claude" },
      prices: PRICES,
    });
    assert.deepEqual(
      report.byAgent.map((g) => g.key),
      ["unknown"],
    );
    assert.equal(report.unattributedRequests, 1);
  });

  test("groups by model and by key", () => {
    const report = buildCacheReport({
      range: "1h",
      entries: [row({ id: "a", model: "m/one" }), row({ id: "b", model: "m/two" })],
      agentByKey: {},
      prices: PRICES,
    });
    assert.deepEqual(report.byModel.map((g) => g.key).sort(), ["m/one", "m/two"]);
    assert.equal(report.byKey.length, 1);
  });
});

describe("cacheVerdict", () => {
  const group = (requests, cached, input) => ({
    key: "g",
    requests,
    inputTokens: input,
    cachedTokens: cached,
    outputTokens: 0,
    costUsd: 0,
    misses: 0,
  });

  test("too few requests to judge", () => {
    assert.equal(cacheVerdict(group(4, 1000, 1000)), "warn");
  });

  test("a low hit ratio is bad", () => {
    assert.equal(cacheVerdict(group(10, 100, 1000)), "bad");
  });

  test("a middling hit ratio warns", () => {
    assert.equal(cacheVerdict(group(10, 400, 1000)), "warn");
  });

  test("a high hit ratio is good", () => {
    assert.equal(cacheVerdict(group(10, 900, 1000)), "good");
  });
});
