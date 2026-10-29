import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { buildCacheReport, cacheVerdict } = await import("../dist/api/cache-report.js");
const { formatLabel, gatewayBilled, estimated, heuristic, labeled, provenanceAudit } = await import(
  "../dist/obs/provenance.js"
);

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

describe("provenance labels", () => {
  test("the three tiers format as the ticket spells them", () => {
    assert.equal(formatLabel(gatewayBilled("the cost field")), "gateway-billed");
    assert.equal(formatLabel(estimated("sums of input_tokens")), "estimated(sums of input_tokens)");
    assert.equal(
      formatLabel(heuristic("time-gap sessionization")),
      "heuristic(time-gap sessionization)",
    );
  });

  test("labeled wraps a value with its label at construction time", () => {
    const n = labeled(42, estimated("count of rows"));
    assert.equal(n.value, 42);
    assert.equal(n.provenance.kind, "estimated");
  });

  test("the audit catalog is complete and honestly labeled", () => {
    const rows = provenanceAudit();
    assert.ok(rows.length >= 10);
    for (const r of rows) {
      assert.ok(r.report.length > 0 && r.field.length > 0 && r.source.length > 0);
      assert.match(r.label, /^(gateway-billed|estimated\(|heuristic\(|simulated\()/);
    }
    // Cost that is billed by the gateway is labeled gateway-billed, and the
    // catalog says outright that we never recompute it.
    const cost = rows.find((r) => r.field === "totals.costUsd");
    assert.equal(cost.label, "gateway-billed");
    assert.match(cost.source, /never recomputed/);
    // Price-derived numbers are separate fields with estimated labels —
    // never passed off as the billed cost.
    assert.equal(
      rows.find((r) => r.field === "costIfUncached").label.startsWith("estimated("),
      true,
    );
    assert.equal(rows.find((r) => r.field === "savedUsd").label.startsWith("estimated("), true);
  });
});

describe("cache report provenance (ticket #68)", () => {
  test("every aggregate carries a label", () => {
    const report = buildCacheReport({ range: "1h", entries: [row()], agentByKey: {}, prices: {} });
    assert.equal(report.provenance.totals.costUsd.kind, "gateway-billed");
    assert.equal(report.provenance.totals.inputTokens.kind, "gateway-billed");
    assert.equal(report.provenance.totals.requests.kind, "estimated");
    assert.equal(report.provenance.hitRatio.kind, "estimated");
    assert.equal(report.provenance.costIfUncached.kind, "estimated");
    assert.equal(report.provenance.savedUsd.kind, "estimated");
  });

  test("unattributed carries count, share and the fix-it hint", () => {
    const report = buildCacheReport({
      range: "1h",
      entries: [row(), row({ id: "log-2", api_key: "sk-zzzz...9999" })],
      agentByKey: { "sk-aaaa...1111": "claude" },
    });
    assert.equal(report.unattributed.count, 1);
    assert.equal(report.unattributed.share, 0.5);
    assert.match(report.unattributed.hint, /--attribute/);
    // The unknown agent stays "unknown" — never guessed.
    assert.deepEqual(
      report.byAgent.map((g) => g.key),
      ["claude", "unknown"],
    );
  });

  test("zero requests give a zero share, not NaN", () => {
    const report = buildCacheReport({ range: "1h", entries: [], agentByKey: {} });
    assert.equal(report.unattributed.share, 0);
    assert.equal(
      cacheVerdict(report.byAgent[0] ?? { requests: 0, inputTokens: 0, cachedTokens: 0 }),
      "warn",
    );
  });

  test("cost is never recomputed from a price table (H3 rule)", () => {
    // Absurdly wrong prices must not move the billed cost one cent.
    const wrongPrices = {
      "zai-org/glm-5.3": { inputPer1m: 999, cachedPer1m: 999, outputPer1m: 999 },
    };
    const entries = [row(), row({ id: "log-2", cost: "0.0012" })];
    const withPrices = buildCacheReport({
      range: "1h",
      entries,
      agentByKey: {},
      prices: wrongPrices,
    });
    const withoutPrices = buildCacheReport({ range: "1h", entries, agentByKey: {} });
    assert.ok(Math.abs(withPrices.totals.costUsd - 0.0016) < 1e-12);
    assert.ok(Math.abs(withoutPrices.totals.costUsd - 0.0016) < 1e-12);
    assert.equal(withPrices.totals.costUsd, withoutPrices.totals.costUsd);
  });
});
