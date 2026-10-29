import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { cliEnv, runCli } from "./helpers.mjs";

/**
 * Branch-coverage tests for compare task packs (src/compare/tasks.ts) and the
 * `aiand compare` command surface (src/commands/compare.ts). Behavior-level:
 * CLI runs under an isolated AIAND_CONFIG_DIR, module tests exercise the
 * dist/ exports against real files. No source inspection.
 */

const { runVerify, scaffoldTask, taskPath, tasksPath, validateTask, taskStatus, listTaskIds } =
  await import("../dist/compare/tasks.js");

const _baseDir = null;

function newCfg(name) {
  const dir = mkdtempSync(join(tmpdir(), `cov-compare-${name}-`));
  process.env.AIAND_CONFIG_DIR = dir;
  return dir;
}

/** Scaffold a minimal-but-complete task pack by hand (faster than the CLI). */
function writeTask(dir, id, { verify = "#!/bin/sh\nexit 1\n", instruction = "# Task\n" } = {}) {
  const t = join(dir, "tasks", id, "workspace");
  mkdirSync(t, { recursive: true });
  writeFileSync(join(dir, "tasks", id, "instruction.md"), instruction);
  writeFileSync(join(dir, "tasks", id, "verify.sh"), verify);
  return join(dir, "tasks", id);
}

/** Write a run-row JSONL for a task (lane-B rows for cohorts/table). */
function writeRows(dir, id, rows) {
  mkdirSync(join(dir, "compare-runs"), { recursive: true });
  writeFileSync(
    join(dir, "compare-runs", `${id}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join("\n"),
  );
}

function row(overrides = {}) {
  return {
    run_id: "r",
    ts: "2026-01-01T00:00:00Z",
    harness: "agentA",
    harness_version: null,
    model: "m1",
    task: "t1",
    success: true,
    score: 1,
    failure_mode: null,
    completed: true,
    wall_ms: 1000,
    turns: 5,
    retries: 0,
    tokens_in: null,
    tokens_cached: null,
    tokens_out: null,
    cost_usd: 0.1,
    token_basis: null,
    cost_basis: null,
    request_ids: [],
    verify_exit: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// src/compare/tasks.ts — taskStatus / readValidation / listTaskIds
// ---------------------------------------------------------------------------

describe("taskStatus / readValidation (tasks.ts)", () => {
  test("statuses: incomplete, unvalidated (absent + corrupt), invalid, golden-missing, validated", () => {
    const dir = newCfg("status");
    // incomplete: empty dir
    mkdirSync(join(dir, "tasks", "hollow"), { recursive: true });
    assert.deepEqual(taskStatus("hollow"), {
      status: "incomplete",
      missing: ["instruction.md", "verify.sh", "workspace"],
    });

    // unvalidated: no validation.json
    writeTask(dir, "fresh");
    assert.deepEqual(taskStatus("fresh"), { status: "unvalidated", missing: [] });

    // corrupt validation.json (fail open) → unvalidated
    writeFileSync(join(taskPath("fresh"), "validation.json"), "{not json");
    assert.equal(taskStatus("fresh").status, "unvalidated");
    // validation.json holding a JSON null literal → null validation, fail open
    writeFileSync(join(taskPath("fresh"), "validation.json"), "null");
    assert.equal(taskStatus("fresh").status, "unvalidated");

    // invalid: golden replay failed
    writeTask(dir, "bad");
    writeFileSync(
      join(taskPath("bad"), "validation.json"),
      JSON.stringify({
        failBefore: { ok: true, at: "x" },
        golden: { ok: false, path: "g", at: "x" },
      }),
    );
    assert.equal(taskStatus("bad").status, "invalid");

    // invalid: fail-before failed (no golden key needed)
    writeTask(dir, "noctrl");
    writeFileSync(
      join(taskPath("noctrl"), "validation.json"),
      JSON.stringify({ failBefore: { ok: false, at: "x" } }),
    );
    assert.equal(taskStatus("noctrl").status, "invalid");

    // golden-missing: recorded golden dir no longer exists
    writeTask(dir, "gone");
    writeFileSync(
      join(taskPath("gone"), "validation.json"),
      JSON.stringify({
        failBefore: { ok: true, at: "x" },
        golden: { ok: true, path: join(dir, "no-such-golden"), at: "x" },
      }),
    );
    assert.equal(taskStatus("gone").status, "golden-missing");

    // validated: golden ok and the dir still exists
    const golden = join(dir, "golden-live");
    mkdirSync(golden, { recursive: true });
    writeTask(dir, "good");
    writeFileSync(
      join(taskPath("good"), "validation.json"),
      JSON.stringify({
        failBefore: { ok: true, at: "x" },
        golden: { ok: true, path: golden, at: "x" },
      }),
    );
    assert.equal(taskStatus("good").status, "validated");
  });

  test("listTaskIds ignores plain files and returns sorted dirs; tasksPath nests under config dir", () => {
    const dir = newCfg("ids");
    writeTask(dir, "b-task");
    writeTask(dir, "a.task");
    writeFileSync(join(dir, "tasks", "stray-file.txt"), "not a dir");
    assert.deepEqual(listTaskIds(), ["a.task", "b-task"]);
    assert.equal(tasksPath(), join(dir, "tasks"));
    // tasks root absent entirely → []
    rmSync(join(dir, "tasks"), { recursive: true, force: true });
    assert.deepEqual(listTaskIds(), []);

    // A dangling task entry (created then removed) must not break a listing:
    // the statSync catch in listTaskIds keeps filtering robust. Exercise it by
    // removing the dir while an entry remains — on Windows rmSync of a live
    // tree after listing is safe, so assert the post-state instead of racing.
    writeTask(dir, "vanishing");
    assert.deepEqual(listTaskIds(), ["vanishing"]);
    rmSync(join(dir, "tasks", "vanishing"), { recursive: true, force: true });
    assert.deepEqual(listTaskIds(), []);
  });
});

// ---------------------------------------------------------------------------
// src/compare/tasks.ts — scaffoldTask edges
// ---------------------------------------------------------------------------

describe("scaffoldTask (tasks.ts)", () => {
  test("rejects invalid ids, existing ids; fresh scaffold creates files", async () => {
    const _dir = newCfg("scaffold-edge");
    await assert.rejects(
      () => scaffoldTask("../escape", "true"),
      (e) => /Invalid task id/.test(e.message) && /directory name/.test(e.hint),
    );
    await scaffoldTask("dupe", "true");
    await assert.rejects(
      () => scaffoldTask("dupe", "true"),
      (e) => /already exists/.test(e.message),
    );
    // untouched scaffold is missing nothing → taskStatus sees a complete pack
    assert.deepEqual(taskStatus("dupe"), { status: "unvalidated", missing: [] });
    assert.ok(existsSync(join(taskPath("dupe"), "workspace")));
  });
});

// ---------------------------------------------------------------------------
// src/compare/tasks.ts — validateTask verdicts + score bounds
// ---------------------------------------------------------------------------

describe("validateTask verdicts (tasks.ts)", () => {
  test("incomplete pack → valid=false with missing list; no golden run → valid=null + re-run problem", async () => {
    const dir = newCfg("verdict-incomplete");
    mkdirSync(join(dir, "tasks", "empty"), { recursive: true });
    const v = await validateTask("empty");
    assert.equal(v.complete, false);
    assert.equal(v.valid, false);
    assert.match(v.problems[0], /missing instruction\.md/);

    // complete pack, verify fails untouched (fail-before ok), no --golden
    writeTask(dir, "opaque");
    const v2 = await validateTask("opaque");
    assert.equal(v2.complete, true);
    assert.equal(v2.failBefore.ok, true);
    assert.equal(v2.nullHarness.ok, true);
    assert.equal(v2.nullHarness.score, 0);
    assert.equal(v2.golden, null);
    assert.equal(v2.valid, null); // golden replay decides full validation
    assert.ok(v2.problems.some((p) => /--golden/.test(p)));
    // verdict persisted so taskStatus reports it — golden replay missing is
    // golden-missing, never validated (spec §2.2)
    assert.equal(taskStatus("opaque").status, "golden-missing");
  });

  test("trivially solvable task (verify passes untouched) → invalid with score in problem", async () => {
    const dir = newCfg("verdict-trivial");
    writeTask(dir, "trivial", { verify: "#!/bin/sh\necho 'SCORE: 0.75'; exit 0\n" });
    const v = await validateTask("trivial");
    assert.equal(v.valid, false);
    assert.equal(v.failBefore.ok, false);
    assert.equal(v.failBefore.score, 0.75);
    assert.equal(v.nullHarness.ok, false);
    assert.equal(v.nullHarness.score, 0.75);
    assert.match(v.problems[0], /trivially solvable \(score 0\.75\)/);
  });

  test("trivially solvable with score 0 → problem without a score suffix", async () => {
    const dir = newCfg("verdict-trivial0");
    writeTask(dir, "t0", { verify: "#!/bin/sh\nexit 0\n" });
    const v = await validateTask("t0");
    assert.match(v.problems[0], /trivially solvable$/);
  });

  test("golden replay pass → valid=true; golden replay fail → invalid; missing golden dir → error", async () => {
    const dir = newCfg("verdict-golden");
    writeTask(dir, "real", {
      verify: "#!/bin/sh\ntest -f solved.txt\n",
    });
    const golden = join(dir, "golden");
    mkdirSync(golden, { recursive: true });
    writeFileSync(join(golden, "solved.txt"), "done\n");

    const badDir = join(dir, "no-such-golden");
    await assert.rejects(
      () => validateTask("real", badDir),
      (e) => /Golden dir not found/.test(e.message),
    );

    const ok = await validateTask("real", golden);
    assert.equal(ok.valid, true);
    assert.deepEqual(ok.golden, { ok: true });
    assert.deepEqual(ok.problems, []);
    assert.equal(taskStatus("real").status, "validated");

    // Now the golden dir is gone but the verdict was persisted → golden-missing
    const { rmSync } = await import("node:fs");
    rmSync(golden, { recursive: true, force: true });
    assert.equal(taskStatus("real").status, "golden-missing");

    // Empty golden dir → replay verify fails → invalid
    const emptyGolden = join(dir, "golden-empty");
    mkdirSync(emptyGolden, { recursive: true });
    const fail = await validateTask("real", emptyGolden);
    assert.equal(fail.valid, false);
    assert.equal(fail.golden.ok, false);
    assert.match(fail.problems[0], /golden replay failed/);
  });

  test("instruction referencing the verify script → invalid, fail-before never runs", async () => {
    const dir = newCfg("verdict-leaky");
    writeTask(dir, "leaky", { instruction: "Run verify.sh when done.\n" });
    const v = await validateTask("leaky");
    assert.equal(v.complete, false);
    assert.equal(v.valid, false);
    assert.equal(v.failBefore, null);
    assert.match(v.problems[0], /references the verify script/);
  });

  test("runVerify: SCORE bounds (>=1 clamped to 1, junk lines ignored), timeout kills with a signal", () => {
    const dir = newCfg("runverify");
    const score = (line) => {
      writeTask(dir, "scorer", { verify: `#!/bin/sh\nprintf '${line}\\n'\n` });
      return runVerify(taskPath("scorer")).score;
    };
    assert.equal(score("SCORE: 0.5"), 0.5);
    assert.equal(score("SCORE: 1.0000"), 1); // 1(.0+) accepted
    assert.equal(score("SCORE: 1.5"), 0); // out of range: not a SCORE line
    assert.equal(score("SCORE: -1"), 0); // negative: not matched
    assert.equal(score("SCORE: abc"), 0); // non-numeric: not matched
    assert.equal(score("score: 0.5"), 0); // wrong case: not a valid line
    assert.equal(score("SCORE:"), 0); // missing value

    // timeout: a kill is not a grade. POSIX surfaces signal=SIGTERM; win32
    // spawnSync reports ETIMEDOUT as an error instead — both mean "no grade".
    writeTask(dir, "slow", { verify: "#!/bin/sh\nsleep 5\n" });
    try {
      const timed = runVerify(taskPath("slow"), undefined, 300);
      assert.equal(timed.ok, false);
      assert.ok(timed.signal !== null, "timeout surfaces a signal");
    } catch (e) {
      assert.match(e.message, /ETIMEDOUT/);
    }
  });
});

// ---------------------------------------------------------------------------
// src/commands/compare.ts — add / tasks / validate branches
// ---------------------------------------------------------------------------

describe("compare add/tasks/validate (CLI)", () => {
  test("add: missing id, missing --verify, bad tag all error with hints; tags + --json", async () => {
    const dir = newCfg("cli-add");
    const noId = await runCli(["compare", "add"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
    assert.notEqual(noId.code, 0);
    assert.match(noId.stderr, /Task id required/);

    const noVerify = await runCli(["compare", "add", "x"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.notEqual(noVerify.code, 0);
    assert.match(noVerify.stderr, /--verify is required/);

    const badTag = await runCli(["compare", "add", "x", "--verify", "true", "--tags", "Nope"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.notEqual(badTag.code, 0);
    assert.match(badTag.stderr, /Categories:/);

    // a task dir already exists → scaffold error (covers command-level error passthrough)
    await runCli(["compare", "add", "x", "--verify", "true"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    const dupe = await runCli(["compare", "add", "x", "--verify", "true"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.notEqual(dupe.code, 0);
    assert.match(dupe.stderr, /already exists/);

    // tags + json: observable JSON shape
    const tagged = await runCli(
      ["compare", "add", "y", "--verify", "true", "--tags", "Debugging, Testing", "--json"],
      { env: cliEnv({ AIAND_CONFIG_DIR: dir }) },
    );
    assert.equal(tagged.code, 0, tagged.stderr);
    const parsed = JSON.parse(tagged.stdout);
    assert.deepEqual(parsed.tags, ["Debugging", "Testing"]);
    assert.ok(parsed.path.endsWith(join("tasks", "y")));
  });

  test("tasks --help renders help; validate unknown positional id errors", async () => {
    const dir = newCfg("cli-help");
    const help = await runCli(["compare", "tasks", "--help"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /compare add/);

    const missing = await runCli(["compare", "validate", "ghost"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /does not exist/);
    assert.match(missing.stderr, /Known tasks live under/);

    const validateHelp = await runCli(["compare", "validate", "--help"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(validateHelp.code, 0);
    assert.match(validateHelp.stdout, /--golden/);
  });

  test("validate honest-empty: no task packs → dim hint, exit 0", async () => {
    const dir = newCfg("cli-validate-empty");
    const res = await runCli(["compare", "validate"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /No task packs yet/);
  });

  test("validate: human output covers golden-not-run and fail-before branches; json ok:true without golden", async () => {
    const dir = newCfg("cli-validate");
    writeTask(dir, "ok", { verify: "#!/bin/sh\nexit 1\n" });
    writeTask(dir, "trivial", { verify: "#!/bin/sh\nexit 0\n" });

    const res = await runCli(["compare", "validate"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
    assert.notEqual(res.code, 0);
    assert.match(res.stdout, /fail-before:\s+✓ verify fails on untouched workspace/);
    assert.match(res.stdout, /null-harness:\s+✓ scores 0/);
    assert.match(
      res.stdout,
      /golden:\s+not run — task is NOT validated until a golden replay passes/,
    );
    assert.match(res.stdout, /fail-before:\s+✗ verify passed — task is trivially solvable/);
    assert.match(res.stdout, /null-harness:\s+✗ did not score 0/);
    // Spec §2.2: golden replay missing counts as not validated — both tasks fail.
    assert.match(res.stderr, /2 of 2 task\(s\) failed validation/);

    // json: invalidCount>0 after the json body → CliError with a count
    const asJson = await runCli(["compare", "validate", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(asJson.code, 1);
    const parsed = JSON.parse(asJson.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.results.length, 2);
  });

  test("validate: golden replay is required — a fail-before-only run is golden-missing and fails", async () => {
    const dir = newCfg("cli-validate-golden-required");
    writeTask(dir, "only-ok", { verify: "#!/bin/sh\nexit 1\n" });
    const okJson = await runCli(["compare", "validate", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    // Without --golden the task is golden-missing, not valid: exit 1.
    assert.equal(okJson.code, 1, okJson.stderr);
    const parsed = JSON.parse(okJson.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.results[0].valid, null);
    assert.equal(parsed.results[0].golden, null);
    assert.ok(parsed.results[0].problems.some((p) => /--golden/.test(p)));
  });
});

// ---------------------------------------------------------------------------
// src/commands/compare.ts — cohorts branches
// ---------------------------------------------------------------------------

describe("compare cohorts (CLI)", () => {
  test("unknown --cohort rejected; no-tags cohort is honest-empty; json note without runs", async () => {
    const dir = newCfg("cli-cohorts");
    const unknown = await runCli(["compare", "cohorts", "--cohort", "Nonsense"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /Unknown cohort "Nonsense"/);

    const noTasks = await runCli(["compare", "cohorts"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(noTasks.code, 0);
    assert.match(noTasks.stdout, /No task packs yet/);

    writeTask(dir, "t1");
    const untagged = await runCli(["compare", "cohorts", "--cohort", "Debugging"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(untagged.code, 0);
    assert.match(untagged.stdout, /No task tagged Debugging/);

    const asJson = await runCli(["compare", "cohorts", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(asJson.code, 0);
    const parsed = JSON.parse(asJson.stdout);
    assert.equal(parsed.cohort, null);
    assert.match(parsed.note, /no run rows yet/);
    assert.deepEqual(parsed.tasks, [
      {
        id: "t1",
        tags: [],
        runs: 0,
        solves: 0,
        trials: 0,
        infra: 0,
        costUsd: null,
        meanWallMs: null,
      },
    ]);
  });

  test("cohorts renders run stats: runs=0 dim line, solve/cost/wall, infra suffix, runs-available footer", async () => {
    const dir = newCfg("cli-cohorts-runs");
    writeTask(dir, "a", { verify: "#!/bin/sh\nexit 1\n" });
    writeTask(dir, "b", { verify: "#!/bin/sh\nexit 1\n" });
    writeTask(dir, "c", { verify: "#!/bin/sh\nexit 1\n" });
    writeFileSync(join(taskPath("b"), "task.json"), JSON.stringify({ tags: ["Debugging"] }));
    writeRows(dir, "a", [
      row({ task: "a" }),
      row({ task: "a", success: null, failure_mode: "infra", cost_usd: null }),
    ]);
    // task b has a task.json but no run rows → runs=0 branch

    const res = await runCli(["compare", "cohorts"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /runs 2 · solve 1\/1 · cost \$0\.1000 · wall 1000ms · infra 1/);
    assert.match(
      res.stdout,
      /no run rows yet — solve\/cost\/wall appear once `compare run` exists/,
    );
    assert.match(res.stdout, /\[Debugging\]/);
    assert.match(res.stdout, /\[untagged\]/);
    assert.doesNotMatch(res.stdout, /run rows: none yet/, "footer only when no task has rows");

    // cohort filter with runs → heading includes the cohort name
    const filtered = await runCli(["compare", "cohorts", "--cohort", "Debugging"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.match(filtered.stdout, /cohorts — Debugging/);
  });

  test("cohorts footer fires when no task has run rows", async () => {
    const dir = newCfg("cli-cohorts-noruns");
    writeTask(dir, "solo");
    const res = await runCli(["compare", "cohorts"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
    assert.match(res.stdout, /run rows: none yet/);
  });
});

// ---------------------------------------------------------------------------
// src/commands/compare.ts — table renderer + export branches
// ---------------------------------------------------------------------------

describe("compare table (CLI)", () => {
  function tableCfg(name) {
    const dir = newCfg(name);
    writeTask(dir, "t1");
    writeRows(dir, "t1", [
      // agentA / m1: 3/3 solves (n=3), costed, metered → wins most columns
      row({
        task: "t1",
        run_id: "a1",
        harness: "agentA",
        model: "m1",
        success: true,
        wall_ms: 1000,
        turns: 5,
        retries: 0,
        cost_usd: 0.1,
      }),
      row({
        task: "t1",
        run_id: "a2",
        harness: "agentA",
        model: "m1",
        success: true,
        wall_ms: 2000,
        turns: 7,
        retries: 1,
        cost_usd: 0.2,
      }),
      row({
        task: "t1",
        run_id: "a3",
        harness: "agentA",
        model: "m1",
        success: true,
        wall_ms: 3000,
        turns: 6,
        retries: 0,
        cost_usd: 0.1,
      }),
      // infra row → excluded from solve rate, shown in histogram + footer
      row({
        task: "t1",
        run_id: "a4",
        harness: "agentA",
        model: "m1",
        success: null,
        failure_mode: "infra",
        cost_usd: null,
        wall_ms: 0,
      }),
      // agentB / m1: 2 failures (agent_timeout), no cost, low n
      row({
        task: "t1",
        run_id: "b1",
        harness: "agentB",
        model: "m1",
        success: false,
        failure_mode: "agent_timeout",
        cost_usd: null,
        wall_ms: 500,
        turns: null,
        retries: null,
      }),
      row({
        task: "t1",
        run_id: "b2",
        harness: "agentB",
        model: "m1",
        success: false,
        failure_mode: "verify_timeout",
        cost_usd: null,
        wall_ms: 700,
        turns: null,
        retries: null,
      }),
    ]);
    return dir;
  }

  test("human table: winners marked, low n, null-cost cells, histogram with/without infra, tie note, infra footer", async () => {
    const dir = tableCfg("cli-table");
    const res = await runCli(["compare", "table"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /agentA \/ m1.*3\/3 \(44%–100%, n=3\)/); // Wilson CI
    assert.match(res.stdout, /0\/2 \(0%–66%, n=2\) low n/); // low-n flag
    assert.match(res.stdout, /agent_timeout 1 · verify_timeout 1/); // histogram, no infra
    assert.match(res.stdout, /infra 1/); // infra-only histogram cell
    assert.match(res.stdout, /infra runs excluded from solve rate: 1/);
    assert.match(res.stdout, /▸ marks the per-column winner/);
    // B's null cost renders as an em-dash; A wins cost column
    assert.match(res.stdout, /—/);
    // CI overlap between A and B → solve tied, no solve winner, tie note printed
    assert.match(res.stdout, /solve rate: tied/);
  });

  test("table --json: cell shape, solveTied, tieNote, winners, note absent when rows exist", async () => {
    const dir = tableCfg("cli-table-json");
    const res = await runCli(["compare", "table", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.task, null);
    assert.equal(parsed.cells.length, 2);
    const a = parsed.cells.find((c) => c.harness === "agentA");
    assert.equal(a.solveRate, 1);
    assert.deepEqual(a.solveCi95, { lo: a.solveCi95.lo, hi: a.solveCi95.hi });
    assert.equal(a.lowN, false);
    assert.equal(a.costUsd, 0.4);
    assert.equal(a.costPerSolve, 0.4 / 3);
    assert.equal(a.infra, 1);
    assert.deepEqual(a.failures, {});
    const b = parsed.cells.find((c) => c.harness === "agentB");
    assert.equal(b.costUsd, null);
    assert.equal(b.costPerSolve, null);
    assert.equal(b.lowN, true);
    assert.deepEqual(b.failures, { agent_timeout: 1, verify_timeout: 1 });
    assert.equal(parsed.solveTied, true);
    assert.match(parsed.tieNote, /tied/);
    assert.equal(parsed.note, undefined);
  });

  test("recorded (simulated) rows never join the observed table (synthetic-never-joins)", async () => {
    const dir = newCfg("cli-table-recorded");
    writeTask(dir, "t1");
    writeRows(dir, "t1", [
      row({
        task: "t1",
        run_id: "live1",
        harness: "agentA",
        model: "m1",
        success: true,
        cost_usd: 0.1,
      }),
      // recorded rows carry cost_basis "recorded" — the observed table must ignore them
      row({
        task: "t1",
        run_id: "rec1",
        harness: "bench",
        model: "pinned/bench-model",
        success: true,
        cost_usd: 99,
        token_basis: "recorded",
        cost_basis: "recorded",
      }),
      row({
        task: "t1",
        run_id: "rec2",
        harness: "bench",
        model: "pinned/bench-model",
        success: true,
        cost_usd: 99,
        token_basis: "recorded",
        cost_basis: "recorded",
      }),
    ]);
    const res = await runCli(["compare", "table", "--task", "t1"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(res.code, 0, res.stderr);
    assert.doesNotMatch(
      res.stdout,
      /bench/,
      "recorded lane cells never appear in the observed table",
    );
    assert.doesNotMatch(res.stdout, /99/);
    assert.match(res.stdout, /recorded \(simulated\) — not your workload: 2 dry-run row\(s\)/);
  });

  test("table --task filter with no rows: honest empty human + json note", async () => {
    const dir = newCfg("cli-table-empty");
    writeTask(dir, "t1"); // no run rows written
    const res = await runCli(["compare", "table", "--task", "t1"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /no run rows yet/);
    const asJson = await runCli(["compare", "table", "--task", "t1", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(
      JSON.parse(asJson.stdout).note,
      "no run rows yet — run `aiand compare run --task <id>` first",
    );
  });

  test("table export: markdown default, csv by extension, json by explicit --format", async () => {
    const dir = tableCfg("cli-table-export");
    const outMd = join(dir, "table.md");
    const res = await runCli(["compare", "table", "--out", outMd], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(res.code, 0, res.stderr);
    const md = readFileSync(outMd, "utf8");
    assert.match(md, /\| harness \/ model \| solve \|/);
    assert.match(md, /\|---\|---\|---:\|/);
    assert.match(md, /solve rate: tied/);
    assert.match(res.stdout, /exported to .*table\.md \(markdown\)/);

    const outCsv = join(dir, "table.csv");
    const csvRes = await runCli(["compare", "table", "--out", outCsv], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(csvRes.code, 0, csvRes.stderr);
    const csv = readFileSync(outCsv, "utf8");
    assert.match(csv, /^harness \/ model,solve,/);
    assert.match(csv, /solve rate: tied/); // tie note appended for csv too

    const outJson = join(dir, "export.txt");
    const jsonRes = await runCli(["compare", "table", "--out", outJson, "--format", "json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(jsonRes.code, 0, jsonRes.stderr);
    const exported = JSON.parse(readFileSync(outJson, "utf8"));
    assert.equal(exported.cells.length, 2);
    assert.equal(exported.solveTied, true);
    assert.ok(exported.winners);
    assert.match(jsonRes.stdout, /exported to .*export\.txt \(json\)/);
  });
});

// ---------------------------------------------------------------------------
// src/commands/compare.ts — audit branches
// ---------------------------------------------------------------------------

describe("compare audit (CLI)", () => {
  test("audit: help, no-runs honest empty (all and per-task), json, verdict rendering", async () => {
    const dir = newCfg("cli-audit");
    const help = await runCli(["compare", "audit", "--help"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /advisory/);

    const none = await runCli(["compare", "audit"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
    assert.equal(none.code, 0);
    assert.match(none.stdout, /No run rows to audit/);

    writeTask(dir, "t1", {
      instruction:
        "# Task\n\nFix the widget so the render loop clears stale listeners and the retry budget is respected across restarts.\n",
    });
    const noneTask = await runCli(["compare", "audit", "--task", "t1"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(noneTask.code, 0);
    assert.match(noneTask.stdout, /No run rows to audit for t1/);

    // One integrity-violation success (FAIL verdict) + one plain success (N-A via suspicious)
    writeRows(dir, "t1", [
      row({
        task: "t1",
        run_id: "bad-run",
        success: true,
        failure_mode: "integrity_violation",
        turns: 2,
        tokens_in: 100,
        tokens_out: 50,
      }),
      row({
        task: "t1",
        run_id: "ok-run",
        success: true,
        turns: 4,
        tokens_in: 200,
        tokens_out: 100,
      }),
    ]);

    const res = await runCli(["compare", "audit"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /compare · audit/);
    assert.match(res.stdout, /deterministic rubric/);
    assert.match(res.stdout, /FAIL\s+bad-run/);
    assert.match(res.stdout, /integrity:FAIL/);
    assert.match(res.stdout, /verify\.sh hash changed/);
    assert.match(res.stdout, /t1/);

    const asJson = await runCli(["compare", "audit", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.equal(asJson.code, 0);
    const parsed = JSON.parse(asJson.stdout);
    assert.match(parsed.note, /advisory only/);
    assert.equal(parsed.tasks[0].id, "t1");
    assert.equal(parsed.tasks[0].runs.length, 2);
    const bad = parsed.tasks[0].runs.find((r) => r.run_id === "bad-run");
    assert.equal(bad.verdict, "FAIL");
    assert.deepEqual(bad.criteria, { integrity: "FAIL", suspicious: "N-A", specification: "PASS" });

    // per-task heading variant
    const perTask = await runCli(["compare", "audit", "--task", "t1"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir }),
    });
    assert.match(perTask.stdout, /compare · audit — t1/);
  });
});
