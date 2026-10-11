import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { BIN, FAKE_API_KEY, runCli, waitFor, withEnv, withTestEnv } from "./helpers.mjs";

// An in-process /logs stub rather than test/mock-gateway.mjs: each test
// scripts its own pages (handler) and inspects the requests the CLI sent,
// which a separate-process mock cannot do. The CLI children are async
// spawns, so the parent event loop stays free to answer them.

const box = withTestEnv("aiand-logs-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
  delete process.env.AIAND_KEY_STORAGE;
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  mkdirSync(join(dir, "home"), { recursive: true });
});

function entry(id, overrides = {}) {
  return {
    id,
    model: "test/model",
    api_key: "sk-test",
    status_code: 200,
    ttft_ms: 10,
    latency_ms: 100,
    input_tokens: 5,
    output_tokens: 7,
    cached_tokens: null,
    cost: "0.001",
    currency: "usd",
    created_at: "2026-09-19T12:00:00.000Z",
    ...overrides,
  };
}

const ROWS = [entry("log-1"), entry("log-2"), entry("log-3"), entry("log-4"), entry("log-5")];

let server;
let baseUrl = "";
let handler = () => ({ data: [], has_more: false, next_after: null, next_after_id: null });
// `--follow` must stop within this after SIGINT, well inside its 30s interval.
const FOLLOW_EXIT_BUDGET_MS = 5_000;
const requests = [];

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/logs") {
      requests.push(url);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(handler(url)));
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

function childEnv() {
  return {
    ...process.env,
    AIAND_CONFIG_DIR: box.dir,
    AIAND_HOME: join(box.dir, "home"),
    AIAND_API_KEY: FAKE_API_KEY,
    AIAND_BASE_URL: baseUrl,
    NO_COLOR: "1",
    CI: "1",
  };
}

const cli = (args) => runCli(args, { env: childEnv(), stdin: "ignore" });

describe("logs footer and paging", () => {
  test("footer states the window total when nothing is truncated", async () => {
    requests.length = 0;
    handler = () => ({
      data: ROWS.slice(0, 3),
      has_more: false,
      next_after: null,
      next_after_id: null,
    });
    const { code, stdout } = await cli(["logs", "--limit", "20"]);
    assert.equal(code, 0);
    assert.match(stdout, /3 requests in the last 24h\./);
    assert.doesNotMatch(stdout, /showing/);
  });

  test("footer says showing when --limit truncates", async () => {
    requests.length = 0;
    handler = (url) => {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      return {
        data: ROWS.slice(0, limit),
        has_more: true,
        next_after: "cursor",
        next_after_id: "log-cursor",
      };
    };
    const { code, stdout } = await cli(["logs", "--limit", "2"]);
    assert.equal(code, 0);
    assert.match(stdout, /showing 2 requests in the last 24h \(use --limit to see more\)\./);
    assert.equal(stdout.split("test/model").length - 1, 2);
  });

  test("an over-delivering page is sliced to --limit", async () => {
    requests.length = 0;
    // Gateway ignores limit and reports no more pages; the CLI must still
    // show (and count) only what --limit asked for.
    handler = () => ({
      data: ROWS,
      has_more: false,
      next_after: null,
      next_after_id: null,
    });
    const { code, stdout } = await cli(["logs", "--limit", "2", "--json"]);
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).length, 2);

    const table = await cli(["logs", "--limit", "2"]);
    assert.equal(table.code, 0);
    assert.match(table.stdout, /showing 2 requests in the last 24h/);
    assert.equal(table.stdout.split("test/model").length - 1, 2);
  });
});

describe("logs --follow", () => {
  test("exits promptly on SIGINT instead of waiting out --interval", async () => {
    requests.length = 0;
    handler = () => ({ data: [], has_more: false, next_after: null, next_after_id: null });
    const seen = requests.length;
    const child = spawn(process.execPath, [BIN, "logs", "--follow", "--interval", "30"], {
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      await waitFor(() => requests.length > seen); // seed fetch done: now inside the 30s sleep
      await new Promise((r) => setTimeout(r, 200));
      const t0 = Date.now();
      child.kill("SIGINT");
      const code = await closed;
      const elapsed = Date.now() - t0;
      // On win32 the SIGINT terminates the process outright, so `close` reports
      // a null code instead of the 0 the clean handler path leaves behind.
      assert.ok(code === 0 || (process.platform === "win32" && code === null), `exit ${code}`);
      assert.ok(
        elapsed < FOLLOW_EXIT_BUDGET_MS,
        `follow took ${elapsed}ms to exit after SIGINT (interval 30s)`,
      );
      assert.match(stderr, /Following .*requests\. Ctrl-C to stop\./);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("follow registers one SIGINT handler and removes it on exit", async () => {
    const { run } = await import("../dist/commands/logs.js");
    requests.length = 0;
    handler = () => ({ data: [], has_more: false, next_after: null, next_after_id: null });
    const seen = requests.length;
    const before = process.listeners("SIGINT");
    await withEnv({ AIAND_API_KEY: FAKE_API_KEY, AIAND_BASE_URL: baseUrl }, async () => {
      const running = run(["--follow", "--interval", "30"]);
      await waitFor(() => requests.length > seen);
      const added = process.listeners("SIGINT").filter((l) => !before.includes(l));
      assert.equal(added.length, 1);
      added[0](); // simulate Ctrl-C without touching the runner's own listeners
      await running;
      assert.deepEqual(process.listeners("SIGINT"), before);
    });
  });
});
