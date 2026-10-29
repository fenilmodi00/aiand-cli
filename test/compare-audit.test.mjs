import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cliEnv, runCli, withTestEnv } from "./helpers.mjs";

/**
 * Ticket #134 — `aiand compare audit`: opt-in deterministic rubric audit of
 * suspicious successes. Computed on read, never persisted, never part of
 * solve rate. No gateway LLM path exists, so no mock gateway is needed —
 * the audit never makes network traffic (verified by the net guard).
 */

const env = withTestEnv("compare-audit", () => {});

function cfg(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const INSTRUCTION =
  "Fix the off-by-one error in src/list.ts so every element is rendered. Add a test covering the last element.";

/** Seed run rows directly into the config dir's compare-runs/<task>.jsonl. */
function seedRuns(cfgDir, task, rows) {
  const dir = join(cfgDir, "compare-runs");
  mkdirSync(dir, { recursive: true });
  const base = {
    run_id: "r",
    ts: "2026-10-29T00:00:00Z",
    harness: "claude",
    harness_version: "1",
    model: "m",
    task,
    success: true,
    score: 1,
    failure_mode: null,
    completed: true,
    wall_ms: 1000,
    turns: 10,
    retries: 0,
    tokens_in: 1000,
    tokens_cached: 0,
    tokens_out: 500,
    cost_usd: 0.01,
    token_basis: "gateway",
    cost_basis: "gateway",
    request_ids: [],
    verify_exit: 0,
  };
  writeFileSync(
    join(dir, `${task}.jsonl`),
    `${rows.map((r) => JSON.stringify({ ...base, ...r })).join("\n")}\n`,
  );
}

/** Minimal task pack so the specification criterion passes. */
function seedTaskPack(cfgDir, task) {
  mkdirSync(join(cfgDir, "tasks", task, "workspace"), { recursive: true });
  writeFileSync(join(cfgDir, "tasks", task, "verify.sh"), "#!/bin/sh\nexit 1\n");
  writeFileSync(join(cfgDir, "tasks", task, "instruction.md"), INSTRUCTION);
}

test("audit flags a clear suspicious success far below the task median", async () => {
  const dir = cfg("suspicious");
  seedTaskPack(dir, "t1");
  // 5 healthy successes at 1500 tokens / 10 turns; one at 100 tokens / 2 turns.
  seedRuns(dir, "t1", [
    ...Array.from({ length: 5 }, (_, i) => ({
      run_id: `ok${i}`,
      tokens_in: 1000,
      tokens_out: 500,
      turns: 10,
    })),
    { run_id: "cheap", tokens_in: 60, tokens_out: 40, turns: 1 },
  ]);
  const res = await runCli(["compare", "audit", "--task", "t1", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(res.stdout);
  const cheap = body.tasks[0].runs.find((r) => r.run_id === "cheap");
  assert.equal(cheap.criteria.suspicious, "FAIL");
  assert.equal(cheap.verdict, "FAIL");
  assert.match(cheap.reasons[0], /suspiciously cheap success/);
  const ok = body.tasks[0].runs.find((r) => r.run_id === "ok0");
  assert.equal(ok.criteria.suspicious, "PASS");
  assert.equal(ok.verdict, "PASS");
});

test("borderline success at exactly the threshold passes", async () => {
  const dir = cfg("borderline");
  seedTaskPack(dir, "t1");
  // median total = 1500; 25% = 375; a 375-token success is NOT below it.
  seedRuns(dir, "t1", [
    ...Array.from({ length: 4 }, (_, i) => ({
      run_id: `ok${i}`,
      tokens_in: 1000,
      tokens_out: 500,
      turns: 10,
    })),
    { run_id: "edge", tokens_in: 250, tokens_out: 125, turns: 3 },
  ]);
  const res = await runCli(["compare", "audit", "--task", "t1", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  const edge = JSON.parse(res.stdout).tasks[0].runs.find((r) => r.run_id === "edge");
  assert.equal(edge.criteria.suspicious, "PASS");
  assert.equal(edge.verdict, "PASS");
});

test("suspicious check is N-A with fewer than 3 metered successes", async () => {
  const dir = cfg("thin");
  seedTaskPack(dir, "t1");
  seedRuns(dir, "t1", [
    { run_id: "a", tokens_in: 10, tokens_out: 10, turns: 1 },
    { run_id: "b", tokens_in: 10, tokens_out: 10, turns: 1 },
  ]);
  const res = await runCli(["compare", "audit", "--task", "t1", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  const runs = JSON.parse(res.stdout).tasks[0].runs;
  assert.ok(runs.every((r) => r.criteria.suspicious === "N-A"));
  assert.ok(runs.every((r) => r.verdict === "N-A"));
});

test("integrity_violation failure mode surfaces as an integrity FAIL", async () => {
  const dir = cfg("integrity");
  seedTaskPack(dir, "t1");
  seedRuns(dir, "t1", [
    ...Array.from({ length: 3 }, (_, i) => ({
      run_id: `ok${i}`,
      tokens_in: 1000,
      tokens_out: 500,
      turns: 10,
    })),
    {
      run_id: "cheat",
      success: true,
      failure_mode: "integrity_violation",
      tokens_in: 1000,
      tokens_out: 500,
      turns: 10,
    },
  ]);
  const res = await runCli(["compare", "audit", "--task", "t1", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  const cheat = JSON.parse(res.stdout).tasks[0].runs.find((r) => r.run_id === "cheat");
  assert.equal(cheat.criteria.integrity, "FAIL");
  assert.equal(cheat.verdict, "FAIL");
  assert.match(cheat.reasons[0], /integrity_violation/);
});

test("short or missing instruction.md fails the specification criterion", async () => {
  const dir = cfg("spec");
  mkdirSync(join(dir, "tasks", "t1", "workspace"), { recursive: true });
  writeFileSync(join(dir, "tasks", "t1", "verify.sh"), "#!/bin/sh\nexit 1\n");
  writeFileSync(join(dir, "tasks", "t1", "instruction.md"), "Fix it.");
  seedRuns(dir, "t1", [{ run_id: "a" }]);
  const res = await runCli(["compare", "audit", "--task", "t1", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  const run = JSON.parse(res.stdout).tasks[0].runs[0];
  assert.equal(run.criteria.specification, "FAIL");
  assert.ok(run.reasons.some((r) => /instruction\.md/.test(r)));

  // No instruction file at all.
  mkdirSync(join(dir, "tasks", "t2", "workspace"), { recursive: true });
  writeFileSync(join(dir, "tasks", "t2", "verify.sh"), "#!/bin/sh\nexit 1\n");
  seedRuns(dir, "t2", [{ run_id: "a" }]);
  const res2 = await runCli(["compare", "audit", "--task", "t2", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  const run2 = JSON.parse(res2.stdout).tasks[0].runs[0];
  assert.equal(run2.criteria.specification, "FAIL");
});

test("honest empty: no run rows prints 'no run rows to audit'", async () => {
  const dir = cfg("empty");
  const res = await runCli(["compare", "audit"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /No run rows to audit/);

  const res2 = await runCli(["compare", "audit", "--task", "nope"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  assert.equal(res2.code, 0);
  assert.match(res2.stdout, /No run rows to audit/);
});

test("corrupt lines are skipped fail-open", async () => {
  const dir = cfg("corrupt");
  const runDir = join(dir, "compare-runs");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "t1.jsonl"),
    "{not json}\n" +
      JSON.stringify({
        run_id: "good",
        ts: "t",
        harness: "claude",
        harness_version: null,
        model: "m",
        task: "t1",
        success: true,
        score: 1,
        failure_mode: null,
        completed: true,
        wall_ms: 1,
        turns: null,
        retries: null,
        tokens_in: null,
        tokens_cached: null,
        tokens_out: null,
        cost_usd: null,
        token_basis: "none",
        cost_basis: "none",
        request_ids: [],
        verify_exit: 0,
      }) +
      "\n",
  );
  const res = await runCli(["compare", "audit", "--task", "t1", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  assert.equal(res.code, 0, res.stderr);
  const runs = JSON.parse(res.stdout).tasks[0].runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run_id, "good");
  assert.equal(runs[0].criteria.suspicious, "N-A", "unmetered success is N-A, not FAIL");
});

test("audit is advisory: run rows on disk are unchanged after an audit", async () => {
  const dir = cfg("advisory");
  seedRuns(dir, "t1", [{ run_id: "a" }]);
  const before = await import("node:fs").then((fs) =>
    fs.readFileSync(join(dir, "compare-runs", "t1.jsonl"), "utf8"),
  );
  await runCli(["compare", "audit", "--task", "t1"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
  const after = await import("node:fs").then((fs) =>
    fs.readFileSync(join(dir, "compare-runs", "t1.jsonl"), "utf8"),
  );
  assert.equal(before, after);
});

test("human output renders the per-run rubric table", async () => {
  const dir = cfg("human");
  seedRuns(dir, "t1", [{ run_id: "a", tokens_in: 10, tokens_out: 10, turns: 1 }]);
  const res = await runCli(["compare", "audit", "--task", "t1"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /compare · audit/);
  assert.match(res.stdout, /integrity:/);
  assert.match(res.stdout, /deterministic rubric/);
});

test("audit makes no network traffic (net guard blocks non-loopback)", async () => {
  const dir = cfg("nonet");
  seedRuns(dir, "t1", [{ run_id: "a" }]);
  // No AIAND_TEST_ALLOW_NETWORK — any non-loopback fetch would reject and fail the CLI.
  const res = await runCli(["compare", "audit", "--task", "t1"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  assert.equal(res.code, 0, res.stderr);
});

test("full healthy task audits to all-PASS across every criterion", async () => {
  const dir = cfg("healthy");
  mkdirSync(join(dir, "tasks", "t1", "workspace"), { recursive: true });
  writeFileSync(join(dir, "tasks", "t1", "verify.sh"), "#!/bin/sh\nexit 1\n");
  writeFileSync(join(dir, "tasks", "t1", "instruction.md"), INSTRUCTION);
  seedRuns(dir, "t1", [
    ...Array.from({ length: 4 }, (_, i) => ({
      run_id: `ok${i}`,
      tokens_in: 1000,
      tokens_out: 500,
      turns: 10,
    })),
  ]);
  const res = await runCli(["compare", "audit", "--task", "t1", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  const runs = JSON.parse(res.stdout).tasks[0].runs;
  assert.ok(runs.length >= 4);
  assert.ok(runs.every((r) => r.verdict === "PASS" && r.reasons.length === 0));
});
