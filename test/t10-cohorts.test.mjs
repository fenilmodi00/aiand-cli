import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

/**
 * Ticket #135 — cohort end-to-end (C6 across harness stats/compare/matrix/
 * recommend) + task-pack tags (lane B) + compare-table export (--out with
 * markdown/csv/json). CLI tests run the built dist CLI over a seeded store;
 * the pure serializers are tested directly.
 */

const env = withTestEnv("t10-cohorts", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const _HOUR = 60 * 60 * 1000;
const baseTime = Date.parse("2026-10-20T10:00:00.000Z");

function iso(offsetMs) {
  return new Date(baseTime + offsetMs).toISOString();
}

function _row(overrides) {
  return {
    model: "zai-org/glm-5.3",
    api_key: "sk-test-claude...aaaa",
    created_at: iso(0),
    input_tokens: 1000,
    output_tokens: 100,
    cached_tokens: 500,
    cost_value: 0.01,
    currency: "usd",
    status_code: 200,
    ttft_ms: 300,
    ...overrides,
  };
}

const { normalizeEnvelope } = await import("../dist/agents/envelope.js");
const { insertEnvelope } = await import("../dist/store/envelopes.js");

/** Five v2 envelope turns for one harness, plus v1 turns for the other. */
async function seedTwoHarnessStore(cfg) {
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey, maskKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    await recordAgentKey("opencode", "sk-test-opencode-super-secret-0001");
  });
  const claudeMask = maskKey("sk-test-claude-super-secret-key-000");
  const opencodeMask = maskKey("sk-test-opencode-super-secret-0001");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 6; i += 1) {
      for (const [id, mask, cost] of [
        ["c", claudeMask, 0.01],
        ["o", opencodeMask, 0.02],
      ]) {
        const at = iso(i * 60_000);
        insert.run(
          `${id}${i}`,
          "zai-org/glm-5.3",
          mask,
          200,
          300,
          null,
          1000,
          100,
          500,
          String(cost),
          cost,
          "usd",
          at,
          at,
        );
      }
    }
    // claude: v2 envelopes (Edit+Bash → "Coding" via the deterministic classifier).
    for (let i = 0; i < 5; i += 1) {
      insertEnvelope(opened.db, {
        agent: "claude",
        model: "zai-org/glm-5.3",
        apiKey: claudeMask,
        createdAt: iso(i * 60_000 + 30_000),
        envelope: normalizeEnvelope({
          tools: ["Bash", "Edit"],
          toolOutcomes: [
            { name: "Bash", ok: i > 0 },
            { name: "Edit", ok: true },
          ],
          terminal: i === 4 ? "errored" : "clean",
          editTargets: ["/repo/src/a.ts"],
          projectRoot: "/repo",
        }),
      });
    }
    // opencode: v1 envelopes (Edit only → also "Coding").
    for (let i = 0; i < 5; i += 1) {
      insertEnvelope(opened.db, {
        agent: "opencode",
        model: "zai-org/glm-5.3",
        apiKey: opencodeMask,
        createdAt: iso(i * 60_000 + 30_000),
        envelope: normalizeEnvelope({ tools: ["Edit"], editTargets: ["/repo/src/a.ts"] }),
      });
    }
    opened.db.close();
  });
  return { claudeMask, opencodeMask };
}

// ---------------------------------------------------------------------------
// Pure export serializers
// ---------------------------------------------------------------------------

test("toMarkdownTable strips ANSI and preserves alignment + winner markers", async () => {
  const { toMarkdownTable } = await import("../dist/compare/table-export.js");
  const lines = toMarkdownTable(
    ["harness", "hit"],
    ["left", "right"],
    [
      ["claude", "▸ 50.0%"],
      ["opencode", "—"],
    ],
  );
  assert.deepEqual(lines, [
    "| harness | hit |",
    "|---|---:|",
    "| claude | ▸ 50.0% |",
    "| opencode | — |",
  ]);
  const colored = toMarkdownTable(["a"], ["left"], [["\x1b[32mgood\x1b[0m"]]);
  assert.ok(!colored[0].includes("\x1b["), "ANSI stripped from export");
  assert.match(colored[2], /good/);
});

test("toCsvRows quotes only when needed and escapes embedded quotes", async () => {
  const { toCsvRows } = await import("../dist/compare/table-export.js");
  const lines = toCsvRows(
    ["harness", "note"],
    [
      ["claude", "plain"],
      ["x", "has,comma"],
      ["y", 'has "quote"'],
      ["z", "line\nbreak"],
    ],
  );
  assert.equal(lines[0], "harness,note");
  assert.equal(lines[1], "claude,plain");
  assert.equal(lines[2], 'x,"has,comma"');
  assert.equal(lines[3], 'y,"has ""quote"""');
  assert.equal(lines[4], 'z,"line\nbreak"');
});

test("inferExportFormat: explicit --format wins, else file extension, else markdown", async () => {
  const { inferExportFormat } = await import("../dist/compare/table-export.js");
  assert.equal(inferExportFormat("x.md", "csv"), "csv");
  assert.equal(inferExportFormat("x.md", undefined), "markdown");
  assert.equal(inferExportFormat("x.csv", undefined), "csv");
  assert.equal(inferExportFormat("x.json", undefined), "json");
  assert.equal(inferExportFormat("x.MD", undefined), "markdown");
  assert.equal(inferExportFormat("x.txt", undefined), "markdown");
});

// ---------------------------------------------------------------------------
// Export of the harness compare table
// ---------------------------------------------------------------------------

test("compare --out writes markdown with winners, n=, and coverage intact", async () => {
  const cfg = cfgDir("export-md");
  await seedTwoHarnessStore(cfg);
  const file = join(env.dir, "export-md.md");
  const run = await runCli(["harness", "compare", "--no-sync", "--out", file], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /Wrote compare table \(markdown, 2 row\(s\)\)/);
  const md = readFileSync(file, "utf8");
  assert.match(md, /^\| harness \| .+ \|$/m);
  assert.match(md, /▸ 10\.0% \(n=5\)/, "winner marker + n= survive the export");
  assert.match(md, /behavioral columns: envelopes \d+% of turns/, "coverage line preserved");
  assert.match(
    md,
    /provenance: heuristic\(one-shot\/retry envelope rule\)/,
    "provenance preserved",
  );
  assert.match(md, /—/, "uncovered cells stay em-dashes");
  assert.ok(!/synthetic/i.test(md), "synthetic sweep never joins the export");
});

test("compare --out --format csv round-trips the same columns", async () => {
  const cfg = cfgDir("export-csv");
  await seedTwoHarnessStore(cfg);
  const file = join(env.dir, "export-csv.csv");
  const run = await runCli(["harness", "compare", "--no-sync", "--out", file, "--format", "csv"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(run.code, 0, run.stderr);
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  assert.match(lines[0], /^harness,cost\/session p50,ttft p50,hit,errors,/);
  assert.equal(lines.length, 3, "header + 2 harness rows");
  assert.match(lines[1], /▸ 10\.0% \(n=5\)/, "winner + n= in csv");
  assert.ok(lines[2].includes("—"), "uncovered cell em-dash in csv");
  // Round-trip: each row has the same field count as the header.
  const fields = lines[0].split(",").length;
  for (const line of lines) assert.equal(line.split(",").length, fields);
});

test("compare --out .json exports the payload with coverage + cohort context", async () => {
  const cfg = cfgDir("export-json");
  await seedTwoHarnessStore(cfg);
  const file = join(env.dir, "export-json.json");
  const run = await runCli(["harness", "compare", "--no-sync", "--out", file, "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(run.code, 0, run.stderr);
  const payload = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(payload.harnesses.length, 2);
  assert.ok(payload.provenance.behavioralCoverage);
  assert.equal(payload.provenance.cohort, null);
  assert.ok(
    payload.notes.some((n) => /behavioral columns/.test(n)),
    "coverage in notes",
  );
  // --out --json must not also print the table to stdout.
  assert.ok(!run.stdout.includes("HARNESS"), "stdout stays clean on export");
});

test("compare --cohort --out carries the cohort provenance line", async () => {
  const cfg = cfgDir("export-cohort");
  await seedTwoHarnessStore(cfg);
  const file = join(env.dir, "export-cohort.md");
  const run = await runCli(
    ["harness", "compare", "--no-sync", "--cohort", "Coding", "--out", file],
    { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) },
  );
  assert.equal(run.code, 0, run.stderr);
  const md = readFileSync(file, "utf8");
  assert.match(md, /cohort Coding: \d+ request\(s\) match — excluded, not folded \(C6\)/);
  assert.match(md, /▸/, "winners still marked");
});

test("compare --out infers format from extension; bad --format rejected; --format alone errors", async () => {
  const cfg = cfgDir("export-formats");
  await seedTwoHarnessStore(cfg);
  const noFlag = await runCli(
    ["harness", "compare", "--no-sync", "--out", join(env.dir, "by-ext.csv")],
    { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) },
  );
  assert.equal(noFlag.code, 0, noFlag.stderr);
  assert.match(readFileSync(join(env.dir, "by-ext.csv"), "utf8"), /^harness,/);

  const bad = await runCli(
    ["harness", "compare", "--no-sync", "--out", join(env.dir, "x.md"), "--format", "yaml"],
    { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) },
  );
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /--format/);

  const lone = await runCli(["harness", "compare", "--no-sync", "--format", "csv"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.notEqual(lone.code, 0);
  assert.match(lone.stderr, /--format needs --out/);
});

// ---------------------------------------------------------------------------
// Cohort consistency across commands (C6 end-to-end)
// ---------------------------------------------------------------------------

test("--cohort narrows stats, matrix, and recommend through the same classifier", async () => {
  const cfg = cfgDir("cohort-all");
  await seedTwoHarnessStore(cfg);
  const envOpts = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  // All Edit/Bash envelopes classify as Coding — full cohort match everywhere.
  for (const args of [
    ["harness", "stats"],
    ["harness", "compare"],
    ["harness", "matrix"],
    ["recommend"],
  ]) {
    const run = await runCli([...args, "--no-sync", "--cohort", "Coding", "--json"], envOpts);
    assert.equal(run.code, 0, `${args.join(" ")}: ${run.stderr}`);
    const payload = JSON.parse(run.stdout);
    const rows = payload.harnesses ?? payload.pairs ?? payload.ranked;
    assert.ok(Array.isArray(rows), `${args.join(" ")}: payload shape`);
  }

  // An empty cohort is honest-zero, not an error, on every surface.
  for (const args of [["harness", "stats"], ["harness", "matrix"], ["recommend"]]) {
    const run = await runCli(
      [...args, "--no-sync", "--cohort", "Brainstorming", "--json"],
      envOpts,
    );
    assert.equal(run.code, 0, `${args.join(" ")}: ${run.stderr}`);
    const payload = JSON.parse(run.stdout);
    const rows = payload.harnesses ?? payload.pairs ?? payload.ranked;
    assert.deepEqual(rows, [], `${args.join(" ")}: empty cohort is empty`);
  }

  // Unknown category rejected identically everywhere.
  for (const args of [
    ["harness", "stats"],
    ["harness", "compare"],
    ["harness", "matrix"],
    ["recommend"],
  ]) {
    const run = await runCli([...args, "--no-sync", "--cohort", "Bogus"], envOpts);
    assert.notEqual(run.code, 0, args.join(" "));
    assert.match(run.stderr, /Unknown cohort/);
  }
});

// ---------------------------------------------------------------------------
// Task-pack tags (lane B) + compare cohorts degradation
// ---------------------------------------------------------------------------

test("compare add --tags writes task.json; tags validated against the taxonomy", async () => {
  const cfg = cfgDir("tags-add");
  const good = await runCli(
    ["compare", "add", "fix-bug", "--verify", "npm test", "--tags", "Debugging, Testing"],
    { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) },
  );
  assert.equal(good.code, 0, good.stderr);
  const meta = JSON.parse(readFileSync(join(cfg, "tasks", "fix-bug", "task.json"), "utf8"));
  assert.deepEqual(meta.tags, ["Debugging", "Testing"]);

  const bad = await runCli(["compare", "add", "nope", "--verify", "x", "--tags", "Bogus"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /Unknown tag "Bogus"/);
  assert.ok(!existsSync(join(cfg, "tasks", "nope")), "invalid tags fail before scaffolding");
});

test("tags are optional: add without --tags leaves no task.json and cohorts shows untagged", async () => {
  const cfg = cfgDir("tags-absent");
  const added = await runCli(["compare", "add", "plain", "--verify", "npm test"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(added.code, 0, added.stderr);
  assert.ok(!existsSync(join(cfg, "tasks", "plain", "task.json")), "no meta file by default");

  const listed = JSON.parse(
    (await runCli(["compare", "cohorts", "--json"], { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) }))
      .stdout,
  );
  assert.deepEqual(listed.tasks, [
    {
      id: "plain",
      tags: [],
      runs: 0,
      solves: 0,
      trials: 0,
      infra: 0,
      costUsd: null,
      meanWallMs: null,
    },
  ]);
  assert.match(listed.note, /no run rows yet/, "honest degradation without the run surface");
});

test("compare cohorts: --cohort filters by tag; no run rows degrades honestly", async () => {
  const cfg = cfgDir("cohorts-filter");
  await runCli(["compare", "add", "bug", "--verify", "npm test", "--tags", "Debugging"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  await runCli(["compare", "add", "test-kit", "--verify", "npm test"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  const run = await runCli(["compare", "cohorts", "--cohort", "Debugging"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /bug/);
  assert.ok(!/test-kit/.test(run.stdout), "untagged task not in the cohort");

  const empty = await runCli(["compare", "cohorts", "--cohort", "Testing"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /No task tagged Testing/);

  const bad = await runCli(["compare", "cohorts", "--cohort", "Bogus"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /Unknown cohort/);
});

test("compare cohorts rolls up run rows when present; infra excluded from solves", async () => {
  const cfg = cfgDir("cohorts-runs");
  await runCli(["compare", "add", "demo", "--verify", "npm test", "--tags", "Debugging"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  const runsDir = join(cfg, "compare-runs");
  mkdirSync(runsDir, { recursive: true });
  const runRow = (harness, success, failureMode, cost, wall) =>
    JSON.stringify({
      run_id: `${harness}:m:demo:1`,
      ts: iso(0),
      harness,
      harness_version: null,
      model: "m",
      task: "demo",
      success,
      score: success === true ? 1 : 0,
      failure_mode: failureMode,
      completed: success !== null,
      wall_ms: wall,
      turns: 5,
      retries: 0,
      tokens_in: 100,
      tokens_cached: 10,
      tokens_out: 50,
      cost_usd: cost,
      token_basis: "gateway",
      cost_basis: "gateway",
      request_ids: [],
      verify_exit: success === true ? 0 : 1,
    });
  writeFileSync(
    join(runsDir, "demo.jsonl"),
    `${[
      runRow("claude", true, null, 0.02, 40000),
      runRow("codex", false, null, 0.01, 60000),
      runRow("opencode", null, "infra", null, 1000),
      "not json at all",
    ].join("\n")}\n`,
  );
  const run = await runCli(["compare", "cohorts", "--cohort", "Debugging", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(run.code, 0, run.stderr);
  const [task] = JSON.parse(run.stdout).tasks;
  assert.equal(task.runs, 3, "corrupt line skipped, 3 valid rows");
  assert.equal(task.solves, 1);
  assert.equal(task.trials, 2, "infra row excluded from trials");
  assert.equal(task.infra, 1);
  assert.ok(Math.abs(task.costUsd - 0.03) < 1e-9, "null cost ignored in the sum");
  assert.ok(Math.abs(task.meanWallMs - 50000) < 1e-9, "infra wall excluded from the mean");
});

test("compare cohorts skips corrupt task.json instead of failing (fail-open)", async () => {
  const cfg = cfgDir("cohorts-corrupt");
  await runCli(["compare", "add", "flaky", "--verify", "npm test"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  writeFileSync(join(cfg, "tasks", "flaky", "task.json"), "{not json");
  const run = await runCli(["compare", "cohorts", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).tasks[0].tags, []);
});

test("run-rows module: absent surface reads empty, guards file absence", async () => {
  const cfg = cfgDir("runs-absent");
  const { hasRuns, readTaskRuns, parseRunRows, runsPath } = await import(
    "../dist/compare/run-rows.js"
  );
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    assert.equal(hasRuns("ghost"), false);
    assert.deepEqual(readTaskRuns("ghost"), []);
    assert.deepEqual(parseRunRows("nope\n{bad json\n"), []);
    assert.match(runsPath(), /compare-runs$/);
  });
});
