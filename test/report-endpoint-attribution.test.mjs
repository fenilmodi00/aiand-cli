import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { withEnv, withTestEnv } from "./helpers.mjs";

// Endpoint-dialect harness attribution (#harness-endpoint): a masked key held
// by several agents resolves per row via the gateway's wire-dialect `endpoint`
// (/v1/messages → claude, /v1/responses → codex, /v1/chat/completions → the
// chat-family agents), endpoint-less rows honestly share, and sessionization
// marks a session whose members mix dialects "shared".

const box = withTestEnv("aiand-report-endpoint-", () => {
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_NO_SYNC;
});

function freshDir(name) {
  const dir = join(box.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One masked key mapped to [claude, omp] — the shared-key mislabel scenario. */
function seedSharedKey(dir) {
  writeFileSync(
    join(dir, "agent-keys.json"),
    JSON.stringify({
      version: 1,
      keys: [
        { agent: "claude", masked: "sk-abcd...1234", fingerprint: "f1", at: 1 },
        { agent: "omp", masked: "sk-abcd...1234", fingerprint: "f2", at: 2 },
      ],
    }),
  );
}

async function seedStore(dir, rows) {
  await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
    const store = await import("../dist/store/index.js");
    const opened = store.openStore(store.storePath());
    assert.ok(opened.ok, `store open failed: ${opened.reason ?? ""}`);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, endpoint, status_code, ttft_ms, " +
        "latency_ms, input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, " +
        "created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      insert.run(
        r.id,
        r.model,
        r.api_key,
        r.endpoint ?? null,
        r.status_code ?? 200,
        r.ttft_ms ?? 100,
        r.latency_ms ?? 500,
        r.input_tokens ?? 1000,
        r.output_tokens ?? 300,
        r.cached_tokens ?? 400,
        r.cost ?? "0.0042",
        r.cost_value ?? 0.0042,
        r.currency ?? "usd",
        r.created_at,
        new Date().toISOString(),
      );
    }
    opened.db.close();
  });
}

let rowSeq = 0;
/** A store row on the shared key; endpoint picks the dialect. */
function row(createdAt, overrides = {}) {
  rowSeq += 1;
  return {
    id: `row-${String(rowSeq).padStart(3, "0")}`,
    model: "zai-org/glm-5.3",
    api_key: "sk-abcd...1234",
    created_at: createdAt,
    ...overrides,
  };
}

const PINNED_NOW = new Date("2026-10-22T12:00:00.000Z");

describe("endpoint-dialect harness attribution", () => {
  test("byHarness splits a shared key by endpoint; endpoint-null rows share", async () => {
    const dir = freshDir("report-data");
    seedSharedKey(dir);
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "m1", endpoint: "/v1/messages" }),
      row("2026-10-20T11:00:00.000Z", { id: "m2", endpoint: "/v1/messages" }),
      row("2026-10-20T12:00:00.000Z", { id: "cc1", endpoint: "/v1/chat/completions" }),
      row("2026-10-20T13:00:00.000Z", { id: "old1", endpoint: null }),
    ]);
    const { buildReportData } = await import("../dist/report/data.js");
    const data = await withEnv({ AIAND_CONFIG_DIR: dir }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    const byHarness = Object.fromEntries(data.byHarness.map((h) => [h.harness, h.requests]));
    assert.equal(byHarness.claude, 2);
    assert.equal(byHarness.omp, 1);
    assert.equal(byHarness.shared, 1);
    assert.equal(byHarness.unknown, undefined);
  });

  test("harness filter is endpoint-aware", async () => {
    const dir = freshDir("report-filter");
    seedSharedKey(dir);
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "m1", endpoint: "/v1/messages" }),
      row("2026-10-20T12:00:00.000Z", { id: "cc1", endpoint: "/v1/chat/completions" }),
    ]);
    const { buildReportData } = await import("../dist/report/data.js");
    const data = await withEnv({ AIAND_CONFIG_DIR: dir }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: ["omp"],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    assert.deepEqual(
      data.byHarness.map((h) => h.harness),
      ["omp"],
    );
    assert.equal(data.byHarness[0]?.requests, 1);
    assert.equal(data.meta.rowCount, 1);
  });

  test("sessions on one key: mixed endpoints → shared, one dialect → that agent", async () => {
    const dir = freshDir("report-sessions");
    seedSharedKey(dir);
    await seedStore(dir, [
      // One gap-separated session mixing dialects → "shared".
      row("2026-10-20T10:00:00.000Z", { id: "s1", endpoint: "/v1/messages" }),
      row("2026-10-20T10:05:00.000Z", { id: "s2", endpoint: "/v1/chat/completions" }),
      // A separate session entirely on /v1/messages → "claude".
      row("2026-10-20T15:00:00.000Z", { id: "s3", endpoint: "/v1/messages" }),
      row("2026-10-20T15:05:00.000Z", { id: "s4", endpoint: "/v1/messages" }),
    ]);
    const { listSessions } = await import("../dist/store/sessions.js");
    const result = await withEnv({ AIAND_CONFIG_DIR: dir }, () => listSessions());
    const byAgent = Object.fromEntries(result.sessions.map((s) => [s.session_id, s.agent]));
    assert.deepEqual(Object.values(byAgent).sort(), ["claude", "shared"]);
  });
});
