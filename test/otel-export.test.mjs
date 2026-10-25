import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { before, describe } from "node:test";
import { CLOSED_URL, cliEnv, runCli, withEnv, withFetch, withTestEnv } from "./helpers.mjs";

// Ticket #72 (OBS-P3-2): OTel metrics export — the claude_code.* family
// (Claude Code dashboard compatibility) and the gen_ai.* family (OTel GenAI
// semconv), hand-emitted OTLP/HTTP JSON + Prometheus text from the local
// store. // #72

const box = withTestEnv("aiand-otel-export-", () => {
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

let rowSeq = 0;
function row(createdAt, overrides = {}) {
  rowSeq += 1;
  return {
    id: `row-${String(rowSeq).padStart(4, "0")}`,
    model: "zai-org/glm-5.3",
    api_key: "sk-abcd...1234",
    status_code: 200,
    ttft_ms: 300,
    latency_ms: 1500,
    input_tokens: 1000,
    output_tokens: 300,
    cached_tokens: 400,
    cost: "0.0042",
    cost_value: 0.0042,
    currency: "usd",
    created_at: createdAt,
    ...overrides,
  };
}

async function seedStore(dir, rows) {
  await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
    const store = await import("../dist/store/index.js");
    const opened = store.openStore(store.storePath());
    assert.ok(opened.ok, `store open failed: ${opened.reason ?? ""}`);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      insert.run(
        r.id,
        r.model,
        r.api_key,
        r.status_code,
        r.ttft_ms,
        r.latency_ms,
        r.input_tokens,
        r.output_tokens,
        r.cached_tokens,
        r.cost,
        r.cost_value,
        r.currency,
        r.created_at,
        new Date().toISOString(),
      );
    }
    opened.db.close();
  });
  return dir;
}

/** Map the fixture masked key to an agent so agent.name attribution kicks in. */
function seedAgentKey(dir) {
  writeFileSync(
    join(dir, "agent-keys.json"),
    JSON.stringify(
      {
        version: 1,
        keys: [
          {
            agent: "claude",
            masked: "sk-abcd...1234",
            fingerprint: "f".repeat(16),
            at: 0,
          },
        ],
      },
      null,
      2,
    ),
  );
}

const withStoreEnv = (dir, fn) =>
  withEnv(
    cliEnv({
      AIAND_CONFIG_DIR: dir,
      AIAND_BASE_URL: CLOSED_URL,
      AIAND_NO_SYNC: "1",
    }),
    fn,
  );

// Fixture window: fixed instants so sessions and windows are deterministic.
const T0 = "2026-10-24T10:00:00.000Z";
const T1 = "2026-10-24T10:05:00.000Z"; // 5 min after T0 — same session (10 min gap)
const T2 = "2026-10-24T10:30:00.000Z"; // 25 min after T1 — new session
const WINDOW = { range: "30days" };

async function buildFixturePayload(dir, { extraRows = [] } = {}) {
  const all = [
    row(T0),
    row(T1, { cost: "0.0010", cost_value: 0.001 }),
    // A failed request: usage recorded too, with error.type (semconv).
    row(T2, {
      status_code: 429,
      ttft_ms: null,
      latency_ms: 200,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      cost: "0",
      cost_value: 0,
    }),
    ...extraRows,
  ];
  await seedStore(dir, all);
  const payload = await withStoreEnv(dir, async () => {
    const otel = await import("../dist/obs/otel.js");
    return otel.buildExportPayload({ ...WINDOW });
  });
  return { dir, payload };
}

const EXPECTED_METRICS = [
  "claude_code.cost.usage",
  "claude_code.session.count",
  "claude_code.token.usage",
  "gen_ai.client.inference.duration",
  "gen_ai.client.inference.operation.input_tokens",
  "gen_ai.client.inference.operation.output_tokens",
  "gen_ai.client.inference.usage.cache_read_tokens",
  "gen_ai.client.inference.usage.cache_write_tokens",
  "gen_ai.client.inference.usage.input_tokens",
  "gen_ai.client.inference.usage.output_tokens",
  "gen_ai.client.inference.usage.reasoning_tokens",
  "gen_ai.server.request.duration",
  "gen_ai.server.time_to_first_token",
];

describe("otel export: provider mapping (#72)", () => {
  test("gateway upstreams map to well-known gen_ai.provider.name values", async () => {
    const { providerForModel, PROVIDER_MAP_DOC } = await import("../dist/obs/otel.js");
    assert.equal(providerForModel("claude-sonnet-4-5"), "anthropic");
    assert.equal(providerForModel("gpt-5.1"), "openai");
    assert.equal(providerForModel("codex-max"), "openai");
    assert.equal(providerForModel("deepseek-v4"), "deepseek");
    assert.equal(providerForModel("kimi-k2.5"), "moonshot_ai");
    assert.equal(providerForModel("moonshot-v1"), "moonshot_ai");
    assert.equal(providerForModel("grok-4"), "x_ai");
    assert.equal(providerForModel("zai-org/glm-5.3"), "zai");
    // Unknown: the family string (segment before "/"), never a guess.
    assert.equal(providerForModel("vendor-x/whatever-9"), "vendor-x");
    assert.equal(providerForModel("mistral-large"), "mistral-large");
    // The documented table backs the docs page and the mapping above.
    assert.ok(PROVIDER_MAP_DOC.length >= 8);
  });
});

describe("otel export: payload from a fixture store (#72)", () => {
  let dir;
  let payload;

  before(async () => {
    const storeDir = freshDir("store");
    seedAgentKey(storeDir); // before the first build: the materialized sessions table bakes agent.name in
    const fixture = await buildFixturePayload(storeDir);
    dir = fixture.dir;
    payload = fixture.payload;
    assert.equal(payload.rows, 3);
    assert.deepEqual(payload.metricNames, EXPECTED_METRICS);
  });

  test("input-excludes-cache conversion + all four token types", async () => {
    // Parse the OTLP payload and pull the claude_code.token.usage series.
    // Series carry session.id, so the successful session (two rows) and the
    // failed request's session are separate points; totals must still hold.
    const doc = JSON.parse(payload.otlp);
    const metric = doc.resourceMetrics[0].scopeMetrics[0].metrics.find(
      (m) => m.name === "claude_code.token.usage",
    );
    assert.ok(metric, "claude_code.token.usage emitted");
    const points = metric.sum.dataPoints.map((p) => ({
      type: p.attributes.find((a) => a.key === "type").value.stringValue,
      value: Number(p.asInt ?? p.asDouble),
    }));
    const total = (type) =>
      points.filter((p) => p.type === type).reduce((sum, p) => sum + p.value, 0);
    // Gateway rows: input=1000 INCLUDES cached=400 → type=input must be
    // (1000 - 400) × 2 = 1200, not 2000.
    assert.equal(total("input"), 1200);
    assert.equal(total("output"), 600);
    assert.equal(total("cacheRead"), 800);
    // OBS-GW-1: 0 until the gateway splits cache writes.
    assert.equal(total("cacheCreation"), 0);
    assert.deepEqual(
      points.filter((p) => p.type === "cacheCreation").map((p) => p.value),
      [0, 0],
    );
  });

  test("cost.usage sums gateway-billed cost as double, per model + agent + masked key", async () => {
    const doc = JSON.parse(payload.otlp);
    const metric = doc.resourceMetrics[0].scopeMetrics[0].metrics.find(
      (m) => m.name === "claude_code.cost.usage",
    );
    assert.equal(metric.unit, "USD");
    assert.equal(metric.sum.dataPoints.length, 2, "success session + failed session");
    const total = metric.sum.dataPoints.reduce((sum, p) => sum + Number(p.asInt ?? p.asDouble), 0);
    assert.equal(total, 0.0052);
    const point = metric.sum.dataPoints.find((p) => Number(p.asInt ?? p.asDouble) > 0);
    const attrs = Object.fromEntries(point.attributes.map((a) => [a.key, a.value.stringValue]));
    assert.equal(attrs.model, "zai-org/glm-5.3");
    assert.equal(attrs["agent.name"], "claude");
    assert.equal(attrs["aiand.key.masked"], "sk-abcd...1234");
    assert.equal(attrs.query_source, "claude");
  });

  test("session.count: two heuristic sessions with start_type + standard attrs", async () => {
    const doc = JSON.parse(payload.otlp);
    const metric = doc.resourceMetrics[0].scopeMetrics[0].metrics.find(
      (m) => m.name === "claude_code.session.count",
    );
    assert.equal(metric.sum.dataPoints.length, 2, "10-min gap split, 25-min gap split");
    for (const point of metric.sum.dataPoints) {
      const attrs = Object.fromEntries(point.attributes.map((a) => [a.key, a.value.stringValue]));
      // Honest derived marker: sessions are time-gap heuristics (#66).
      assert.equal(attrs.start_type, "derived");
      assert.match(attrs["session.id"], /^[0-9a-f]{16}$/);
      assert.equal(attrs["agent.name"], "claude");
      assert.equal(attrs["terminal.type"], process.env.TERM ?? "unknown");
      assert.match(attrs["app.version"], /^\d+\.\d+/);
    }
  });

  test("gen_ai counters: required attrs, failed ops carry error.type + usage", async () => {
    const doc = JSON.parse(payload.otlp);
    const metrics = doc.resourceMetrics[0].scopeMetrics[0].metrics;
    const input = metrics.find((m) => m.name === "gen_ai.client.inference.usage.input_tokens");
    // Success (1000, verbatim gateway sum incl. cache) and failed (0) are
    // separate series — usage recorded on failed operations, grouped by
    // error.type per semconv.
    assert.equal(input.sum.dataPoints.length, 2);
    const byError = input.sum.dataPoints.map((p) => ({
      error: p.attributes.find((a) => a.key === "error.type")?.value.stringValue,
      value: Number(p.asInt),
    }));
    assert.deepEqual(
      byError.sort((a, b) => String(a.error).localeCompare(String(b.error))),
      [
        { error: "429", value: 0 },
        { error: undefined, value: 2000 },
      ],
    );
    for (const point of input.sum.dataPoints) {
      const attrs = Object.fromEntries(point.attributes.map((a) => [a.key, a.value.stringValue]));
      assert.equal(attrs["gen_ai.operation.name"], "chat");
      assert.equal(attrs["gen_ai.provider.name"], "zai");
      assert.equal(attrs["gen_ai.token.modality"], "text");
      assert.equal(attrs["gen_ai.request.model"], "zai-org/glm-5.3");
      assert.equal(attrs["gen_ai.response.model"], "zai-org/glm-5.3");
      assert.equal(attrs["aiand.key.masked"], "sk-abcd...1234");
    }
  });

  test("histograms: explicit buckets cover latency and ttft, failed row excluded from ttft", async () => {
    const doc = JSON.parse(payload.otlp);
    const metrics = doc.resourceMetrics[0].scopeMetrics[0].metrics;
    const ttft = metrics.find((m) => m.name === "gen_ai.server.time_to_first_token");
    assert.ok(ttft, "time_to_first_token emitted");
    const success = ttft.histogram.dataPoints.find(
      (p) => !p.attributes.some((a) => a.key === "error.type"),
    );
    const failed = ttft.histogram.dataPoints.find((p) =>
      p.attributes.some((a) => a.key === "error.type" && a.value.stringValue === "429"),
    );
    assert.equal(Number(success.count), 2, "two successful ttft samples (s units)");
    assert.equal(Number(failed.count), 0, "failed row has no ttft (null) but the series exists");
    assert.ok(success.explicitBounds.length > 0);
    assert.equal(success.explicitBounds.length + 1, success.bucketCounts.length);
    const duration = metrics.find((m) => m.name === "gen_ai.client.inference.duration");
    const dSuccess = duration.histogram.dataPoints.find(
      (p) => !p.attributes.some((a) => a.key === "error.type"),
    );
    assert.equal(Number(dSuccess.count), 2);
    assert.equal(dSuccess.sum, (1500 + 1500) / 1000, "latency_ms converted to seconds");
  });

  test("delta temporality default; --temporality cumulative switches the enum", async () => {
    assert.equal(payload.temporality, "delta");
    let doc = JSON.parse(payload.otlp);
    assert.equal(doc.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality, 1);
    const cumulative = await withStoreEnv(dir, async () => {
      const otel = await import("../dist/obs/otel.js");
      return otel.buildExportPayload({ ...WINDOW, temporality: "cumulative" });
    });
    assert.equal(cumulative.temporality, "cumulative");
    doc = JSON.parse(cumulative.otlp);
    assert.equal(doc.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality, 2);
  });

  test("deterministic: same store + flags → identical payload modulo timestamps", async () => {
    const strip = (s) =>
      JSON.stringify(JSON.parse(s), (key, value) => (/UnixNano$/.test(key) ? "<ts>" : value));
    const again = await withStoreEnv(dir, async () => {
      const otel = await import("../dist/obs/otel.js");
      return otel.buildExportPayload({ ...WINDOW });
    });
    assert.equal(strip(payload.otlp), strip(again.otlp));
    assert.equal(payload.prometheus, again.prometheus);
  });

  test("privacy: metadata only — no content field anywhere in attrs", async () => {
    const doc = JSON.parse(payload.otlp);
    const keys = [];
    for (const m of doc.resourceMetrics[0].scopeMetrics[0].metrics) {
      const points = m.sum?.dataPoints ?? m.histogram?.dataPoints ?? [];
      for (const p of points) {
        for (const a of p.attributes) {
          keys.push(a.key);
          assert.ok(
            !/prompt|completion|content/i.test(a.key),
            `attribute ${a.key} must not carry content`,
          );
        }
      }
    }
    assert.ok(keys.includes("session.id"));
  });
});

describe("otel export: Prometheus text exposition (#72)", () => {
  test("parses: counter + histogram lines with sane le values and escaped labels", async () => {
    const dir = freshDir("prom-store");
    await seedStore(dir, [row(T0, { api_key: 'sk-we"ird\\key', cost: "0.5", cost_value: 0.5 })]);
    const payload = await withStoreEnv(dir, async () => {
      const otel = await import("../dist/obs/otel.js");
      return otel.buildExportPayload({ range: "30days" });
    });
    const lines = payload.prometheus.trimEnd().split("\n");

    // A minimal parser: every sample line is name{labels} value, TYPE declares
    // each metric once, and histogram le bounds are numerically ordered.
    const types = lines.filter((l) => l.startsWith("# TYPE "));
    assert.ok(types.some((l) => l === "# TYPE claude_code_token_usage counter"));
    assert.ok(types.some((l) => l === "# TYPE gen_ai_server_time_to_first_token histogram"));
    const samples = lines.filter((l) => l.length > 0 && !l.startsWith("#"));
    const sampleRe = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? (-?\d+(\.\d+)?|NaN|\+Inf)$/;
    for (const line of samples) assert.match(line, sampleRe);

    const inputLine = samples.find(
      (l) => l.startsWith("claude_code_token_usage{") && l.includes('type="input"'),
    );
    assert.match(inputLine, / 600$/);
    // Label values are escaped.
    assert.ok(
      samples.some((l) => l.includes('aiand_key_masked="sk-we\\"ird\\\\key"')),
      `escaped masked key label missing:\n${samples.join("\n")}`,
    );

    // Histogram bucket lines: within ONE series (identical label prefix up to
    // le), le ascending then +Inf, matching bucketCounts.
    const bucketLines = samples.filter((l) =>
      l.startsWith("gen_ai_server_time_to_first_token_bucket{"),
    );
    const groups = new Map();
    for (const line of bucketLines) {
      const labels = line.slice(line.indexOf("{") + 1, line.lastIndexOf("}"));
      const key = labels
        .split(",")
        .filter((pair) => !pair.startsWith("le="))
        .sort()
        .join(",");
      const list = groups.get(key) ?? [];
      list.push(line);
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      const leValues = list.map((l) => /le="([^"]+)"/.exec(l)[1]);
      // +Inf terminates the series; numeric le values ascend before it.
      const numeric = leValues.filter((le) => le !== "+Inf");
      for (let i = 1; i < numeric.length; i += 1) {
        assert.ok(Number(numeric[i]) > Number(numeric[i - 1]), "le values ascend within a series");
      }
      assert.equal(leValues.at(-1), "+Inf");
    }
    assert.ok(groups.size >= 1);
  });

  test("counters carry per-agent/key attrs so concurrent exports never collide", async () => {
    const dir = freshDir("collide-store");
    await seedStore(dir, [row(T0)]);
    const payload = await withStoreEnv(dir, async () => {
      const otel = await import("../dist/obs/otel.js");
      return otel.buildExportPayload({ range: "30days" });
    });
    for (const line of payload.prometheus.split("\n")) {
      if (
        line.startsWith("claude_code_cost_usage{") ||
        line.startsWith("claude_code_token_usage{")
      ) {
        assert.match(line, /agent_name="/, "agent.name on cost/token series");
        assert.match(line, /aiand_key_masked="/, "masked key on cost/token series");
      }
    }
  });
});

describe("otel export: CLI surface (#72)", () => {
  let dir;
  test.before(async () => {
    dir = freshDir("cli-store");
    await seedStore(dir, [row(T0), row(T1)]);
    seedAgentKey(dir);
  });

  const cli = (args) =>
    runCli(args, {
      env: cliEnv({
        AIAND_CONFIG_DIR: dir,
        AIAND_BASE_URL: CLOSED_URL,
        AIAND_NO_SYNC: "1",
        NO_COLOR: "1",
        CI: "1",
      }),
    });

  test("stdout OTLP is valid JSON; summary goes to stderr", async () => {
    const { code, stdout, stderr } = await cli(["export", "--format", "otel", "--range", "30days"]);
    assert.equal(code, 0, stderr);
    const doc = JSON.parse(stdout);
    assert.equal(doc.resourceMetrics[0].resource.attributes[0].key, "service.name");
    assert.match(stderr, /2 requests/);
  });

  test("--file writes the payload; --format prometheus writes exposition text", async () => {
    const file = join(dir, "metrics.prom");
    const { code, stderr } = await cli([
      "export",
      "--format",
      "prometheus",
      "--range",
      "30days",
      "--file",
      file,
    ]);
    assert.equal(code, 0, stderr);
    const text = readFileSync(file, "utf8");
    assert.match(text, /# TYPE claude_code_token_usage counter/);
    assert.match(stderr, /Wrote prometheus metrics for 2 requests/);
  });

  test("bad --format / bad --since are clean CLI errors", async () => {
    const badFormat = await cli(["export", "--format", "influx"]);
    assert.equal(badFormat.code, 1);
    assert.match(badFormat.stderr, /--format/);
    const badSince = await cli(["export", "--since", "yesterday"]);
    assert.equal(badSince.code, 1);
    assert.match(badSince.stderr, /--since/);
  });

  test("cumulative temporality via flag lands in the payload", async () => {
    const { code, stdout } = await cli([
      "export",
      "--temporality",
      "cumulative",
      "--range",
      "30days",
    ]);
    assert.equal(code, 0);
    const doc = JSON.parse(stdout);
    const first = doc.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.sum);
    assert.equal(first.sum.aggregationTemporality, 2);
  });
});

describe("otel export: --endpoint push (#72)", () => {
  test("POSTs OTLP JSON with content-type and custom headers; non-2xx is a CLI error", async () => {
    const dir = freshDir("endpoint-store");
    await seedStore(dir, [row(T0)]);
    await withStoreEnv(dir, async () => {
      const { run } = await import("../dist/commands/export.js");
      const calls = [];
      await withFetch(
        async (url, init = {}) => {
          calls.push({ url: String(url), init });
          return { ok: true, status: 200, statusText: "OK" };
        },
        async () => {
          await run([
            "--endpoint",
            "https://collector.example/v1/metrics",
            "--header",
            "x-api-key: secret-push-token",
            "--range",
            "30days",
          ]);
        },
      );
      assert.equal(calls.length, 1);
      const { url, init } = calls[0];
      assert.equal(url, "https://collector.example/v1/metrics");
      assert.equal(init.method, "POST");
      assert.equal(init.headers["content-type"], "application/json");
      assert.equal(init.headers["x-api-key"], "secret-push-token");
      const body = JSON.parse(init.body);
      assert.ok(Array.isArray(body.resourceMetrics));

      // A failed push is a loud error, not a silent drop.
      await withFetch(
        async () => ({ ok: false, status: 503, statusText: "Service Unavailable" }),
        async () => {
          await assert.rejects(
            run(["--endpoint", "https://collector.example/v1/metrics", "--range", "30days"]),
            /HTTP 503/,
          );
        },
      );
    });
  });

  test("prometheus push uses the exposition content type", async () => {
    const dir = freshDir("endpoint-prom-store");
    await seedStore(dir, [row(T0)]);
    await withStoreEnv(dir, async () => {
      const { run } = await import("../dist/commands/export.js");
      const calls = [];
      await withFetch(
        async (url, init = {}) => {
          calls.push({ url: String(url), init });
          return { ok: true, status: 200, statusText: "OK" };
        },
        async () => {
          await run([
            "--format",
            "prometheus",
            "--endpoint",
            "https://pushgateway.example/metrics/job/aiand",
          ]);
        },
      );
      assert.equal(calls[0].init.headers["content-type"], "text/plain; version=0.0.4");
      assert.match(calls[0].init.body, /^# TYPE /);
    });
  });
});
