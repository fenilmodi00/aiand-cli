import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { describe } from "node:test";
import { CLOSED_URL, cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

// OBS-P1-1 (#60): the store-backed usage report — blocks (--by day|week|month|
// session), filters, --sections from ONE load, --jq, --format csv, --compact,
// --no-cost, mixed-currency honesty, color-drop on pipe. Bucketing is golden-
// tested against a directly-seeded local store; sync behavior runs against a
// loopback gateway double (never the network).

const box = withTestEnv("aiand-usage-report-", () => {
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_NO_SYNC;
});

function freshDir(name) {
  const dir = join(box.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// -- fixtures -----------------------------------------------------------------

let rowSeq = 0;
/** A verbatim store row at a fixed UTC instant (deterministic bucketing). */
function row(createdAt, overrides = {}) {
  rowSeq += 1;
  return {
    id: `row-${String(rowSeq).padStart(3, "0")}`,
    model: "zai-org/glm-5.3",
    api_key: "sk-abcd...1234",
    status_code: 200,
    ttft_ms: 100,
    latency_ms: 500,
    input_tokens: 1000,
    output_tokens: 300,
    cached_tokens: 400,
    cost: "0.0042",
    cost_value: 0.0042,
    currency: "usd",
    created_at: createdAt,
    ...overrides,
  };
}

/** Seed the store directly (offline — no sync engine, no gateway). */
async function seedStore(dir, rows) {
  await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
    const store = await import("../dist/store/index.js");
    const opened = store.openStore(store.storePath());
    assert.ok(opened.ok, `store open failed: ${opened.reason ?? ""}`);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      insert.run(
        r.id,
        r.model,
        r.api_key,
        r.status_code,
        r.ttft_ms,
        r.latency_ms,
        r.input_tokens,
        r.output_tokens,
        r.cached_tokens,
        r.cost,
        r.cost_value,
        r.currency,
        r.created_at,
        new Date().toISOString(),
      );
    }
    opened.db.close();
  });
}

const reportEnv = (dir) =>
  cliEnv({
    AIAND_CONFIG_DIR: dir,
    AIAND_NO_SYNC: "1",
    NO_COLOR: "1",
    CI: "1",
  });

/** The seeded store shared by most bucketing tests (three UTC days, one gap). */
const SPREAD_ROWS = [
  row("2026-10-19T10:00:00.000Z", {
    id: "d1",
    input_tokens: 100,
    output_tokens: 10,
    cached_tokens: 50,
  }),
  row("2026-10-20T10:00:00.000Z", {
    id: "d2",
    input_tokens: 200,
    output_tokens: 20,
    cached_tokens: 60,
  }),
  row("2026-10-20T15:00:00.000Z", {
    id: "d3",
    input_tokens: 300,
    output_tokens: 30,
    cached_tokens: 70,
  }),
  row("2026-10-21T10:00:00.000Z", {
    id: "d4",
    input_tokens: 400,
    output_tokens: 40,
    cached_tokens: 80,
  }),
];

const DIRTY_DIR = freshDir("bucketing");
await seedStore(DIRTY_DIR, SPREAD_ROWS);

// -- bucketing (golden) ---------------------------------------------------------

describe("usage --by day|week|month bucketing", () => {
  test("day blocks sum tokens per UTC calendar day, totals row reconciles", async () => {
    const run = await runCli(["usage", "--by", "day", "--json"], { env: reportEnv(DIRTY_DIR) });
    assert.equal(run.code, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    const daily = payload.sections.daily;
    assert.deepEqual(
      daily.map((b) => b.period),
      ["2026-10-19", "2026-10-20", "2026-10-21"],
    );
    assert.equal(daily[1].requests, 2);
    assert.equal(daily[1].input_tokens, 500); // gateway convention: includes cached, never re-added
    assert.equal(daily[1].output_tokens, 50);
    assert.equal(daily[1].cached_tokens, 130);
    const totals = payload.sections.totals;
    assert.equal(totals.requests, 4);
    assert.equal(totals.input_tokens, 1000);
    assert.equal(totals.output_tokens, 100);
  });

  test("week blocks use ISO weeks (Monday start)", async () => {
    const run = await runCli(["usage", "--by", "week", "--json"], { env: reportEnv(DIRTY_DIR) });
    assert.equal(run.code, 0, run.stderr);
    const daily = JSON.parse(run.stdout).sections.weekly;
    // 2026-10-19 IS a Monday; the whole fixture sits in one ISO week.
    assert.deepEqual(
      daily.map((b) => b.period),
      ["2026-W43"],
    );
    assert.equal(daily[0].requests, 4);
  });

  test("month blocks bucket by calendar month", async () => {
    const dir = freshDir("months");
    await seedStore(dir, [
      row("2026-09-30T23:59:59.000Z", { id: "m1" }),
      row("2026-10-01T00:00:00.000Z", { id: "m2" }),
      row("2026-10-31T12:00:00.000Z", { id: "m3" }),
    ]);
    const run = await runCli(["usage", "--by", "month", "--json"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    const monthly = JSON.parse(run.stdout).sections.monthly;
    assert.deepEqual(
      monthly.map((b) => b.period),
      ["2026-09", "2026-10"],
    );
    assert.equal(monthly[0].requests, 1);
    assert.equal(monthly[1].requests, 2);
  });

  test("--timezone moves day boundaries: same store, different tz, different blocks", async () => {
    // 2026-03-08T04:00:00Z is 2026-03-07 23:00 in America/New_York (EST, pre-DST).
    const dir = freshDir("tz");
    await seedStore(dir, [row("2026-03-08T04:00:00.000Z", { id: "t1" })]);
    const utc = JSON.parse(
      (await runCli(["usage", "--by", "day", "--json"], { env: reportEnv(dir) })).stdout,
    );
    const ny = JSON.parse(
      (
        await runCli(["usage", "--by", "day", "--json", "--timezone", "America/New_York"], {
          env: reportEnv(dir),
        })
      ).stdout,
    );
    assert.deepEqual(
      utc.sections.daily.map((b) => b.period),
      ["2026-03-08"],
    );
    assert.deepEqual(
      ny.sections.daily.map((b) => b.period),
      ["2026-03-07"],
    );
    assert.equal(ny.meta.timezone, "America/New_York");
  });

  test("--timezone crossing DST: a spring-forward morning stays on one local day", async () => {
    // In America/New_York, 2026-03-08 01:30 EST (06:30Z) and 03:30 EDT (07:30Z)
    // are the same calendar day despite the skipped hour.
    const dir = freshDir("dst");
    await seedStore(dir, [
      row("2026-03-08T06:30:00.000Z", { id: "s1" }),
      row("2026-03-08T07:30:00.000Z", { id: "s2" }),
    ]);
    const run = await runCli(["usage", "--by", "day", "--json", "--timezone", "America/New_York"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    const daily = JSON.parse(run.stdout).sections.daily;
    assert.deepEqual(
      daily.map((b) => b.period),
      ["2026-03-08"],
    );
    assert.equal(daily[0].requests, 2);
  });
});

// -- session bucketing ------------------------------------------------------------

describe("usage --by session", () => {
  test("sessions come from the #66 gap heuristic, annotated, not re-grouped here", async () => {
    const run = await runCli(["usage", "--by", "session", "--json"], { env: reportEnv(DIRTY_DIR) });
    assert.equal(run.code, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.meta.sessionization.method, "time-gap");
    assert.equal(payload.meta.sessionization.confidence, "heuristic");
    assert.match(payload.meta.provenance.sessions, /^heuristic\(/);
    const sessions = payload.sections.sessions;
    assert.equal(sessions.length, 4); // gaps between the fixture rows exceed 10 min
    assert.ok(sessions.every((s) => typeof s.turns === "number"));
  });
});

// -- filters ----------------------------------------------------------------------

describe("usage filters", () => {
  test("--since/--until bound the window (date = end of day for --until)", async () => {
    const run = await runCli(
      ["usage", "--by", "day", "--json", "--since", "2026-10-20", "--until", "2026-10-20"],
      { env: reportEnv(DIRTY_DIR) },
    );
    assert.equal(run.code, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.deepEqual(
      payload.sections.daily.map((b) => b.period),
      ["2026-10-20"],
    );
    assert.equal(payload.meta.range.since, "2026-10-20T00:00:00.000Z");
  });

  test("--last 7d is a relative window (only recent rows survive)", async () => {
    const dir = freshDir("last");
    const now = Date.now();
    await seedStore(dir, [
      row(new Date(now - 1 * 86_400_000).toISOString(), { id: "recent" }),
      row(new Date(now - 60 * 86_400_000).toISOString(), { id: "old" }),
    ]);
    const run = await runCli(["usage", "--by", "day", "--json", "--last", "7d"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.sections.totals.requests, 1);
    assert.match(payload.meta.range.since, /^(\d{4}-\d{2}-\d{2})T/);
  });

  test("--agent filters on the masked-key attribution (unknown = unmapped)", async () => {
    const dir = freshDir("agent");
    writeFileSync(
      join(dir, "agent-keys.json"),
      JSON.stringify({
        version: 1,
        keys: [{ agent: "claude", masked: "sk-abcd...1234", fingerprint: "f".repeat(16), at: 0 }],
      }),
    );
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "a1" }), // sk-abcd...1234 -> claude
      row("2026-10-20T11:00:00.000Z", { id: "a2", api_key: "sk-eeee....9999" }), // unknown
    ]);
    const claude = JSON.parse(
      (
        await runCli(["usage", "--by", "day", "--json", "--agent", "claude"], {
          env: reportEnv(dir),
        })
      ).stdout,
    );
    assert.equal(claude.sections.totals.requests, 1);
    const unknown = JSON.parse(
      (
        await runCli(["usage", "--by", "day", "--json", "--agent", "unknown"], {
          env: reportEnv(dir),
        })
      ).stdout,
    );
    assert.equal(unknown.sections.totals.requests, 1);
  });

  test("--model is a repeatable glob", async () => {
    const dir = freshDir("model");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "g1", model: "zai-org/glm-5.3" }),
      row("2026-10-20T11:00:00.000Z", { id: "g2", model: "other/model-v2" }),
      row("2026-10-20T12:00:00.000Z", { id: "g3", model: "other/model-v3" }),
    ]);
    const one = JSON.parse(
      (
        await runCli(["usage", "--by", "day", "--json", "--model", "zai-*"], {
          env: reportEnv(dir),
        })
      ).stdout,
    );
    assert.equal(one.sections.totals.requests, 1);
    const both = JSON.parse(
      (
        await runCli(
          ["usage", "--by", "day", "--json", "--model", "zai-*", "--model", "other/*-v2"],
          {
            env: reportEnv(dir),
          },
        )
      ).stdout,
    );
    assert.equal(both.sections.totals.requests, 2);
  });

  test("--order desc reverses blocks; --sort requests orders numerically", async () => {
    const desc = JSON.parse(
      (
        await runCli(["usage", "--by", "day", "--json", "--order", "desc"], {
          env: reportEnv(DIRTY_DIR),
        })
      ).stdout,
    );
    assert.deepEqual(
      desc.sections.daily.map((b) => b.period),
      ["2026-10-21", "2026-10-20", "2026-10-19"],
    );
    const sorted = JSON.parse(
      (
        await runCli(["usage", "--by", "day", "--json", "--sort", "requests", "--order", "desc"], {
          env: reportEnv(DIRTY_DIR),
        })
      ).stdout,
    );
    assert.equal(sorted.sections.daily[0].requests, 2); // 2026-10-20 has two
  });

  test("--harness matches the same key attribution as --agent", async () => {
    const run = await runCli(["usage", "--by", "day", "--json", "--harness", "unknown"], {
      env: reportEnv(DIRTY_DIR),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).sections.totals.requests, 4);
  });
});

// -- sections: one load, many reports ---------------------------------------------

describe("usage --sections", () => {
  test("every section is served by ONE store read", async () => {
    const { buildReport } = await import("../dist/commands/usage-report.js");
    let loads = 0;
    const report = buildReport({
      unit: "day",
      sections: ["daily", "totals", "by-model", "by-agent"],
      timezone: "UTC",
      sinceMs: null,
      untilMs: null,
      filters: { agents: [], models: [] },
      sort: "period",
      order: "asc",
      sync: { skipped: true },
      load: () => {
        loads += 1;
        return SPREAD_ROWS.map((r) => ({ ...r }));
      },
    });
    assert.equal(loads, 1, "the store must be read once for --sections a,b,c");
    assert.ok(report.sections.daily.length > 0);
    assert.ok(report.sections["by-model"].length > 0);
    assert.ok(report.sections["by-agent"].length > 0);
    assert.equal(report.sections.totals.requests, 4);
  });

  test("--sections registry is validated and drives the block unit", async () => {
    const bad = await runCli(["usage", "--sections", "nope"], { env: reportEnv(DIRTY_DIR) });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Invalid --sections entry/);
    const weekly = await runCli(["usage", "--sections", "weekly,totals", "--json"], {
      env: reportEnv(DIRTY_DIR),
    });
    assert.equal(weekly.code, 0, weekly.stderr);
    assert.ok(JSON.parse(weekly.stdout).sections.weekly);
  });
});

// -- --jq / CSV -------------------------------------------------------------------

describe("usage --jq and --format csv", () => {
  test("--jq '.sections.totals' returns the totals object", async () => {
    const run = await runCli(["usage", "--json", "--jq", ".sections.totals"], {
      env: reportEnv(DIRTY_DIR),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      requests: 4,
      input_tokens: 1000,
      output_tokens: 100,
      cached_tokens: 260,
      costs: { usd: 0.0168 },
    });
  });

  test("--jq supports indexes and iteration", async () => {
    const first = JSON.parse(
      (
        await runCli(["usage", "--json", "--jq", ".sections.daily[0].period"], {
          env: reportEnv(DIRTY_DIR),
        })
      ).stdout,
    );
    assert.equal(first, "2026-10-19");
    const all = JSON.parse(
      (
        await runCli(["usage", "--json", "--jq", ".sections.daily[].period"], {
          env: reportEnv(DIRTY_DIR),
        })
      ).stdout,
    );
    assert.deepEqual(all, ["2026-10-19", "2026-10-20", "2026-10-21"]);
    const missing = JSON.parse(
      (await runCli(["usage", "--json", "--jq", ".nope"], { env: reportEnv(DIRTY_DIR) })).stdout,
    );
    assert.equal(missing, null);
    const bad = await runCli(["usage", "--json", "--jq", "sections.x"], {
      env: reportEnv(DIRTY_DIR),
    });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Unsupported --jq filter/);
  });

  test("CSV header is fixed and stable across widths and --compact", async () => {
    const plain = await runCli(["usage", "--format", "csv"], { env: reportEnv(DIRTY_DIR) });
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trim().split("\n");
    assert.equal(
      lines[0],
      "period,requests,input_tokens,output_tokens,cached_tokens,cost,currency",
      "the documented header row is locked",
    );
    assert.equal(lines.length, 4); // header + one row per block (single currency)
    const compact = await runCli(["usage", "--format", "csv", "--compact"], {
      env: reportEnv(DIRTY_DIR),
    });
    assert.equal(compact.stdout, plain.stdout, "CSV ignores terminal width / compact");
  });

  test("mixed currencies emit one CSV row per (period, currency), never summed", async () => {
    const dir = freshDir("csv-mixed");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "c1" }),
      row("2026-10-20T11:00:00.000Z", { id: "c2", currency: "eur", cost: "0.5", cost_value: 0.5 }),
    ]);
    const run = await runCli(["usage", "--format", "csv"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.deepEqual(
      lines.slice(1).map((l) => `${l.split(",").slice(0, 1)[0]}|${l.split(",").at(-1)}`),
      ["2026-10-20|eur", "2026-10-20|usd"],
    );
  });
});

// -- currency honesty ---------------------------------------------------------------

describe("mixed-currency handling", () => {
  test("per-currency sub-rows and a warning; never a summed cost", async () => {
    const dir = freshDir("mixed");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "x1", cost: "1.00", cost_value: 1.0, currency: "usd" }),
      row("2026-10-20T11:00:00.000Z", { id: "x2", cost: "2.00", cost_value: 2.0, currency: "eur" }),
    ]);
    const run = await runCli(["usage", "--by", "day"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /mixed currencies/);
    assert.match(run.stdout, /Costs per currency/);
    assert.match(run.stdout, /eur/);
    assert.match(run.stdout, /usd/);
    const payload = JSON.parse(
      (await runCli(["usage", "--by", "day", "--json"], { env: reportEnv(dir) })).stdout,
    );
    assert.equal(payload.meta.currencyHandling, "mixed");
    assert.deepEqual(payload.sections.daily[0].costs, { eur: 2, usd: 1 });
  });

  test("--no-cost removes every cost column (and the per-currency table)", async () => {
    const run = await runCli(["usage", "--by", "day", "--no-cost"], { env: reportEnv(DIRTY_DIR) });
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /COST/);
    assert.doesNotMatch(run.stdout, /Costs per currency/);
  });
});

// -- UX conventions ---------------------------------------------------------------

describe("report UX conventions", () => {
  test("piped output carries zero ANSI escape bytes", async () => {
    const run = await runCli(["usage", "--by", "day", "--breakdown"], {
      env: reportEnv(DIRTY_DIR),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.ok(!run.stdout.includes("\x1b"), "no ANSI escapes when stdout is not a TTY");
  });

  test("--compact drops the cached column and collapses tokens", async () => {
    const run = await runCli(["usage", "--by", "day", "--compact"], { env: reportEnv(DIRTY_DIR) });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /TOKENS/);
    assert.doesNotMatch(run.stdout, /CACHED TOKENS/);
    assert.doesNotMatch(run.stdout, /INPUT TOKENS/);
  });

  test("--no-totals drops the totals row; --breakdown adds per-model sub-tables", async () => {
    const noTotals = await runCli(["usage", "--by", "day", "--no-totals"], {
      env: reportEnv(DIRTY_DIR),
    });
    assert.doesNotMatch(noTotals.stdout, /\btotal\b/);
    const breakdown = await runCli(["usage", "--by", "day", "-b"], { env: reportEnv(DIRTY_DIR) });
    assert.match(breakdown.stdout, /MODEL/);
    assert.match(breakdown.stdout, /zai-org\/glm-5\.3/);
  });

  test("flag errors are clear", async () => {
    for (const args of [
      ["--last", "7x"],
      ["--timezone", "Mars/Phobos"],
      ["--sort", "nope"],
      ["--format", "xml"],
      ["--json", "--format", "csv"],
    ]) {
      const run = await runCli(["usage", ...args], { env: reportEnv(DIRTY_DIR) });
      assert.equal(run.code, 1, `expected exit 1 for ${args.join(" ")}`);
      assert.ok(run.stderr.length > 0, `expected an error for ${args.join(" ")}`);
    }
  });
});

// -- sync behavior ------------------------------------------------------------------

describe("report auto-sync", () => {
  test("auto-syncs before reading (single load), then reports from the store", async () => {
    const dir = freshDir("sync");
    const served = [row(new Date().toISOString(), { id: "live-1" })];
    let logsHits = 0;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/logs") {
        logsHits += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ data: served, has_more: false, next_after: null, next_after_id: null }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const run = await runCli(["usage", "--by", "day", "--json"], {
        env: cliEnv({
          AIAND_CONFIG_DIR: dir,
          AIAND_API_KEY: "sk-test",
          AIAND_BASE_URL: `http://127.0.0.1:${port}`,
          NO_COLOR: "1",
          CI: "1",
        }),
      });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(logsHits, 1, "exactly one /logs pull");
      const payload = JSON.parse(run.stdout);
      assert.equal(payload.sections.totals.requests, 1);
      assert.ok(!run.stdout.includes("sync failed"));
    } finally {
      server.close();
    }
  });

  test("a failed sync warns on stderr and serves the local store anyway (exit 0)", async () => {
    const dir = freshDir("sync-fail");
    await seedStore(dir, [row("2026-10-20T10:00:00.000Z", { id: "local-1" })]);
    const run = await runCli(["usage", "--by", "day", "--json"], {
      env: cliEnv({
        AIAND_CONFIG_DIR: dir,
        AIAND_API_KEY: "sk-test",
        AIAND_BASE_URL: CLOSED_URL,
        NO_COLOR: "1",
        CI: "1",
      }),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /sync failed/);
    assert.equal(JSON.parse(run.stdout).sections.totals.requests, 1);
  });

  test("--no-sync never touches the network and marks the store skipped", async () => {
    const run = await runCli(["usage", "--by", "day", "--json", "--no-sync"], {
      env: cliEnv({
        AIAND_CONFIG_DIR: DIRTY_DIR,
        AIAND_API_KEY: "sk-test",
        AIAND_BASE_URL: CLOSED_URL,
        NO_COLOR: "1",
        CI: "1",
      }),
    });
    assert.equal(run.code, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.meta.coverage.sync.status, "skipped");
    assert.equal(payload.sections.totals.requests, 4);
  });
});

// -- trust-boundary hardening (#87) --------------------------------------------

describe("CLI error hardening (#87)", () => {
  test("--since with a nonexistent calendar date fails with a CliError, no rollover", async () => {
    // 2025-02-29 does not exist; Date.parse silently rolls it to March 1.
    const run = await runCli(
      ["usage", "--since", "2025-02-29", "--until", "2025-03-05", "--json", "--no-sync"],
      { env: reportEnv(DIRTY_DIR) },
    );
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Invalid --since value: 2025-02-29/);
    assert.ok(!/ at \S+\(\S+:\d+/.test(run.stderr), "no stack trace leaks to the user");
  });

  test("--until with an impossible component (month 13, hour 25) fails with a CliError", async () => {
    for (const [flag, value] of [
      ["--until", "2025-13-01"],
      ["--until", "2025-10-01T25:00:00Z"],
    ]) {
      const run = await runCli(
        ["usage", "--since", "2025-09-01", flag, value, "--json", "--no-sync"],
        { env: reportEnv(DIRTY_DIR) },
      );
      assert.equal(run.code, 1, `${flag} ${value}`);
      assert.match(
        run.stderr,
        new RegExp(`Invalid ${flag} value: ${value.replace(/[-T:]/g, "\\$&")}`),
      );
    }
  });

  test("AIAND_CONFIG_DIR pointing at a regular file fails cleanly on reads and writes", async () => {
    const notADir = join(box.dir, "config-file-trap");
    writeFileSync(notADir, "not a directory");
    for (const args of [["config"], ["config", "set", "profile", "x"]]) {
      const run = await runCli(args, { env: reportEnv(notADir) });
      assert.equal(run.code, 1, `${args.join(" ")}: ${run.stderr}`);
      assert.match(run.stderr, /config dir is not a directory/i);
      assert.ok(!run.stderr.includes("ENOTDIR") && !run.stderr.includes("EEXIST"), run.stderr);
    }
  });

  test("--profile with an unsafe name is rejected even with --no-sync", async () => {
    const run = await runCli(
      ["usage", "--by", "day", "--json", "--no-sync", "--profile", "__proto__"],
      { env: reportEnv(DIRTY_DIR) },
    );
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Profile name "__proto__" is not allowed/);
    assert.equal(run.stdout, "", "no report is rendered");
  });

  test("--profile with an unsafe name is rejected when sync fails open", async () => {
    // Signed-in key against a dead gateway: the sync fails open, the profile
    // name must still be validated before any report renders.
    const run = await runCli(["usage", "--by", "day", "--json", "--profile", "bad/name"], {
      env: cliEnv({
        AIAND_CONFIG_DIR: DIRTY_DIR,
        AIAND_API_KEY: "sk-test",
        AIAND_BASE_URL: CLOSED_URL,
        NO_COLOR: "1",
        CI: "1",
      }),
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Profile name "bad\/name" is not allowed/);
    assert.equal(run.stdout, "", "no report is rendered");
  });

  // #91: the remaining #87 guard branches — wallToUtc's regex-miss and NaN
  // arms (only reachable through --timezone wall parsing), the ISO-datetime
  // date-part validation for both flags, and the sessions-window order check.
  test("--since/--until with a well-shaped but impossible time fail with the parse error", async () => {
    // An ISO datetime whose date part is real but whose time cannot exist
    // (minute 60) reaches parseSince/parseUntil's NaN arm.
    const badMinute = await runCli(
      ["usage", "--timezone", "UTC", "--since", "2026-10-01T00:60:00", "--json", "--no-sync"],
      { env: reportEnv(DIRTY_DIR) },
    );
    assert.equal(badMinute.code, 1);
    assert.match(badMinute.stderr, /Invalid --since value: 2026-10-01T00:60:00/);
    const badSecond = await runCli(
      ["usage", "--timezone", "UTC", "--until", "2026-10-01T00:00:61", "--json", "--no-sync"],
      { env: reportEnv(DIRTY_DIR) },
    );
    assert.equal(badSecond.code, 1);
    assert.match(badSecond.stderr, /Invalid --until value: 2026-10-01T00:00:61/);
  });

  test("ISO datetimes with a nonexistent calendar date are rejected for --since and --until (#87)", async () => {
    for (const [flag, value] of [
      ["--since", "2025-02-29T10:00:00Z"],
      ["--until", "2025-02-29T10:00:00Z"],
    ]) {
      const run = await runCli(["usage", flag, value, "--json", "--no-sync"], {
        env: reportEnv(DIRTY_DIR),
      });
      assert.equal(run.code, 1, `${flag} ${value}`);
      assert.match(run.stderr, /Invalid .* value: 2025-02-29/);
      assert.match(run.stderr, /calendar date does not exist/);
    }
  });

  test("--since with a space-separated ISO datetime still validates the date part", async () => {
    const run = await runCli(["usage", "--since", "2025-02-29 10:00:00", "--json", "--no-sync"], {
      env: reportEnv(DIRTY_DIR),
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Invalid --since value: 2025-02-29/);
  });

  test("sessions rejects an inverted --since/--until window with a --last override", async () => {
    // --last alone is fine, but an explicit inverted pair must refuse even
    // with --last present (the assertWindowOrder call runs after both parses).
    const run = await runCli(
      ["sessions", "--since", "2026-10-20", "--until", "2026-10-19", "--last", "7d", "--no-sync"],
      { env: reportEnv(DIRTY_DIR) },
    );
    assert.equal(run.code, 1);
    assert.match(run.stderr, /is after --until/);
  });

  test("inverted --since/--until windows are rejected", async () => {
    const run = await runCli(
      ["usage", "--since", "2026-10-20", "--until", "2026-10-19", "--json", "--no-sync"],
      { env: reportEnv(DIRTY_DIR) },
    );
    assert.equal(run.code, 1);
    assert.match(run.stderr, /--since .* is after --until/);

    const sessionsRun = await runCli(
      ["sessions", "--since", "2026-10-20", "--until", "2026-10-19", "--no-sync"],
      { env: reportEnv(DIRTY_DIR) },
    );
    assert.equal(sessionsRun.code, 1);
    assert.match(sessionsRun.stderr, /is after --until/);

    const exportRun = await runCli(
      ["export", "--format", "otel", "--since", "2026-10-20", "--until", "2026-10-19", "--no-sync"],
      { env: reportEnv(DIRTY_DIR) },
    );
    assert.equal(exportRun.code, 1);
    assert.match(exportRun.stderr, /is after --until/);
  });

  test("export --since/--until and --endpoint/--file guards (#91)", async () => {
    const badSince = await runCli(
      ["export", "--format", "otel", "--since", "not-a-date", "--no-sync"],
      { env: reportEnv(DIRTY_DIR) },
    );
    assert.equal(badSince.code, 1);
    assert.match(badSince.stderr, /Invalid --since value: not-a-date/);

    const both = await runCli(
      [
        "export",
        "--format",
        "otel",
        "--endpoint",
        "https://collector.example/v1/metrics",
        "--file",
        "metrics.json",
        "--no-sync",
      ],
      { env: reportEnv(DIRTY_DIR) },
    );
    assert.equal(both.code, 1);
    assert.match(both.stderr, /mutually exclusive/);
  });
});
