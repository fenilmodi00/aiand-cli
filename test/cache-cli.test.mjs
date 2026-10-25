import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FAKE_API_KEY, runCli, withTestEnv } from "./helpers.mjs";

// The `aiand cache` command, driven as the real binary against a stub
// gateway: it must read /logs, price the tokens from the catalog, and
// attribute requests to an agent by the key map.

const box = withTestEnv("aiand-cache-cli-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_HOME = join(dir, "home");
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
});

const { recordAgentKey } = await import("../dist/api/agent-keys.js");

function logEntry(overrides = {}) {
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

const MODELS = {
  object: "list",
  data: [
    {
      id: "zai-org/glm-5.3",
      name: "GLM 5.3",
      object: "model",
      created: 0,
      owned_by: "zai-org",
      provider: "zai-org",
      context_window: 1000000,
      capabilities: ["tool_calling"],
      reasoning_efforts: null,
      reasoning_effort_default: null,
      description: null,
      currency: "usd",
      input_per_1m: "1.000000",
      output_per_1m: "4.000000",
      cached_input_per_1m: "0.300000",
    },
  ],
};

let server;
let baseUrl = "";
let logHandler = () => ({ data: [], has_more: false, next_after: null, next_after_id: null });

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/logs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(logHandler(url)));
      return;
    }
    if (url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MODELS));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

const cli = (args) =>
  runCli(args, {
    env: {
      ...process.env,
      AIAND_CONFIG_DIR: box.dir,
      AIAND_HOME: join(box.dir, "home"),
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: baseUrl,
      NO_COLOR: "1",
      CI: "1",
    },
    stdin: "ignore",
  });

describe("aiand cache", () => {
  test("reports the hit rate and what the cache saved", async () => {
    logHandler = () => ({
      data: [logEntry()],
      has_more: false,
      next_after: null,
      next_after_id: null,
    });
    const { code, stdout } = await cli(["cache", "--range", "24h"]);
    assert.equal(code, 0);
    assert.match(stdout, /hit rate\s+80\.0%/);
    assert.match(stdout, /saved by cache/);
  });

  test("--json emits the report as JSON", async () => {
    logHandler = () => ({
      data: [logEntry()],
      has_more: false,
      next_after: null,
      next_after_id: null,
    });
    const { code, stdout } = await cli(["cache", "--range", "24h", "--json"]);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.equal(report.totals.requests, 1);
    assert.equal(report.totals.cachedTokens, 800);
    assert.equal(report.hitRatio, 0.8);
  });

  test("groups by the agent the key map names", async () => {
    // A key long enough for the mask to look like the gateway's.
    await recordAgentKey("claude", "sk-aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666");
    logHandler = () => ({
      data: [logEntry({ api_key: "sk-aaaa...6666" })],
      has_more: false,
      next_after: null,
      next_after_id: null,
    });
    const { code, stdout } = await cli(["cache", "--range", "24h", "--json"]);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.deepEqual(
      report.byAgent.map((g) => g.key),
      ["claude"],
    );
  });

  test("--attribute labels a key the CLI cannot place", async () => {
    logHandler = () => ({
      data: [logEntry()],
      has_more: false,
      next_after: null,
      next_after_id: null,
    });
    const { code, stdout } = await cli([
      "cache",
      "--range",
      "24h",
      "--json",
      "--attribute",
      "omp=sk-aaaa...1111",
    ]);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.deepEqual(
      report.byAgent.map((g) => g.key),
      ["omp"],
    );
  });

  test("an unknown key is reported as unknown, never guessed", async () => {
    logHandler = () => ({
      data: [logEntry({ api_key: "sk-zzzz...9999" })],
      has_more: false,
      next_after: null,
      next_after_id: null,
    });
    const { code, stdout } = await cli(["cache", "--range", "24h", "--json"]);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.deepEqual(
      report.byAgent.map((g) => g.key),
      ["unknown"],
    );
    assert.equal(report.unattributedRequests, 1);
  });

  test("--by model groups by model instead of agent", async () => {
    logHandler = () => ({
      data: [logEntry()],
      has_more: false,
      next_after: null,
      next_after_id: null,
    });
    const { code, stdout } = await cli(["cache", "--range", "24h", "--by", "model", "--json"]);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.deepEqual(
      report.byModel.map((g) => g.key),
      ["zai-org/glm-5.3"],
    );
  });

  test("an empty window says so instead of printing an empty table", async () => {
    logHandler = () => ({ data: [], has_more: false, next_after: null, next_after_id: null });
    const { code, stdout } = await cli(["cache", "--range", "24h"]);
    assert.equal(code, 0);
    assert.match(stdout, /No requests in the last 24h\./);
  });
});
