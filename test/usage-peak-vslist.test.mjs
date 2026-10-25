import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { CLOSED_URL, cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

// Tickets #81 (OBS-P2-5): peak/off-peak split (B9) and the vendor-list-price
// equivalent comparison (B8). // #81

const box = withTestEnv("aiand-usage-peak-", () => {
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
// B9: the window table + the pure split
// ---------------------------------------------------------------------------

const { splitPeakOffPeak, wallMinutes, wallWeekday, familyOf, windowsFor } = await import(
  "../dist/pricing/peak-windows.js"
);
const { inWindows } = await import("../dist/pricing/peak-windows.js");

describe("peak windows (B9)", () => {
  test("GLM 14:00-18:00 SGT == 06:00-10:00 UTC, boundaries exact", () => {
    // 2026-10-05 is a Monday; 05:59:59Z is 13:59 SGT (one minute before peak).
    assert.equal(wallMinutes("Asia/Singapore", Date.parse("2026-10-05T05:59:59Z")), 13 * 60 + 59);
    assert.equal(familyOf("zai-org/glm-5.3"), "glm");
    const windows = windowsFor("zai-org/glm-5.3");
    assert.ok(windows);
    assert.equal(inWindows(Date.parse("2026-10-05T05:59:59Z"), windows), false, "1s before peak");
    assert.equal(inWindows(Date.parse("2026-10-05T06:00:00Z"), windows), true, "peak start");
    assert.equal(inWindows(Date.parse("2026-10-05T09:59:59Z"), windows), true, "1s before end");
    assert.equal(inWindows(Date.parse("2026-10-05T10:00:00Z"), windows), false, "peak end");
  });

  test("midnight-UTC fixtures stay on the SGT calendar day; weekends never peak", () => {
    const windows = windowsFor("glm-5.3");
    // 23:30 UTC Monday = 07:30 SGT Tuesday: off-peak either way.
    assert.equal(inWindows(Date.parse("2026-10-05T23:30:00Z"), windows), false);
    // 00:30 UTC Tuesday = 08:30 SGT Tuesday: off-peak.
    assert.equal(inWindows(Date.parse("2026-10-06T00:30:00Z"), windows), false);
    // Saturday 2026-10-03 08:00 UTC = 16:00 SGT Saturday: weekday filter excludes.
    assert.equal(inWindows(Date.parse("2026-10-03T08:00:00Z"), windows), false);
    assert.equal(wallWeekday("Asia/Singapore", Date.parse("2026-10-03T08:00:00Z")), 6);
  });

  test("split shares are percentages of cost and sum to exactly 100", () => {
    const split = splitPeakOffPeak([
      { model: "glm-5.3", created_at: "2026-10-05T07:00:00Z", cost_value: 1.0, currency: "usd" },
      { model: "glm-5.3", created_at: "2026-10-05T08:00:00Z", cost_value: 3.0, currency: "usd" },
      { model: "glm-5.3", created_at: "2026-10-05T12:00:00Z", cost_value: 3.0, currency: "usd" },
    ]);
    assert.equal(split.models.length, 1);
    const model = split.models[0];
    assert.equal(model.family, "glm");
    assert.equal(model.peak.requests, 2);
    assert.equal(model.peak.costs.usd, 4.0);
    assert.equal(model.offPeak.costs.usd, 3.0);
    assert.equal(model.shares.usd.peak, 57.1);
    assert.equal(model.shares.usd.peak + model.shares.usd.offPeak, 100);
  });

  test("unclassified families land in their own bucket, never guessed", () => {
    const split = splitPeakOffPeak([
      {
        model: "some-vendor/mystery-x",
        created_at: "2026-10-05T07:00:00Z",
        cost_value: 2,
        currency: "usd",
      },
    ]);
    const model = split.models[0];
    assert.equal(model.family, null);
    assert.equal(model.unclassified.costs.usd, 2);
    assert.deepEqual(model.shares, {});
    assert.equal(split.routed.requests, 0);
  });

  test("non-first-party rows aggregate into the routed bucket", () => {
    const split = splitPeakOffPeak([
      { model: "glm-5.3", created_at: "2026-10-05T07:00:00Z", cost_value: 1, currency: "usd" },
      {
        model: "glm-5.3",
        created_at: "2026-10-05T07:00:00Z",
        cost_value: 9,
        currency: "usd",
        route: "proxy",
      },
    ]);
    assert.equal(split.models[0].peak.costs.usd, 1);
    assert.equal(split.routed.requests, 1);
    assert.equal(split.routed.costs.usd, 9);
  });

  test("rows without a cost still count requests", () => {
    const split = splitPeakOffPeak([
      { model: "glm-5.3", created_at: "2026-10-05T07:00:00Z", cost_value: null, currency: null },
    ]);
    assert.equal(split.models[0].peak.requests, 1);
    assert.equal(split.models[0].shares.usd, undefined);
  });
});

// ---------------------------------------------------------------------------
// B8: list-price snapshot, exact-only matching, overrides, savings
// ---------------------------------------------------------------------------

const { computeVsList, resolveRequestPrice, readSnapshotFile } = await import(
  "../dist/pricing/list-prices.js"
);
const { parseSnapshot, resolveAlias } = await import("../dist/pricing/price-snapshot.js");

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

describe("usage --show-windows / --sections peak / --vs-list", () => {
  test("--show-windows prints the table with sources; --json prints the raw data", async () => {
    const dir = freshDir("peak-windows-cli");
    await seedStore(dir, []);
    await withStoreEnv(dir, async () => {
      const shown = await runCli(["usage", "--show-windows"]);
      assert.equal(shown.code, 0);
      assert.match(shown.stdout, /glm/);
      assert.match(shown.stdout, /14:00-18:00 Asia\/Singapore/);
      assert.match(shown.stdout, /docs\.z\.ai/);
      const asJson = await runCli(["usage", "--show-windows", "--json"]);
      const table = JSON.parse(asJson.stdout);
      assert.equal(table[0].family, "glm");
      assert.equal(table[0].windows[0].tz, "Asia/Singapore");
    });
  });

  test("--sections peak splits seeded GLM rows and sums shares to 100", async () => {
    const dir = freshDir("peak-section");
    // Monday 2026-10-05: 07:00Z is peak SGT, 12:00Z is off-peak.
    await seedStore(dir, [
      row("2026-10-05T07:00:00Z", { cost: "1.000000", cost_value: 1 }),
      row("2026-10-05T12:00:00Z", { cost: "3.000000", cost_value: 3 }),
      row("2026-10-05T12:30:00Z", {
        model: "other-vendor/unknown",
        cost: "2.000000",
        cost_value: 2,
      }),
    ]);
    await withStoreEnv(dir, async () => {
      const shown = await runCli(["usage", "--sections", "peak", "--no-totals"]);
      assert.equal(shown.code, 0);
      assert.match(shown.stdout, /Peak \/ off-peak/);
      assert.match(shown.stdout, /glm/);
      assert.match(shown.stdout, /25\.0% \(\$1\.000000\)/);
      assert.match(shown.stdout, /75\.0% \(\$3\.000000\)/);
      assert.match(shown.stdout, /unclassified/);
      assert.match(shown.stdout, /never guessed/);
      assert.match(shown.stdout, /estimated\(peak-window table/);

      const asJson = await runCli(["usage", "--sections", "peak", "--json"]);
      const payload = JSON.parse(asJson.stdout);
      const peak = payload.sections.peak;
      const glm = peak.models.find((m) => m.family === "glm");
      assert.equal(glm.peak.costs.usd, 1);
      assert.equal(glm.shares.usd.peak + glm.shares.usd.offPeak, 100);
      assert.equal(
        payload.meta.provenance.peak,
        "estimated(peak-window table applied to stored created_at timestamps and gateway costs)",
      );
    });
  });

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

  test("--vs-list never guesses: without prices everything is unpriced", async () => {
    const dir = freshDir("vs-list-unpriced");
    await seedStore(dir, [row("2026-10-05T07:00:00Z")]);
    await withStoreEnv(dir, async () => {
      const shown = await runCli(["usage", "--vs-list"]);
      assert.equal(shown.code, 0);
      assert.match(shown.stdout, /unpriced/);
      assert.doesNotMatch(shown.stdout, /\$0\.000000/);
      assert.match(shown.stdout, /no list price for glm-5\.3/);
      const asJson = await runCli(["usage", "--vs-list", "--json"]);
      const payload = JSON.parse(asJson.stdout);
      assert.equal(payload.rows[0].status, "unpriced");
      assert.equal(payload.rows[0].priced, false);
      assert.equal(payload.rows[0].equivalent, null);
      assert.equal(payload.meta.snapshot_name, "bundled");
      assert.match(payload.meta.provenance.equivalent, /estimated\(vendor-list-price bundled@/);
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
});
