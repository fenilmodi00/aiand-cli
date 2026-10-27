import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { CLOSED_URL, cliEnv, runCli, withEnv, withMockGateway, withTestEnv } from "./helpers.mjs";

// OBS-P0-2 (#63): the reconciliation accuracy gate — `aiand usage --verify`.
// An in-process gateway double serves /logs (forward pager, like the real
// cursor pagination) and /analytics/summary; the local store is planted with
// the same fixture through the real sync engine, so every number on both
// sides of the comparison is a gateway-verbatim sum. The CI gate: consistent
// fixtures reconcile to exact zero deltas; a mutated fixture is detected and
// reported, never smoothed away; a gateway/auth failure is loud and exits
// non-zero, never silently green.

const box = withTestEnv("aiand-usage-verify-", () => {
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_NO_SYNC;
});

// -- fixtures ----------------------------------------------------------------

/** A gateway LogEntry stamped n minutes ago, inside even the 15m window. */
function entry(n, overrides = {}) {
  const created = new Date(Date.now() - n * 60_000).toISOString();
  return {
    id: `log-${String(n).padStart(4, "0")}`,
    model: "test/model",
    api_key: "sk-abcd...1234",
    status_code: 200,
    ttft_ms: 120,
    latency_ms: 1_400,
    // Gateway convention: input INCLUDES cached. The reconciliation sums must
    // never re-add cached_tokens on top (tested explicitly below).
    input_tokens: 1_000 + n,
    output_tokens: 300,
    cached_tokens: 400,
    cost: "0.0042",
    currency: "usd",
    created_at: created,
    ...overrides,
  };
}

function entries(count) {
  return Array.from({ length: count }, (_, i) => entry(i + 1));
}

function totals(entries_) {
  return {
    requests: entries_.length,
    input_tokens: entries_.reduce((s, e) => s + (e.input_tokens ?? 0), 0),
    output_tokens: entries_.reduce((s, e) => s + (e.output_tokens ?? 0), 0),
  };
}

/** /analytics/summary fixture consistent with `entries_` (previous: zeros). */
function summaryFixture(entries_) {
  const current = totals(entries_);
  return {
    current,
    previous: { requests: 0, input_tokens: 0, output_tokens: 0 },
    timeseries: [],
  };
}

function fakeSession(url) {
  return {
    profile: { name: "test", authUrl: url, apiUrl: url },
    token: "test-token",
    credential: null,
  };
}

// -- gateway double ------------------------------------------------------------

let server;
let baseUrl = "";
/** Scripted /logs behavior: a forward pager over `rows` by default. */
let serveLogs = () => ({ data: [], has_more: false, next_after: null, next_after_id: null });
/** Scripted /analytics/summary body. */
let serveSummary = () => summaryFixture([]);
/** Count of /logs requests served since the last reset (sync + verify). */
let logsServed = 0;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/logs") {
      logsServed += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(serveLogs(url)));
      return;
    }
    if (url.pathname === "/analytics/summary") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(serveSummary(url)));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

/** Forward-cursor /logs pager over `rows`, like the gateway. */
function forwardPager(rows, pageSize = 100) {
  return (url) => {
    const after = url.searchParams.get("after");
    const limit = Number(url.searchParams.get("limit") ?? pageSize);
    const remaining = after ? rows.filter((e) => e.created_at > after) : rows;
    const data = remaining.slice(0, limit);
    const hasMore = remaining.length > data.length;
    return {
      data,
      has_more: hasMore,
      next_after: hasMore ? data[data.length - 1].created_at : null,
      next_after_id: hasMore ? data[data.length - 1].id : null,
    };
  };
}

// -- helpers -------------------------------------------------------------------

const reconcile = () => import("../dist/store/reconcile.js");

function verifyEnv(dir) {
  return cliEnv({ AIAND_CONFIG_DIR: dir, AIAND_API_KEY: "sk-test", AIAND_BASE_URL: baseUrl });
}

/** Plant the local store through the real sync engine against the double. */
async function plantStore(dir, rows) {
  serveLogs = forwardPager(rows);
  await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
    const store = await import("../dist/store/index.js");
    const result = await store.syncStore(fakeSession(baseUrl));
    assert.equal(result.ok, true, `store plant failed: ${JSON.stringify(result)}`);
  });
}

function freshDir(name) {
  const dir = join(box.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// -- tests ---------------------------------------------------------------------

describe("reconciliation arithmetic (pure)", () => {
  test("tokens follow the gateway convention: input INCLUDES cached, never re-added", async () => {
    // #63 — one request: input 1000 (of which cached 400), output 300.
    // The gateway-billed token total is 1300; adding cached again (1700) or
    // subtracting it (900) would fake a delta on every window.
    const { sumLogEntries } = await reconcile();
    const totalsRow = sumLogEntries([
      entry(1, { input_tokens: 1000, cached_tokens: 400, output_tokens: 300 }),
    ]);
    assert.equal(totalsRow.requests, 1);
    assert.equal(totalsRow.tokens, 1300, "tokens = input + output (input already includes cached)");
    assert.ok(Math.abs(totalsRow.cost - 0.0042) < 1e-12, "cost = parsed gateway cost string");
  });

  test("sums skip nulls on both sides: absent tokens/cost contribute nothing", async () => {
    const { sumLogEntries } = await reconcile();
    const totalsRow = sumLogEntries([
      entry(1, { input_tokens: null, output_tokens: null, cached_tokens: null, cost: null }),
      entry(2, { cost: "0.0100" }),
    ]);
    assert.equal(totalsRow.requests, 2);
    assert.equal(totalsRow.tokens, 1302); // only entry 2 contributes
    assert.ok(Math.abs(totalsRow.cost - 0.01) < 1e-12);
  });

  test("windows past the gateway horizon resolve to an unverifiable source", async () => {
    const { resolveVerifyWindow } = await reconcile();
    const now = Date.now();
    const beyond = resolveVerifyWindow(
      {
        range: "30days",
        since: new Date(now - 200 * 86_400_000).toISOString(),
        until: new Date(now - 100 * 86_400_000).toISOString(),
      },
      now,
    );
    assert.equal(beyond.source, "none");
    assert.match(beyond.detail ?? "", /3-month/i);

    const midWide = resolveVerifyWindow(
      {
        range: "30days",
        since: new Date(now - 60 * 86_400_000).toISOString(),
        until: new Date(now).toISOString(),
      },
      now,
    );
    assert.equal(midWide.source, "none"); // /logs stops at 30d; the summary is fixed-range
    assert.match(midWide.detail ?? "", /fixed ranges/i);

    const explicitShort = resolveVerifyWindow(
      {
        range: "30days",
        since: new Date(now - 10 * 60_000).toISOString(),
        until: new Date(now).toISOString(),
      },
      now,
    );
    assert.equal(explicitShort.source, "logs");

    const threeMonths = resolveVerifyWindow({ range: "3months" }, now);
    assert.equal(threeMonths.source, "analytics");
  });
});

describe("usage --verify (CI gate)", () => {
  test("consistent local store + gateway fixtures reconcile to exact zero deltas, exit 0", async () => {
    const dir = freshDir("happy");
    const rows = entries(3);
    await plantStore(dir, rows);
    serveLogs = forwardPager(rows);
    logsServed = 0;

    const run = await runCli(["usage", "--verify", "--json"], { env: verifyEnv(dir) });
    assert.equal(run.code, 0, `exit ${run.code}: ${run.stderr}`);
    const parsed = JSON.parse(run.stdout);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 3); // requests, tokens, cost for the one window
    for (const row of parsed) {
      assert.deepEqual(Object.keys(row).sort(), [
        "delta",
        "local",
        "metric",
        "remote",
        "source",
        "status",
        "window",
      ]);
      assert.equal(row.source, "logs");
      assert.equal(row.status, "ok");
      assert.equal(row.delta, 0, `${row.metric} delta must be exactly 0`);
      assert.equal(row.local, row.remote);
      assert.ok(row.window.since && row.window.until);
      assert.ok(new Date(row.window.until) - new Date(row.window.since) > 0);
    }
    assert.deepEqual(
      parsed.map((r) => r.metric),
      ["requests", "tokens", "cost"],
    );
    assert.equal(parsed.find((r) => r.metric === "requests").local, 3);
    // input includes cached: 3 entries, inputs 1001+1002+1003, outputs 300×3
    assert.equal(parsed.find((r) => r.metric === "tokens").local, 1001 + 1002 + 1003 + 900);
    // The pre-verify sync ran (and re-fetched /logs) before the verify fetch.
    assert.ok(logsServed >= 2, `expected sync + verify /logs calls, got ${logsServed}`);
  });

  test("--range 3months reconciles against /analytics/summary; cost is UNVERIFIABLE there", async () => {
    const dir = freshDir("three-months");
    const rows = entries(2);
    await plantStore(dir, rows);
    serveLogs = forwardPager(rows);
    serveSummary = () => summaryFixture(rows);

    const run = await runCli(["usage", "--verify", "--range", "3months", "--json"], {
      env: verifyEnv(dir),
    });
    assert.equal(run.code, 0, `exit ${run.code}: ${run.stderr}`);
    const parsed = JSON.parse(run.stdout);
    const requests = parsed.find((r) => r.metric === "requests");
    const tokensRow = parsed.find((r) => r.metric === "tokens");
    const cost = parsed.find((r) => r.metric === "cost");
    assert.equal(requests.source, "analytics");
    assert.equal(requests.status, "ok");
    assert.equal(requests.local, rows.length);
    assert.equal(tokensRow.status, "ok");
    assert.equal(
      tokensRow.remote,
      rows.reduce((s, e) => s + e.input_tokens + e.output_tokens, 0),
    );
    // The summary endpoint reports no cost: reported as unverifiable, never hidden.
    assert.equal(cost.status, "unverifiable");
    assert.equal(cost.remote, null);
    assert.equal(cost.delta, null);
    assert.match(cost.detail ?? "", /no cost/i);
  });

  test("mutated gateway fixture: non-zero delta detected and reported, exit 1", async () => {
    const dir = freshDir("drift-tokens");
    const rows = entries(3);
    await plantStore(dir, rows);
    // Remote reports one entry with 100 more output tokens than the store has.
    // --no-sync: compare the local store AS-IS against the drifting remote.
    const mutated = rows.map((e, i) =>
      i === 0 ? { ...e, output_tokens: e.output_tokens + 100 } : e,
    );
    serveLogs = forwardPager(mutated);

    const run = await runCli(["usage", "--verify", "--no-sync", "--json"], { env: verifyEnv(dir) });
    assert.equal(run.code, 1, `expected mismatch exit 1, got ${run.code}`);
    const parsed = JSON.parse(run.stdout);
    const tokensRow = parsed.find((r) => r.metric === "tokens");
    assert.equal(tokensRow.status, "mismatch");
    // delta = local - remote: the gateway saw 100 more tokens than the store.
    assert.equal(tokensRow.delta, -100, "the exact delta is reported, never smoothed");
    assert.equal(
      tokensRow.local,
      rows.reduce((s, e) => s + e.input_tokens + e.output_tokens, 0),
    );
    assert.equal(tokensRow.remote, tokensRow.local + 100);
    // Unrelated metrics still reconcile — mismatches are per-metric.
    assert.equal(parsed.find((r) => r.metric === "requests").status, "ok");
    assert.equal(parsed.find((r) => r.metric === "cost").status, "ok");
  });

  test("a request the gateway reports but the store lacks: all three metrics mismatch, exit 1", async () => {
    const dir = freshDir("drift-requests");
    const rows = entries(3);
    await plantStore(dir, rows);
    serveLogs = forwardPager([...rows, entry(4)]); // one extra remote request

    const run = await runCli(["usage", "--verify", "--no-sync", "--json"], { env: verifyEnv(dir) });
    assert.equal(run.code, 1);
    const parsed = JSON.parse(run.stdout);
    for (const row of parsed) {
      assert.equal(row.status, "mismatch", `${row.metric} must mismatch`);
      // delta = local - remote: the store lacks one whole request.
      if (row.metric === "requests") assert.equal(row.delta, -1);
      if (row.metric === "tokens") assert.equal(row.delta, -1304);
      if (row.metric === "cost") assert.ok(Math.abs(row.delta - -0.0042) < 1e-9);
    }
  });

  test("window older than 3 months: UNVERIFIABLE rows, exit 0, never silently skipped", async () => {
    const dir = freshDir("beyond");
    const run = await runCli(
      [
        "usage",
        "--verify",
        "--json",
        "--since",
        new Date(Date.now() - 200 * 86_400_000).toISOString(),
        "--until",
        new Date(Date.now() - 100 * 86_400_000).toISOString(),
      ],
      { env: verifyEnv(dir) },
    );
    assert.equal(run.code, 0);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.length, 3);
    for (const row of parsed) {
      assert.equal(row.source, "none");
      assert.equal(row.status, "unverifiable");
      assert.equal(row.remote, null);
      assert.equal(row.delta, null);
      assert.match(row.detail ?? "", /3-month/i);
    }
  });

  test("failed pre-verify sync is surfaced (never pass/fail) and a store-less verify is UNVERIFIABLE", async () => {
    const dir = freshDir("sync-fail");
    const rows = entries(3);
    // The FIRST /logs request (the sync's) fails; the verify fetch succeeds.
    let first = true;
    serveLogs = (url) => {
      if (first) {
        first = false;
        return { error: "boom" };
      }
      return forwardPager(rows)(url);
    };

    const run = await runCli(["usage", "--verify", "--json"], { env: verifyEnv(dir) });
    assert.match(run.stderr, /sync failed/i, "the sync failure must be loud");
    assert.equal(run.code, 0, "a sync failure alone is indeterminate, not a mismatch");
    const parsed = JSON.parse(run.stdout);
    for (const row of parsed) {
      // No local store exists yet: nothing to compare against, so unverifiable
      // — never local-0-vs-remote-N mismatches masquerading as drift.
      assert.equal(row.status, "unverifiable", `${row.metric}`);
      assert.match(row.detail ?? "", /store/i);
      assert.equal(
        row.remote,
        row.metric === "requests"
          ? 3
          : row.metric === "tokens"
            ? totals(rows).input_tokens + totals(rows).output_tokens
            : 3 * 0.0042,
      );
    }
  });

  test("gateway auth failure: loud non-zero exit, never silently green", async () => {
    const dir = freshDir("auth-fail");
    await withMockGateway(async ({ url }) => {
      const run = await runCli(["usage", "--verify", "--json"], {
        env: cliEnv({
          AIAND_CONFIG_DIR: dir,
          AIAND_API_KEY: "sk-test",
          AIAND_BASE_URL: `${url}/stub/401`,
        }),
      });
      assert.equal(run.code, 1, `expected failure exit, got ${run.code}: ${run.stdout}`);
      assert.match(run.stderr, /401|unauthorized/i);
      assert.ok(!run.stdout.includes('"status": "ok"') && !run.stdout.includes('"status":"ok"'));
    });
  });

  test("gateway unreachable: loud non-zero exit, never silently green", async () => {
    const dir = freshDir("offline");
    const run = await runCli(["usage", "--verify", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir, AIAND_API_KEY: "sk-test", AIAND_BASE_URL: CLOSED_URL }),
    });
    assert.equal(run.code, 1);
    assert.ok(run.stderr.trim().length > 0, "an unreachable gateway must print an error");
    assert.doesNotMatch(run.stdout, /"status":\s*"ok"/);
  });

  test("human output: OK rows reconcile; a drift renders MISMATCH prominently and exits 1", async () => {
    const dir = freshDir("human-ok");
    const rows = entries(2);
    await plantStore(dir, rows);
    serveLogs = forwardPager(rows);
    const ok = await runCli(["usage", "--verify"], { env: verifyEnv(dir) });
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /Accuracy check/);
    assert.match(ok.stdout, /OK/);
    assert.match(ok.stdout, /reconcile exactly/);

    const driftDir = freshDir("human-drift");
    await plantStore(driftDir, rows);
    serveLogs = forwardPager(rows.map((e) => ({ ...e, cost: "0.9999" })));
    const bad = await runCli(["usage", "--verify"], { env: verifyEnv(driftDir) });
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /MISMATCH/);
    assert.match(bad.stdout, /do not reconcile/i);
    assert.match(bad.stdout, /Exit code 1/);
  });

  test("surface errors: --metrics conflicts, one-sided --since, bad range", async () => {
    const dir = freshDir("surface");
    const conflict = await runCli(["usage", "--verify", "--metrics"], { env: verifyEnv(dir) });
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /--metrics/);

    const oneSided = await runCli(
      ["usage", "--verify", "--json", "--since", new Date(Date.now() - 60_000).toISOString()],
      { env: verifyEnv(dir) },
    );
    assert.equal(oneSided.code, 1);
    assert.match(oneSided.stderr, /--since and --until/);

    const badRange = await runCli(["usage", "--verify", "--range", "1year", "--json"], {
      env: verifyEnv(dir),
    });
    assert.equal(badRange.code, 1);
    assert.match(badRange.stderr, /--range/);
  });

  // #92 (OBS-BF-8): the battle report's critical repros, distilled into
  // mock-gateway fixtures. (a) `--since <today>` must return same-day rows
  // from a synced store — the live sync stores the gateway's wire-format
  // created_at (space separator, `+00`), the exact shape `' ' < 'T'`
  // comparisons dropped. (b) `usage --verify` catches an injected gap:
  // rows deleted from the local store behind the gateway's back must
  // report MISMATCH and exit 1.
  test("#92: wire-format rows synced via the mock are matched by --since <today>", async () => {
    const dir = freshDir("repro-since-today");
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const wireFormat = (date) =>
      `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 23)}+00`;
    // Today's rows in the gateway's verbatim wire format (space + `+00`),
    // served by the real sync engine into the store — not seeded by hand.
    const rows = entries(3).map((e, i) => ({
      ...e,
      created_at: wireFormat(new Date(midnight.getTime() + (i + 1) * 60_000)),
    }));
    await plantStore(dir, rows);
    serveLogs = forwardPager(rows);

    const today = new Date().toISOString().slice(0, 10);
    const run = await runCli(["usage", "--by", "day", "--json", "--since", today], {
      env: cliEnv({ AIAND_CONFIG_DIR: dir, AIAND_NO_SYNC: "1", NO_COLOR: "1", CI: "1" }),
    });
    assert.equal(run.code, 0, `exit ${run.code}: ${run.stderr}`);
    const parsed = JSON.parse(run.stdout);
    assert.equal(
      parsed.sections.totals.requests,
      3,
      "same-day --since must match wire-format rows stored by a real sync",
    );
  });

  test("#92: injected gap — rows deleted from the store behind the gateway are MISMATCH, exit 1", async () => {
    const dir = freshDir("repro-gap");
    const rows = entries(5);
    await plantStore(dir, rows);
    serveLogs = forwardPager(rows);
    // Inject the gap: delete two rows locally as if they were lost.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dir, "store.db"));
    db.prepare("DELETE FROM requests WHERE id IN ('log-0001', 'log-0002')").run();
    db.close();

    const run = await runCli(["usage", "--verify", "--no-sync", "--json"], {
      env: verifyEnv(dir),
    });
    assert.equal(run.code, 1, `expected mismatch exit 1, got ${run.code}: ${run.stdout}`);
    const parsed = JSON.parse(run.stdout);
    const requests = parsed.find((r) => r.metric === "requests");
    assert.equal(requests.status, "mismatch");
    assert.equal(requests.local, 3);
    assert.equal(requests.remote, 5);
    assert.equal(requests.delta, -2);
    for (const metric of ["tokens", "cost"]) {
      assert.equal(parsed.find((r) => r.metric === metric).status, "mismatch");
    }
  });
});
