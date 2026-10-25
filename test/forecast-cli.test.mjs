import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { cliEnv, runCli, withTestEnv } from "./helpers.mjs";

// OBS-P2-2 (#74): the `aiand forecast` command + budget config surface, end
// to end against a seeded local store (AIAND_NO_SYNC=1 keeps it offline).

const box = withTestEnv("aiand-forecast-cli-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_HOME = dir;
  process.env.AIAND_NO_SYNC = "1";
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_NO_WARN;
  delete process.env.AIAND_BASE_URL;
});

function cli(args, extraEnv = {}) {
  return runCli(args, { env: cliEnv({ ...extraEnv }) });
}

/** Seed store.db with one USD cost row `hoursAgo` before now. */
function seed(rows) {
  mkdirSync(box.dir, { recursive: true });
  return import("node:sqlite").then(async ({ DatabaseSync }) => {
    const { MIGRATIONS } = await import("../dist/store/migrations/index.js");
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(join(box.dir, `store.db${suffix}`), { force: true });
    }
    const db = new DatabaseSync(join(box.dir, "store.db"));
    try {
      for (const migration of MIGRATIONS) db.exec(migration.sql);
      const insert = db.prepare(
        "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, " +
          "latency_ms, input_tokens, output_tokens, cached_tokens, cost, cost_value, " +
          "currency, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      rows.forEach((r, i) => {
        insert.run(
          `cli-${i}`,
          "test/model",
          r.api_key ?? "sk-abcd...1234",
          200,
          120,
          null,
          1000,
          300,
          400,
          String(r.cost),
          r.cost,
          r.currency ?? "usd",
          r.created_at,
          new Date().toISOString(),
        );
      });
    } finally {
      db.close();
    }
  });
}

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const monthStart = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
};

// -- config surface ------------------------------------------------------------

describe("forecast CLI · config", () => {
  test("budget set → get → unset round-trip through config.json", async () => {
    let r = await cli(["config", "set", "budget.monthly", "150"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Set budget\.monthly = 150/);

    r = await cli(["config", "get", "budget"]);
    assert.match(r.stdout, /budget\.monthly\s+150/);

    r = await cli(["config", "set", "budget.harness.claude", "50"]);
    assert.equal(r.code, 0);
    r = await cli(["config", "set", "budget.warn-pct", "90"]);
    assert.equal(r.code, 0);

    r = await cli(["config", "get", "budget", "--json"]);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.monthly, 150);
    assert.equal(payload.harness.claude, 50);
    assert.equal(payload.warn_pct, 90);

    r = await cli(["config", "unset", "budget.monthly"]);
    assert.equal(r.code, 0);
    r = await cli(["config", "get", "budget"]);
    assert.match(r.stdout, /budget\.monthly\s+not set/);

    // Validation: non-numeric, non-positive, unknown keys.
    r = await cli(["config", "set", "budget.monthly", "abc"]);
    assert.equal(r.code, 1);
    r = await cli(["config", "set", "budget.monthly", "0"]);
    assert.equal(r.code, 1);
    r = await cli(["config", "unset", "model"]);
    assert.equal(r.code, 1);
  });
});

// -- forecast command ----------------------------------------------------------

describe("forecast CLI · command", () => {
  test("no store → no-data verdict, table renders, bench stub", async () => {
    rmSync(join(box.dir, "store.db"), { force: true });
    let r = await cli(["config", "unset", "budget.monthly"]);
    r = await cli(["forecast"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Forecast ·/);
    assert.match(r.stdout, /no-data/);
    assert.match(r.stdout, /gateway-billed/);
    assert.match(r.stdout, /heuristic\(burn-rate v1\)/);
    assert.match(r.stdout, /budgets are advisory/);

    r = await cli(["forecast", "bench"]);
    assert.equal(r.stdout.trim(), "not implemented (v2 calibrated forecast)");
  });

  test("--json emits the projection object; --jq extracts a path", async () => {
    rmSync(join(box.dir, "store.db"), { force: true });
    await cli(["config", "set", "budget.monthly", "150"]);
    let r = await cli(["forecast", "--json"]);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.verdict, "no-data");
    assert.equal(payload.budget, 150);
    assert.equal(payload.current_spend.provenance, "gateway-billed");
    assert.equal(payload.projected_month_end, null);

    r = await cli(["forecast", "--json", "--jq", "verdict"]);
    assert.equal(JSON.parse(r.stdout), "no-data");
    r = await cli(["forecast", "--json", "--jq", "missing.path"]);
    assert.equal(JSON.parse(r.stdout), null);
  });

  test("#74 pacing verdicts end to end: exceeding with projected figure + date", async () => {
    rmSync(join(box.dir, "store.db"), { force: true });
    await seed([
      { cost: 10, created_at: hoursAgo(1) },
      { cost: 20, created_at: hoursAgo(3) },
    ]);
    await cli(["config", "set", "budget.monthly", "1"]);

    const r = await cli(["forecast", "--json"]);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.verdict, "exceeding");
    assert.ok(payload.projected_month_end.value > 1);
    assert.match(payload.projected_month_end.provenance, /^estimated\(/);
    assert.ok(payload.projected_exceed_date);
    assert.match(
      payload.pacing,
      /^On pace to exceed budget: projected \$[\d.]+ by \d{4}-\d{2}-\d{2} \(budget \$1\.00\)$/,
    );

    const human = await cli(["forecast"]);
    assert.match(
      human.stdout,
      /On pace to exceed budget: projected \$[\d.]+ by \d{4}-\d{2}-\d{2} \(budget \$1\.00\)/,
    );
  });

  test("#74 indeterminate with thin data (<2h), on-pace with a large budget", async () => {
    rmSync(join(box.dir, "store.db"), { force: true });
    await seed([{ cost: 5, created_at: hoursAgo(1) }]);
    let r = await cli(["forecast", "--json"]);
    assert.equal(JSON.parse(r.stdout).verdict, "indeterminate");

    rmSync(join(box.dir, "store.db"), { force: true });
    await seed([
      { cost: 5, created_at: hoursAgo(1) },
      { cost: 5, created_at: hoursAgo(3) },
    ]);
    await cli(["config", "set", "budget.monthly", "100000"]);
    r = await cli(["forecast", "--json"]);
    assert.equal(JSON.parse(r.stdout).verdict, "on-pace");
  });

  test("#74 the 80% warning prints on stderr and --no-warn / env suppress it", async () => {
    rmSync(join(box.dir, "store.db"), { force: true });
    // One row inside the current month at 100% of a 0.5 budget — no rate
    // needed, so this is deterministic at any wall-clock month position.
    await seed([{ cost: 0.5, created_at: monthStart() }]);
    await cli(["config", "set", "budget.monthly", "0.5"]);

    let r = await cli(["forecast"]);
    assert.match(r.stderr, /⚠ 100% of monthly budget used \(\$0\.50 \/ \$0\.50\)/);

    r = await cli(["forecast", "--no-warn"]);
    assert.doesNotMatch(r.stderr, /monthly budget used/);

    r = await cli(["forecast"], { AIAND_NO_WARN: "1" });
    assert.doesNotMatch(r.stderr, /monthly budget used/);
  });

  test("#74 per-harness budgets apply under --harness; attribution via agent-keys", async () => {
    rmSync(join(box.dir, "store.db"), { force: true });
    writeFileSync(
      join(box.dir, "agent-keys.json"),
      JSON.stringify({
        version: 1,
        keys: [{ agent: "claude", masked: "sk-claude...9999", fingerprint: "f".repeat(16), at: 1 }],
      }),
    );
    await seed([
      { cost: 10, created_at: hoursAgo(1), api_key: "sk-claude...9999" },
      { cost: 10, created_at: hoursAgo(3) },
    ]);
    await cli(["config", "set", "budget.harness.claude", "2"]);

    let r = await cli(["forecast", "--harness", "claude", "--json"]);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.harness, "claude");
    assert.equal(payload.budget, 2);
    assert.equal(payload.current_spend.value, 10);

    // An unknown harness sees no rows → no-data.
    r = await cli(["forecast", "--harness", "codex", "--json"]);
    assert.equal(JSON.parse(r.stdout).verdict, "no-data");
  });

  test("row-narrowing filters: --range / --since / --last", async () => {
    rmSync(join(box.dir, "store.db"), { force: true });
    await seed([
      { cost: 10, created_at: hoursAgo(1) },
      { cost: 10, created_at: hoursAgo(3) },
      { cost: 10, created_at: hoursAgo(30) },
    ]);
    let r = await cli(["forecast", "--range", "24h", "--json"]);
    assert.equal(JSON.parse(r.stdout).current_spend.value, 20);
    r = await cli(["forecast", "--last", "1", "--json"]);
    assert.equal(JSON.parse(r.stdout).current_spend.value, 20);
    r = await cli(["forecast", "--last", "2", "--json"]);
    assert.equal(JSON.parse(r.stdout).current_spend.value, 30);
    r = await cli(["forecast", "--since", hoursAgo(2), "--json"]);
    assert.equal(JSON.parse(r.stdout).current_spend.value, 10);
    r = await cli(["forecast", "--range", "nonsense", "--json"]);
    assert.equal(r.code, 1);
  });

  test("#74 --suggest-budget: P90 of completed months, or the refusal copy", async () => {
    rmSync(join(box.dir, "store.db"), { force: true });
    let r = await cli(["forecast", "--suggest-budget"]);
    assert.match(r.stdout, /insufficient history for P90 suggestion \(0 windows\)/);

    const now = new Date();
    const month = (offset) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 10));
      return d.toISOString();
    };
    await seed([
      { cost: 100, created_at: month(-2) },
      { cost: 40, created_at: month(-1) },
      { cost: 60, created_at: month(-1) },
    ]);
    r = await cli(["forecast", "--suggest-budget"]);
    assert.match(r.stdout, /Suggested budget\.monthly: 100/);
    assert.match(r.stdout, /aiand config set budget\.monthly 100/);

    r = await cli(["forecast", "--suggest-budget", "--json"]);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.suggested, 100);
    assert.equal(payload.provenance, "heuristic(P90 of monthly totals)");
  });

  test("mixed currencies are an explicit error, not a guess", async () => {
    rmSync(join(box.dir, "store.db"), { force: true });
    await seed([
      { cost: 1, created_at: hoursAgo(1), currency: "usd" },
      { cost: 1, created_at: hoursAgo(3), currency: "eur" },
    ]);
    const r = await cli(["forecast"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Mixed currencies/);
    assert.match(r.stderr, /doctor/);
  });
});
