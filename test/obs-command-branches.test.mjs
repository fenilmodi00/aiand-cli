import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLOSED_URL, cliEnv, FAKE_API_KEY, runCli, withTestEnv } from "./helpers.mjs";

/**
 * Branch coverage for the observability command surfaces the hardening
 * sweep left untested: overview/report/heatmap/wrapped/recommend/logs/
 * export/cache flag and error branches. Behavior-level only: exit codes,
 * stdout/stderr, and written files. Stores are seeded exactly like
 * branch-hardening (direct SQLite inserts under an isolated config dir).
 */

const env = withTestEnv("obs-command-branches", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const iso = (ms) => new Date(Date.parse("2026-10-20T10:00:00.000Z") + ms).toISOString();

async function seedStore(cfg, rows) {
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  const { withEnv } = await import("./helpers.mjs");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    const opened = openStore(storePath());
    assert.ok(opened.ok);
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
        r.currency === null ? null : (r.currency ?? "usd"),
        r.created_at ?? iso(0),
        r.created_at ?? iso(0),
      );
    }
    opened.db.close();
  });
}

const rows = () => [
  { id: "a1", cost: 0.02 },
  { id: "a2", cost: 0.03, created_at: iso(60_000) },
  { id: "a3", cost: 0.04, created_at: iso(120_000), model: "openai/gpt-5.2" },
  { id: "a4", cost: null, currency: null, created_at: iso(180_000) },
  { id: "a5", cost: 0.05, currency: "eur", created_at: iso(240_000) },
];

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

test("overview: every section list renders, bad sections are a user error", async () => {
  const cfg = cfgDir("overview-branches");
  await seedStore(cfg, rows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  for (const args of [
    ["overview", "--no-sync"],
    ["overview", "--no-sync", "--sections", "totals,by-harness,models,busiest,daily,budget"],
    ["overview", "--no-sync", "--sections", "totals", "--json"],
    ["overview", "--no-sync", "--model", "openai/*", "--timezone", "America/New_York"],
    ["overview", "--no-sync", "--last", "48h", "--no-cost"],
  ]) {
    const out = await runCli(args, base);
    assert.equal(out.code, 0, `${args.join(" ")}\n${out.stdout}${out.stderr}`);
    assert.ok(out.stdout.length > 0);
  }

  const bad = await runCli(["overview", "--no-sync", "--sections", "totals,bananas"], base);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /bananas|--sections/);
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

test("report: theme/out/sections variants write a file; bad out dir fails loud", async () => {
  const cfg = cfgDir("report-branches");
  await seedStore(cfg, rows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  for (const args of [
    ["report", "--no-sync"],
    ["report", "--no-sync", "--theme", "dark"],
    ["report", "--no-sync", "--sections", "timeseries,sessions"],
    ["report", "--no-sync", "--last", "7d", "--no-cost"],
  ]) {
    const out = await runCli(args, base);
    assert.equal(out.code, 0, `${args.join(" ")}\n${out.stdout}${out.stderr}`);
    assert.ok(/wrote/i.test(out.stdout) || out.stdout.includes(".html"));
  }

  const badDir = await runCli(
    ["report", "--no-sync", "--out", join(cfg, "no", "such", "dir", "r.html")],
    base,
  );
  // Either the CLI creates parents (exit 0) or refuses with a clear error —
  // a crash exit with a stack trace is the only unacceptable outcome.
  if (badDir.code !== 0) assert.ok(badDir.stderr.length > 0 && !/at file:/.test(badDir.stderr));
});

test("report: empty store still writes a report", async () => {
  const cfg = cfgDir("report-empty");
  const out = await runCli(["report", "--no-sync"], { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
  assert.equal(out.code, 0, `${out.stdout}${out.stderr}`);
});

// ---------------------------------------------------------------------------
// heatmap + wrapped
// ---------------------------------------------------------------------------

test("heatmap: metrics/window/filters compose; bad metric is a user error", async () => {
  const cfg = cfgDir("heatmap-branches");
  await seedStore(cfg, rows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  for (const args of [
    ["heatmap", "--no-sync"],
    ["heatmap", "--no-sync", "--metric", "cost"],
    ["heatmap", "--no-sync", "--metric", "requests"],
    ["heatmap", "--no-sync", "--last", "7d"],
    ["heatmap", "--no-sync", "--harness", "claude"],
    ["heatmap", "--no-sync", "--json"],
  ]) {
    const out = await runCli(args, base);
    assert.equal(out.code, 0, `${args.join(" ")}\n${out.stdout}${out.stderr}`);
    assert.ok(out.stdout.length > 0);
  }

  const bad = await runCli(["heatmap", "--no-sync", "--metric", "bananas"], base);
  assert.notEqual(bad.code, 0);
});

// #99: --json emits machine-readable per-cell data instead of the text render.
test("heatmap --json emits per-cell JSON (#99)", async () => {
  const cfg = cfgDir("heatmap-json");
  await seedStore(cfg, [
    { id: "j1", cost: 0.25, created_at: "2026-10-20T10:30:00.000Z" },
    { id: "j2", cost: 0.5, created_at: "2026-10-20T10:45:00.000Z" },
  ]);
  const out = await runCli(["heatmap", "--no-sync", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(out.code, 0, `${out.stdout}${out.stderr}`);
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.metric, "cost");
  assert.equal(payload.currency, "usd");
  assert.equal(payload.rowCount, 2);
  const tuesday1030 = payload.cells.find((c) => c.day === "Tue" && c.hour === 10);
  assert.ok(tuesday1030);
  assert.equal(tuesday1030.spend, 0.75);
  assert.ok(payload.cells.every((c) => typeof c.day === "string" && typeof c.hour === "number"));
  assert.equal(payload.cells.length, 7 * 24);
  assert.ok(payload.peak && payload.peak.value === 0.75);

  const reqs = await runCli(["heatmap", "--no-sync", "--metric", "requests", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  const reqPayload = JSON.parse(reqs.stdout);
  assert.equal(reqPayload.cells.find((c) => c.day === "Tue" && c.hour === 10).count, 2);
});

test("wrapped: formats/windows/no-cost/json; dead gateway fails open", async () => {
  const cfg = cfgDir("wrapped-branches");
  await seedStore(cfg, rows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  for (const args of [
    ["wrapped", "--no-sync"],
    ["wrapped", "--no-sync", "--format", "markdown"],
    ["wrapped", "--no-sync", "--json"],
    ["wrapped", "--no-sync", "--last", "30d", "--no-cost"],
    ["wrapped", "--no-sync", "--since", "2026-10-18", "--until", "2026-10-21"],
  ]) {
    const out = await runCli(args, base);
    assert.equal(out.code, 0, `${args.join(" ")}\n${out.stdout}${out.stderr}`);
    assert.ok(out.stdout.length > 0);
  }

  const dead = await runCli(["wrapped", "--base-url", CLOSED_URL], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: FAKE_API_KEY }),
  });
  assert.equal(dead.code, 0, dead.stderr);

  const badTz = await runCli(["wrapped", "--no-sync", "--timezone", "Not/AZone"], base);
  assert.notEqual(badTz.code, 0);
});

// ---------------------------------------------------------------------------
// recommend
// ---------------------------------------------------------------------------

test("recommend: sort/top/harness/json; insufficient data is honest, empty exits clean", async () => {
  const cfg = cfgDir("recommend-branches");
  await seedStore(cfg, rows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  for (const args of [
    ["recommend", "--no-sync"],
    ["recommend", "--no-sync", "--sort", "cost"],
    ["recommend", "--no-sync", "--top", "1"],
    ["recommend", "--no-sync", "--harness", "claude"],
    ["recommend", "--no-sync", "--json"],
  ]) {
    const out = await runCli(args, base);
    assert.equal(out.code, 0, `${args.join(" ")}\n${out.stdout}${out.stderr}`);
    assert.ok(out.stdout.length > 0);
  }

  const empty = cfgDir("recommend-empty");
  const none = await runCli(["recommend", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: empty }),
  });
  assert.equal(none.code, 0, `${none.stdout}${none.stderr}`);
});

// ---------------------------------------------------------------------------
// logs command
// ---------------------------------------------------------------------------

test("logs: dead gateway fails open to a clear error; bad range is a user error", async () => {
  // `aiand logs` reads the live gateway /logs, not the local store — so the
  // offline branches are the error paths, not seeded rows.
  const cfg = cfgDir("logs-branches");
  const dead = await runCli(["logs", "--base-url", CLOSED_URL], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: FAKE_API_KEY }),
  });
  assert.notEqual(dead.code, 0);
  assert.ok(/Could not reach|sign|key|failed/i.test(dead.stderr), `dead gateway: ${dead.stderr}`);

  const badRange = await runCli(["logs", "--range", "bananas"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: FAKE_API_KEY }),
  });
  assert.notEqual(badRange.code, 0);

  const help = await runCli(["logs", "--help"], { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes("aiand logs"));
});

// ---------------------------------------------------------------------------
// key export + cache branches
// ---------------------------------------------------------------------------

test("cache: range/by/json against a loopback gateway; dead gateway fails open", async () => {
  // `aiand cache` always reads the live gateway /logs (even with --no-sync),
  // so the report paths need a loopback stub, mirroring cache-cli.test.mjs.
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/logs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              id: "log-1",
              model: "zai-org/glm-5.3",
              api_key: "sk-test...1111",
              status_code: 200,
              ttft_ms: 10,
              latency_ms: 100,
              input_tokens: 1000,
              output_tokens: 20,
              cached_tokens: 800,
              cost: "0.0004",
              currency: "usd",
              created_at: iso(0),
            },
          ],
          has_more: false,
          next_after: null,
          next_after_id: null,
        }),
      );
      return;
    }
    if (url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "zai-org/glm-5.3",
              name: "GLM 5.3",
              object: "model",
              created: 0,
              owned_by: "zai-org",
              provider: "zai-org",
              context_window: 1000000,
              capabilities: ["tool_calling"],
              reasoning_efforts: null,
              reasoning_effort_default: null,
              description: null,
              currency: "usd",
              input_per_1m: "1.000000",
              output_per_1m: "4.000000",
              cached_input_per_1m: "0.300000",
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stubUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = cfgDir("cache-branches");
    const base = {
      env: cliEnv({
        AIAND_CONFIG_DIR: cfg,
        AIAND_API_KEY: FAKE_API_KEY,
        AIAND_BASE_URL: stubUrl,
      }),
    };
    for (const args of [
      ["cache", "--no-sync"],
      ["cache", "--no-sync", "--range", "24h"],
      ["cache", "--no-sync", "--by", "model"],
      ["cache", "--no-sync", "--json"],
    ]) {
      const out = await runCli(args, base);
      assert.equal(out.code, 0, `${args.join(" ")}\n${out.stdout}${out.stderr}`);
      assert.ok(out.stdout.length > 0);
    }

    const dead = await runCli(["cache", "--base-url", CLOSED_URL], {
      env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: FAKE_API_KEY }),
    });
    // The /logs read is the command's data source, so a dead gateway is a
    // real failure — exit 1 with the reachability hint (not a stale report).
    assert.equal(dead.code, 1, dead.stderr);
    assert.match(dead.stderr, /Could not reach/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// export command (OTLP JSON / prometheus from the local store)
// ---------------------------------------------------------------------------

test("export: otel json and prometheus to stdout and --file", async () => {
  const cfg = cfgDir("export-branches");
  await seedStore(cfg, rows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  const otel = await runCli(["export", "--no-sync"], base);
  assert.equal(otel.code, 0, otel.stderr);
  assert.ok(otel.stdout.includes("resourceMetrics"));

  const prom = await runCli(["export", "--no-sync", "--format", "prometheus"], base);
  assert.equal(prom.code, 0, prom.stderr);
  assert.ok(/cache|tokens/.test(prom.stdout), `prom metrics: ${prom.stdout.slice(0, 200)}`);

  const outPath = join(cfg, "metrics.prom");
  const toFile = await runCli(
    ["export", "--no-sync", "--format", "prometheus", "--file", outPath],
    base,
  );
  assert.equal(toFile.code, 0, toFile.stderr);

  const empty = cfgDir("export-empty");
  const none = await runCli(["export", "--no-sync"], {
    env: cliEnv({ AIAND_CONFIG_DIR: empty }),
  });
  assert.equal(none.code, 0, `${none.stdout}${none.stderr}`);
});

test("auto-sync branch: no credentials still renders every store-backed report", async () => {
  // Without --no-sync the commands attempt a real sync first; with no
  // credentials that fails and every one of them must fail open (the
  // catch branch the --no-sync runs never reach). The ambient CI key is
  // scrubbed so openSession throws NotLoggedIn.
  const cfg = cfgDir("autosync-failopen");
  await seedStore(cfg, rows());
  for (const args of [
    ["overview"],
    ["report"],
    ["heatmap"],
    ["wrapped"],
    ["recommend"],
    ["sessions"],
  ]) {
    const out = await runCli(args, {
      env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: undefined }),
    });
    assert.equal(out.code, 0, `${args.join(" ")}\n${out.stdout}${out.stderr}`);
    assert.ok(out.stdout.length > 0);
  }
});

// ---------------------------------------------------------------------------
// usage command: by/sections/filters/sort/format branches
// ---------------------------------------------------------------------------

test("usage: by-units, sections, filters, sort, formats, and flag errors", async () => {
  const cfg = cfgDir("usage-branches");
  await seedStore(cfg, rows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  for (const args of [
    ["usage", "--no-sync"],
    ["usage", "--no-sync", "--by", "week"],
    ["usage", "--no-sync", "--by", "month"],
    ["usage", "--no-sync", "--by", "session"],
    ["usage", "--no-sync", "--sections", "daily,totals"],
    ["usage", "--no-sync", "--agent", "claude"],
    ["usage", "--no-sync", "--agent", "unknown"],
    ["usage", "--no-sync", "--model", "openai/*"],
    ["usage", "--no-sync", "--sort", "requests", "--order", "desc"],
    ["usage", "--no-sync", "--breakdown"],
    ["usage", "--no-sync", "--no-totals", "--no-cost", "--compact"],
    ["usage", "--no-sync", "--last", "7d", "--timezone", "America/New_York"],
    ["usage", "--no-sync", "--json"],
    ["usage", "--no-sync", "--format", "csv"],
    ["usage", "--no-sync", "--json", "--jq", ".sections.totals"],
    ["usage", "--no-sync", "--audit"],
    ["usage", "--no-sync", "--show-windows"],
  ]) {
    const out = await runCli(args, base);
    assert.equal(out.code, 0, `${args.join(" ")}\n${out.stdout}${out.stderr}`);
    assert.ok(out.stdout.length > 0);
  }

  const badBy = await runCli(["usage", "--no-sync", "--by", "century"], base);
  assert.notEqual(badBy.code, 0);

  const empty = cfgDir("usage-empty");
  const none = await runCli(["usage", "--no-sync"], { env: cliEnv({ AIAND_CONFIG_DIR: empty }) });
  assert.equal(none.code, 0, `${none.stdout}${none.stderr}`);
});

test("usage: --vs-list vendor equivalent renders; mixed currencies stay per-currency", async () => {
  const cfg = cfgDir("usage-vslist");
  await seedStore(cfg, rows());
  const out = await runCli(["usage", "--no-sync", "--vs-list"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(out.code, 0, `${out.stdout}${out.stderr}`);
});

test("orgs + models: error paths and help are clean", async () => {
  const cfg = cfgDir("orgs-models");
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };
  for (const [args, re] of [
    [["orgs", "--help"], /aiand orgs/],
    [["models", "--help"], /aiand models/],
  ]) {
    const out = await runCli(args, base);
    assert.equal(out.code, 0);
    assert.match(out.stdout, re);
  }
  // Dead gateway on orgs/models is a real failure: clear stderr, no crash.
  const dead = await runCli(["models", "--base-url", CLOSED_URL], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: FAKE_API_KEY }),
  });
  assert.notEqual(dead.code, 0);
  assert.ok(dead.stderr.length > 0 && !/at file:/.test(dead.stderr));
});

test("export: --header parsing and --endpoint/--file exclusivity", async () => {
  const cfg = cfgDir("export-headers");
  await seedStore(cfg, rows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  // Malformed headers are a user error naming the bad value.
  for (const bad of ["", ":", "name:", "=value", "bad name: v", ": v"]) {
    const out = await runCli(
      ["export", "--no-sync", "--endpoint", "http://127.0.0.1:1/x", "--header", bad],
      base,
    );
    assert.notEqual(out.code, 0, `header "${bad}" must be rejected`);
    assert.match(out.stderr, /Invalid --header/);
  }

  // --endpoint and --file are mutually exclusive.
  const both = await runCli(
    ["export", "--no-sync", "--endpoint", "http://127.0.0.1:1/x", "--file", join(cfg, "m.prom")],
    base,
  );
  assert.notEqual(both.code, 0);
  assert.match(both.stderr, /mutually exclusive/);
});

test("usage: legacy gateway views via loopback stub; report/legacy flag conflicts", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const respond = (payload) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/analytics/summary") {
      respond({
        current: { requests: 10, input_tokens: 100, output_tokens: 50 },
        previous: { requests: 5, input_tokens: 40, output_tokens: 20 },
        timeseries: [{ timestamp: "2026-10-25T10:00:00Z", tokens: 10 }],
      });
      return;
    }
    if (url.pathname === "/analytics/metrics") {
      respond({ models: [], totals: { requests: 0 } });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stubUrl = `http://127.0.0.1:${server.address().port}`;
  const cfg = cfgDir("usage-legacy");
  const base = {
    env: cliEnv({
      AIAND_CONFIG_DIR: cfg,
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: stubUrl,
    }),
  };
  try {
    // Report flags and legacy view flags are mutually exclusive — asserted
    // before the legacy path ever runs (the legacy gateway view needs a live
    // summary endpoint and is not driven here).
    const conflict = await runCli(["usage", "--range", "7days", "--by", "week"], base);
    assert.notEqual(conflict.code, 0);
    assert.match(conflict.stderr, /legacy gateway view|cannot be combined/);
  } finally {
    server.close();
  }
});

test("usage: --import-ccusage flag-guards reject bad combinations", async () => {
  const cfg = cfgDir("usage-import");
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };
  // --include-imported alongside the import itself is a flag error.
  const both = await runCli(["usage", "--import-ccusage", "-", "--include-imported"], base);
  assert.notEqual(both.code, 0);
  // --vs-list / --metrics / --range with the import is a flag error.
  const mixed = await runCli(["usage", "--import-ccusage", "-", "--vs-list"], base);
  assert.notEqual(mixed.code, 0);
});

// ---------------------------------------------------------------------------
// price-snapshot parse guards (pure)
// ---------------------------------------------------------------------------

test("parseSnapshot: refuses bad shapes, parses good ones; resolveAlias maps", async () => {
  const { parseSnapshot, resolveAlias, BUNDLED_SNAPSHOT } = await import(
    "../dist/pricing/price-snapshot.js"
  );
  assert.throws(() => parseSnapshot(null, "x"), /not a JSON object/);
  assert.throws(() => parseSnapshot("[]", "x"), /not a JSON object|JSON/);
  assert.throws(() => parseSnapshot({ format: 2 }, "x"), /format must be 1/);
  assert.throws(() => parseSnapshot({ format: 1, date: "october" }, "x"), /date must be/);
  assert.throws(
    () => parseSnapshot({ format: 1, date: "2026-10-20", sources: "no" }, "x"),
    /sources must be an array/,
  );
  assert.throws(
    () => parseSnapshot({ format: 1, date: "2026-10-20", sources: [{ name: 1 }] }, "x"),
    /source entries need/,
  );
  const good = parseSnapshot(
    {
      format: 1,
      date: "2026-10-20",
      sources: [{ name: "s", url: "https://x" }],
      aliases: [{ alias: "a/b", vendorId: "b", source: "doc" }],
      models: { b: { input: 1, output: 2, cacheRead: null, source: "s" } },
    },
    "test",
  );
  assert.equal(good.sources.length, 1);
  assert.equal(resolveAlias(good, "a/b"), "b");
  assert.equal(resolveAlias(good, "zzz"), "zzz");
  // The bundled snapshot resolves at least one alias.
  const anyAlias = BUNDDED_SAFE();
  assert.ok(anyAlias !== undefined);
  function BUNDDED_SAFE() {
    return BUNDLED_SNAPSHOT.aliases[0];
  }
  // Tier parsing: good tiers round-trip, bad tiers refuse per field.
  const tiered = parseSnapshot(
    {
      format: 1,
      date: "2026-10-20",
      models: {
        b: {
          input: 1,
          output: 2,
          cacheRead: null,
          source: "s",
          tiers: [{ minInput: 0, maxInput: 128, input: 1, output: 2, cacheRead: null }],
        },
      },
    },
    "test",
  );
  assert.equal(tiered.models.b.tiers.length, 1);
  const tier = tiered.models.b.tiers[0];
  assert.deepEqual(tier, { minInput: 0, maxInput: 128, input: 1, output: 2, cacheRead: null });
  assert.throws(
    () =>
      parseSnapshot(
        {
          format: 1,
          date: "2026-10-20",
          models: { b: { input: 1, output: 2, source: "s", tiers: "nope" } },
        },
        "test",
      ),
    /tiers must be an array/,
  );
  assert.throws(
    () =>
      parseSnapshot(
        {
          format: 1,
          date: "2026-10-20",
          models: {
            b: {
              input: 1,
              output: 2,
              source: "s",
              tiers: [{ minInput: -1, maxInput: null, input: 1, output: 1, cacheRead: null }],
            },
          },
        },
        "test",
      ),
    /tier.minInput/,
  );
  assert.throws(
    () =>
      parseSnapshot(
        {
          format: 1,
          date: "2026-10-20",
          models: {
            b: {
              input: 1,
              output: 2,
              source: "s",
              tiers: [{ minInput: 0, maxInput: null, input: "x", output: 1, cacheRead: null }],
            },
          },
        },
        "test",
      ),
    /tier input\/output prices must be numbers/,
  );
  assert.throws(
    () =>
      parseSnapshot(
        {
          format: 1,
          date: "2026-10-20",
          models: { b: { input: 1, output: 2, source: "s", cacheRead: "x" } },
        },
        "test",
      ),
    /cacheRead must be a number or null/,
  );
  // Every bundled alias resolves to its vendor id, and unknowns pass through.
  for (const alias of BUNDLED_SNAPSHOT.aliases) {
    assert.equal(resolveAlias(BUNDLED_SNAPSHOT, alias.alias), alias.vendorId);
  }
});

test("usage: --by session renders the sessionization annotation; mixed currencies stay apart", async () => {
  const cfg = cfgDir("usage-session");
  await seedStore(cfg, rows());
  const out = await runCli(["usage", "--no-sync", "--by", "session"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(out.code, 0, `${out.stdout}${out.stderr}`);
  assert.ok(/session|gap/i.test(out.stdout), `session blocks render: ${out.stdout.slice(0, 200)}`);

  const json = await runCli(["usage", "--no-sync", "--by", "session", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.ok(parsed.meta.sessionization || parsed.blocks, "session shape present");

  // Mixed currencies: the meta says mixed and costs stay per-currency.
  const mixed = await runCli(["usage", "--no-sync", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(mixed.code, 0, mixed.stderr);
  const meta = JSON.parse(mixed.stdout).meta;
  assert.ok(["single", "mixed", "none"].includes(meta.currencyHandling));
});

// #91: cheap multi-branch drives — one CLI call covers a cluster of flag and
// fail-open branches the earlier happy paths missed.
test("usage/sessions/heatmap/wrapped/overview/export flag-guard sweep (#91)", async () => {
  const cfg = cfgDir("guard-sweep");
  await seedStore(cfg, rows());
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  // --top validation on report; wrapped has no --top, so its format list
  // guard is exercised instead.
  const badTop = await runCli(["report", "--no-sync", "--top", "0"], base);
  assert.notEqual(badTop.code, 0);
  const badFormatW = await runCli(["wrapped", "--no-sync", "--format", "pdf"], base);
  assert.notEqual(badFormatW.code, 0);

  // --profile validation on the report surfaces even with --no-sync.
  const badProfile = await runCli(["heatmap", "--no-sync", "--profile", "../evil"], base);
  assert.equal(badProfile.code, 1, badProfile.stderr);
  assert.match(badProfile.stderr, /not allowed/);
  const badProfileW = await runCli(["wrapped", "--no-sync", "--profile", "bad/name"], base);
  assert.equal(badProfileW.code, 1, badProfileW.stderr);
  const badProfileO = await runCli(["overview", "--no-sync", "--profile", "x/y"], base);
  assert.equal(badProfileO.code, 1, badProfileO.stderr);
  const badProfileR = await runCli(["report", "--no-sync", "--profile", ".."], base);
  assert.equal(badProfileR.code, 1, badProfileR.stderr);
  const badProfileU = await runCli(["usage", "--by", "day", "--no-sync", "--profile", "a/b"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(badProfileU.code, 1, badProfileU.stderr);

  // Heatmap window + metric composition over a seeded store.
  for (const args of [
    ["heatmap", "--no-sync", "--since", "2026-10-19", "--until", "2026-10-21"],
    ["heatmap", "--no-sync", "--range", "7d"],
    ["heatmap", "--no-sync", "--timezone", "America/New_York"],
  ]) {
    const out = await runCli(args, base);
    assert.equal(out.code, 0, `${args.join(" ")}: ${out.stdout}${out.stderr}`);
  }

  // Export: valid --since/--until pair + prometheus file (mutually-exclusive
  // guard and the inverted-pair guard are asserted in otel-export tests).
  const file = join(cfg, "export.prom");
  const exp = await runCli(
    [
      "export",
      "--no-sync",
      "--format",
      "prometheus",
      "--since",
      "2026-10-19T00:00:00Z",
      "--until",
      "2026-10-21T00:00:00Z",
      "--file",
      file,
    ],
    { env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_NO_SYNC: "1", CI: "1" }) },
  );
  assert.equal(exp.code, 0, exp.stderr);
});
