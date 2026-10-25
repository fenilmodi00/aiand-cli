import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { cliEnv, runCli, withTestEnv } from "./helpers.mjs";

// OBS-P2-1 (#71): the observability surface of `aiand status` end to end —
// --format line / --format json / --write-state, the G5 exit-code contract,
// and the invariant that plain `aiand status` keeps its auth semantics.
// AIAND_NO_SYNC=1 keeps everything offline; status itself never syncs.

const box = withTestEnv("aiand-status-obs-test-", (dir) => {
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

const NOW_MS = Date.now();
const HOUR_MS = 3_600_000;
const hoursAgo = (h) => new Date(NOW_MS - h * HOUR_MS).toISOString();

async function seed(rows) {
  mkdirSync(box.dir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
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
        `obs-${i}`,
        "test/model",
        "sk-abcd...1234",
        200,
        r.ttft_ms ?? 120,
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
}

async function setBudget(value) {
  const r = await cli(["config", "set", "budget.monthly", String(value)]);
  assert.equal(r.code, 0);
}
async function unsetBudget() {
  const r = await cli(["config", "unset", "budget.monthly"]);
  assert.equal(r.code, 0);
}

// -- exit codes (G5) -------------------------------------------------------------

describe("status observability · exit codes", () => {
  test("empty store → exit 30, one no-data line, no ANSI", async () => {
    rmSync(join(box.dir, "store.db"), { force: true });
    const { code, stdout } = await cli(["status", "--format", "line"]);
    assert.equal(code, 30);
    assert.equal(stdout.split("\n").filter((l) => l.trim() !== "").length, 1);
    assert.match(stdout, /no data yet/);
    assert.doesNotMatch(stdout, /\x1b\[/);
  });

  test("no budget + data → exit 0 with the full line", async () => {
    await seed([
      { created_at: hoursAgo(1), cost: 1.0 },
      { created_at: hoursAgo(3), cost: 2.0 },
    ]);
    const { code, stdout } = await cli(["status", "--format", "line"]);
    assert.equal(code, 0);
    assert.match(stdout, /💰 \$1\.00 session \/ \$3\.00 today/);
    assert.match(stdout, /🔥 \$0\.13\/hr/);
    assert.match(stdout, /ttft p50 120ms/);
    assert.ok(!stdout.includes("of budget"));
  });

  test("budget 80–99% → exit 10; ≥100% → exit 11; under → exit 0", async () => {
    await setBudget(10);
    await seed([
      { created_at: hoursAgo(1), cost: 6.7 },
      { created_at: hoursAgo(3), cost: 2.0 },
    ]);
    let r = await cli(["status", "--format", "line"]);
    assert.equal(r.code, 10);
    assert.match(r.stdout, /🟡/);

    await seed([
      { created_at: hoursAgo(1), cost: 60 },
      { created_at: hoursAgo(3), cost: 60 },
    ]);
    r = await cli(["status", "--format", "line"]);
    assert.equal(r.code, 11);
    assert.match(r.stdout, /🔴/);

    await unsetBudget();
    await seed([
      { created_at: hoursAgo(1), cost: 6.7 },
      { created_at: hoursAgo(3), cost: 2.0 },
    ]);
    r = await cli(["status", "--format", "line"]);
    assert.equal(r.code, 0);
  });

  test("budget set but insufficient history for a rate → exit 20", async () => {
    await setBudget(150);
    await seed([{ created_at: hoursAgo(0.5), cost: 1.0 }]);
    const { code, stdout } = await cli(["status", "--format", "line"]);
    assert.equal(code, 20);
    assert.match(stdout, /⚪/);
    await unsetBudget();
  });
});

// -- formats and the snapshot contract ---------------------------------------------

describe("status observability · formats", () => {
  test("--format json is the snapshot plus additive context", async () => {
    await seed([
      { created_at: hoursAgo(1), cost: 1.0 },
      { created_at: hoursAgo(3), cost: 2.0 },
    ]);
    const { code, stdout } = await cli(["status", "--format", "json"]);
    assert.equal(code, 0);
    const payload = JSON.parse(stdout);
    assert.equal(payload.schema_version, 1);
    assert.equal(payload.source, "aiand status");
    assert.equal(payload.spend.today, 3);
    assert.equal(payload.spend.currency, "usd");
    assert.equal(payload.verdict, "ok");
    assert.equal(payload.provenance.spend, "gateway-billed");
    assert.match(payload.provenance.burn, /^heuristic\(burn-rate v1\)$/);
    // Additive superset fields
    assert.equal(typeof payload.burn_span_hours, "number");
    assert.ok(payload.store_rows >= 2);
  });

  test("--write-state writes valid versioned JSON atomically; stdout stays quiet without --print", async () => {
    await seed([
      { created_at: hoursAgo(1), cost: 1.0 },
      { created_at: hoursAgo(3), cost: 2.0 },
    ]);
    const statePath = join(box.dir, "nested", "status-state.json");
    const { code, stdout, stderr } = await cli(["status", "--write-state", statePath]);
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /Snapshot written/);

    const written = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(written.schema_version, 1);
    assert.equal(written.source, "aiand status");
    assert.ok(!Number.isNaN(Date.parse(written.generated_at)));
    assert.deepEqual(Object.keys(written.spend).sort(), ["currency", "session", "today"]);
    assert.equal(written.budget, null);
    assert.equal(written.verdict, "ok");
    assert.ok("stale" in written && typeof written.stale === "boolean");
    assert.ok(written.provenance.spend === "gateway-billed");

    // No tmp residue: the atomic write renamed its temp file away.
    const siblings = readdirSync(join(box.dir, "nested"));
    assert.deepEqual(siblings, ["status-state.json"]);

    // --print opts back into the line.
    const printed = await cli(["status", "--write-state", statePath, "--print"]);
    assert.equal(printed.code, 0);
    assert.match(printed.stdout, /💰/);
  });

  test("--write-state reports no-data through the snapshot AND exit 30", async () => {
    rmSync(join(box.dir, "store.db"), { force: true });
    const statePath = join(box.dir, "empty-state.json");
    const { code } = await cli(["status", "--write-state", statePath]);
    assert.equal(code, 30);
    const written = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(written.verdict, "no-data");
  });

  test("invalid --format and --watch values are clear user errors", async () => {
    let r = await cli(["status", "--format", "yaml"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Invalid --format value/);

    r = await cli(["status", "--watch", "1"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /at least 2s/);

    r = await cli(["status", "--watch", "soon"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Invalid --watch interval/);
  });
});

// -- the auth surface is untouched ---------------------------------------------------

describe("status observability · auth surface unchanged", () => {
  test("plain --json keeps the {auth, agents} shape (and does not gain spend fields)", async () => {
    const { code, stdout } = await cli(["status", "--json"]);
    // Signed out in this env: exit 1 exactly as documented before #71.
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.auth && typeof parsed.auth === "object");
    assert.ok(Array.isArray(parsed.agents));
    assert.equal(parsed.spend, undefined);
  });
});
