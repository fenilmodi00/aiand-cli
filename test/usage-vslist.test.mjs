import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { CLOSED_URL, cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

// Ticket #81 (OBS-P2-5): the vendor-list-price equivalent comparison (B8). // #81

const box = withTestEnv("aiand-usage-vslist-", () => {
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

let rowSeq = 0;
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
  return dir;
}

const withStoreEnv = (dir, fn) =>
  withEnv(
    cliEnv({
      AIAND_CONFIG_DIR: dir,
      AIAND_BASE_URL: CLOSED_URL,
      AIAND_NO_SYNC: "1",
    }),
    fn,
  );

// ---------------------------------------------------------------------------
// B8: list-price snapshot, exact-only matching, overrides, savings
// ---------------------------------------------------------------------------

const { computeVsList, resolveRequestPrice, readSnapshotFile } = await import(
  "../dist/pricing/list-prices.js"
);
const { parseSnapshot, resolveAlias, BUNDLED_SNAPSHOT } = await import(
  "../dist/pricing/price-snapshot.js"
);

describe("vs-list pricing (B8)", () => {
  const SNAPSHOT = {
    format: 1,
    name: "unit",
    date: "2026-10-25",
    aliases: [{ alias: "zai-org/glm-5.3", vendorId: "glm-5.3", source: "unit" }],
    models: {
      "glm-5.3": { input: 1, output: 3, cacheRead: 0.3, source: "unit fixture" },
      tiered: {
        input: 0,
        output: 0,
        cacheRead: null,
        source: "unit fixture",
        tiers: [
          { minInput: 0, maxInput: 128000, input: 1, output: 3, cacheRead: null },
          { minInput: 128000, maxInput: 500000, input: 0.5, output: 3, cacheRead: null },
        ],
      },
    },
  };
  const snapshot = () => parseSnapshot(structuredClone(SNAPSHOT), "unit");

  const vsRow = (over = {}) => ({
    model: "zai-org/glm-5.3",
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cached_tokens: 0,
    cost_value: 3,
    currency: "usd",
    ...over,
  });

  test("alias resolution + equivalent math: (input-cached)*in + cached*cache + out*out", () => {
    assert.equal(resolveAlias(snapshot(), "zai-org/glm-5.3"), "glm-5.3");
    const result = computeVsList([vsRow()], snapshot());
    const rowResult = result.rows[0];
    // 1M uncached input at $1/1M + 1M output at $3/1M = $4.00; billed $3 -> $1 saved.
    assert.equal(rowResult.equivalent, 4);
    assert.equal(rowResult.savings, 1);
    assert.equal(rowResult.status, "priced");
    assert.equal(rowResult.priced, true);
    assert.equal(rowResult.snapshot_date, "2026-10-25");
    assert.match(rowResult.source, /vendor-list-price/);
    assert.equal(result.totals.savings, 1);
  });

  test("cached tokens price at the cacheRead rate", () => {
    const result = computeVsList([vsRow({ cached_tokens: 500_000 })], snapshot());
    // 0.5M at $1 + 0.5M at $0.3 + 1M at $3 = 0.5 + 0.15 + 3 = 3.65
    assert.ok(Math.abs(result.rows[0].equivalent - 3.65) < 1e-9);
  });

  test("never-guess: unknown model is unpriced with a reason, never $0.00", () => {
    const result = computeVsList([vsRow({ model: "vendor/who-knows" })], snapshot());
    const rowResult = result.rows[0];
    assert.equal(rowResult.status, "unpriced");
    assert.equal(rowResult.priced, false);
    assert.equal(rowResult.equivalent, null);
    assert.equal(rowResult.savings, null);
    assert.match(rowResult.reason, /no list price/);
    assert.equal(result.totals.equivalent, null);
    assert.equal(result.totals.savings, null);
  });

  test("unpriced model still reports its gateway-billed cost, never $0.000000", () => {
    const result = computeVsList(
      [vsRow({ model: "vendor/who-knows", cost_value: 4.99 })],
      snapshot(),
    );
    const rowResult = result.rows[0];
    assert.equal(rowResult.status, "unpriced");
    assert.equal(rowResult.billed, 4.99);
    assert.equal(result.totals.billed, 4.99);
  });

  test("exact-only: no fuzzy id matching", () => {
    const result = computeVsList([vsRow({ model: "glm-5.3-mini" })], snapshot());
    assert.equal(result.rows[0].status, "unpriced");
  });

  test("tier selection is exact; outside every tier is unpriced with the reason", () => {
    const inTier2 = resolveRequestPrice(
      snapshot(),
      {},
      vsRow({ model: "tiered", input_tokens: 200_000 }),
    );
    assert.equal(inTier2.input, 0.5);
    const outside = resolveRequestPrice(
      {
        ...snapshot(),
        models: {
          tiered: {
            ...snapshot().models.tiered,
            tiers: [{ minInput: 0, maxInput: 128000, input: 1, output: 3, cacheRead: null }],
          },
        },
      },
      {},
      vsRow({ model: "tiered", input_tokens: 1_000_000 }),
    );
    assert.equal(outside.unpriced !== undefined, true);
    assert.match(outside.unpriced, /outside every pricing tier/);
  });

  test("user overrides win per field and are labeled user-override", () => {
    const result = computeVsList([vsRow({ cached_tokens: 500_000 })], snapshot(), {
      "zai-org/glm-5.3": { input: 2 },
    });
    const rowResult = result.rows[0];
    // override input $2 + snapshot cacheRead $0.3 + output $3 => 1 + 0.15 + 3
    assert.ok(Math.abs(rowResult.equivalent - 4.15) < 1e-9);
    assert.match(rowResult.source, /user-override/);
  });

  test("partial: tier escape + sibling unpriced model -> savings withheld where owed", () => {
    const result = computeVsList(
      [
        // One model, two requests: one inside the 128k tier (priced), one
        // outside every tier (unpriced) -> the MODEL row is partial.
        vsRow({ model: "tiered", input_tokens: 50_000, output_tokens: 1_000_000, cost_value: 9 }),
        vsRow({
          model: "tiered",
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cost_value: 9,
        }),
        // A wholly unpriced model stays unpriced, never $0.00.
        vsRow({ model: "vendor/who-knows", cost_value: 9 }),
      ],
      snapshot(),
    );
    assert.equal(result.rows[0].status, "partial");
    assert.equal(result.rows[0].savings, null);
    assert.match(result.rows[0].reason, /unpriced/);
    assert.equal(result.rows[1].status, "unpriced");
    assert.equal(result.rows[1].equivalent, null);
    // No model is fully priced here, so the totals accrue no savings at all.
    assert.equal(result.totals.savings, null);
    assert.ok(Math.abs(result.totals.equivalent - (0.05 + 3)) < 1e-9);
  });

  test("non-USD billed cost never yields savings (FX out of scope)", () => {
    const result = computeVsList([vsRow({ currency: "jpy" })], snapshot());
    assert.equal(result.rows[0].status, "partial");
    assert.equal(result.rows[0].savings, null);
    assert.match(result.rows[0].reason, /USD/);
  });

  test("--prices-file snapshots are validated: overlapping tiers rejected", () => {
    assert.throws(
      () =>
        parseSnapshot(
          {
            format: 1,
            date: "2026-10-25",
            models: {
              m: {
                input: 1,
                output: 2,
                cacheRead: null,
                tiers: [
                  { minInput: 0, maxInput: 100000, input: 1, output: 2, cacheRead: null },
                  { minInput: 50000, maxInput: null, input: 1, output: 2, cacheRead: null },
                ],
              },
            },
          },
          "bad",
        ),
      /must not overlap/,
    );
    assert.throws(() => parseSnapshot({ format: 2, date: "2026-10-25" }, "bad"), /format/);
  });

  // OBS-LT-3 (#108): the bundled snapshot is priced for the first-party
  // models. Golden round-trip: glm-5.3 through BUNDLED_SNAPSHOT itself.
  test("bundled snapshot prices glm-5.3 end to end with a cited source", () => {
    assert.equal(BUNDLED_SNAPSHOT.format, 1);
    assert.equal(BUNDLED_SNAPSHOT.name, "bundled");
    assert.equal(BUNDLED_SNAPSHOT.date, "2026-10-28");
    const result = computeVsList(
      [
        vsRow({
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cached_tokens: 400_000,
          cost_value: 3,
        }),
      ],
      BUNDLED_SNAPSHOT,
    );
    const rowResult = result.rows[0];
    assert.equal(rowResult.status, "priced");
    // 0.6M uncached at $1.4 + 0.4M cached at $0.26 + 1M output at $4.4
    assert.ok(Math.abs(rowResult.equivalent - (0.84 + 0.104 + 4.4)) < 1e-9);
    assert.equal(result.totals.savings, rowResult.equivalent - 3);
    // Every bundled entry cites a vendor pricing page.
    for (const [id, entry] of Object.entries(BUNDLED_SNAPSHOT.models)) {
      assert.match(entry.source, /^https?:\/\//, `${id} source must be a URL`);
    }
  });

  test("readSnapshotFile reports unreadable and invalid JSON files as CliErrors", () => {
    assert.throws(
      () =>
        readSnapshotFile("/nope", "nope.json", () => {
          throw new Error("ENOENT");
        }),
      /ENOENT/,
    );
    assert.throws(() => readSnapshotFile("x", "x.json", () => "{nope"), /not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

describe("usage --vs-list", () => {
  test("--vs-list with --prices-file prices, labels the snapshot, and supports --jq", async () => {
    const dir = freshDir("vs-list-cli");
    await seedStore(dir, [
      row("2026-10-05T07:00:00Z", {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cached_tokens: 0,
        cost: "3.000000",
        cost_value: 3,
      }),
    ]);
    const prices = {
      format: 1,
      date: "2026-10-20",
      models: { "glm-5.3": { input: 1, output: 3, cacheRead: 0.3, source: "unit fixture" } },
      aliases: [{ alias: "zai-org/glm-5.3", vendorId: "glm-5.3", source: "unit" }],
    };
    const pricesPath = join(dir, "prices.json");
    writeFileSync(pricesPath, JSON.stringify(prices));

    await withStoreEnv(dir, async () => {
      const shown = await runCli(["usage", "--vs-list", "--prices-file", pricesPath]);
      assert.equal(shown.code, 0);
      assert.match(shown.stdout, /prices\.json@2026-10-20/);
      assert.match(shown.stdout, /4\.000000/);
      assert.match(shown.stdout, /1\.000000/);
      assert.match(shown.stdout, /gateway-billed/);

      const savings = await runCli([
        "usage",
        "--vs-list",
        "--prices-file",
        pricesPath,
        "--jq",
        ".totals.savings",
      ]);
      assert.equal(JSON.parse(savings.stdout), 1);
    });
  });

  test("--vs-list never guesses: models the bundled snapshot lacks stay unpriced", async () => {
    const dir = freshDir("vs-list-unpriced");
    await seedStore(dir, [row("2026-10-05T07:00:00Z", { model: "some-vendor/mystery-x" })]);
    await withStoreEnv(dir, async () => {
      const shown = await runCli(["usage", "--vs-list"]);
      assert.equal(shown.code, 0);
      assert.match(shown.stdout, /unpriced/);
      assert.doesNotMatch(shown.stdout, /\$0\.000000/);
      assert.match(shown.stdout, /no list price for some-vendor\/mystery-x/);
      const asJson = await runCli(["usage", "--vs-list", "--json"]);
      const payload = JSON.parse(asJson.stdout);
      assert.equal(payload.rows[0].status, "unpriced");
      assert.equal(payload.rows[0].priced, false);
      assert.equal(payload.rows[0].equivalent, null);
      assert.equal(payload.meta.snapshot_name, "bundled");
      assert.match(payload.meta.provenance.equivalent, /estimated\(vendor-list-price bundled@/);
    });
  });

  test("--vs-list prices bundled first-party models without --prices-file (#108)", async () => {
    const dir = freshDir("vs-list-bundled");
    await seedStore(dir, [
      row("2026-10-05T07:00:00Z", {
        model: "deepseek-ai/deepseek-v4.1-flash",
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cached_tokens: 0,
        cost: "1.000000",
        cost_value: 1,
      }),
    ]);
    await withStoreEnv(dir, async () => {
      const shown = await runCli(["usage", "--vs-list"]);
      assert.equal(shown.code, 0);
      // 1M input at $0.30 + 1M output at $1.20 = $1.50 equivalent vs $1 billed.
      assert.match(shown.stdout, /1\.500000/);
      assert.match(shown.stdout, /bundled@2026-10-28/);
      const asJson = await runCli(["usage", "--vs-list", "--json"]);
      const payload = JSON.parse(asJson.stdout);
      assert.equal(payload.meta.snapshot_name, "bundled");
      assert.equal(payload.meta.snapshot_date, "2026-10-28");
      assert.equal(payload.rows[0].status, "priced");
      assert.ok(Math.abs(payload.rows[0].equivalent - 1.5) < 1e-9);
      assert.match(payload.rows[0].source, /bundled@2026-10-28/);
    });
  });

  test("config set prices.* overrides land in the comparison as user-override", async () => {
    const dir = freshDir("vs-list-override");
    await seedStore(dir, [
      row("2026-10-05T07:00:00Z", {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cached_tokens: 0,
        cost: "3.000000",
        cost_value: 3,
      }),
    ]);
    await withStoreEnv(dir, async () => {
      const set = await runCli(["config", "set", "prices.zai-org/glm-5.3.input", "2"]);
      assert.equal(set.code, 0, set.stderr);
      const setOut = await runCli(["config", "set", "prices.zai-org/glm-5.3.output", "1"]);
      assert.equal(setOut.code, 0, setOut.stderr);

      const shown = await runCli(["usage", "--vs-list"]);
      assert.equal(shown.code, 0);
      // 1M * $2 + 1M * $1 = $3 equivalent vs $3 billed -> savings 0, priced.
      assert.match(shown.stdout, /user-override/);
      const asJson = await runCli(["usage", "--vs-list", "--json"]);
      const payload = JSON.parse(asJson.stdout);
      assert.equal(payload.rows[0].status, "priced");
      assert.ok(Math.abs(payload.rows[0].equivalent - 3) < 1e-9);
      assert.match(payload.rows[0].source, /user-override/);

      const bad = await runCli(["config", "set", "prices.zai-org/glm-5.3.input", "abc"]);
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /non-negative number/);
    });
  });

  test("--vs-list rejects --format csv and legacy combos", async () => {
    const dir = freshDir("vs-list-guard");
    await seedStore(dir, []);
    await withStoreEnv(dir, async () => {
      const csv = await runCli(["usage", "--vs-list", "--format", "csv"]);
      assert.equal(csv.code, 1);
      const legacy = await runCli(["usage", "--vs-list", "--range", "7days"]);
      assert.equal(legacy.code, 1);
    });
  });

  // #91: runVsList's pre-read sync arms — a dead gateway warns and the
  // vendor-equivalent view still serves local rows (fail-open), with a
  // missing credential taking the thrown-session arm.
  test("--vs-list fail-open: dead-gateway sync warns and still prices rows (#91)", async () => {
    const dir = freshDir("vs-list-sync-fail");
    await seedStore(dir, [row("2026-10-05T07:00:00Z")]);
    await withEnv(
      cliEnv({
        AIAND_CONFIG_DIR: dir,
        AIAND_BASE_URL: CLOSED_URL,
        AIAND_API_KEY: "sk-test-sync-fail",
        AIAND_NO_SYNC: undefined,
      }),
      async () => {
        const shown = await runCli(["usage", "--vs-list"]);
        assert.equal(shown.code, 0, shown.stderr);
        assert.match(shown.stderr, /Warning: sync failed/);
        assert.match(shown.stdout, /unpriced|gateway-billed/);
      },
    );
  });

  test("--vs-list fail-open: no credential throws inside the sync and warns (#91)", async () => {
    const dir = freshDir("vs-list-sync-throw");
    await seedStore(dir, [row("2026-10-05T07:00:00Z")]);
    await withEnv(
      cliEnv({
        AIAND_CONFIG_DIR: dir,
        AIAND_BASE_URL: CLOSED_URL,
        AIAND_NO_SYNC: undefined,
      }),
      async () => {
        const shown = await runCli(["usage", "--vs-list"]);
        assert.equal(shown.code, 0, shown.stderr);
        assert.match(shown.stderr, /Warning: sync failed/);
      },
    );
  });
});
