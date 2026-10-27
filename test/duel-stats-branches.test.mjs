import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

/**
 * Branch coverage for harness-duel and harness-stats flag/parse edges the
 * existing suites' happy paths leave open: pair/baseline parsing, flag
 * errors, timezone and window validation. Pure functions are imported
 * directly; CLI drives cover exit codes and stderr text.
 */

const env = withTestEnv("duel-stats-branches", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MODELS = ["zai-org/glm-5.3", "openai/gpt-5.2"];

// ---------------------------------------------------------------------------
test("parsePairs: minimum count, bad specs, and good pairs", async () => {
  const { parsePairs } = await import("../dist/benchmark/duel.js");
  // Too few pairs (min 2 by default).
  assert.throws(() => parsePairs([], MODELS), /At least 2 --pair/);
  assert.throws(
    () => parsePairs(["harness=claude-code,model=zai-org/glm-5.3"], MODELS),
    /At least 2/,
  );
  // min=1 (the latency command) accepts a single pair.
  assert.deepEqual(parsePairs(["harness=claude-code,model=zai-org/glm-5.3"], MODELS, 1), [
    { harness: "claude-code", model: "zai-org/glm-5.3" },
  ]);
  // Malformed specs name the offending value.
  assert.throws(() => parsePairs(["nonsense"], MODELS, 1), /Invalid --pair value "nonsense"/);
  assert.throws(() => parsePairs(["harness=claude-code"], MODELS, 1), /Invalid --pair value/);
  // Unknown layout is rejected with the valid list and the omit-harness hint.
  assert.throws(
    () => parsePairs(["harness=ghost,model=zai-org/glm-5.3"], MODELS, 1),
    (error) => {
      assert.match(error.message, /Unknown harness layout "ghost"/);
      assert.match(error.hint, /claude-code.*omp/s);
      assert.match(error.hint, /omit harness=/);
      return true;
    },
  );
  // Omitting harness= uses the default layout; harness=default is NOT one.
  assert.deepEqual(parsePairs(["model=zai-org/glm-5.3"], MODELS, 1), [
    { harness: "omp", model: "zai-org/glm-5.3" },
  ]);
  assert.throws(
    () => parsePairs(["harness=default,model=zai-org/glm-5.3"], MODELS, 1),
    /Unknown harness layout "default"/,
  );
  // Unknown model (against the known list) is rejected but overridable.
  assert.throws(
    () => parsePairs(["harness=omp,model=nonexistent/x"], MODELS, 1),
    /Unknown model "nonexistent\/x"/,
  );
  // With no known models, any model passes.
  assert.deepEqual(parsePairs(["harness=omp,model=anything/at-all"], [], 1), [
    { harness: "omp", model: "anything/at-all" },
  ]);
  // Two valid pairs parse.
  assert.deepEqual(
    parsePairs(
      ["harness=claude-code,model=zai-org/glm-5.3", "harness=omp,model=openai/gpt-5.2"],
      MODELS,
    ),
    [
      { harness: "claude-code", model: "zai-org/glm-5.3" },
      { harness: "omp", model: "openai/gpt-5.2" },
    ],
  );
});

test("resolveBaseline: default, index, spec forms, and the unknown error", async () => {
  const { resolveBaseline } = await import("../dist/benchmark/duel.js");
  const pairs = [
    { harness: "claude-code", model: "zai-org/glm-5.3" },
    { harness: "omp", model: "openai/gpt-5.2" },
  ];
  assert.equal(resolveBaseline(undefined, pairs), 0);
  assert.equal(resolveBaseline("1", pairs), 0);
  assert.equal(resolveBaseline("2", pairs), 1);
  assert.equal(resolveBaseline("claude-code", pairs), 0); // bare layout name
  assert.equal(resolveBaseline("omp,openai/gpt-5.2", pairs), 1); // h,m form
  assert.equal(resolveBaseline("harness=omp,model=openai/gpt-5.2", pairs), 1);
  assert.throws(() => resolveBaseline("3", pairs), /Unknown --baseline/);
  assert.throws(() => resolveBaseline("nobody", pairs), /Unknown --baseline/);
});

// ---------------------------------------------------------------------------
// harness duel: flag-argument errors through the CLI
// ---------------------------------------------------------------------------

test("duel CLI: shape-source, turns-cap, format, and pair-count errors", async () => {
  const cfg = cfgDir("duel-flags");
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  // Exactly one shape source is required.
  const neither = await runCli(["harness", "duel", "--yes"], base);
  assert.notEqual(neither.code, 0);
  assert.match(neither.stderr, /exactly one shape source/i);
  // ALL unmet requirements are reported at once, not one at a time.
  assert.match(neither.stderr, /at least 2 --pair values are required/);

  const both = await runCli(
    ["harness", "duel", "--session", "abc", "--scenario", "multi-turn-refactor", "--yes"],
    base,
  );
  assert.notEqual(both.code, 0);
  assert.match(both.stderr, /mutually exclusive/i);

  // --turns-cap must be positive (reported in the combined requirements message).
  const cap = await runCli(
    ["harness", "duel", "--scenario", "multi-turn-refactor", "--turns-cap", "0", "--yes"],
    base,
  );
  assert.notEqual(cap.code, 0);
  assert.match(cap.stderr, /--turns-cap must be a positive number/);

  // --format must be one of the three.
  const format = await runCli(
    ["harness", "duel", "--scenario", "multi-turn-refactor", "--format", "pdf", "--yes"],
    base,
  );
  assert.notEqual(format.code, 0);

  // --pair count enforced before any request leaves (needs a shape source).
  const pairs = await runCli(
    ["harness", "duel", "--scenario", "multi-turn-refactor", "--yes"],
    base,
  );
  assert.notEqual(pairs.code, 0);
  assert.match(pairs.stderr, /at least 2 --pair values are required/);

  // Unknown session id (with valid pairs) is a clean error, never a hang.
  const missing = await runCli(
    [
      "harness",
      "duel",
      "--session",
      "no-such-session",
      "--pair",
      "harness=claude-code,model=zai-org/glm-5.3",
      "--pair",
      "harness=omp,model=zai-org/glm-5.3",
      "--no-sync",
      "--yes",
    ],
    base,
  );
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /No session with id/);

  // An unknown layout name is rejected with the valid list + omit-harness hint,
  // before any request leaves.
  const badLayout = await runCli(
    [
      "harness",
      "duel",
      "--scenario",
      "multi-turn-refactor",
      "--pair",
      "harness=default,model=zai-org/glm-5.3",
      "--pair",
      "harness=omp,model=zai-org/glm-5.3",
      "--yes",
    ],
    base,
  );
  assert.notEqual(badLayout.code, 0);
  assert.match(badLayout.stderr, /Unknown harness layout "default"/);
  assert.match(badLayout.stderr, /omit harness=/);

  // Help renders both verbs, every valid layout, and the turn-limiting flag.
  const help = await runCli(["harness", "duel", "--help"], base);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes("harness duel"));
  for (const layout of [
    "claude-code",
    "omp",
    "rebuilt-system",
    "compacting",
    "reordered",
    "reordered-stable",
  ]) {
    assert.ok(help.stdout.includes(layout), `help names layout ${layout}`);
  }
  assert.match(help.stdout, /--turns-cap/);
});

// ---------------------------------------------------------------------------
// harness latency: layout errors and help through the CLI
// ---------------------------------------------------------------------------

// #107: an unknown --layout names the valid layouts and the default-pair escape.
test("latency CLI: unknown layout names the valid layouts and the default hint; help lists them", async () => {
  const cfg = cfgDir("latency-flags");
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  const badLayout = await runCli(
    ["harness", "latency", "--pair", "harness=default,model=zai-org/glm-5.3", "--no-sync"],
    base,
  );
  assert.notEqual(badLayout.code, 0);
  assert.match(badLayout.stderr, /Unknown harness layout "default"/);
  assert.match(badLayout.stderr, /Valid layouts:/);
  assert.match(badLayout.stderr, /omit harness=/);

  const help = await runCli(["harness", "latency", "--help"], base);
  assert.equal(help.code, 0);
  for (const layout of [
    "claude-code",
    "omp",
    "rebuilt-system",
    "compacting",
    "reordered",
    "reordered-stable",
  ]) {
    assert.ok(help.stdout.includes(layout), `help names layout ${layout}`);
  }
});

// ---------------------------------------------------------------------------
// harness stats / compare: window, timezone, and sample-flag branches
// ---------------------------------------------------------------------------

async function seedStore(cfg, statuses = [200, 200, 200, 500, 429]) {
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const base0 = Date.parse("2026-10-19T10:00:00.000Z");
    statuses.forEach((status, i) => {
      const at = new Date(base0 + i * 3_600_000).toISOString();
      insert.run(
        `s${i}`,
        i % 2 === 0 ? "zai-org/glm-5.3" : "openai/gpt-5.2",
        "sk-test...-000",
        status,
        200 + i,
        null,
        1000,
        100,
        500,
        "0.02",
        0.02,
        "usd",
        at,
        at,
      );
    });
    opened.db.close();
  });
}

test("stats CLI: timezone, window pairs, and gap validation", async () => {
  const cfg = cfgDir("stats-flags");
  await seedStore(cfg);
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  const badTz = await runCli(["harness", "stats", "--no-sync", "--timezone", "Not/AZone"], base);
  assert.notEqual(badTz.code, 0);
  assert.match(badTz.stderr, /Unknown timezone/);

  const sinceOnly = await runCli(["harness", "stats", "--no-sync", "--since", "2026-10-01"], base);
  assert.equal(sinceOnly.code, 0, sinceOnly.stderr);

  const badGap = await runCli(["harness", "stats", "--no-sync", "--session-gap", "abc"], base);
  assert.notEqual(badGap.code, 0);

  const ok = await runCli(
    [
      "harness",
      "stats",
      "--no-sync",
      "--last",
      "30d",
      "--samples",
      "--harness",
      "claude",
      "--model",
      "openai/*",
    ],
    base,
  );
  assert.equal(ok.code, 0, `${ok.stdout}${ok.stderr}`);
  assert.ok(ok.stdout.length > 0);
});

test("stats CLI: --json shape, empty store, and compare needs 2 harnesses", async () => {
  const cfg = cfgDir("stats-json");
  // Compare groups by attribution: two distinct masked keys = two harnesses.
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-key-001");
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const base0 = Date.parse("2026-10-19T10:00:00.000Z");
    const rowsSpec = [
      ["claude-key", "sk-test...-000"],
      ["opencode-key", "sk-test...-001"],
    ];
    let n = 0;
    for (const [tag, mask] of rowsSpec) {
      for (const model of ["zai-org/glm-5.3", "openai/gpt-5.2"]) {
        const at = new Date(base0 + n * 3_600_000).toISOString();
        insert.run(
          `${tag}-${n}`,
          model,
          mask,
          200,
          300,
          null,
          1000,
          100,
          500,
          "0.02",
          0.02,
          "usd",
          at,
          at,
        );
        n += 1;
      }
    }
    opened.db.close();
  });
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  const json = await runCli(["harness", "stats", "--no-sync", "--json"], base);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.ok(typeof parsed === "object" && parsed !== null);

  const compare = await runCli(["harness", "compare", "--no-sync"], base);
  assert.equal(compare.code, 0, `${compare.stdout}${compare.stderr}`);

  const empty = cfgDir("stats-empty");
  const none = await runCli(["harness", "stats", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: empty }),
  });
  assert.equal(none.code, 0, `${none.stdout}${none.stderr}`);
});
