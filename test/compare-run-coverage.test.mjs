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
 * Branch-coverage tests for `aiand compare run` (src/compare/run.ts): flag
 * validation, pre-run cost estimate paths, ledger/cost-join edge cases, the
 * envelope turn/retry join, failure-mode classification edges, and the
 * plain-text renderer. All gateway traffic stays on the loopback mock.
 */

const env = withTestEnv("compare-run-cov-", () => {});

function cfg(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal stub: one line of output, exits 0; optionally solves. */
const AGENT_STUB = `env > "$AIAND_CAPTURE.env"
printf '%s\\n' "$@" > "$AIAND_CAPTURE.args"
node -e "if(process.env.AIAND_SOLVE)require('fs').writeFileSync('solved.txt','x\\n')"
echo 'done: workspace updated'
exit 0`;

const VERIFY_SCRIPT =
  "#!/bin/sh\nif [ -f solved.txt ]; then echo 'SCORE: 1'; exit 0; else echo 'not solved'; exit 1; fi\n";

/** Verbose stub printing a context-window complaint on failure. */
const CONTEXT_STUB = `env > "$AIAND_CAPTURE.env"
node -e "if(process.env.AIAND_SOLVE)require('fs').writeFileSync('solved.txt','x\\n')"
if [ -f solved.txt ]; then echo 'done'; else echo 'request failed: this prompt exceeds the context length of the model'; fi
exit 0`;

async function addValidatedTask(cfgDir, id) {
  const add = await runCli(["compare", "add", id, "--verify", "test -f solved.txt"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfgDir, PATH: withNode(cfgDir) }),
  });
  assert.equal(add.code, 0, `add exits 0\n${add.stderr}`);
  writeFileSync(join(cfgDir, "tasks", id, "verify.sh"), VERIFY_SCRIPT);
  const golden = join(env.dir, `${id}-golden`);
  mkdirSync(golden, { recursive: true });
  writeFileSync(join(golden, "solved.txt"), "x\n");
  const validate = await runCli(["compare", "validate", id, "--golden", golden], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfgDir, PATH: withNode(cfgDir) }),
  });
  assert.equal(validate.code, 0, `validate exits 0\n${validate.stderr}`);
  return join(cfgDir, "tasks", id);
}

function withNode(cfgDir, extra) {
  const shDirs = ["C:/Program Files/Git/bin", "C:/Program Files/Git/usr/bin"];
  return `${[join(cfgDir, "bin"), dirname(process.execPath), ...shDirs, extra]
    .filter(Boolean)
    .join(delimiter)}${delimiter}${process.env.PATH}`;
}

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

async function withPinnedGateway(fn) {
  const logs = join(env.dir, `rows-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(logs, "[]");
  await withEnv({ AIAND_MOCK_LOG_FILE: logs }, async () => {
    await withMockGateway(async ({ url }) => fn({ url: `${url}/stub/logs-pinned`, logs }));
  });
}

/** A gateway whose /logs reads a per-test rows file: set the var name the
 * gateway process will look up via AIAND_MOCK_LOG_FILE_VAR. */
async function withFileGateway(rowsFile, fn) {
  const varName = `AIAND_MOCK_LOG_FILE_${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(rowsFile, "[]");
  await withEnv(
    { AIAND_MOCK_LOG_FILE_VAR: varName, [varName]: rowsFile },
    async () => {
      await withMockGateway(async ({ url }) =>
        fn({ url: `${url}/stub/logs-pinned-file`, rowsFile, envVar: varName }),
      );
    },
  );
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

const { normalizeEnvelope } = await import("../dist/agents/envelope.js");
const { insertEnvelope } = await import("../dist/store/envelopes.js");
const { openStore, storePath } = await import("../dist/store/index.js");

// ---------------------------------------------------------------------------
// 1. Flag validation
// ---------------------------------------------------------------------------

test("missing --task refuses with a usage hint", async () => {
  const dir = cfg("no-task");
  const res = await runCli(["compare", "run", "--harness", "codex", "--trials", "1"], {
    env: runEnv(dir, "http://127.0.0.1:9"),
  });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /--task is required/);
  assert.match(res.stderr, /Usage: aiand compare run --task/);
});

test("--trials 0 refuses", async () => {
  const dir = cfg("trials0");
  await addValidatedTask(dir, "t0");
  const res = await runCli(
    ["compare", "run", "--task", "t0", "--harness", "codex", "--trials", "0"],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /--trials must be at least 1/);
});

test("--trials negative refuses", async () => {
  const dir = cfg("trialsneg");
  await addValidatedTask(dir, "tneg");
  const res = await runCli(
    ["compare", "run", "--task", "tneg", "--harness", "codex", "--trials", "-2"],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.notEqual(res.code, 0);
  // The flag parser refuses "-2" as ambiguous before the min-1 guard; either
  // refusal is a correct rejection of a negative trial count.
  assert.match(res.stderr, /argument is ambiguous|--trials must be at least 1/);
});

test("--timeout non-numeric refuses with the parse error", async () => {
  const dir = cfg("badtimeout");
  await addValidatedTask(dir, "tt");
  const res = await runCli(
    ["compare", "run", "--task", "tt", "--harness", "codex", "--trials", "1", "--timeout", "soon"],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /--timeout/);
});

test("--harness with an empty list (only commas/whitespace) falls back to defaults", async () => {
  const dir = cfg("emptyharness");
  await addValidatedTask(dir, "eh");
  plantStub(join(dir, "bin"), "codex", AGENT_STUB);
  // The empty list resolves to DEFAULT_HARNESSES; the first (claude) is not
  // installed in this hermetic env, so it fails loudly with the not-installed
  // error rather than "unknown harness" — that proves the fallback ran.
  const res = await runCli(
    ["compare", "run", "--task", "eh", "--harness", " , ,, ", "--trials", "1"],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.notEqual(res.code, 0);
  assert.doesNotMatch(res.stderr, /Unknown harness/);
  assert.match(res.stderr, /not installed|--harness/);
});

// ---------------------------------------------------------------------------
// 2. Cost estimate paths (pre-run stderr line)
// ---------------------------------------------------------------------------

test("catalog present: metered stderr line with per-token prices", async () => {
  await withPinnedGateway(async ({ url }) => {
    const dir = cfg("estimate-present");
    await addValidatedTask(dir, "est");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    const res = await runCli(
      ["compare", "run", "--task", "est", "--harness", "codex", "--trials", "1", "--json"],
      { env: runEnv(dir, url) },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stderr, /metered: zai-org\/glm-5\.3 — input \$\d/);
    assert.match(res.stderr, /1 trial\(s\)\/harness/);
  });
});

test("catalog absent: yellow warning that cost columns may read null", async () => {
  // /stub/catalog-down serves 500 on /v1/models but still serves /logs (its
  // pinned rows file is empty); --model pins the id so the run proceeds
  // without prices.
  await withMockGateway(async ({ url }) => {
    const dir = cfg("estimate-absent");
    await addValidatedTask(dir, "est2");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    const res = await runCli(
      [
        "compare",
        "run",
        "--task",
        "est2",
        "--harness",
        "codex",
        "--trials",
        "1",
        "--model",
        "zai-org/glm-5.3",
        "--json",
      ],
      { env: runEnv(dir, `${url}/stub/catalog-down`) },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stderr, /no catalog prices for zai-org\/glm-5\.3/);
    assert.match(res.stderr, /cost columns may read null/);
  });
});

// ---------------------------------------------------------------------------
// 3. Ledger/cost join edges
// ---------------------------------------------------------------------------

test("matched rows with null cost fields: tokens gateway, summed cost stays null", async () => {
  await withFileGateway(join(env.dir, "rows-nullcost.json"), async ({ url, rowsFile }) => {
    const dir = cfg("null-cost");
    await addValidatedTask(dir, "nullcost");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    writeFileSync(rowsFile, JSON.stringify([logRow("req-null", MASKED_KEY, { cost: null })]));
    const res = await runCli(
      ["compare", "run", "--task", "nullcost", "--harness", "codex", "--trials", "1", "--json"],
      { env: runEnv(dir, url, { AIAND_SOLVE: "1" }) },
    );
    assert.equal(res.code, 0, res.stderr);
    const [row] = JSON.parse(res.stdout).rows;
    assert.equal(row.token_basis, "gateway");
    assert.equal(row.tokens_in, 1_000);
    // All cost fields null ⇒ the summed cost stays null, never 0; the basis
    // still reads "gateway" because the run WAS metered — the gateway just
    // didn't price the request.
    assert.equal(row.cost_usd, null);
    assert.equal(row.cost_basis, "gateway");
  });
});

test("matched row with tokens but no cost row data: token join, null cost", async () => {
  await withFileGateway(join(env.dir, "rows-toknocost.json"), async ({ url, rowsFile }) => {
    const dir = cfg("tokens-nocost");
    // Row has tokens but the cost column comes back null.
    await addValidatedTask(dir, "toknocost");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    writeFileSync(rowsFile, JSON.stringify([logRow("req-tok", MASKED_KEY, { cost: null })]));
    const res = await runCli(
      ["compare", "run", "--task", "toknocost", "--harness", "codex", "--trials", "1", "--json"],
      { env: runEnv(dir, url, { AIAND_SOLVE: "1" }) },
    );
    assert.equal(res.code, 0, res.stderr);
    const [row] = JSON.parse(res.stdout).rows;
    assert.deepEqual(row.request_ids, ["req-tok"]);
    assert.equal(row.tokens_out, 300);
    assert.equal(row.cost_usd, null);
  });
});

test("multiple rows in window are summed", async () => {
  await withFileGateway(join(env.dir, "rows-sum.json"), async ({ url, rowsFile }) => {
    const dir = cfg("sum");
    await addValidatedTask(dir, "sumtask");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    writeFileSync(
      rowsFile,
      JSON.stringify([
        logRow("req-a", MASKED_KEY),
        logRow("req-b", MASKED_KEY, {
          input_tokens: 500,
          cached_tokens: 100,
          output_tokens: 50,
          cost: "0.0010",
        }),
      ]),
    );
    const res = await runCli(
      ["compare", "run", "--task", "sumtask", "--harness", "codex", "--trials", "1", "--json"],
      { env: runEnv(dir, url, { AIAND_SOLVE: "1" }) },
    );
    assert.equal(res.code, 0, res.stderr);
    const [row] = JSON.parse(res.stdout).rows;
    assert.deepEqual(row.request_ids, ["req-a", "req-b"]);
    assert.equal(row.tokens_in, 1_500);
    assert.equal(row.tokens_cached, 500);
    assert.equal(row.tokens_out, 350);
    assert.ok(Math.abs(row.cost_usd - 0.0052) < 1e-9);
    assert.equal(row.cost_basis, "gateway");
  });
});

test("rows only outside the window: request_ids empty, usage null, never 0", async () => {
  await withFileGateway(join(env.dir, "rows-old.json"), async ({ url, rowsFile }) => {
    const dir = cfg("outside-window");
    // Only a row from an hour ago — far outside the 2-minute tolerance.
    await addValidatedTask(dir, "oldtask");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    writeFileSync(
      rowsFile,
      JSON.stringify([
        { ...logRow("req-old", MASKED_KEY), created_at: new Date(Date.now() - 3_600_000).toISOString() },
      ]),
    );
    const res = await runCli(
      ["compare", "run", "--task", "oldtask", "--harness", "codex", "--trials", "1", "--json"],
      { env: runEnv(dir, url, { AIAND_SOLVE: "1" }) },
    );
    assert.equal(res.code, 0, res.stderr);
    const [row] = JSON.parse(res.stdout).rows;
    assert.deepEqual(row.request_ids, []);
    assert.equal(row.tokens_in, null);
    assert.equal(row.tokens_out, null);
    assert.equal(row.cost_usd, null);
    assert.equal(row.token_basis, "none");
    assert.equal(row.cost_basis, "none");
    assert.equal(row.success, true, "the solve itself is unaffected");
  });
});

// ---------------------------------------------------------------------------
// 4. Turn/retry envelope join
// ---------------------------------------------------------------------------

test("envelope rows in window: turns counted, retries derived; absent rows stay null", async () => {
  await withMockGateway(async ({ url }) => {
    const dir = cfg("envelopes");
    await addValidatedTask(dir, "envtask");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    // Seed 2 envelope rows under the masked key: edit, then shell, then edit
    // again would be 2 turns / 1 retry; with just two edit turns it is 2 / 0.
    // A different key's row must be filtered out.
    const previous = process.env.AIAND_CONFIG_DIR;
    process.env.AIAND_CONFIG_DIR = dir;
    try {
      const opened = openStore(storePath());
      assert.ok(opened.ok);
      insertEnvelope(opened.db, {
        agent: "codex",
        model: "zai-org/glm-5.3",
        apiKey: MASKED_KEY,
        envelope: normalizeEnvelope({ tools: ["Edit"], editTargets: ["src/a.ts"], projectRoot: "/repo" }),
      });
      insertEnvelope(opened.db, {
        agent: "codex",
        model: "zai-org/glm-5.3",
        apiKey: `${FAKE_API_KEY.slice(0, 7)}...other`,
        envelope: normalizeEnvelope({ tools: ["Edit"], editTargets: ["src/b.ts"], projectRoot: "/repo" }),
      });
      opened.db.close();
    } finally {
      process.env.AIAND_CONFIG_DIR = previous;
    }

    const res = await runCli(
      ["compare", "run", "--task", "envtask", "--harness", "codex", "--trials", "1", "--json"],
      { env: runEnv(dir, url, { AIAND_SOLVE: "1" }) },
    );
    assert.equal(res.code, 0, res.stderr);
    const [row] = JSON.parse(res.stdout).rows;
    assert.equal(row.turns, 1, "only the masked-key rows count");
    assert.equal(row.retries, 0, "single edit turn with no shell between = one-shot");
  });
});

test("no envelope rows: turns and retries stay null", async () => {
  await withPinnedGateway(async ({ url }) => {
    const dir = cfg("no-env");
    await addValidatedTask(dir, "noenv");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    const res = await runCli(
      ["compare", "run", "--task", "noenv", "--harness", "codex", "--trials", "1", "--json"],
      { env: runEnv(dir, url, { AIAND_SOLVE: "1" }) },
    );
    assert.equal(res.code, 0, res.stderr);
    const [row] = JSON.parse(res.stdout).rows;
    assert.equal(row.turns, null);
    assert.equal(row.retries, null);
  });
});

// ---------------------------------------------------------------------------
// 5. Failure-mode edges
// ---------------------------------------------------------------------------

test("context_exceeded: harness output matches the context regex with a verify fail", async () => {
  await withPinnedGateway(async ({ url }) => {
    const dir = cfg("ctx");
    await addValidatedTask(dir, "ctxtask");
    plantStub(join(dir, "bin"), "codex", CONTEXT_STUB);
    const res = await runCli(
      ["compare", "run", "--task", "ctxtask", "--harness", "codex", "--trials", "1", "--json"],
      { env: runEnv(dir, url) },
    );
    assert.equal(res.code, 0, res.stderr);
    const [row] = JSON.parse(res.stdout).rows;
    assert.equal(row.success, false);
    assert.equal(row.failure_mode, "context_exceeded");
    assert.equal(row.verify_exit, 1);
  });
});

// ---------------------------------------------------------------------------
// 6. Rendering: plain-text lines + mixed --json payload
// ---------------------------------------------------------------------------

test("plain text: solved line, failing line, footer with solve rate and cost total", async () => {
  await withMockGateway(async ({ url }) => {
    const dir = cfg("render");
    await addValidatedTask(dir, "rendertask");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    plantStub(join(dir, "bin"), "opencode", `echo 'request failed: prompt is too long'`);
    const res = await runCli(
      [
        "compare",
        "run",
        "--task",
        "rendertask",
        "--harness",
        "codex,opencode",
        "--trials",
        "1",
        "--model",
        "zai-org/glm-5.3",
      ],
      { env: runEnv(dir, `${url}/stub/logs-pinned`, { AIAND_SOLVE: "1" }) },
    );
    assert.equal(res.code, 0, res.stdout);
    // The solved row prints green; the context_exceeded row prints the red
    // failure-mode line. Neither run had gateway traffic, so both read `cost —`
    // and the total stays at zero dollars.
    assert.match(res.stdout, /✓ solved/);
    assert.match(res.stdout, /✗ context_exceeded/);
    assert.match(res.stdout, /1\/2 solved/);
    assert.match(res.stdout, /total \$0\.0000/);
    assert.match(res.stdout, /rows: .*compare-runs.*rendertask\.jsonl/);
    const rows = readRows(dir, "rendertask");
    assert.equal(rows.length, 2);
  });
});

test("all-infra run: infra lines, solve rate excludes infra, exit code 1", async () => {
  await withMockGateway(async ({ url }) => {
    const dir = cfg("infra-render");
    await addValidatedTask(dir, "infratask");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    // /stub/500 answers 500 on /logs too: the sync fails at the network
    // layer, so every row is infra.
    const res = await runCli(
      [
        "compare",
        "run",
        "--task",
        "infratask",
        "--harness",
        "codex",
        "--trials",
        "2",
        "--model",
        "zai-org/glm-5.3",
      ],
      { env: runEnv(dir, `${url}/stub/500`, { AIAND_SOLVE: "1" }) },
    );
    assert.equal(res.code, 1, "infra rows fail the command so scripts notice");
    assert.match(res.stdout, /infra {2}wall/);
    assert.match(res.stdout, /cost —/);
    assert.match(res.stdout, /0\/0 solved · 2 infra \(excluded\)/);
    assert.match(res.stdout, /total \$0\.0000/);
    for (const row of readRows(dir, "infratask")) {
      assert.equal(row.failure_mode, "infra");
      assert.equal(row.success, null);
      assert.equal(row.cost_usd, null, "infra never fabricates a zero cost");
      assert.equal(row.tokens_in, null);
      assert.deepEqual(row.request_ids, []);
      assert.equal(row.token_basis, "none");
    }
  });
});

test("mixed --json payload: solved row and parse_error row keep distinct null shapes", async () => {
  await withMockGateway(async ({ url }) => {
    const dir = cfg("mixed");
    await addValidatedTask(dir, "mixedtask");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    plantStub(join(dir, "bin"), "opencode", "exit 0");
    const res = await runCli(
      [
        "compare",
        "run",
        "--task",
        "mixedtask",
        "--harness",
        "codex,opencode",
        "--trials",
        "1",
        "--model",
        "zai-org/glm-5.3",
        "--json",
      ],
      { env: runEnv(dir, `${url}/stub/logs-pinned`, { AIAND_SOLVE: "1" }) },
    );
    assert.equal(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.task, "mixedtask");
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.model, "zai-org/glm-5.3");
    assert.equal(parsed.rows.length, 2);
    const solved = parsed.rows.find((r) => r.harness === "codex");
    const silent = parsed.rows.find((r) => r.harness === "opencode");
    assert.equal(solved.success, true);
    assert.equal(solved.failure_mode, null);
    assert.equal(silent.failure_mode, "parse_error");
    assert.equal(silent.success, null);
    assert.equal(silent.completed, true, "the silent harness exited cleanly");
    // Rows without gateway traffic keep nulls, never zeros.
    assert.equal(silent.cost_usd, null);
    assert.equal(silent.tokens_in, null);
    assert.deepEqual(silent.request_ids, []);
    assert.equal(silent.token_basis, "none");
  });
});

// ---------------------------------------------------------------------------
// 7. Refusals and degraded paths
// ---------------------------------------------------------------------------

test("nonexistent --task refuses naming the scaffold command", async () => {
  const dir = cfg("ghost");
  const res = await runCli(
    ["compare", "run", "--task", "no-such-task", "--harness", "codex", "--trials", "1"],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /Task "no-such-task" does not exist/);
  assert.match(res.stderr, /compare add no-such-task/);
});

test("--dry-run with an unknown bench layout refuses, listing layouts", async () => {
  const dir = cfg("dry-bogus");
  await addValidatedTask(dir, "drybogus");
  const res = await runCli(
    ["compare", "run", "--task", "drybogus", "--dry-run", "--harness", "bogus-layout"],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /Unknown bench layout "bogus-layout"/);
  assert.match(res.stderr, /bench layouts:/);
});

test("corrupt store.db: usage degrades to nulls, run still grades and records", async () => {
  await withMockGateway(async ({ url }) => {
    const dir = cfg("badstore");
    await addValidatedTask(dir, "badstore-task");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    // A store file that cannot open: openStore fails, joinGatewayUsage and
    // the envelope walk both degrade to nulls instead of crashing.
    writeFileSync(join(dir, "store.db"), "definitely not sqlite");
    const res = await runCli(
      ["compare", "run", "--task", "badstore-task", "--harness", "codex", "--trials", "1", "--model", "zai-org/glm-5.3", "--json"],
      { env: runEnv(dir, `${url}/stub/logs-pinned`, { AIAND_SOLVE: "1" }) },
    );
    assert.equal(res.code, 0, res.stderr);
    const [row] = JSON.parse(res.stdout).rows;
    assert.equal(row.success, true, "grading is independent of the metering store");
    assert.equal(row.cost_usd, null);
    assert.equal(row.tokens_in, null);
    assert.deepEqual(row.request_ids, []);
    assert.equal(row.turns, null);
    assert.equal(row.retries, null);
    assert.equal(row.token_basis, "none");
  });
});

test("no --model and catalog unreachable refuses, telling you to pin one", async () => {
  await withMockGateway(async ({ url }) => {
    const dir = cfg("nomodel");
    await addValidatedTask(dir, "nomodel-task");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    const res = await runCli(
      ["compare", "run", "--task", "nomodel-task", "--harness", "codex", "--trials", "1"],
      { env: runEnv(dir, `${url}/stub/catalog-down`) },
    );
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /--model is required: the model catalog is unreachable/);
    assert.match(res.stderr, /Pass --model <id> to pin the model explicitly/);
  });
});

test("installed harness without a headless driver refuses loudly", async () => {
  const dir = cfg("nodriver");
  await addValidatedTask(dir, "nodriver-task");
  // `pi` has no HEADLESS_PROMPT entry: with the binary merely present, the
  // pre-flight capability check refuses before any session or catalog work.
  plantStub(join(dir, "bin"), "pi", "exit 0");
  const res = await runCli(
    ["compare", "run", "--task", "nodriver-task", "--harness", "pi", "--trials", "1"],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /no headless driver yet/);
  assert.match(res.stderr, /compare run drives: claude, codex, opencode/);
});

test("ledger join: mixed rows (one metered, one unpriced) sum the present values", async () => {
  await withFileGateway(join(env.dir, "rows-mixed.json"), async ({ url, rowsFile }) => {
    const dir = cfg("mixed-rows");
    await addValidatedTask(dir, "mixedrows");
    plantStub(join(dir, "bin"), "codex", AGENT_STUB);
    // One row fully priced, one with null token columns: the sum skips the
    // nulls (never folds them to 0) and the totals come from the priced row.
    writeFileSync(
      rowsFile,
      JSON.stringify([
        logRow("req-1", MASKED_KEY, { input_tokens: null, output_tokens: null, cached_tokens: null, cost: null }),
        logRow("req-2", MASKED_KEY, { input_tokens: 700, output_tokens: 200, cached_tokens: 0, cost: "0.0030" }),
      ]),
    );
    const res = await runCli(
      ["compare", "run", "--task", "mixedrows", "--harness", "codex", "--trials", "1", "--json"],
      { env: runEnv(dir, url, { AIAND_SOLVE: "1" }) },
    );
    assert.equal(res.code, 0, res.stderr);
    const [row] = JSON.parse(res.stdout).rows;
    assert.deepEqual(row.request_ids, ["req-1", "req-2"]);
    assert.equal(row.tokens_in, 700);
    assert.equal(row.tokens_out, 200);
    assert.ok(Math.abs(row.cost_usd - 0.003) < 1e-9);
  });
});

test("dry-run rows render with the dry-run heading and recorded cost basis", async () => {
  const dir = cfg("dry-render");
  await addValidatedTask(dir, "dryrender");
  const res = await runCli(
    ["compare", "run", "--task", "dryrender", "--dry-run", "--harness", "claude-code", "--trials", "1"],
    { env: runEnv(dir, "http://127.0.0.1:9") },
  );
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /dry-run/);
  assert.match(res.stdout, /\$[\d.]+ \(recorded\)/);
  assert.match(res.stdout, /0\/1 solved|1\/1 solved/);
});
