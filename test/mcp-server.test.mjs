import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { describe } from "node:test";
import { openStore, storePath } from "../dist/store/index.js";
import { BIN, CLOSED_URL, FAKE_API_KEY, runCli, waitFor, withTestEnv } from "./helpers.mjs";

/**
 * OBS-P3-1 (#70): the `aiand mcp` stdio MCP server. Tests drive the BUILT CLI
 * as a subprocess over newline-delimited JSON-RPC (exactly what an MCP client
 * does), against seeded stores under isolated AIAND_CONFIG_DIR, with
 * AIAND_NO_SYNC=1 so no tool ever reaches the network. Equality against the
 * CLI payloads uses fixed --since/--until windows so both sides are
 * deterministic; `--last` is covered shape-wise (its window depends on now).
 */

const box = withTestEnv("aiand-mcp-", () => {});

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

function envFor(dir, overrides = {}) {
  const env = {
    ...process.env,
    AIAND_CONFIG_DIR: dir,
    AIAND_HOME: join(box.dir, "home"),
    AIAND_API_KEY: FAKE_API_KEY,
    AIAND_NO_SYNC: "1",
    NO_COLOR: "1",
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

function seedAgentKeys(dir, mappings) {
  writeFileSync(
    join(dir, "agent-keys.json"),
    `${JSON.stringify(
      {
        version: 1,
        keys: mappings.map(([agent, masked]) => ({
          agent,
          masked,
          fingerprint: "f".repeat(16),
          at: 0,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

async function seed(dir, rows) {
  const previous = process.env.AIAND_CONFIG_DIR;
  process.env.AIAND_CONFIG_DIR = dir;
  try {
    const opened = openStore(storePath());
    assert.ok(opened.ok, `store failed to open: ${opened.reason ?? ""}`);
    const db = opened.db;
    const insert = db.prepare(
      "INSERT INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.model ?? "zai-org/glm-5.3",
        row.api_key ?? null,
        row.status_code ?? 200,
        row.ttft_ms ?? null,
        row.latency_ms ?? null,
        row.input_tokens ?? 100,
        row.output_tokens ?? 20,
        row.cached_tokens ?? 0,
        row.cost_value === undefined ? null : String(row.cost_value),
        row.cost_value ?? null,
        row.currency ?? "usd",
        row.created_at,
        row.created_at,
      );
    }
    db.close();
  } finally {
    process.env.AIAND_CONFIG_DIR = previous;
  }
}

function fixtureRows() {
  const t = (offsetMs) => new Date(NOW - offsetMs).toISOString();
  return [
    // harness "claude" — two requests a minute apart, one session
    {
      id: "c1",
      api_key: "sk-test-claude...aaaa",
      created_at: t(3 * HOUR),
      cost_value: 0.02,
      ttft_ms: 200,
      latency_ms: 5000,
    },
    {
      id: "c2",
      api_key: "sk-test-claude...aaaa",
      created_at: t(3 * HOUR - 60_000),
      cost_value: 0.03,
      ttft_ms: 400,
      latency_ms: 5000,
    },
    // harness "codex" — three requests, another session
    {
      id: "x1",
      api_key: "sk-test-codex...bbbb",
      created_at: t(5 * HOUR),
      cost_value: 0.1,
      ttft_ms: 100,
    },
    {
      id: "x2",
      api_key: "sk-test-codex...bbbb",
      created_at: t(5 * HOUR - 60_000),
      cost_value: 0.1,
      ttft_ms: 100,
    },
    {
      id: "x3",
      api_key: "sk-test-codex...bbbb",
      created_at: t(5 * HOUR - 120_000),
      cost_value: 0.1,
      ttft_ms: 100,
    },
  ];
}

const WINDOW = { since: "2026-10-01", until: "2030-01-01" };

/** Fields that legitimately differ between the MCP tool and the CLI document
 * are normalized before parity deepEquals: lagSeconds is computed from "now"
 * on both sides (milliseconds apart), and harness names are pseudonymized by
 * the tool (asserted separately via /^project-/). */
const stableDoc = (doc) =>
  JSON.parse(
    JSON.stringify(doc, (key, value) => {
      if (key === "lagSeconds" && typeof value === "number") return "<lag>";
      if (key === "harness" && typeof value === "string") return "<harness>";
      if (key === "agent" && typeof value === "string") return "<agent>";
      return value;
    }),
  );

function startServer(dir, envOverrides = {}) {
  const child = spawn(process.execPath, [BIN, "mcp"], {
    env: envFor(dir, envOverrides),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const pending = new Map();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // non-JSON line (server banner, stray output) — never break the pump
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      // RPC-level errors resolve — tests assert on response.error.code.
      waiter.resolve(message);
    }
  });
  let nextId = 0;
  const request = (method, params = {}) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const close = () =>
    new Promise((resolve) => {
      child.on("close", resolve);
      child.stdin.end();
      // Windows stdin close does not always propagate to the child prompt;
      // make sure no MCP server process outlives the test.
      setTimeout(() => child.kill(), 2_000).unref();
    });
  return { child, request, send, close, waitFor, rl, stderrText: () => stderr };
}

async function initialized(dir, envOverrides = {}) {
  const server = startServer(dir, envOverrides);
  const init = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { server, init };
}

async function callTool(server, name, args = {}) {
  const response = await server.request("tools/call", { name, arguments: args });
  assert.equal(response.jsonrpc, "2.0");
  return response;
}

function resultOf(response) {
  assert.equal(response.result.isError, false, JSON.stringify(response.result));
  assert.equal(response.result.content[0].type, "text");
  assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
  return response.result.structuredContent;
}

describe("aiand mcp — protocol", () => {
  test("initialize echoes the protocol version and lists exactly the four tools", async () => {
    const dir = join(box.dir, "proto");
    mkdirSync(dir, { recursive: true });
    const { server, init } = await initialized(dir);
    try {
      assert.equal(init.jsonrpc, "2.0");
      assert.equal(init.result.protocolVersion, "2025-06-18");
      assert.equal(init.result.serverInfo.name, "aiand");
      assert.ok(init.result.capabilities.tools);
      const listed = await server.request("tools/list");
      assert.deepEqual(
        listed.result.tools.map((tool) => tool.name),
        ["usage_stats", "session_stats", "harness_compare", "spend_check"],
      );
      for (const tool of listed.result.tools) {
        assert.ok(tool.description.length > 40, tool.name);
        assert.equal(tool.inputSchema.type, "object");
      }
      // units and time semantics live in the descriptions (ticket req 6)
      assert.match(listed.result.tools[0].description, /USD/);
      assert.match(listed.result.tools[0].description, /last/);
      assert.match(listed.result.tools[3].description, /per hour/);
    } finally {
      await server.close();
    }
  });

  test("ping answers; unknown methods and tools are protocol errors", async () => {
    const dir = join(box.dir, "proto");
    const { server } = await initialized(dir);
    try {
      const pong = await server.request("ping");
      assert.deepEqual(pong.result, {});
      const bad = await server.request("resources/list");
      assert.equal(bad.error.code, -32601);
      const unknownTool = await server.request("tools/call", { name: "nope", arguments: {} });
      assert.equal(unknownTool.error.code, -32602);
      assert.deepEqual(unknownTool.error.data.known, [
        "usage_stats",
        "session_stats",
        "harness_compare",
        "spend_check",
      ]);
    } finally {
      await server.close();
    }
  });

  test("a malformed line gets a parse error and the server keeps going", async () => {
    const dir = join(box.dir, "proto");
    const server = startServer(dir);
    try {
      server.child.stdin.write("this is not json\n");
      // drain until the -32700 arrives, then prove the server still answers
      const parseError = await new Promise((resolve) => {
        server.rl.on("line", function once(line) {
          const message = JSON.parse(line);
          if (message.error?.code === -32700) resolve(message);
          else server.rl.once("line", once);
        });
      });
      assert.equal(parseError.id, null);
      const pong = await server.request("ping");
      assert.deepEqual(pong.result, {});
    } finally {
      await server.close();
    }
  });
});

describe("aiand mcp — tools over a seeded store", () => {
  test("usage_stats returns the same document as `aiand usage --json`", async () => {
    const dir = join(box.dir, "usage");
    mkdirSync(dir, { recursive: true });
    seedAgentKeys(dir, [
      ["claude", "sk-test-claude...aaaa"],
      ["codex", "sk-test-codex...bbbb"],
    ]);
    await seed(dir, fixtureRows());
    const { server } = await initialized(dir);
    try {
      const response = await callTool(server, "usage_stats", WINDOW);
      const payload = resultOf(response);
      const cli = await runCli(
        ["usage", "--since", WINDOW.since, "--until", WINDOW.until, "--json"],
        { env: envFor(dir) },
      );
      assert.equal(cli.code, 0, cli.stderr);
      assert.deepEqual(stableDoc(payload), stableDoc(JSON.parse(cli.stdout)));
      assert.equal(payload.sections.totals.requests, 5);
      assert.ok(payload.sections.totals.costs.usd > 0);
      // harness names are pseudonymized in by-agent keys (req 3) — a second
      // call with that section (the parity call above uses the defaults)
      const pseudo = resultOf(
        await callTool(server, "usage_stats", { ...WINDOW, sections: ["by-agent"] }),
      );
      assert.ok(pseudo.sections["by-agent"].length > 0);
      for (const row of pseudo.sections["by-agent"]) {
        assert.match(row.key, /^project-[0-9a-f]{4}$/);
      }
      // a --last window works and filters time (shape, not equality)
      const last = resultOf(await callTool(server, "usage_stats", { last: "4h" }));
      assert.equal(last.sections.totals.requests, 2);
      assert.match(last.meta.range.since, /^2026-/);
    } finally {
      await server.close();
    }
  });

  test("session_stats matches `aiand sessions --json` for the list and the drill-down", async () => {
    const dir = join(box.dir, "sessions");
    mkdirSync(dir, { recursive: true });
    seedAgentKeys(dir, [
      ["claude", "sk-test-claude...aaaa"],
      ["codex", "sk-test-codex...bbbb"],
    ]);
    await seed(dir, fixtureRows());
    const { server } = await initialized(dir);
    try {
      const list = resultOf(await callTool(server, "session_stats", { ...WINDOW }));
      assert.equal(list.sessionization.method, "time-gap");
      assert.equal(list.sessionization.confidence, "heuristic");
      assert.equal(list.sessions.length, 2);
      for (const session of list.sessions) {
        assert.match(session.harness, /^project-[0-9a-f]{4}$/);
      }

      const cliList = await runCli(
        ["sessions", "--since", WINDOW.since, "--until", WINDOW.until, "--json"],
        { env: envFor(dir) },
      );
      assert.equal(cliList.code, 0, cliList.stderr);
      assert.deepEqual(stableDoc(list), stableDoc(JSON.parse(cliList.stdout)));

      const id = list.sessions[0].id;
      const drill = resultOf(
        await callTool(server, "session_stats", { ...WINDOW, session_id: id }),
      );
      const cliDrill = await runCli(
        ["sessions", id, "--since", WINDOW.since, "--until", WINDOW.until, "--json"],
        { env: envFor(dir) },
      );
      assert.equal(cliDrill.code, 0, cliDrill.stderr);
      assert.deepEqual(stableDoc(drill), stableDoc(JSON.parse(cliDrill.stdout)));
      assert.equal(drill.requests.length, drill.session.turns);
      assert.ok(drill.session.ttft.p50 > 0);
    } finally {
      await server.close();
    }
  });

  test("harness_compare matches `aiand harness compare --json`", async () => {
    const dir = join(box.dir, "compare");
    mkdirSync(dir, { recursive: true });
    seedAgentKeys(dir, [
      ["claude", "sk-test-claude...aaaa"],
      ["codex", "sk-test-codex...bbbb"],
    ]);
    await seed(dir, fixtureRows());
    const { server } = await initialized(dir);
    try {
      const payload = resultOf(await callTool(server, "harness_compare", { ...WINDOW }));
      const cli = await runCli(
        ["harness", "compare", "--since", WINDOW.since, "--until", WINDOW.until, "--json"],
        { env: envFor(dir) },
      );
      assert.equal(cli.code, 0, cli.stderr);
      assert.deepEqual(stableDoc(payload), stableDoc(JSON.parse(cli.stdout)));
      assert.equal(payload.harnesses.length, 2);
      for (const row of payload.harnesses) {
        assert.match(row.harness, /^project-[0-9a-f]{4}$/);
        assert.ok(row.samples.every((sample) => /^project-[0-9a-f]{4}$/.test(sample.agent)));
      }
      // pseudonyms are stable and distinct per harness
      const names = payload.harnesses.map((row) => row.harness);
      assert.equal(new Set(names).size, 2);
      // scoping to one harness works by pseudonym-free real name
      const scoped = resultOf(
        await callTool(server, "harness_compare", { ...WINDOW, harness: "codex" }),
      );
      assert.equal(scoped.harnesses.length, 1);
    } finally {
      await server.close();
    }
  });

  test("spend_check reports burn, budget remaining, and a verdict", async () => {
    const dir = join(box.dir, "spend");
    mkdirSync(dir, { recursive: true });
    seedAgentKeys(dir, [["claude", "sk-test-claude...aaaa"]]);
    await seed(dir, [
      {
        id: "s1",
        api_key: "sk-test-claude...aaaa",
        created_at: new Date(NOW - 3 * HOUR).toISOString(),
        cost_value: 5,
        latency_ms: 60_000,
      },
      {
        id: "s2",
        api_key: "sk-test-claude...aaaa",
        created_at: new Date(NOW - 1 * HOUR).toISOString(),
        cost_value: 5,
        latency_ms: 60_000,
      },
    ]);
    writeFileSync(
      join(dir, "config.json"),
      `${JSON.stringify({
        profile: "default",
        profiles: { default: {} },
        budget: { monthly: 100, currency: "usd" },
      })}\n`,
    );
    const { server } = await initialized(dir);
    try {
      const payload = resultOf(await callTool(server, "spend_check"));
      assert.equal(payload.harness, null);
      assert.equal(payload.verdict, "on-pace");
      assert.equal(payload.currency, "usd");
      assert.equal(payload.budget, 100);
      assert.ok(Math.abs(payload.current_spend.value - 10) < 1e-9);
      assert.ok(Math.abs(payload.budget_remaining - 90) < 1e-9);
      assert.ok(payload.burn_rate_24h.value > 0);
      assert.match(payload.current_spend.provenance, /gateway-billed/);
      assert.match(payload.headline_rate.provenance, /heuristic/);
      // scoped to one harness, the echo is pseudonymized like every other name
      const scoped = resultOf(await callTool(server, "spend_check", { harness: "claude" }));
      assert.match(scoped.harness, /^project-[0-9a-f]{4}$/);
      assert.ok(scoped.current_spend.value > 0);
    } finally {
      await server.close();
    }
  });
});

describe("aiand mcp — privacy, emptiness, sync", () => {
  test("real project names opt-in via config mcp.realProjectNames", async () => {
    const dir = join(box.dir, "realnames");
    mkdirSync(dir, { recursive: true });
    seedAgentKeys(dir, [["claude", "sk-test-claude...aaaa"]]);
    await seed(dir, fixtureRows());
    writeFileSync(
      join(dir, "config.json"),
      `${JSON.stringify({
        profile: "default",
        profiles: { default: {} },
        mcp: { realProjectNames: true },
      })}\n`,
    );
    const { server } = await initialized(dir);
    try {
      const payload = resultOf(await callTool(server, "harness_compare", { ...WINDOW }));
      // Unmapped keys stay "unknown" even in real-names mode — honest, and anonymous.
      assert.deepEqual(
        payload.harnesses.map((row) => row.harness),
        ["claude", "unknown"],
      );
      // and `config set` flips it back without a server restart on the next call
      const set = await runCli(["config", "set", "mcp.realProjectNames", "false"], {
        env: envFor(dir),
      });
      assert.equal(set.code, 0, set.stderr);
      const after = resultOf(await callTool(server, "harness_compare", { ...WINDOW }));
      for (const row of after.harnesses) {
        // "unknown" is already anonymous — it never becomes a project- hash.
        if (row.harness === "unknown") continue;
        assert.match(row.harness, /^project-[0-9a-f]{4}$/);
      }
    } finally {
      await server.close();
    }
  });

  test("an empty or missing store returns empty results, not errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-mcp-empty-"));
    const { server } = await initialized(dir);
    try {
      const usage = resultOf(await callTool(server, "usage_stats"));
      assert.equal(usage.sections.totals.requests, 0);
      assert.deepEqual(usage.sections.totals.costs, {});
      const sessions = resultOf(await callTool(server, "session_stats"));
      assert.deepEqual(sessions.sessions, []);
      const compare = resultOf(await callTool(server, "harness_compare"));
      assert.deepEqual(compare.harnesses, []);
      const spend = resultOf(await callTool(server, "spend_check"));
      assert.ok(["no-data", "no-budget", "indeterminate"].includes(spend.verdict));
      // an unknown session id is a tool ERROR result, not a crash
      const bad = await callTool(server, "session_stats", { session_id: "nope" });
      assert.equal(bad.result.isError, true);
      assert.match(bad.result.content[0].text, /No session with id/);
    } finally {
      await server.close();
    }
  });

  test("sync failures fail open: the store serves as-is when the gateway is down", async () => {
    const dir = join(box.dir, "failopen");
    mkdirSync(dir, { recursive: true });
    await seed(dir, fixtureRows());
    // No AIAND_NO_SYNC: the server attempts the shared sync against an
    // unreachable gateway, reports it on stderr, and the tool still answers
    // from the local store.
    const { server } = await initialized(dir, {
      AIAND_BASE_URL: CLOSED_URL,
      AIAND_NO_SYNC: undefined,
    });
    try {
      const payload = resultOf(await callTool(server, "usage_stats", { last: "30d" }));
      assert.equal(payload.sections.totals.requests, 5);
      assert.match(server.stderrText(), /sync/);
    } finally {
      await server.close();
    }
  });
});
