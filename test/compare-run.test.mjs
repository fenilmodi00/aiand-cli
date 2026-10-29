import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import {
  cliEnv,
  FAKE_API_KEY,
  plantStub,
  runCli,
  withEnv,
  withMockGateway,
  withTestEnv,
} from "./helpers.mjs";

/**
 * Ticket #131 — `aiand compare run`: headless harness drivers, JSONL run
 * rows, the masked-key+time-window cost join against the mock gateway's
 * /logs, and the failure taxonomy. All gateway traffic goes to
 * test/mock-gateway.mjs on loopback (never a real gateway); harness
 * binaries are capture stubs on a hermetic PATH.
 */

const env = withTestEnv("compare-run-", () => {});

function cfg(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The agent capture stub: dump argv+env, optionally solve, optionally hack. */
const AGENT_STUB = `env > "$AIAND_CAPTURE.env"
printf '%s\\n' "$@" > "$AIAND_CAPTURE.args"
node -e "if(process.env.AIAND_SOLVE)require('fs').writeFileSync('solved.txt','x\\n')"
node -e "if(process.env.AIAND_HACK)require('fs').writeFileSync(process.env.AIAND_HACK,'hacked\\n')"
echo 'done: workspace updated'
exit 0`;

const VERIFY_SCRIPT =
  "#!/bin/sh\nif [ -f solved.txt ]; then echo 'SCORE: 1'; exit 0; else echo 'not solved'; exit 1; fi\n";

/** Scaffold a task, hand-write a deterministic verify script, validate it. */
async function addValidatedTask(cfgDir, id) {
  const add = await runCli(["compare", "add", id, "--verify", "test -f solved.txt"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfgDir, PATH: withNode(cfgDir) }),
  });
  assert.equal(add.code, 0, `add exits 0\n${add.stderr}`);
  const taskDir = join(cfgDir, "tasks", id);
  writeFileSync(join(taskDir, "verify.sh"), VERIFY_SCRIPT);
  // Golden replay: a dir holding the solved file, so validate passes.
  const golden = join(env.dir, `${id}-golden`);
  mkdirSync(golden, { recursive: true });
  writeFileSync(join(golden, "solved.txt"), "x\n");
  const validate = await runCli(["compare", "validate", id, "--golden", golden], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfgDir, PATH: withNode(cfgDir) }),
  });
  assert.equal(validate.code, 0, `validate exits 0\n${validate.stderr}`);
  return taskDir;
}

/** PATH guaranteed to carry `node` for the stub's execSync lines, `sh`
 * for verify scripts, and the planted agent stub dir first — the same
 * shape agent-session.test.mjs uses (inherited PATH keeps cmd.exe and the
 * shell utilities the shims exec). */
function withNode(cfgDir, extra) {
  const shDirs = ["C:/Program Files/Git/bin", "C:/Program Files/Git/usr/bin"];
  return `${[join(cfgDir, "bin"), dirname(process.execPath), ...shDirs, extra]
    .filter(Boolean)
    .join(delimiter)}${delimiter}${process.env.PATH}`;
}

/** Child env for a compare run against `base`, with the agent stub first. */
function runEnv(cfgDir, base, overrides = {}) {
  return cliEnv({
    CI: "1",
    NO_COLOR: "1",
    AIAND_CONFIG_DIR: cfgDir,
    AIAND_HOME: join(cfgDir, "home"),
    AIAND_API_KEY: FAKE_API_KEY,
    AIAND_BASE_URL: base,
    AIAND_CAPTURE: join(cfgDir, "capture"),
    PATH: withNode(cfgDir),
    ...overrides,
  });
}

/** Gateway + shared rows file: AIAND_MOCK_LOG_FILE must reach the gateway
 * PROCESS (it re-reads the file per request), not the CLI child — same
 * wiring as store-sync-94's withPinnedGateway. */
async function withPinnedGateway(fn) {
  const logs = join(env.dir, `rows-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(logs, "[]");
  await withEnv({ AIAND_MOCK_LOG_FILE: logs }, async () => {
    await withMockGateway(async ({ url }) => fn({ url: `${url}/stub/logs-pinned`, logs }));
  });
}

/** One gateway /logs row (wire created_at, masked key) inside the join window. */
function logRow(id, maskedKey, overrides = {}) {
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date(Date.now() - 30_000);
  const wire =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.000000+00`;
  return {
    id,
    model: "zai-org/glm-5.3",
    api_key: maskedKey,
    status_code: 200,
    ttft_ms: 100,
    latency_ms: 900,
    input_tokens: 1_000,
    output_tokens: 300,
    cached_tokens: 400,
    cost: "0.0042",
    currency: "usd",
    created_at: wire,
    ...overrides,
  };
}

/** FAKE_API_KEY masked the way the gateway masks /logs rows. */
const MASKED_KEY = `${FAKE_API_KEY.slice(0, 7)}...${FAKE_API_KEY.slice(-4)}`;

const readRows = (cfgDir, task) =>
  readFileSync(join(cfgDir, "compare-runs", `${task}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

const RUN_SHAPE = [
  "run_id",
  "ts",
  "harness",
  "harness_version",
  "model",
  "task",
  "success",
  "score",
  "failure_mode",
  "completed",
  "wall_ms",
  "turns",
  "retries",
  "tokens_in",
  "tokens_cached",
  "tokens_out",
  "cost_usd",
  "token_basis",
  "cost_basis",
  "request_ids",
  "verify_exit",
];

test("happy path: solved row with gateway-metered cost and exact pinned shape", async () => {
  await withPinnedGateway(async ({ url, logs }) => {
    const dir = cfg("happy");
    writeFileSync(logs, JSON.stringify([logRow("req-1", MASKED_KEY)]));
    const taskDir = await addValidatedTask(dir, "solve-it");
    assert.equal(existsSync(taskDir), true);
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);

    const res = await runCli(
      ["compare", "run", "--task", "solve-it", "--harness", "codex", "--trials", "1", "--json"],
      {
        env: runEnv(dir, url, { AIAND_SOLVE: "1" }),
      },
    );
    assert.equal(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.rows.length, 1);
    const row = parsed.rows[0];
    assert.deepEqual(Object.keys(row).sort(), RUN_SHAPE.sort());
    assert.equal(row.run_id, `codex:zai-org/glm-5.3:solve-it:trial1`);
    assert.equal(row.success, true);
    assert.equal(row.score, 1);
    assert.equal(row.completed, true);
    assert.equal(row.failure_mode, null);
    assert.equal(row.verify_exit, 0);
    assert.equal(row.token_basis, "gateway");
    assert.equal(row.cost_basis, "gateway");
    assert.deepEqual(row.request_ids, ["req-1"]);
    assert.equal(row.tokens_in, 1_000);
    assert.equal(row.tokens_cached, 400);
    assert.equal(row.tokens_out, 300);
    assert.equal(row.cost_usd, 0.0042);
    assert.equal(typeof row.wall_ms, "number");
    assert.ok(row.ts, "row carries a timestamp");
    // The row landed in the append-only JSONL under the data dir.
    assert.deepEqual(readRows(dir, "solve-it"), parsed.rows);
  });
});

test("verify-fail row: success false, score null, exit recorded", async () => {
  await withPinnedGateway(async ({ url }) => {
    const dir = cfg("fail");
    await addValidatedTask(dir, "miss-it");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB); // never writes solved.txt

    const res = await runCli(
      ["compare", "run", "--task", "miss-it", "--harness", "codex", "--trials", "1", "--json"],
      { env: runEnv(dir, url) },
    );
    assert.equal(res.code, 0, res.stderr);
    const [row] = JSON.parse(res.stdout).rows;
    assert.equal(row.success, false);
    assert.equal(row.score, null);
    assert.equal(row.completed, true, "harness exited cleanly — separate from success");
    assert.equal(row.verify_exit, 1);
    assert.equal(row.failure_mode, null);
  });
});

test("integrity violation: agent edits verify.sh => flagged, verify result not taken", async () => {
  await withPinnedGateway(async ({ url }) => {
    const dir = cfg("hack");
    const taskDir = await addValidatedTask(dir, "grader-hack");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);

    const res = await runCli(
      ["compare", "run", "--task", "grader-hack", "--harness", "codex", "--trials", "1", "--json"],
      {
        env: runEnv(dir, url, {
          AIAND_SOLVE: "1",
          AIAND_HACK: join(taskDir, "verify.sh"),
        }),
      },
    );
    assert.equal(res.code, 0, res.stderr);
    const [row] = JSON.parse(res.stdout).rows;
    assert.equal(row.failure_mode, "integrity_violation");
    assert.equal(row.success, null, "a hacked grader is never taken as a pass");
    assert.equal(row.verify_exit, null);
    assert.equal(readFileSync(join(taskDir, "verify.sh"), "utf8"), "hacked\n");
  });
});

test("trials > 1: one row per trial, stable run_ids", async () => {
  await withPinnedGateway(async ({ url }) => {
    const dir = cfg("trials");
    await addValidatedTask(dir, "repeat");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);

    const res = await runCli(
      ["compare", "run", "--task", "repeat", "--harness", "codex", "--trials", "3", "--json"],
      { env: runEnv(dir, url) },
    );
    assert.equal(res.code, 0, res.stderr);
    const rows = JSON.parse(res.stdout).rows;
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.run_id),
      [
        "codex:zai-org/glm-5.3:repeat:trial1",
        "codex:zai-org/glm-5.3:repeat:trial2",
        "codex:zai-org/glm-5.3:repeat:trial3",
      ],
    );
  });
});

test("unvalidated task refused with a hint; --force overrides", async () => {
  const dir = cfg("unvalidated");
  const add = await runCli(["compare", "add", "raw", "--verify", "test -f solved.txt"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir, PATH: withNode(dir) }),
  });
  assert.equal(add.code, 0, add.stderr);

  const refused = await runCli(
    ["compare", "run", "--task", "raw", "--harness", "codex", "--trials", "1"],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /not validated/);
  assert.match(refused.stderr, /compare validate/);

  // --force still refuses to spend: the harness stub is absent, so the run
  // reports the missing binary as infra rather than crashing.
  const forced = await runCli(
    [
      "compare",
      "run",
      "--task",
      "raw",
      "--harness",
      "codex",
      "--trials",
      "1",
      "--force",
      "--model",
      "zai-org/glm-5.3",
      "--json",
    ],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.notEqual(forced.code, 0, "infra rows fail the command, reported separately");
  const rows = JSON.parse(forced.stdout).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].failure_mode, "infra");
});

test("gateway unreachable => infra row, cost null, never folded into solve rate", async () => {
  const dir = cfg("offline");
  await addValidatedTask(dir, "offline-task");
  plantStub(join(dir, "bin"), "codex", AGENT_STUB);

  // CLOSED_URL fails fast with ECONNREFUSED — the gateway is unreachable.
  const res = await runCli(
    [
      "compare",
      "run",
      "--task",
      "offline-task",
      "--harness",
      "codex",
      "--trials",
      "1",
      "--model",
      "zai-org/glm-5.3",
      "--json",
    ],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.notEqual(res.code, 0, "infra is reported, not swallowed");
  const [row] = JSON.parse(res.stdout).rows;
  assert.equal(row.failure_mode, "infra");
  assert.equal(row.success, null);
  assert.equal(row.cost_usd, null);
  assert.equal(row.token_basis, "none");
  assert.deepEqual(row.request_ids, []);
});

test("--dry-run: recorded lane, zero gateway spend, recorded basis", async () => {
  const dir = cfg("dry");
  await addValidatedTask(dir, "dry-task");
  // No agent stub planted: the dry lane must not spawn any harness.

  const res = await runCli(
    [
      "compare",
      "run",
      "--task",
      "dry-task",
      "--dry-run",
      "--harness",
      "claude-code",
      "--trials",
      "2",
      "--json",
    ],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.model, "pinned/bench-model");
  assert.equal(parsed.rows.length, 2);
  for (const row of parsed.rows) {
    assert.equal(row.harness, "claude-code");
    assert.equal(row.token_basis, "recorded");
    assert.equal(row.cost_basis, "recorded");
    assert.ok(row.cost_usd > 0, "recorded prices give a concrete cost figure");
    assert.ok(row.turns > 0);
    assert.equal(row.request_ids.length, 0, "no gateway requests were made");
  }
  assert.deepEqual(readRows(dir, "dry-task"), parsed.rows);
});

test("parse_error: harness exits cleanly with no output => never graded as success", async () => {
  await withPinnedGateway(async ({ url }) => {
    const dir = cfg("silent");
    await addValidatedTask(dir, "silent-task");
    plantStub(join(dir, "bin"), "codex", `exit 0`);

    const res = await runCli(
      ["compare", "run", "--task", "silent-task", "--harness", "codex", "--trials", "1", "--json"],
      { env: runEnv(dir, url) },
    );
    assert.equal(res.code, 0, res.stderr);
    const [row] = JSON.parse(res.stdout).rows;
    assert.equal(row.failure_mode, "parse_error");
    assert.equal(row.success, null);
    assert.equal(row.completed, true, "the harness exited cleanly");
    assert.equal(row.verify_exit, null, "nothing was graded");
  });
});

test("copilot-app cannot be driven headless: loud failure naming the limitation", async () => {
  const dir = cfg("gui");
  await addValidatedTask(dir, "gui-task");

  const res = await runCli(
    ["compare", "run", "--task", "gui-task", "--harness", "copilot-app", "--trials", "1"],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /desktop app/);
  assert.match(res.stderr, /cannot drive it headless/);
});

test("unknown harness named explicitly => clear error", async () => {
  const dir = cfg("unknown");
  await addValidatedTask(dir, "u-task");
  const res = await runCli(
    ["compare", "run", "--task", "u-task", "--harness", "bogus", "--trials", "1"],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /Unknown harness/);
});

test("table with no run rows is honest-empty with exit 0 (#132)", async () => {
  const dir = cfg("table");
  const res = await runCli(["compare", "table"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
  assert.match(res.stdout, /No task packs yet/);
});
