import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { describe } from "node:test";
import { cliEnv, FAKE_API_KEY, runCli, withEnv, withTestEnv } from "./helpers.mjs";

/**
 * Branch-coverage push for `dist/commands/usage-report.js` and
 * `dist/commands/usage.js`. All offline: seeded local stores
 * (test/branch-hardening.test.mjs pattern) and ccusage imports
 * (test/usage-ccusage-import.test.mjs pattern); the legacy gateway view
 * (usage --range / --metrics) runs against a loopback HTTP stub with an env
 * key, never the network and never the real keychain.
 */

const box = withTestEnv("usage-report-branches-", () => {
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

const reportEnv = (dir) =>
  cliEnv({
    AIAND_CONFIG_DIR: dir,
    AIAND_NO_SYNC: "1",
    NO_COLOR: "1",
    CI: "1",
  });

let rowSeq = 0;
/** A verbatim store row at a fixed UTC instant. */
function row(createdAt, overrides = {}) {
  rowSeq += 1;
  return {
    id: `row-${String(rowSeq).padStart(4, "0")}`,
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
        r.model ?? "zai-org/glm-5.3",
        r.api_key ?? null,
        r.status ?? 200,
        r.ttft ?? 300,
        r.latency ?? null,
        r.input ?? 1000,
        r.output ?? 100,
        r.cached ?? 500,
        r.cost === null ? null : String(r.cost),
        r.cost,
        r.currency === "" ? null : (r.currency ?? "usd"),
        r.created_at ?? "2026-10-20T10:00:00.000Z",
        new Date().toISOString(),
      );
    }
    opened.db.close();
  });
}

/** Write a ccusage payload file and import it (file form, no stdin). */
async function importCcusage(dir, payload) {
  const file = join(dir, `ccusage-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(payload));
  const run = await runCli(["usage", "--import-ccusage", file], { env: reportEnv(dir) });
  assert.equal(run.code, 0, run.stderr);
  return run;
}

// ---------------------------------------------------------------------------
// usage-report.js: filter paths, currency branches, breakdowns, sections
// ---------------------------------------------------------------------------

describe("usage report: filters, currency, breakdown", () => {
  test("api_key null maps to the unknown agent; agentOf covers both key forms", async () => {
    const dir = freshDir("agent-null");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "n1", api_key: null }), // unknown agent
      row("2026-10-20T11:00:00.000Z", { id: "n2" }), // mapped by agent-keys.json
    ]);
    writeFileSync(
      join(dir, "agent-keys.json"),
      JSON.stringify({
        version: 1,
        keys: [{ agent: "claude", masked: "sk-abcd...1234", fingerprint: "f".repeat(16), at: 0 }],
      }),
    );
    const run = await runCli(["usage", "--sections", "by-agent", "--no-totals", "--json"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    const agents = JSON.parse(run.stdout).sections["by-agent"];
    assert.deepEqual(agents.map((a) => a.key).sort(), ["claude", "unknown"]);
    assert.equal(agents.find((a) => a.key === "claude").requests, 1);
    assert.equal(agents.find((a) => a.key === "unknown").requests, 1);
  });

  test("a store row with cost but no currency aggregates under the unknown-currency key", async () => {
    const dir = freshDir("unknown-currency");
    await seedStore(dir, [row("2026-10-20T10:00:00.000Z", { id: "u1", currency: "" })]);
    const run = await runCli(["usage", "--by", "day", "--json"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    // Single unknown currency is still "single" handling, keyed by "".
    assert.equal(payload.meta.currencyHandling, "single");
    assert.equal(payload.meta.currency, "");
    assert.deepEqual(payload.sections.daily[0].costs, { "": 0.0042 });
  });

  test("--breakdown renders per-model sub-tables per period; --no-breakdown drops them", async () => {
    const dir = freshDir("breakdowns");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "b1", model: "zai-org/glm-5.3" }),
      row("2026-10-20T11:00:00.000Z", { id: "b2", model: "openai/gpt-5.2" }),
    ]);
    const withBd = await runCli(["usage", "--by", "day", "-b"], { env: reportEnv(dir) });
    assert.equal(withBd.code, 0, withBd.stderr);
    assert.match(withBd.stdout, /2026-10-20/);
    assert.match(withBd.stdout, /zai-org\/glm-5\.3/);
    assert.match(withBd.stdout, /openai\/gpt-5\.2/);

    const off = await runCli(["usage", "--by", "day", "-b", "--no-breakdown"], {
      env: reportEnv(dir),
    });
    assert.equal(off.code, 0, off.stderr);
    assert.doesNotMatch(off.stdout, /gpt-5\.2/);
  });

  test("--sort cost|input|output|cached|requests all order blocks", async () => {
    const dir = freshDir("sort-cols");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "s1", cost: 0.01, input: 100, output: 10, cached: 5 }),
      row("2026-10-21T10:00:00.000Z", { id: "s2", cost: 0.5, input: 900, output: 90, cached: 40 }),
      row("2026-10-22T10:00:00.000Z", { id: "s3", cost: 0.1, input: 400, output: 40, cached: 20 }),
    ]);
    for (const [column, expectedFirst, expectedLast] of [
      ["cost", "2026-10-20", "2026-10-21"],
      ["input", "2026-10-20", "2026-10-21"],
      ["output", "2026-10-20", "2026-10-21"],
      ["cached", "2026-10-20", "2026-10-21"],
      ["requests", "2026-10-20", "2026-10-22"], // all 1 request; tie breaks by start date
    ]) {
      const run = await runCli(
        ["usage", "--by", "day", "--json", "--sort", column, "--order", "asc"],
        { env: reportEnv(dir) },
      );
      assert.equal(run.code, 0, run.stderr);
      const blocks = JSON.parse(run.stdout).sections.daily;
      assert.equal(blocks[0].period, expectedFirst, `--sort ${column} asc`);
      assert.equal(blocks.at(-1).period, expectedLast, `--sort ${column} asc last`);
    }
    // sessions order by started_at, asc and desc
    const sess = await runCli(
      ["usage", "--by", "session", "--json", "--sort", "requests", "--order", "desc"],
      { env: reportEnv(dir) },
    );
    assert.equal(sess.code, 0, sess.stderr);
    assert.ok(JSON.parse(sess.stdout).sections.sessions.length >= 3);
  });

  test("--format csv with no block section refuses loudly; with sessions it renders", async () => {
    const dir = freshDir("csv-sections");
    await seedStore(dir, [row("2026-10-20T10:00:00.000Z", { id: "c1" })]);
    const noBlock = await runCli(
      ["usage", "--format", "csv", "--sections", "totals,by-model,by-agent,peak"],
      { env: reportEnv(dir) },
    );
    assert.equal(noBlock.code, 1);
    assert.match(noBlock.stderr, /needs a block section/);

    const sessions = await runCli(["usage", "--format", "csv", "--sections", "sessions"], {
      env: reportEnv(dir),
    });
    assert.equal(sessions.code, 0, sessions.stderr);
    assert.match(
      sessions.stdout,
      /^period,requests,input_tokens,output_tokens,cached_tokens,cost,currency/,
    );
  });

  test("--sections includes every registry entry in one run (by-model/by-agent/peak/json)", async () => {
    const dir = freshDir("all-sections");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "m1" }),
      row("2026-10-20T11:00:00.000Z", { id: "m2", cost: 2.0, currency: "eur" }),
    ]);
    const run = await runCli(
      [
        "usage",
        "--sections",
        "daily,totals,by-model,by-agent,peak,imported,grand-total",
        "--include-imported",
        "--json",
      ],
      { env: reportEnv(dir) },
    );
    assert.equal(run.code, 0, run.stderr);
    const sections = JSON.parse(run.stdout).sections;
    for (const name of ["daily", "totals", "by-model", "by-agent", "peak", "grand-total"]) {
      assert.ok(sections[name] !== undefined, `section ${name} present`);
    }
    // imported absent: nothing was imported
    assert.equal(sections.imported, undefined);
  });

  test("--by week with --sections weekly passes the matching-unit guard", async () => {
    const dir = freshDir("sections-guard-ok");
    await seedStore(dir, [row("2026-10-20T10:00:00.000Z", { id: "w1" })]);
    const run = await runCli(["usage", "--by", "week", "--sections", "weekly,totals", "--json"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.ok(JSON.parse(run.stdout).sections.weekly);
  });

  test("an empty --sections list defaults to the unit's block + totals", async () => {
    const dir = freshDir("sections-default");
    await seedStore(dir, [row("2026-10-20T10:00:00.000Z", { id: "d1" })]);
    const run = await runCli(["usage", "--by", "month", "--json"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    const sections = JSON.parse(run.stdout).sections;
    assert.ok(sections.monthly);
    assert.ok(sections.totals);
  });
});

// ---------------------------------------------------------------------------
// usage-report.js: imported lane, grand total, mixed-currency grand total
// ---------------------------------------------------------------------------

describe("usage report: imported ccusage lane branches", () => {
  const DAILY = {
    daily: [{ date: "2026-10-20", inputTokens: 1000, outputTokens: 200, costUSD: 0.5 }],
  };

  test("--include-imported with a mixed-currency store sums per currency, never across", async () => {
    const dir = freshDir("grand-mixed");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "g1", cost: 1.0, currency: "usd" }),
      row("2026-10-20T12:00:00.000Z", { id: "g2", cost: 2.0, currency: "eur" }),
    ]);
    await importCcusage(dir, DAILY);
    const run = await runCli(["usage", "--by", "day", "--json", "--include-imported"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.meta.currencyHandling, "mixed");
    const grand = payload.sections["grand-total"];
    assert.ok(grand);
    assert.deepEqual(grand.gateway.costs, { usd: 1, eur: 2 });
    assert.deepEqual(grand.imported.costs, { usd: 0.5 });
    // #89 casefold: gateway "usd" and ccusage-imported "USD" merge into one lane.
    assert.deepEqual(grand.costs, { usd: 1.5, eur: 2 });
    assert.equal(grand.requests, 3);
    assert.equal(payload.meta.currencyHandling, "mixed");
  });

  test("--include-imported with nothing imported: grand total is gateway-only", async () => {
    const dir = freshDir("grand-empty");
    await seedStore(dir, [row("2026-10-20T10:00:00.000Z", { id: "g1" })]);
    const run = await runCli(["usage", "--by", "day", "--json", "--include-imported"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    const grand = JSON.parse(run.stdout).sections["grand-total"];
    assert.ok(grand);
    assert.equal(grand.imported, null);
    assert.equal(grand.requests, 1);
    assert.deepEqual(grand.costs, { usd: 0.0042 });
  });

  test("table render shows the grand-total block and the mixed-currency per-currency table", async () => {
    const dir = freshDir("grand-render");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "g1", cost: 1.0, currency: "usd" }),
      row("2026-10-20T12:00:00.000Z", { id: "g2", cost: 2.0, currency: "eur" }),
    ]);
    await importCcusage(dir, DAILY);
    const run = await runCli(["usage", "--by", "day", "--include-imported"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /mixed currencies/);
    assert.match(run.stdout, /Costs per currency/);
    assert.match(run.stdout, /Grand total \(gateway \+ imported\)/);
    assert.match(run.stdout, /gateway/);
    assert.match(run.stdout, /imported/);
    assert.match(run.stdout, /combined/);
  });

  test("imported rows render their own table with the hint when no grand total is asked", async () => {
    const dir = freshDir("imported-render");
    await seedStore(dir, [row("2026-10-20T10:00:00.000Z", { id: "g1" })]);
    await importCcusage(dir, DAILY);
    const run = await runCli(["usage", "--by", "day"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Imported \(ccusage\) — excluded from gateway totals/);
    assert.match(run.stdout, /Run with --include-imported for a combined grand total\./);
    assert.doesNotMatch(run.stdout, /Grand total/);
  });

  test("--include-imported --compact renders the compact group columns for the grand total", async () => {
    const dir = freshDir("grand-compact");
    await seedStore(dir, [row("2026-10-20T10:00:00.000Z", { id: "g1" })]);
    await importCcusage(dir, DAILY);
    const run = await runCli(["usage", "--by", "day", "--include-imported", "--compact"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /TOKENS/);
    assert.match(run.stdout, /Grand total/);
  });

  test("--by session renders the session block table with started/turns columns", async () => {
    const dir = freshDir("session-render");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "se1" }),
      row("2026-10-20T10:01:00.000Z", { id: "se2" }),
      row("2026-10-20T12:00:00.000Z", { id: "se3" }),
    ]);
    const run = await runCli(["usage", "--by", "session"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /SESSION/);
    assert.match(run.stdout, /STARTED/);
    assert.match(run.stdout, /TURNS/);
    assert.match(run.stdout, /10-min gap heuristic/);
  });

  test("mixed-currency CSV keeps one row per (period, currency) with a currency column", async () => {
    const dir = freshDir("csv-mixed-cols");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "cm1", currency: "" }),
      row("2026-10-20T11:00:00.000Z", { id: "cm2", cost: 0.5, currency: "eur" }),
    ]);
    const run = await runCli(["usage", "--format", "csv"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    const lines = run.stdout
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "");
    assert.equal(lines.length, 3, `header + one row per currency:\n${run.stdout}`);
    // localeCompare: the unknown-currency "" lane sorts before "eur".
    assert.match(lines[1], /,$/, "unknown currency renders as an empty code");
    assert.match(lines[2], /eur/);
  });
});

// ---------------------------------------------------------------------------
// usage-report.js: peak section edge rows and totals-only table
// ---------------------------------------------------------------------------

describe("usage report: peak + totals-only rendering", () => {
  test("--sections peak renders unclassified families with the no-guessing note", async () => {
    const dir = freshDir("peak-unclassified");
    await seedStore(dir, [
      // glm rows get windowed; unknown-vendor model has no family.
      row("2026-10-05T07:00:00Z", { id: "p1", cost: 1.0 }),
      row("2026-10-05T12:00:00Z", { id: "p2", cost: 3.0 }),
      row("2026-10-05T13:00:00Z", { id: "p3", cost: 2.0, model: "other-vendor/unknown" }),
    ]);
    const run = await runCli(["usage", "--sections", "peak", "--no-totals"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Peak \/ off-peak/);
    assert.match(run.stdout, /unclassified/);
    assert.match(run.stdout, /no window-table entry for other-vendor\/unknown/);
    assert.match(run.stdout, /window sources: /);
    assert.match(run.stdout, /n\/a/); // unclassified model row cells
    assert.match(run.stdout, /-/); // empty unclassified bucket for glm
  });

  test("peak renders the routed-traffic line only when routed requests exist", async () => {
    const dir = freshDir("peak-routed");
    // Store rows carry no route metadata, so routed stays empty — the line
    // must not print. (buildReport maps store rows without a route field.)
    await seedStore(dir, [row("2026-10-05T07:00:00Z", { id: "r1", cost: 1.0 })]);
    const run = await runCli(["usage", "--sections", "peak", "--no-totals"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /routed \(non-first-party\)/);
  });

  test("--sections totals only: no block table, the Totals field list renders", async () => {
    const dir = freshDir("totals-only");
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", { id: "t1" }),
      row("2026-10-20T11:00:00.000Z", { id: "t2", currency: "" }),
      row("2026-10-20T12:00:00.000Z", { id: "t3", currency: "jpy", cost: 100, cost_value: 100 }),
    ]);
    const run = await runCli(["usage", "--sections", "totals"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Totals/);
    assert.match(run.stdout, /requests/);
    assert.match(run.stdout, /cost \(unknown\)/, "the unknown-currency totals line");
    assert.match(run.stdout, /cost \(jpy\)/);
    assert.doesNotMatch(run.stdout, /PERIOD/);
  });

  test("--sections totals --no-cost: no cost lines at all", async () => {
    const dir = freshDir("totals-nocost");
    await seedStore(dir, [row("2026-10-20T10:00:00.000Z", { id: "t1" })]);
    const run = await runCli(["usage", "--sections", "totals", "--no-cost"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Totals/);
    assert.doesNotMatch(run.stdout, /cost/);
  });
});

// ---------------------------------------------------------------------------
// usage.js: report-surface guards (sync failures, --last, CSV vs jq, sections)
// ---------------------------------------------------------------------------

describe("usage report surface: guards and failure paths", () => {
  test("a failed sync is fail-open: warn on stderr, local data still reported, exit 0", async () => {
    const dir = freshDir("sync-fail-open");
    await seedStore(dir, [row("2026-10-20T10:00:00.000Z", { id: "f1" })]);
    const run = await runCli(["usage", "--by", "day", "--json"], {
      env: cliEnv({
        AIAND_CONFIG_DIR: dir,
        AIAND_API_KEY: FAKE_API_KEY,
        AIAND_BASE_URL: "http://127.0.0.1:9",
        NO_COLOR: "1",
        CI: "1",
      }),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /sync failed/);
    assert.equal(JSON.parse(run.stdout).sections.totals.requests, 1);
  });

  test("--last combined with --since takes the later bound (Math.max branch)", async () => {
    const dir = freshDir("last-plus-since");
    await seedStore(dir, [
      row("2026-10-19T10:00:00.000Z", { id: "l1" }),
      row("2026-10-20T10:00:00.000Z", { id: "l2" }),
      row("2026-10-21T10:00:00.000Z", { id: "l3" }),
    ]);
    // --since 2026-10-19 pins the near edge; a wide --last (26w) starts far
    // before it, so the Math.max(since, lastStart) branch deterministically
    // picks the --since bound — and --until pins the far edge, making the
    // assertion independent of the wall clock.
    const both = await runCli(
      [
        "usage",
        "--by",
        "day",
        "--json",
        "--since",
        "2026-10-19",
        "--until",
        "2026-10-22",
        "--last",
        "26w",
      ],
      { env: reportEnv(dir) },
    );
    assert.equal(both.code, 0, both.stderr);
    assert.equal(JSON.parse(both.stdout).sections.totals.requests, 3);
  });

  test("--format csv alongside --jq refuses; --format csv is a report-only surface", async () => {
    const dir = freshDir("csv-jq");
    await seedStore(dir, [row("2026-10-20T10:00:00.000Z", { id: "q1" })]);
    const run = await runCli(["usage", "--format", "csv", "--jq", ".sections.totals"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /cannot be combined/);
  });

  test("--sections with a --by mismatch refuses with the documented error", async () => {
    const dir = freshDir("sections-mismatch");
    await seedStore(dir, [row("2026-10-20T10:00:00.000Z", { id: "x1" })]);
    const run = await runCli(["usage", "--by", "day", "--sections", "weekly"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /--by day does not match --sections weekly/);
  });

  test("--vs-list with an invalid --timezone refuses before any store read", async () => {
    const dir = freshDir("vslist-tz");
    const run = await runCli(["usage", "--vs-list", "--timezone", "Mars/Olympus"], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Invalid --timezone/);
  });

  test("--vs-list --no-sync renders the empty-store message and skips the network", async () => {
    const dir = freshDir("vslist-empty");
    const run = await runCli(["usage", "--vs-list", "--no-sync"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /No matching requests\./);
    assert.match(run.stderr, /sync skipped/);
  });

  test("--vs-list with rows renders the comparison table and totals line", async () => {
    const dir = freshDir("vslist-rows");
    // glm-5.3 is in the bundled window/pricing fixtures: billed cost exists,
    // the equivalent may be unpriced — the table renders either way.
    await seedStore(dir, [
      row("2026-10-20T10:00:00.000Z", {
        id: "v1",
        cost: 0.02,
        input: 1_000_000,
        output: 1_000_000,
        cached: 0,
      }),
    ]);
    const run = await runCli(["usage", "--vs-list", "--no-sync"], { env: reportEnv(dir) });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /List-price comparison/);
    assert.match(run.stdout, /zai-org\/glm-5\.3/);
    assert.match(run.stdout, /total billed/);
  });
});

// ---------------------------------------------------------------------------
// usage.js: the legacy gateway view (--range / --metrics) over a loopback stub
// ---------------------------------------------------------------------------

describe("usage legacy gateway view (loopback stub, env key)", () => {
  /** A loopback double serving both analytics endpoints; returns its base URL. */
  async function startStub({ metrics = null, summary = null } = {}) {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const respond = (payload) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === "/analytics/metrics") {
        respond({ object: "list", data: metrics ?? [] });
        return;
      }
      if (url.pathname === "/analytics/summary") {
        respond(
          summary ?? {
            current: { requests: 10, input_tokens: 1000, output_tokens: 500 },
            previous: { requests: 5, input_tokens: 400, output_tokens: 200 },
            timeseries: [
              { timestamp: "2026-10-25T00:00:00Z", tokens: 1500 },
              { timestamp: "2026-10-26T00:00:00Z", tokens: 1500 },
            ],
          },
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
  }

  const stubEnv = (dir, baseUrl) =>
    cliEnv({
      AIAND_CONFIG_DIR: dir,
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: baseUrl,
      NO_COLOR: "1",
      CI: "1",
    });

  test("--range renders the comparison table with the sparkline footer", async () => {
    const dir = freshDir("legacy-summary");
    const { server, baseUrl } = await startStub();
    try {
      const run = await runCli(["usage", "--range", "24h"], {
        env: stubEnv(dir, baseUrl),
      });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /Last 24h/);
      assert.match(run.stdout, /requests/);
      assert.match(run.stdout, /total tokens/);
      assert.match(run.stdout, /tokens {2}/, "the timeseries sparkline header");
    } finally {
      server.close();
    }
  });

  test("--range --json returns the summary document verbatim", async () => {
    const dir = freshDir("legacy-json");
    const summary = {
      current: { requests: 1, input_tokens: 2, output_tokens: 3 },
      previous: { requests: 4, input_tokens: 5, output_tokens: 6 },
      timeseries: [],
    };
    const { server, baseUrl } = await startStub({ summary });
    try {
      const run = await runCli(["usage", "--range", "7days", "--json"], {
        env: stubEnv(dir, baseUrl),
      });
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), summary);
    } finally {
      server.close();
    }
  });

  test("--metrics renders the metrics table; empty metrics prints the no-data line", async () => {
    const dir = freshDir("legacy-metrics");
    const metric = {
      metric_name: "requests",
      unit: "count",
      aggregation: "sum",
      timeseries: [
        { timestamp: "2026-10-25T00:00:00Z", value: 1 },
        { timestamp: "2026-10-26T00:00:00Z", value: 3 },
      ],
      summary: [{ display_name: "Requests", value: 4 }],
      info: null,
    };
    const { server, baseUrl } = await startStub({ metrics: [metric] });
    try {
      const run = await runCli(["usage", "--metrics", "--range", "7days"], {
        env: stubEnv(dir, baseUrl),
      });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /Last 7days/);
      assert.match(run.stdout, /Requests/);
      assert.match(run.stdout, /count/);
    } finally {
      server.close();
    }

    const empty = freshDir("legacy-metrics-empty");
    const { server: server2, baseUrl: baseUrl2 } = await startStub({ metrics: [] });
    try {
      const run = await runCli(["usage", "--metrics"], { env: stubEnv(empty, baseUrl2) });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /No metrics for this window\./);
    } finally {
      server2.close();
    }
  });

  test("a store with a budget prints the budget footer alongside the legacy view", async () => {
    const dir = freshDir("legacy-budget");
    await seedStore(dir, [row(new Date().toISOString(), { id: "bud1", cost: 90, latency: 0 })]);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({ budget: { monthly: 100, warn_pct: 80, currency: "usd" } }),
      );
    });
    const { server, baseUrl } = await startStub();
    try {
      const run = await runCli(["usage", "--range", "24h"], {
        env: stubEnv(dir, baseUrl),
      });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stderr, /% of monthly budget used/);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// usage.js: --verify surface branches (human-output lines not covered by
// test/usage-verify.test.mjs: the UNVERIFIABLE verdict line and detail lines)
// ---------------------------------------------------------------------------

describe("usage --verify: unverifiable human-output lines", () => {
  test("a fully-unverifiable window prints the yellow verdict and per-row details", async () => {
    const dir = freshDir("verify-unverifiable");
    const run = await runCli(
      [
        "usage",
        "--verify",
        "--no-sync",
        "--since",
        new Date(Date.now() - 200 * 86_400_000).toISOString(),
        "--until",
        new Date(Date.now() - 100 * 86_400_000).toISOString(),
      ],
      {
        env: cliEnv({
          AIAND_CONFIG_DIR: dir,
          AIAND_API_KEY: FAKE_API_KEY,
          AIAND_BASE_URL: "http://127.0.0.1:9",
          NO_COLOR: "1",
          CI: "1",
        }),
      },
    );
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /sync: skipped/);
    assert.match(run.stdout, /UNVERIFIABLE/);
    assert.match(run.stdout, /Everything comparable reconciles; some rows are UNVERIFIABLE/);
    assert.match(run.stdout, /unverifiable \(\w+\): /, "the per-row detail lines");
  });
});

// ---------------------------------------------------------------------------
// usage.js: --import-ccusage non-json table output and flag guards
// ---------------------------------------------------------------------------

describe("usage --import-ccusage: table output and flag guards", () => {
  const PAYLOAD = {
    daily: [{ date: "2026-10-20", inputTokens: 10, outputTokens: 5, costUSD: 0.01 }],
  };

  test("non-json import prints the source/report table and the anti-double-count notes", async () => {
    const dir = freshDir("import-table");
    const run = await importCcusage(dir, PAYLOAD);
    assert.match(run.stdout, /ccusage import/);
    assert.match(run.stdout, /imported\(ccusage@\d{4}-\d{2}-\d{2}\)/);
    assert.match(run.stdout, /daily/);
    assert.match(run.stdout, /EXCLUDED from gateway totals/);
    assert.match(run.stdout, /Run aiand usage --include-imported/);
  });

  test("re-import prints the deduped rows-written cell", async () => {
    const dir = freshDir("import-deduped");
    await importCcusage(dir, PAYLOAD);
    const run = await importCcusage(dir, PAYLOAD);
    assert.match(run.stdout, /0 \(already imported\)/);
  });

  test("--import-ccusage with --include-imported refuses (report flag on the import)", async () => {
    const dir = freshDir("import-guard-include");
    const run = await runCli(["usage", "--import-ccusage", "-", "--include-imported"], {
      env: reportEnv(dir),
      input: JSON.stringify(PAYLOAD),
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /--include-imported is a report flag/);
  });

  test("--import-ccusage with --metrics / --range / --vs-list refuses (view flags on the import)", async () => {
    const dir = freshDir("import-guard-views");
    for (const extra of [["--metrics"], ["--range", "7days"], ["--vs-list"]]) {
      const run = await runCli(["usage", "--import-ccusage", "-", ...extra], {
        env: reportEnv(dir),
        input: JSON.stringify(PAYLOAD),
      });
      assert.equal(run.code, 1, `--import-ccusage ${extra.join(" ")} must refuse`);
      assert.match(run.stderr, /only imports data/);
    }
  });

  test("a missing payload file refuses with the file-read error", async () => {
    const dir = freshDir("import-missing");
    const run = await runCli(["usage", "--import-ccusage", join(dir, "nope.json")], {
      env: reportEnv(dir),
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Could not read ccusage JSON file/);
  });
});
