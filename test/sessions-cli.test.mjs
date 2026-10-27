import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

/**
 * Ticket #62 — `aiand sessions`: list, `--top-cost`, request-level drill-down,
 * per-session usage. CLI tests seed a real store under an isolated
 * AIAND_CONFIG_DIR and drive dist/index.js with --no-sync (plus one fail-open
 * sync test). Session ids are the #66 sha256(mask, started_at) derivation.
 */

// One file-level env (withTestEnv registers FILE hooks); each test gets its
// own config subdir so stores/key maps never bleed between tests.
const env = withTestEnv("sessions-cli", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const KEY = "sk-test-claude-super-secret-key-000";
const MASK = "sk-test...-000";
const SESSION_A_ID = createHash("sha256")
  .update(`${MASK}\n2026-10-20T10:00:00.000Z`)
  .digest("hex")
  .slice(0, 16);
const SESSION_B_ID = createHash("sha256")
  .update(`${MASK}\n2026-10-20T12:00:00.000Z`)
  .digest("hex")
  .slice(0, 16);

/** request row: [id, model, status, ttft, latency, in, out, cached, cost, currency, created_at] */
function seedRequests(db, rows) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
      "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) {
    const [id, model, status, ttft, latency, input, output, cached, cost, currency, at] = r;
    insert.run(
      id,
      model,
      MASK,
      status,
      ttft,
      latency,
      input,
      output,
      cached,
      cost === null ? null : String(cost),
      cost,
      currency,
      at,
      at,
    );
  }
}

async function seedStore(cfg, rows, agent = "claude") {
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey(agent, KEY);
  });
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const opened = openStore(storePath());
    assert.ok(opened.ok, "store opens under the test config dir");
    seedRequests(opened.db, rows);
    opened.db.close();
  });
}

// The canonical two-session fixture: A = 3 paid turns with ttft, B = 2
// costless turns without ttft and one 500 (zero-cost / zero-measurable-ttft
// rendering, requirement 6).
function baseRows() {
  return [
    [
      "ra1",
      "zai-org/glm-5.3",
      200,
      300,
      1500,
      1000,
      100,
      500,
      0.01,
      "usd",
      "2026-10-20T10:00:00.000Z",
    ],
    [
      "ra2",
      "zai-org/glm-5.3",
      200,
      200,
      1400,
      1000,
      100,
      500,
      0.02,
      "usd",
      "2026-10-20T10:01:00.000Z",
    ],
    [
      "ra3",
      "zai-org/glm-5.3",
      200,
      400,
      1300,
      1000,
      100,
      500,
      0.03,
      "usd",
      "2026-10-20T10:02:00.000Z",
    ],
    [
      "rb1",
      "openai/gpt-5.2",
      500,
      null,
      null,
      2000,
      200,
      0,
      null,
      "usd",
      "2026-10-20T12:00:00.000Z",
    ],
    [
      "rb2",
      "openai/gpt-5.2",
      200,
      null,
      null,
      2000,
      200,
      0,
      null,
      "usd",
      "2026-10-20T12:01:00.000Z",
    ],
  ];
}

const ENV = (cfg) => cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_NO_SYNC: "1" });

// runCli captures raw child output: normalize CRLF on Windows.
function lines(stdout) {
  return stdout.replace(/\r\n/g, "\n");
}

test("cli: sessions table is a deterministic snapshot over a fixture store", async () => {
  const cfg = cfgDir("snapshot");
  await seedStore(cfg, baseRows());
  const { code, stdout } = await runCli(["sessions"], { env: ENV(cfg) });
  assert.equal(code, 0, `sessions exits 0\n${stdout}`);
  // #62 snapshot: header block, both sessions, every column. Ids are the
  // sha256(mask, started_at) derivation, stable across rebuilds.
  assert.equal(
    lines(stdout),
    [
      "Sessions",
      "  sessions derived by 10-min gap heuristic — boundaries are approximate, not authoritative",
      "",
      "SESSION           HARNESS  MODELS             TURNS  INPUT TOK  OUT TOK  CACHED TOK       COST  TTFT P50    P95  ERRORS  START             END",
      `${SESSION_A_ID}  claude   zai-org/glm-5.3:3      3      3,000      300       1,500  $0.060000     300ms  390ms       0  2026-10-20 10:00  2026-10-20 10:02`,
      `${SESSION_B_ID}  claude   openai/gpt-5.2:2       2      4,000      400           0          -       n/a    n/a       1  2026-10-20 12:00  2026-10-20 12:01`,
      "",
    ].join("\n"),
  );
});

test("cli: --json list carries the pinned shape and the sessionization annotation", async () => {
  const cfg = cfgDir("json-list");
  await seedStore(cfg, baseRows());
  const { code, stdout } = await runCli(["sessions", "--json"], { env: ENV(cfg) });
  assert.equal(code, 0, stdout);
  const payload = JSON.parse(stdout);
  // The #66 confidence annotation is mandatory on every session-derived payload.
  assert.deepEqual(payload.sessionization, {
    method: "time-gap",
    gapMinutes: 10,
    confidence: "heuristic",
  });
  assert.equal(payload.sessions.length, 2);
  const session = payload.sessions.find((s) => s.id === SESSION_A_ID);
  assert.deepEqual(Object.keys(session).sort(), [
    "cost",
    "costs",
    "currency",
    "end",
    "errors",
    "harness",
    "id",
    "models",
    "start",
    "tokens",
    "ttft",
    "turns",
  ]);
  assert.deepEqual(session.models, [{ model: "zai-org/glm-5.3", count: 3 }]);
  assert.deepEqual(session.tokens, { input: 3000, output: 300, cached: 1500 });
  assert.equal(session.cost, 0.06);
  assert.equal(session.currency, "usd");
  assert.deepEqual(session.ttft, { p50: 300, p95: 390 });
  assert.equal(session.errors, 0);
  // Zero-cost / no-measurable-ttft session renders cleanly (no NaN/undefined).
  const costless = payload.sessions.find((s) => s.id === SESSION_B_ID);
  assert.equal(costless.cost, null);
  assert.equal(costless.currency, null);
  assert.deepEqual(costless.ttft, { p50: null, p95: null });
  assert.equal(costless.errors, 1);
});

test("cli: drill-down reconciles to the session row and prints request rows", async () => {
  const cfg = cfgDir("drill");
  await seedStore(cfg, baseRows());
  const { code, stdout } = await runCli(["sessions", SESSION_A_ID], { env: ENV(cfg) });
  assert.equal(code, 0, stdout);
  assert.ok(stdout.includes(`Session ${SESSION_A_ID}`));
  assert.ok(stdout.includes("harness claude · 3 turns"));
  assert.ok(stdout.includes("2026-10-20 10:00 → 2026-10-20 10:02"));
  // request-level rows: one per turn, gateway-verbatim fields
  assert.ok(stdout.includes("2026-10-20 10:00:00  zai-org/glm-5.3"));
  assert.ok(stdout.includes("1500ms"));
  assert.ok(stdout.includes("$0.010000"));
  assert.ok(stdout.includes("200"));
  // totals footer reconciles to the list row
  assert.ok(stdout.includes("total"));
  assert.ok(stdout.includes("$0.060000"));
  assert.ok(stdout.includes("3,000"));
});

test("cli: drill-down --json reconciles request sums to the session row", async () => {
  const cfg = cfgDir("drill-json");
  await seedStore(cfg, baseRows());
  const { code, stdout } = await runCli(["sessions", SESSION_A_ID, "--json"], { env: ENV(cfg) });
  assert.equal(code, 0, stdout);
  const payload = JSON.parse(stdout);
  assert.deepEqual(payload.sessionization, {
    method: "time-gap",
    gapMinutes: 10,
    confidence: "heuristic",
    override: SESSION_A_ID,
  });
  assert.equal(payload.session.id, SESSION_A_ID);
  assert.equal(payload.session.harness, "claude");
  assert.equal(payload.session.turns, payload.requests.length);
  const request = payload.requests[0];
  assert.deepEqual(Object.keys(request).sort(), [
    "cost",
    "currency",
    "id",
    "latency_ms",
    "model",
    "status",
    "timestamp",
    "tokens",
    "ttft_ms",
  ]);
  assert.deepEqual(request.tokens, { input: 1000, output: 100, cached: 500 });
  const costSum = payload.requests.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  assert.ok(Math.abs(costSum - payload.session.cost) < 1e-9);
  const turnsSum = payload.requests.length;
  assert.equal(turnsSum, payload.session.turns);
});

test("cli: unknown session id exits non-zero with the nearest-sessions hint", async () => {
  const cfg = cfgDir("unknown");
  await seedStore(cfg, baseRows());
  const { code, stderr } = await runCli(["sessions", "deadbeef00000000"], { env: ENV(cfg) });
  assert.notEqual(code, 0);
  assert.match(stderr, /No session with id "deadbeef00000000"/);
  assert.match(stderr, new RegExp(SESSION_B_ID));
  assert.match(stderr, new RegExp(SESSION_A_ID));
});

test("cli: --top-cost sorts by cost desc and breaks ties by the newer session", async () => {
  const cfg = cfgDir("top-cost");
  const rows = [
    // session A: 0.06 total, started 10:00
    ...baseRows(),
    // session C: 0.06 total, started 14:00 (ties with A → newer start first)
    ["rc1", "zai-org/glm-5.3", 200, 100, 900, 500, 50, 0, 0.04, "usd", "2026-10-20T14:00:00.000Z"],
    ["rc2", "zai-org/glm-5.3", 200, 100, 900, 500, 50, 0, 0.02, "usd", "2026-10-20T14:01:00.000Z"],
    // session D: most expensive, started 16:00
    ["rd1", "zai-org/glm-5.3", 200, 100, 900, 500, 50, 0, 0.5, "usd", "2026-10-20T16:00:00.000Z"],
  ];
  await seedStore(cfg, rows);
  const SESSION_C_ID = createHash("sha256")
    .update(`${MASK}\n2026-10-20T14:00:00.000Z`)
    .digest("hex")
    .slice(0, 16);
  const SESSION_D_ID = createHash("sha256")
    .update(`${MASK}\n2026-10-20T16:00:00.000Z`)
    .digest("hex")
    .slice(0, 16);
  const { code, stdout } = await runCli(["sessions", "--top-cost", "2", "--json"], {
    env: ENV(cfg),
  });
  assert.equal(code, 0, stdout);
  const ids = JSON.parse(stdout).sessions.map((s) => s.id);
  assert.deepEqual(ids, [SESSION_D_ID, SESSION_C_ID]);
  // Bare --top-cost defaults to 10.
  const bare = await runCli(["sessions", "--top-cost", "--json"], { env: ENV(cfg) });
  assert.equal(bare.code, 0, bare.stdout);
  assert.equal(JSON.parse(bare.stdout).sessions.length, 4);
  // Invalid values are user errors.
  const bad = await runCli(["sessions", "--top-cost", "0"], { env: ENV(cfg) });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /--top-cost/);
});

test("cli: --format csv has the locked header and never sums mixed currencies", async () => {
  const cfg = cfgDir("csv");
  await seedStore(cfg, baseRows());
  const { code, stdout } = await runCli(["sessions", "--format", "csv"], { env: ENV(cfg) });
  assert.equal(code, 0, stdout);
  assert.equal(
    lines(stdout),
    [
      "session_id,harness,turns,input_tokens,output_tokens,cached_tokens,cost,currency,start,end",
      `${SESSION_A_ID},claude,3,3000,300,1500,0.060000,usd,2026-10-20T10:00:00.000Z,2026-10-20T10:02:00.000Z`,
      `${SESSION_B_ID},claude,2,4000,400,0,,,2026-10-20T12:00:00.000Z,2026-10-20T12:01:00.000Z`,
      "",
    ].join("\n"),
  );
});

test("cli: mixed currencies stay per-currency in table, csv, and json", async () => {
  const cfg = cfgDir("mixed-currency");
  await seedStore(cfg, [
    ["rx1", "zai-org/glm-5.3", 200, 300, 900, 100, 10, 0, 0.01, "usd", "2026-10-20T09:00:00.000Z"],
    ["rx2", "zai-org/glm-5.3", 200, 300, 900, 100, 10, 0, 2, "eur", "2026-10-20T09:01:00.000Z"],
  ]);
  const SESSION_X_ID = createHash("sha256")
    .update(`${MASK}\n2026-10-20T09:00:00.000Z`)
    .digest("hex")
    .slice(0, 16);

  const list = await runCli(["sessions"], { env: ENV(cfg) });
  assert.equal(list.code, 0, list.stdout);
  assert.match(list.stdout, /mixed currencies/);
  assert.match(list.stdout, /Costs per currency/);
  assert.match(list.stdout, new RegExp(`${SESSION_X_ID}  usd`));
  assert.match(list.stdout, new RegExp(`${SESSION_X_ID}  eur`));

  const csv = await runCli(["sessions", "--format", "csv"], { env: ENV(cfg) });
  assert.equal(csv.code, 0, csv.stdout);
  const dataLines = csv.stdout.trimEnd().split("\n").slice(1);
  assert.equal(dataLines.length, 2, "one CSV row per currency, never summed");
  assert.ok(dataLines.some((line) => line.includes(",0.010000,usd,")));
  assert.ok(dataLines.some((line) => line.includes(",2.000000,eur,")));

  const payload = JSON.parse((await runCli(["sessions", "--json"], { env: ENV(cfg) })).stdout);
  const session = payload.sessions[0];
  assert.equal(session.cost, null, "mixed session has no single-currency sum");
  assert.equal(session.currency, null);
  assert.ok(Math.abs(session.costs.usd - 0.01) < 1e-9);
  assert.ok(Math.abs(session.costs.eur - 2) < 1e-9);
});

test("cli: --no-cost drops cost columns and drill-down still renders", async () => {
  const cfg = cfgDir("no-cost");
  await seedStore(cfg, baseRows());
  const list = await runCli(["sessions", "--no-cost"], { env: ENV(cfg) });
  assert.equal(list.code, 0, list.stdout);
  assert.ok(!list.stdout.includes("COST"), "no cost header");
  assert.ok(!list.stdout.includes("$0.060000"));
  assert.ok(list.stdout.includes("TTFT P50"));

  const drill = await runCli(["sessions", SESSION_A_ID, "--no-cost"], { env: ENV(cfg) });
  assert.equal(drill.code, 0, drill.stdout);
  assert.ok(!drill.stdout.includes("$"));
  assert.ok(drill.stdout.includes("total"));
});

test("cli: filters (--agent, --model, --since/--until, --session-gap) compose", async () => {
  const cfg = cfgDir("filters");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  const OTHER = "sk-test-opencode-super-secret-001";
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", KEY);
    await recordAgentKey("opencode", OTHER);
  });
  const otherMask = "sk-test...-001";
  const rows = [
    ...baseRows(),
    ["ro1", "zai-org/glm-5.3", 200, 100, 900, 100, 10, 0, 0.01, "usd", "2026-10-20T10:00:00.000Z"],
  ];
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { openStore, storePath } = await import("../dist/store/index.js");
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // base rows on the claude key, ro1 on the opencode key
    for (const row of [...baseRows(), rows[5]]) {
      const [id, model, status, ttft, latency, input, output, cached, cost, currency, at] = row;
      insert.run(
        id,
        model,
        id === "ro1" ? otherMask : MASK,
        status,
        ttft,
        latency,
        input,
        output,
        cached,
        cost === null ? null : String(cost),
        cost,
        currency,
        at,
        at,
      );
    }
    opened.db.close();
  });

  const byAgent = JSON.parse(
    (await runCli(["sessions", "--json", "--agent", "opencode"], { env: ENV(cfg) })).stdout,
  );
  assert.equal(byAgent.sessions.length, 1);
  assert.equal(byAgent.sessions[0].harness, "opencode");

  const byModel = JSON.parse(
    (await runCli(["sessions", "--json", "--model", "openai/gpt-*"], { env: ENV(cfg) })).stdout,
  );
  assert.equal(byModel.sessions.length, 1);
  assert.deepEqual(byModel.sessions[0].models, [{ model: "openai/gpt-5.2", count: 2 }]);

  const windowed = JSON.parse(
    (
      await runCli(
        [
          "sessions",
          "--json",
          "--since",
          "2026-10-20T11:00:00Z",
          "--until",
          "2026-10-20T13:00:00Z",
        ],
        { env: ENV(cfg) },
      )
    ).stdout,
  );
  assert.equal(windowed.sessions.length, 1);
  assert.equal(windowed.sessions[0].id, SESSION_B_ID);

  // A 2-minute gap merges the 10:00–10:02 turns with nothing else, but the
  // 12:00 pair and 09:00 pair stay separate sessions under any gap here; the
  // gap override only needs to be reflected in the annotation.
  const gapped = JSON.parse(
    (await runCli(["sessions", "--json", "--session-gap", "5"], { env: ENV(cfg) })).stdout,
  );
  assert.equal(gapped.sessionization.gapMinutes, 5);
  const invalidGap = await runCli(["sessions", "--session-gap", "abc"], { env: ENV(cfg) });
  assert.notEqual(invalidGap.code, 0);
  assert.match(invalidGap.stderr, /--session-gap/);
});

test("cli: auto-sync failure fails open with a warning, still lists sessions", async () => {
  const cfg = cfgDir("fail-open");
  await seedStore(cfg, baseRows());
  // No AIAND_NO_SYNC and no credentials: openSession fails, the command warns
  // on stderr and serves the local store anyway. AIAND_API_KEY: undefined
  // scrubs CI's ambient job-level key — without it openSession takes the env
  // key and a real sync attempt turns "skipped" into "failed".
  const { code, stdout, stderr } = await runCli(["sessions"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: undefined }),
  });
  assert.equal(code, 0, `fail-open keeps the command alive\n${stdout}${stderr}`);
  assert.match(stderr, /store sync skipped/);
  assert.match(stdout, new RegExp(SESSION_A_ID));
});

test("cli: sessions is registered and its --help renders", async () => {
  const cfg = cfgDir("help");
  const help = await runCli(["sessions", "--help"], { env: ENV(cfg) });
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes("aiand sessions"));
  assert.ok(help.stdout.includes("--top-cost"));
  assert.ok(help.stdout.includes('A "turn" is exactly one stored request'));
  const registry = await import("../dist/commands/index.js");
  assert.ok(registry.COMMANDS.some((c) => c.name === "sessions"));
});

// #91: the session flag guards and costless-drilldown render branches the
// earlier CLI tests leave open.
test("cli: sessions flag guards all refuse with clear errors", async () => {
  const cfg = cfgDir("flag-guards");
  await seedStore(cfg, baseRows());
  const base = { env: ENV(cfg) };

  const badFormat = await runCli(["sessions", "--format", "yaml"], base);
  assert.equal(badFormat.code, 1);
  assert.match(badFormat.stderr, /Invalid --format value: yaml/);

  const csvJson = await runCli(["sessions", "--format", "csv", "--json"], base);
  assert.equal(csvJson.code, 1);
  assert.match(csvJson.stderr, /choose one/);

  const badTz = await runCli(["sessions", "--timezone", "Mars/Olympus"], base);
  assert.equal(badTz.code, 1);
  assert.match(badTz.stderr, /Invalid --timezone value/);

  const tooMany = await runCli(["sessions", "a", "b"], base);
  assert.equal(tooMany.code, 1);
  assert.match(tooMany.stderr, /at most one session id/);

  const badTopCost = await runCli(["sessions", "--top-cost", "1.5"], base);
  assert.equal(badTopCost.code, 1);
  assert.match(badTopCost.stderr, /--top-cost/);
});

test("cli: drill-down on a costless session prints the costless note and n/a cells", async () => {
  const cfg = cfgDir("costless-drill");
  await seedStore(cfg, [baseRows().at(-2), baseRows().at(-1)]);
  const run = await runCli(["sessions", SESSION_B_ID], { env: ENV(cfg) });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /No billed cost recorded for this session/);
  assert.match(run.stdout, /n\/a/, "ttft cell renders n/a without ttft rows");
});
