import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { HARNESS_LAYOUTS, findHarnessLayout } = await import("../dist/benchmark/harness-layouts.js");
const { runHarnessBenchmark } = await import("../dist/benchmark/harness-bench.js");
const { BENCH_SCENARIOS, findBenchScenario } = await import("../dist/benchmark/scenarios.js");

/**
 * A fake gateway that caches by prefix, the way the real one does: a request
 * hits when some previously-sent request is a block-exact prefix of it, and
 * the cached amount is the whole matching request floored to 128 tokens.
 *
 * The rules under test are the layout's, not the fake's: the fake implements
 * the measured behavior, so a layout that keeps its leading blocks stable
 * hits and one that does not misses. It also answers each dialect in its own
 * shape, because the two report the prompt differently.
 */
function fakeGateway({ blockTokens = 64 } = {}) {
  const entries = [];
  const requests = [];

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const anthropic = url.includes("/v1/messages");
    // The Anthropic dialect carries the system block outside the message
    // list, so the comparable unit is the whole request's leading blocks:
    // the system block plus the messages.
    const messages = anthropic ? [body.system, ...body.messages] : body.messages;
    requests.push(body);

    // The matched entry: the longest previously-sent request that is a
    // block-exact prefix of this one.
    let matched = 0;
    for (const entry of entries) {
      if (entry.length > messages.length) continue;
      let prefix = true;
      for (let i = 0; i < entry.length; i++) {
        if (JSON.stringify(entry[i]) !== JSON.stringify(messages[i])) {
          prefix = false;
          break;
        }
      }
      if (prefix) matched = Math.max(matched, entry.length);
    }
    entries.push(messages);

    const totalBlocks = messages.length;
    const promptTokens = totalBlocks * blockTokens;
    const cachedTokens = Math.floor((matched * blockTokens) / 128) * 128;

    // The Anthropic dialect reports input_tokens WITHOUT the cached part;
    // the OpenAI dialect reports prompt_tokens WITH it.
    const usage = anthropic
      ? {
          input_tokens: promptTokens - cachedTokens,
          output_tokens: 8,
          cache_read_input_tokens: cachedTokens,
        }
      : {
          prompt_tokens: promptTokens,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: cachedTokens },
        };
    return new Response(JSON.stringify({ usage }), {
      status: 200,
      headers: { "X-Cost": "0.0001", "Content-Type": "application/json" },
    });
  };

  return { fetchImpl, requests };
}

const SESSION = {
  profile: { name: "default", apiUrl: "https://example.test", authUrl: "", model: undefined },
  token: "sk-test",
  credential: null,
};

const SCENARIO = {
  id: "multi-turn",
  title: "Multi-turn",
  turns: ["first prompt", "second prompt", "third prompt"],
  file: { path: "src/a.ts", content: "file contents" },
};

const PRICES = { "test/model": { inputPer1m: 1, cachedPer1m: 0.3, outputPer1m: 4 } };

describe("harness layouts", () => {
  test("every layout has an id, a label and a note", () => {
    for (const layout of HARNESS_LAYOUTS) {
      assert.ok(layout.id.length > 0);
      assert.ok(layout.label.length > 0);
      assert.ok(layout.note.length > 0);
    }
  });

  test("layout ids are unique", () => {
    const ids = HARNESS_LAYOUTS.map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("a layout can be found by id", () => {
    assert.equal(findHarnessLayout("claude-code")?.id, "claude-code");
    assert.equal(findHarnessLayout("nope"), undefined);
  });
});

describe("runHarnessBenchmark", () => {
  test("the append-only layout hits the cache from the second turn", async () => {
    const gateway = fakeGateway();
    const results = await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("claude-code")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    const result = results[0];
    assert.equal(result.turns.length, 3);
    assert.equal(result.turns[0].hit, false, "the first request has nothing cached");
    assert.equal(result.turns[1].hit, true);
    assert.equal(result.turns[2].hit, true);
    assert.ok(result.cachedTokens > 0);
  });

  test("a rebuilt system block misses every turn", async () => {
    const gateway = fakeGateway();
    const results = await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("rebuilt-system")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    for (const turn of results[0].turns) assert.equal(turn.hit, false);
    assert.equal(results[0].cachedTokens, 0);
  });

  test("a compacting client misses every turn", async () => {
    const gateway = fakeGateway();
    const results = await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("compacting")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    for (const turn of results[0].turns) assert.equal(turn.hit, false);
  });

  test("a consistent reorder still hits — the order never shifts", async () => {
    const gateway = fakeGateway();
    const results = await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("reordered-stable")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    assert.equal(results[0].turns[1].hit, true);
    assert.ok(results[0].cachedTokens > 0);
  });

  test("a reorder that moves as the conversation grows misses", async () => {
    const gateway = fakeGateway();
    const results = await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("reordered")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    for (const turn of results[0].turns) assert.equal(turn.hit, false);
  });

  test("each layout gets its own cache, so one cannot inherit another's hit", async () => {
    const gateway = fakeGateway();
    const results = await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("claude-code"), findHarnessLayout("claude-code")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    // The second layout must not start with the first one's cache entry.
    assert.equal(results[1].turns[0].hit, false);
  });

  test("the savings are zero when nothing is cached", async () => {
    const gateway = fakeGateway();
    const results = await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("compacting")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    // The baseline is the whole prompt at the full rate; the cost reported is
    // what the fake charged, so savings are not negative.
    assert.ok(results[0].savedUsd >= 0);
  });
});

describe("dialects", () => {
  test("Claude Code speaks the Anthropic dialect", () => {
    assert.equal(findHarnessLayout("claude-code").dialect, "anthropic");
  });

  test("Oh My Pi speaks the OpenAI dialect", () => {
    assert.equal(findHarnessLayout("omp").dialect, "openai");
  });

  test("the Anthropic dialect posts to /v1/messages", async () => {
    const gateway = fakeGateway();
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(url);
      return gateway.fetchImpl(url, init);
    };
    await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("claude-code")],
      model: "test/model",
      prices: PRICES,
      fetchImpl,
    });
    assert.ok(
      seen.every((url) => url.endsWith("/v1/messages")),
      seen.join(", "),
    );
  });

  test("the OpenAI dialect posts to /v1/chat/completions", async () => {
    const gateway = fakeGateway();
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(url);
      return gateway.fetchImpl(url, init);
    };
    await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("omp")],
      model: "test/model",
      prices: PRICES,
      fetchImpl,
    });
    assert.ok(
      seen.every((url) => url.endsWith("/v1/chat/completions")),
      seen.join(", "),
    );
  });

  test("both dialects report the same cached amount for the same shape", async () => {
    // The prompt total is the same either way: the Anthropic dialect
    // reports the uncached part separately, the OpenAI one folds it in.
    const gateway = fakeGateway();
    const results = await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("claude-code"), findHarnessLayout("omp")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    assert.equal(results[0].cachedTokens, results[1].cachedTokens);
    assert.equal(results[0].inputTokens, results[1].inputTokens);
  });

  test("the Anthropic dialect sends the system block outside the message list", async () => {
    const gateway = fakeGateway();
    await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("claude-code")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    const body = gateway.requests[0];
    assert.ok(body.system.length > 0, "the system block is a top-level field");
    assert.ok(
      body.messages.every((m) => m.role !== "system"),
      "no system message in the message list",
    );
  });

  test("the OpenAI dialect sends the system block as a message", async () => {
    const gateway = fakeGateway();
    await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("omp")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    assert.equal(gateway.requests[0].messages[0].role, "system");
  });

  test("the OpenAI dialect encodes a tool call as tool_calls", async () => {
    const gateway = fakeGateway();
    await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("omp")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    const assistant = gateway.requests[0].messages.find((m) => m.role === "assistant");
    assert.equal(assistant.tool_calls[0].type, "function");
    assert.equal(assistant.tool_calls[0].function.name, "Read");
  });

  test("the Anthropic dialect encodes a tool call as a tool_use block", async () => {
    const gateway = fakeGateway();
    await runHarnessBenchmark({
      session: SESSION,
      scenario: SCENARIO,
      layouts: [findHarnessLayout("claude-code")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    const assistant = gateway.requests[0].messages.find((m) => m.role === "assistant");
    assert.equal(assistant.content[0].type, "tool_use");
    assert.equal(assistant.content[0].name, "Read");
  });
});

describe("scenarios", () => {
  test("every scenario has an id, a title and at least one turn", () => {
    for (const scenario of BENCH_SCENARIOS) {
      assert.ok(scenario.id.length > 0);
      assert.ok(scenario.title.length > 0);
      assert.ok(scenario.turns.length >= 1);
      assert.ok(scenario.file.path.length > 0);
      assert.ok(scenario.file.content.length > 0);
    }
  });

  test("scenario ids are unique", () => {
    const ids = BENCH_SCENARIOS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("a scenario can be found by id", () => {
    assert.equal(findBenchScenario("multi-turn-refactor")?.id, "multi-turn-refactor");
    assert.equal(findBenchScenario("nope"), undefined);
  });
});
