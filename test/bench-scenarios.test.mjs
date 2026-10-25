import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { runCli } from "./helpers.mjs";

const { HARNESS_LAYOUTS, findHarnessLayout } = await import("../dist/benchmark/harness-layouts.js");
const { runHarnessBenchmark } = await import("../dist/benchmark/harness-bench.js");
const { BENCH_SCENARIOS, findBenchScenario } = await import("../dist/benchmark/scenarios.js");
const { help } = await import("../dist/commands/harness.js");

// #65 — the scenario pack expansion: new families, determinism, dialect
// parity, discoverability, and smoke runs over a stubbed transport.

const NEW_SCENARIO_IDS = ["multi-turn-refactor-long", "long-file-read", "tool-heavy"];

/**
 * The same fake prefix-caching gateway harness-bench.test.mjs uses: a
 * request hits when a previously-sent request is a block-exact prefix of
 * it, and each dialect reports usage in its own shape (OpenAI folds the
 * cached portion into prompt_tokens; Anthropic reports it separately).
 */
function fakeGateway({ blockTokens = 64 } = {}) {
  const entries = [];
  const requests = [];

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const anthropic = url.includes("/v1/messages");
    const messages = anthropic ? [body.system, ...body.messages] : body.messages;
    requests.push(body);

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

    const promptTokens = messages.length * blockTokens;
    const cachedTokens = Math.floor((matched * blockTokens) / 128) * 128;
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

const PRICES = { "test/model": { inputPer1m: 1, cachedPer1m: 0.3, outputPer1m: 4 } };

describe("scenario registry", () => {
  test("every scenario (old and new) has an id and a one-line description", () => {
    for (const scenario of BENCH_SCENARIOS) {
      assert.ok(scenario.id.length > 0);
      assert.ok(scenario.title.length > 0, `${scenario.id} needs a description`);
      assert.ok(!scenario.title.includes("\n"), `${scenario.id} title is one line`);
    }
  });

  test("scenario ids are unique", () => {
    const ids = BENCH_SCENARIOS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("the new families are registered and findable", () => {
    for (const id of NEW_SCENARIO_IDS) {
      assert.equal(findBenchScenario(id)?.id, id, id);
    }
  });

  test("the tool-heavy scenario declares more tool results than one per turn", () => {
    const toolHeavy = findBenchScenario("tool-heavy");
    assert.ok(toolHeavy.toolResults.length >= 3, "tool-heavy needs several tool exchanges");
  });

  test("help text lists every scenario id", () => {
    for (const scenario of BENCH_SCENARIOS) {
      assert.ok(help.includes(scenario.id), `help mentions ${scenario.id}`);
      assert.ok(help.includes(scenario.title), `help describes ${scenario.id}`);
    }
  });

  test("--list-scenarios prints id + description for every scenario", async () => {
    const { code, stdout } = await runCli(["harness", "--list-scenarios"]);
    assert.equal(code, 0);
    for (const scenario of BENCH_SCENARIOS) {
      assert.ok(stdout.includes(scenario.id), `lists ${scenario.id}`);
      assert.ok(stdout.includes(scenario.title), `describes ${scenario.id}`);
    }
  });

  test("--list-scenarios --json prints the registry", async () => {
    const { code, stdout } = await runCli(["harness", "--list-scenarios", "--json"]);
    assert.equal(code, 0);
    const registry = JSON.parse(stdout);
    assert.deepEqual(
      registry.map((s) => s.id),
      BENCH_SCENARIOS.map((s) => s.id),
    );
    for (const entry of registry) {
      assert.ok(entry.description.length > 0);
    }
  });
});

describe("determinism", () => {
  const FIXED_INPUT = {
    system: "fixed system block",
    toolOutput: "fixed tool output",
    toolCallId: "call_1",
    prompt: "first prompt",
    followUps: ["second prompt", "third prompt"],
  };

  test("two generations of the same scenario through the same layout are identical", () => {
    for (const scenario of BENCH_SCENARIOS) {
      const extras = (scenario.toolResults ?? []).map((text, i) => ({
        id: `call_${i + 2}`,
        path: `src/step-${i + 1}.ts`,
        text,
      }));
      for (const layout of HARNESS_LAYOUTS) {
        const input = {
          ...FIXED_INPUT,
          turn: 3,
          extraToolResults: extras.slice(0, 2),
        };
        const first = layout.build(input);
        const second = layout.build(input);
        assert.deepEqual(second, first, `${scenario.id} x ${layout.id} is deterministic`);
      }
    }
  });

  test("scenario fixtures are byte-identical across two reads", () => {
    for (const id of NEW_SCENARIO_IDS) {
      const first = findBenchScenario(id);
      const second = findBenchScenario(id);
      assert.deepEqual(second, first, `${id} fixture is stable`);
    }
  });
});

describe("new scenarios run end-to-end (stubbed transport)", () => {
  for (const id of NEW_SCENARIO_IDS) {
    for (const layoutId of ["claude-code", "omp"]) {
      test(`${id} x ${layoutId} replays every turn`, async () => {
        const gateway = fakeGateway();
        const results = await runHarnessBenchmark({
          session: SESSION,
          scenario: findBenchScenario(id),
          layouts: [findHarnessLayout(layoutId)],
          model: "test/model",
          prices: PRICES,
          fetchImpl: gateway.fetchImpl,
        });
        assert.equal(results.length, 1);
        const result = results[0];
        assert.equal(result.scenario, id, "the result row names its scenario");
        assert.equal(result.requests, findBenchScenario(id).turns.length);
        assert.ok(result.inputTokens > 0);
      });
    }
  }

  test("long-file-read's first prompt dwarfs the short scenarios'", async () => {
    const short = findBenchScenario("multi-turn-refactor").file.content.length;
    const long = findBenchScenario("long-file-read").file.content.length;
    assert.ok(long > short * 10, `long read ${long} vs short ${short}`);
  });

  test("long-context refactor carries a much larger stable file than the short one", () => {
    const short = findBenchScenario("multi-turn-refactor").file.content.length;
    const long = findBenchScenario("multi-turn-refactor-long").file.content.length;
    assert.ok(long > short * 10, `long context ${long} vs short ${short}`);
  });

  test("tool-heavy interleaves tool exchanges as the conversation grows", async () => {
    const gateway = fakeGateway();
    const scenario = findBenchScenario("tool-heavy");
    await runHarnessBenchmark({
      session: SESSION,
      scenario,
      layouts: [findHarnessLayout("claude-code")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    // Anthropic messages: turn n carries the read exchange plus n-1 extra
    // (assistant tool_call, user tool_result) pairs, plus n-1 follow-up
    // pairs — the message count must grow by 4 per turn.
    const counts = gateway.requests.map((body) => body.messages.length);
    assert.equal(counts.length, scenario.turns.length);
    for (let i = 1; i < counts.length; i++) {
      assert.equal(counts[i] - counts[i - 1], 4, `turn ${i + 1} adds one tool exchange`);
    }
    const toolUseCount = (body) =>
      body.messages.filter(
        (m) =>
          m.role === "assistant" && Array.isArray(m.content) && m.content[0].type === "tool_use",
      ).length;
    assert.equal(toolUseCount(gateway.requests.at(-1)), 1 + (scenario.turns.length - 1));
  });

  test("the append-only layout keeps hitting on the tool-heavy scenario", async () => {
    const gateway = fakeGateway();
    const results = await runHarnessBenchmark({
      session: SESSION,
      scenario: findBenchScenario("tool-heavy"),
      layouts: [findHarnessLayout("claude-code")],
      model: "test/model",
      prices: PRICES,
      fetchImpl: gateway.fetchImpl,
    });
    const { turns } = results[0];
    assert.equal(turns[0].hit, false);
    for (const turn of turns.slice(1)) assert.equal(turn.hit, true);
  });
});

describe("provider parity", () => {
  // OpenAI's prompt_tokens INCLUDE the cached portion; Anthropic's
  // input_tokens EXCLUDE it. Parity means both dialects account for the
  // SAME total token shape, so the runner normalizes and the totals match.
  for (const id of NEW_SCENARIO_IDS) {
    test(`${id}: both dialects account for the same total token shape`, async () => {
      const gateway = fakeGateway();
      const results = await runHarnessBenchmark({
        session: SESSION,
        scenario: findBenchScenario(id),
        layouts: [findHarnessLayout("claude-code"), findHarnessLayout("omp")],
        model: "test/model",
        prices: PRICES,
        fetchImpl: gateway.fetchImpl,
      });
      const [anthropic, openai] = results;
      assert.equal(anthropic.dialect, "anthropic");
      assert.equal(openai.dialect, "openai");
      assert.equal(anthropic.inputTokens, openai.inputTokens, "same prompt total");
      assert.equal(anthropic.cachedTokens, openai.cachedTokens, "same cached total");
      assert.equal(anthropic.turns.length, openai.turns.length);
      for (let i = 0; i < anthropic.turns.length; i++) {
        assert.equal(anthropic.turns[i].promptTokens, openai.turns[i].promptTokens);
        assert.equal(anthropic.turns[i].cachedTokens, openai.turns[i].cachedTokens);
      }
    });
  }
});
