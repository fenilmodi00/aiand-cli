import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test, { before, describe } from "node:test";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

// #86 (OBS-BF-2): window filters compared gateway wire-format created_at
// (space separator, `+00` offset — e.g. `2026-10-26 05:02:11.844519+00`)
// against ISO `T` strings in SQL text comparisons; `' ' < 'T'` made
// same-day --since/--until windows match zero rows. Every date-window
// filter now routes through the normalized `datetime()` helpers
// (src/store/index.ts `createdSince` / `createdUntilIncl` /
// `createdUntilExcl`). These tests seed verbatim gateway-format rows and
// check each surface counts them at midnight, same-day, and
// exactly-on-boundary (inclusive <=) windows, plus --timezone behavior.

const box = withTestEnv("aiand-window-filters-", () => {
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

const cliEnvFor = (dir) =>
  cliEnv({ AIAND_CONFIG_DIR: dir, AIAND_NO_SYNC: "1", NO_COLOR: "1", CI: "1" });

// -- the gateway wire format: space separator, +00 offset (stored verbatim) --
const DAY = "2026-10-26";
const WIRE_MIDNIGHT = `${DAY} 00:00:00.000000+00`;
const WIRE_NOON = `${DAY} 12:00:00.000000+00`;
const WIRE_PREV_EVENING = "2026-10-25 23:59:59.999999+00";
const WIRE_NEXT_MIDNIGHT = "2026-10-27 00:00:00.000000+00";

describe("window filters match gateway wire-format rows (#86)", () => {
  const rows = [
    row(WIRE_PREV_EVENING, { id: "prev-evening" }),
    row(WIRE_MIDNIGHT, { id: "midnight" }),
    row(WIRE_NOON, { id: "noon" }),
    row(WIRE_NEXT_MIDNIGHT, { id: "next-midnight" }),
  ];
  const dir = freshDir("wire");
  before(async () => {
    await seedStore(dir, rows);
  });

  test("usage: --since today equals unfiltered count for same-day data", async () => {
    const unfiltered = JSON.parse(
      (await runCli(["usage", "--by", "day", "--json"], { env: cliEnvFor(dir) })).stdout,
    );
    assert.equal(unfiltered.sections.totals.requests, 4);
    const filtered = JSON.parse(
      (
        await runCli(["usage", "--by", "day", "--json", "--since", DAY], {
          env: cliEnvFor(dir),
        })
      ).stdout,
    );
    // Before the fix, `'2026-10-26 05:...' < '2026-10-26T00:...'` dropped
    // every same-day row; now midnight onward matches (inclusive since).
    assert.equal(filtered.sections.totals.requests, 3);
    assert.equal(
      filtered.sections.totals.requests,
      unfiltered.sections.totals.requests - 1,
      "only the previous-evening row falls outside --since today",
    );
  });

  test("usage: same-day --since/--until window counts midnight and boundary rows inclusively", async () => {
    // --until date = end of day (inclusive of the whole day in UTC).
    const run = JSON.parse(
      (
        await runCli(["usage", "--by", "day", "--json", "--since", DAY, "--until", DAY], {
          env: cliEnvFor(dir),
        })
      ).stdout,
    );
    assert.equal(run.sections.totals.requests, 2);
    const periods = run.sections.daily.map((b) => b.period);
    assert.deepEqual(periods, [DAY]);
  });

  test("sessions: same-day window counts wire rows; boundary stays inclusive", async () => {
    // untilMs = WIRE_BOUNDARY instant; the noon row sits exactly on the
    // inclusive upper bound and must be counted.
    const sinceMs = Date.parse(`${DAY}T00:00:00.000Z`);
    const untilMs = Date.parse(`${DAY}T12:00:00.000Z`);
    const { readSessionRows } = await import("../dist/commands/sessions.js");
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const inWindow = readSessionRows({ sinceMs, untilMs }, { agents: [], models: [] });
      assert.equal(inWindow.length, 2, "midnight + exactly-on-boundary noon");
      const before = readSessionRows(
        { sinceMs: null, untilMs: Date.parse("2026-10-25T23:59:59.999Z") },
        { agents: [], models: [] },
      );
      assert.equal(before.length, 1, "only the previous-evening row");
    });
  });

  test("export: --since/--until instants count wire rows (inclusive <=)", async () => {
    const { code, stderr } = await runCli(
      [
        "export",
        "--format",
        "otel",
        "--since",
        `${DAY}T00:00:00Z`,
        "--until",
        `${DAY}T12:00:00.000Z`,
      ],
      { env: cliEnvFor(dir) },
    );
    assert.equal(code, 0, stderr);
    assert.match(stderr, /2 requests/, "midnight + noon (boundary inclusive)");
  });

  test("heatmap: same-day window renders wire-format rows", async () => {
    const { code, stdout } = await runCli(
      ["heatmap", "--no-sync", "--metric", "requests", "--since", DAY, "--until", DAY],
      { env: { ...cliEnvFor(dir), FORCE_COLOR: "0" } },
    );
    assert.equal(code, 0);
    assert.ok(!stdout.includes("no activity"), "same-day wire rows must render");
  });

  // #92 (OBS-BF-8): instants the #86 suite left unpinned — a mid-day ISO
  // `--since` (both bounds same day) and an exactly-on-boundary wire row at
  // the inclusive upper edge, per read surface. The old ISO-string
  // comparator also failed here (space < 'T' at any hour, not just midnight).
  test("usage: mid-day --since/--until instants and exactly-on-boundary upper edge (#92)", async () => {
    // Since 09:00Z excludes the midnight row; the exactly-10:00 wire row is
    // the inclusive upper bound and must be counted.
    const dirMid = freshDir("midday");
    await seedStore(dirMid, [
      row(WIRE_MIDNIGHT, { id: "at-midnight" }),
      row("2026-10-26 10:00:00.000000+00", { id: "at-boundary" }),
      // Sub-millisecond precision is knowingly dropped by the shared
      // comparator; 1s past the bound is the smallest resolvable exclusion (datetime() truncates sub-seconds).
      row("2026-10-26 10:00:01.000000+00", { id: "just-after" }),
      row("2026-10-26 18:00:00.000000+00", { id: "evening" }),
    ]);
    const run = JSON.parse(
      (
        await runCli(
          [
            "usage",
            "--by",
            "day",
            "--json",
            "--since",
            `${DAY}T09:00:00Z`,
            "--until",
            `${DAY}T10:00:00.000Z`,
          ],
          { env: cliEnvFor(dirMid) },
        )
      ).stdout,
    );
    assert.equal(
      run.sections.totals.requests,
      1,
      "only the exactly-on-boundary 10:00 row; 10:00:01 excluded (second-precision bound)",
    );
  });

  test("sessions: mid-day window with an exactly-on-boundary wire row (#92)", async () => {
    const dirMid = freshDir("midday-sessions");
    await seedStore(dirMid, [
      row("2026-10-26 09:00:00.000000+00", { id: "at-since" }),
      row("2026-10-26 12:00:00.000000+00", { id: "at-until" }),
      // Sub-ms precision is knowingly dropped; 1s is the smallest exclusion (datetime() truncates sub-seconds).
      row("2026-10-26 12:00:01.000000+00", { id: "after-until" }),
    ]);
    const { readSessionRows } = await import("../dist/commands/sessions.js");
    await withEnv({ AIAND_CONFIG_DIR: dirMid }, async () => {
      const rows = readSessionRows(
        {
          sinceMs: Date.parse(`${DAY}T09:00:00.000Z`),
          untilMs: Date.parse(`${DAY}T12:00:00.000Z`),
        },
        { agents: [], models: [] },
      );
      assert.deepEqual(
        rows.map((r) => r.id).sort(),
        ["at-since", "at-until"],
        "both boundary instants inclusive",
      );
    });
  });

  test("export: mid-day window counts wire rows strictly inside and on the bound (#92)", async () => {
    const dirMid = freshDir("midday-export");
    await seedStore(dirMid, [
      row("2026-10-26 08:59:59.999000+00", { id: "before" }),
      row("2026-10-26 09:00:00.000000+00", { id: "on-since" }),
      row("2026-10-26 11:30:00.000000+00", { id: "inside" }),
    ]);
    const { code, stderr } = await runCli(
      ["export", "--format", "otel", "--since", `${DAY}T09:00:00Z`, "--until", `${DAY}T11:30:00Z`],
      { env: cliEnvFor(dirMid) },
    );
    assert.equal(code, 0, stderr);
    assert.match(stderr, /2 requests/, "on-since + inside; before excluded");
  });
});

describe("window filters: --timezone behavior preserved (#86)", () => {
  const dir = freshDir("tz");
  // America/New_York is EDT (UTC-4) through Oct 25; the local day 2026-10-26
  // runs 2026-10-25T20:00:00Z -> 2026-10-26T19:59:59.999Z. The midnight-UTC
  // row is 01:02 New York wall (inside), and an ISO row at 05:02Z is too.
  before(async () => {
    await seedStore(dir, [
      row("2026-10-26 05:02:11.844519+00", { id: "ny-early" }),
      row("2026-10-26T05:02:11.844Z", { id: "iso-early" }),
      row("2026-10-27 03:59:59.999999+00", { id: "ny-next-day" }),
    ]);
  });

  test("America/New_York: --since/--until for the local day keeps the UTC offset math", async () => {
    // The zoned window instants come from the pre-existing two-pass
    // wallToUtc (untouched here): under EDT as implemented, the local day
    // 2026-10-26 maps to 2026-10-25T20:00:00Z .. 2026-10-26T19:59:59.999Z.
    // Both 05:02Z rows (wire + ISO) fall inside it; the Oct-27 03:59Z wire
    // row falls outside. #86 is about matching wire-format rows inside
    // whatever window the zoned parse produces — mixed formats count alike.
    const run = JSON.parse(
      (
        await runCli(
          [
            "usage",
            "--by",
            "day",
            "--json",
            "--since",
            DAY,
            "--until",
            DAY,
            "--timezone",
            "America/New_York",
          ],
          { env: cliEnvFor(dir) },
        )
      ).stdout,
    );
    assert.equal(run.meta.timezone, "America/New_York");
    assert.equal(run.sections.totals.requests, 2);
    assert.deepEqual(
      run.sections.daily.map((b) => b.period),
      ["2026-10-26"],
    );
  });

  test("UTC: the same window excludes rows past midnight UTC", async () => {
    // The 03:59Z Oct-27 wire row falls outside the UTC day window.
    const run = JSON.parse(
      (
        await runCli(["usage", "--by", "day", "--json", "--since", DAY, "--until", DAY], {
          env: cliEnvFor(dir),
        })
      ).stdout,
    );
    assert.equal(run.sections.totals.requests, 2);
  });
});
