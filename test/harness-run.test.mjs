import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { cliEnv, FAKE_API_KEY, runCli, withMockGateway, withTestEnv } from "./helpers.mjs";

/**
 * `aiand harness` — the synthetic benchmark run path (the default command, as
 * opposed to `harness duel`/`latency`/`stats`). Everything goes through the
 * mock gateway in its own process: the benchmark posts real request shapes to
 * <base>/v1/chat/completions, so the OpenAI-dialect layouts (`omp`) run for
 * real while the Anthropic ones are covered by harness-bench.test.mjs, which
 * can stub the transport in-process.
 *
 * The mock gateway speaks only OpenAI, hence every SUCCESSFUL run below pins
 * `--harness omp`; the failure paths (unknown ids, bad profile) never reach
 * the network, and the default-layouts branch is exercised separately.
 */

const env = withTestEnv("harness-run", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `aiand harness <args>` against `url`, isolated to its own config dir. */
function harness(args, cfg, url, overrides = {}) {
  return runCli(["harness", ...args], {
    env: cliEnv({
      CI: "1",
      NO_COLOR: "1",
      AIAND_CONFIG_DIR: cfg,
      AIAND_HOME: join(cfg, "home"),
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: url,
      ...overrides,
    }),
    stdin: "ignore",
  });
}

describe("aiand harness — benchmark run", () => {
  test("defaults to the default scenario and the profile model fallback (JSON)", async () => {
    await withMockGateway(async ({ url }) => {
      const { code, stdout, stderr } = await harness(
        ["--harness", "omp", "--json"],
        cfgDir("json"),
        url,
      );
      assert.equal(code, 0, stderr);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.scenario, "multi-turn-refactor");
      // No --model and no configured profile model: the built-in default wins.
      assert.equal(parsed.model, "zai-org/glm-5.3");
      assert.equal(parsed.results.length, 1);
      const [result] = parsed.results;
      assert.equal(result.harness, "omp");
      assert.equal(result.dialect, "openai");
      assert.equal(result.requests, 4, "one request per scenario turn");
      assert.equal(result.turns.length, 4);
      // The mock gateway reports no cached tokens, so every turn is a miss.
      assert.ok(result.turns.every((turn) => turn.hit === false));
    });
  });

  test("an explicit --scenario and --model render the per-turn cache table", async () => {
    await withMockGateway(async ({ url }) => {
      const { code, stdout, stderr } = await harness(
        [
          "--harness",
          "omp",
          "--scenario",
          "debug-failing-test",
          "--model",
          "deepseek-ai/deepseek-v4-flash",
        ],
        cfgDir("table"),
        url,
      );
      assert.equal(code, 0, stderr);
      assert.match(stdout, /Debug a failing test · deepseek-ai\/deepseek-v4-flash/);
      assert.match(stdout, /HARNESS\s+DIALECT\s+TURNS\s+HIT\s+CACHED\s+COST\s+SAVED/);
      assert.match(stdout, /0\.0%/);
      assert.match(stdout, /cached per turn: miss, miss/);
      // onProgress is stderr, so --json consumers never see it.
      assert.match(stderr, /running Oh My Pi…/);
    });
  });

  test("a known harness mixed with an unknown one keeps the known result", async () => {
    await withMockGateway(async ({ url }) => {
      const { code, stdout } = await harness(
        ["--harness", "bogus", "--harness", "omp", "--json"],
        cfgDir("mixed"),
        url,
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.deepEqual(
        parsed.results.map((r) => r.harness),
        ["omp"],
      );
    });
  });

  test("--sweep-models runs every catalog model and saves the sweep", async () => {
    await withMockGateway(async ({ url }) => {
      // /stub/vision-catalog serves a two-model catalog, so the sweep is two
      // models rather than the three-model default.
      const cfg = cfgDir("sweep-json");
      const { code, stdout, stderr } = await harness(
        ["--harness", "omp", "--sweep-models", "--json"],
        cfg,
        `${url}/stub/vision-catalog`,
      );
      assert.equal(code, 0, stderr);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.scenario, "multi-turn-refactor");
      assert.deepEqual(
        parsed.sweep.map((entry) => entry.model),
        ["vendor/vision-model", "vendor/text-model"],
      );
      assert.match(stderr, /model vendor\/vision-model…/);
      assert.match(stderr, /sweep saved for `aiand harness matrix --synthetic`/);

      const saved = JSON.parse(readFileSync(join(cfg, "bench-sweep.json"), "utf8"));
      assert.equal(saved.scenario, "multi-turn-refactor");
      assert.equal(saved.sweep.length, 2);
      assert.ok(existsSync(join(cfg, "bench-sweep.json")));
    });
  });

  test("--sweep-models without --json prints one table per model", async () => {
    await withMockGateway(async ({ url }) => {
      const { code, stdout } = await harness(
        ["--harness", "omp", "--sweep-models"],
        cfgDir("sweep-table"),
        `${url}/stub/vision-catalog`,
      );
      assert.equal(code, 0);
      assert.match(stdout, /Multi-turn refactor \(short context\) · every model/);
      assert.match(stdout, /vendor\/vision-model/);
      assert.match(stdout, /vendor\/text-model/);
      assert.match(stdout, /Oh My Pi/);
    });
  });

  test("an unknown --scenario fails and names the known ids", async () => {
    const { code, stdout, stderr } = await harness(
      ["--scenario", "nope"],
      cfgDir("bad-scenario"),
      "http://127.0.0.1:9",
    );
    assert.notEqual(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /Unknown scenario "nope"/);
    assert.match(stderr, /multi-turn-refactor/);
  });

  test("an unknown --harness fails and names the known ids", async () => {
    const { code, stderr } = await harness(
      ["--harness", "nope"],
      cfgDir("bad-harness"),
      "http://127.0.0.1:9",
    );
    assert.notEqual(code, 0);
    assert.match(stderr, /Unknown harness "nope"/);
    assert.match(stderr, /claude-code/);
    assert.match(stderr, /omp/);
  });

  test("an unsafe --profile is rejected before any request", async () => {
    const { code, stderr } = await harness(
      ["--harness", "omp", "--profile", "__proto__"],
      cfgDir("bad-profile"),
      "http://127.0.0.1:9",
    );
    assert.equal(code, 1);
    assert.match(stderr, /Profile name "__proto__" is not allowed/);
  });

  test("--help prints the usage and exits 0", async () => {
    const { code, stdout } = await harness(["--help"], cfgDir("help"), "http://127.0.0.1:9");
    assert.equal(code, 0);
    assert.match(stdout, /--sweep-models/);
    assert.match(stdout, /Harnesses/);
  });
});
