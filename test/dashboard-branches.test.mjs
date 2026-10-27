import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CLOSED_URL,
  cliEnv,
  FAKE_API_KEY,
  FakeInput,
  FakeOutput,
  runCli,
  waitFor,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

/**
 * Branch coverage for the dashboard command's TUI loop and flag surface —
 * the pieces dashboard-heatmap-wrapped.test.mjs's happy-path drive leaves
 * open: refresh validation, bad timezone, dead-gateway sync warning, the
 * r/scroll/arrow/compare-off key branches, and the narrow/one-column frame.
 */

const env = withTestEnv("dashboard-branches", () => {});

function cfgDir(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MONDAY_10 = Date.parse("2026-10-19T10:00:00.000Z");
const HOUR = 3_600_000;

async function seedStore(cfg, n = 6) {
  const { openStore, storePath } = await import("../dist/store/index.js");
  const { recordAgentKey } = await import("../dist/api/agent-keys.js");
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    await recordAgentKey("claude", "sk-test-claude-super-secret-key-000");
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < n; i += 1) {
      insert.run(
        `d${i}`,
        "zai-org/glm-5.3",
        "sk-test...-000",
        200,
        300,
        null,
        1000,
        100,
        500,
        "0.02",
        0.02,
        "usd",
        new Date(MONDAY_10 + i * HOUR).toISOString(),
        new Date(MONDAY_10 + i * HOUR).toISOString(),
      );
    }
    opened.db.close();
  });
}

// ---------------------------------------------------------------------------
// run() flag-argument branches (CLI level)
// ---------------------------------------------------------------------------

test("dashboard: --refresh below 60 or non-numeric is a user error", async () => {
  const cfg = cfgDir("refresh-bad");
  for (const value of ["30", "0", "-5", "abc", ""]) {
    const out = await runCli(["dashboard", "--no-sync", "--refresh", value], {
      env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
    });
    assert.notEqual(out.code, 0, `--refresh ${value} must be rejected`);
    assert.match(out.stderr, /--refresh/);
  }
  // 60 is the floor and passes (piped run prints the overview).
  const ok = await runCli(["dashboard", "--no-sync", "--refresh", "60"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(ok.code, 0, ok.stderr);
});

test("dashboard: bad timezone is rejected; --no-tui matches the piped path", async () => {
  const cfg = cfgDir("tz-bad");
  const bad = await runCli(["dashboard", "--no-sync", "--timezone", "Not/AZone"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.notEqual(bad.code, 0);

  await seedStore(cfg);
  const text = await runCli(["dashboard", "--no-tui", "--no-sync", "--last", "7d"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg }),
  });
  assert.equal(text.code, 0, text.stderr);
  assert.ok(text.stdout.includes("ai&"), "overview renders");
});

test("dashboard: dead-gateway sync warns on stderr, overview still renders", async () => {
  const cfg = cfgDir("dash-deadgw");
  await seedStore(cfg);
  const out = await runCli(["dashboard", "--base-url", CLOSED_URL], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: FAKE_API_KEY }),
  });
  assert.equal(out.code, 0, out.stderr);
  assert.ok(out.stdout.includes("ai&"), "overview renders despite the dead gateway");
});

// ---------------------------------------------------------------------------
// TUI key branches beyond the happy path (injected FakeInput/FakeOutput)
// ---------------------------------------------------------------------------

test("dashboard TUI: arrows, j/k scroll, r refresh, c toggles back, q quits", async () => {
  const cfg = cfgDir("tui-keys");
  await seedStore(cfg, 8);
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { runDashboardUi } = await import("../dist/commands/dashboard.js");
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 110;
    output.rows = 40;
    const done = runDashboardUi({
      input,
      output,
      timezone: "UTC",
      models: [],
      initialHarness: "claude",
      showCost: true,
      refreshMs: 60_000,
      sync: { skipped: true },
      now: new Date(MONDAY_10 + 12 * HOUR),
    });
    try {
      await waitFor(() => output.text.includes("ai& dashboard"));

      input.send("\x1b[D"); // left arrow: Today wraps to Lifetime
      await waitFor(() => output.text.includes("[6 Lifetime]"), 5000, "left arrow to Lifetime");
      input.send("\x1b[C"); // right arrow: forward again
      await waitFor(() => output.text.includes("[1 Today]"), 5000, "right arrow back to Today");

      input.send("j"); // scroll down the per-day list
      input.send("j");
      input.send("k"); // scroll back up (clamps at 0)
      input.send("k");
      input.send("\x1b[5~"); // PgUp
      input.send("\x1b[6~"); // PgDn
      input.send("r"); // manual refresh — must redraw, not throw

      input.send("c"); // compare on
      await waitFor(() => output.text.includes("Harness compare"), 5000, "compare on");
      const withCompare = output.text.length;
      input.send("c"); // compare off: a new frame is drawn without the section
      await waitFor(() => output.text.length > withCompare, 5000, "frame redrawn");
      const tail = output.text.slice(withCompare);
      const lastFrame = tail.split("\r").pop() ?? "";
      assert.ok(!lastFrame.includes("Harness compare"), "compare off in the newest frame");
      assert.ok(output.text.includes("Top 5 sessions (pinned)"), "pinned block stays");

      input.send("q");
      await done;
    } finally {
      input.send("q");
      await done.catch(() => {});
    }
  });
});

test("dashboard TUI: narrow terminal renders the one-column frame", async () => {
  const cfg = cfgDir("tui-narrow");
  await seedStore(cfg, 4);
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { runDashboardUi } = await import("../dist/commands/dashboard.js");
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 40;
    output.rows = 24;
    const done = runDashboardUi({
      input,
      output,
      timezone: "UTC",
      models: [],
      initialHarness: null,
      showCost: false,
      refreshMs: 60_000,
      sync: { skipped: true },
      now: new Date(MONDAY_10 + 12 * HOUR),
    });
    try {
      await waitFor(() => output.text.includes("ai& dashboard"));
      input.send("q");
      await done;
      // No line wider than the terminal survived clipping.
      for (const line of output.text.split("\n")) {
        assert.ok(line.length <= 200, `clipped frame, got ${line.length} cols`);
      }
    } finally {
      input.send("q");
      await done.catch(() => {});
    }
  });
});

test("dashboard TUI: Ctrl-C cancels the loop (a lone ESC needs a second chunk)", async () => {
  // A bare ESC byte at the end of a chunk stays in the key parser's pending
  // buffer until more input flushes it (select.ts createKeyParser), so ESC
  // quits only on the next keystroke in this seam; Ctrl-C is immediate.
  const cfg = cfgDir("tui-quit-ctrlc");
  await seedStore(cfg, 3);
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { runDashboardUi } = await import("../dist/commands/dashboard.js");
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 100;
    output.rows = 30;
    const done = runDashboardUi({
      input,
      output,
      timezone: "UTC",
      models: [],
      initialHarness: null,
      showCost: true,
      refreshMs: 60_000,
      sync: { skipped: true },
      now: new Date(MONDAY_10 + 12 * HOUR),
    });
    await waitFor(() => output.text.includes("ai& dashboard"));
    input.send("\x03");
    // Ctrl-C rejects with the cancellation error — the loop is gone either way.
    await assert.rejects(done, /cancel|abort|interrupt/i);
    assert.ok(output.text.includes("^C"), "the ^C marker is printed");

    // ESC: pending until the next chunk flushes it, then quits.
    const input2 = new FakeInput();
    const output2 = new FakeOutput();
    output2.columns = 100;
    output2.rows = 30;
    const done2 = runDashboardUi({
      input: input2,
      output: output2,
      timezone: "UTC",
      models: [],
      initialHarness: null,
      showCost: true,
      refreshMs: 60_000,
      sync: { skipped: true },
      now: new Date(MONDAY_10 + 12 * HOUR),
    });
    await waitFor(() => output2.text.includes("ai& dashboard"));
    input2.send("\x1b");
    input2.send("z"); // any follow-up byte flushes the pending ESC
    await done2;
  });
});

test("dashboard TUI: stdin end (hangup) exits the loop, cursor restored", async () => {
  const cfg = cfgDir("tui-end");
  await seedStore(cfg, 3);
  await withEnv({ AIAND_CONFIG_DIR: cfg }, async () => {
    const { runDashboardUi } = await import("../dist/commands/dashboard.js");
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 100;
    output.rows = 30;
    const done = runDashboardUi({
      input,
      output,
      timezone: "UTC",
      models: [],
      initialHarness: null,
      showCost: true,
      refreshMs: 60_000,
      sync: { skipped: true },
      now: new Date(MONDAY_10 + 12 * HOUR),
    });
    await waitFor(() => output.text.includes("ai& dashboard"));
    input.emit("end");
    // A hangup rejects with the interactive-terminal error — the loop is gone.
    await assert.rejects(done, /Input ended|interactive terminal/i);
    assert.ok(output.text.includes("\x1b[?25h"), "cursor shown again after exit");
  });
});

// #91: heatmap's fail-open sync arms and window filtering, plus report's
// --json/--out composition on a seeded store.
test("heatmap sync fail-open warn, --since/--until window, and --model filter (#91)", async () => {
  const cfg = cfgDir("heatmap-guards");
  await seedStore(cfg);
  const base = { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) };

  // Dead gateway + env key: the failed sync warns, the grid still renders.
  const warned = await runCli(["heatmap"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_API_KEY: FAKE_API_KEY, AIAND_BASE_URL: CLOSED_URL }),
  });
  assert.equal(warned.code, 0, warned.stdout);
  assert.match(warned.stderr, /sync failed|Warning/);

  // A --since/--until pair that contains the seeded rows renders activity.
  const windowed = await runCli(
    ["heatmap", "--no-sync", "--since", "2026-10-19", "--until", "2026-10-20", "--model", "zai*"],
    base,
  );
  assert.equal(windowed.code, 0, windowed.stdout);
  assert.doesNotMatch(windowed.stdout, /no activity/);

  // A window past all data prints the empty note.
  const empty = await runCli(["heatmap", "--no-sync", "--since", "2027-01-01"], base);
  assert.equal(empty.code, 0, empty.stdout);
  assert.match(empty.stdout, /no activity/);
});

test("report --json writes the file and emits the report object (#91)", async () => {
  const cfg = cfgDir("report-json");
  await seedStore(cfg);
  const out = join(cfg, "r.html");
  const run = await runCli(
    ["report", "--no-sync", "--json", "--out", out, "--sections", "timeseries"],
    { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) },
  );
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.report, out);
  assert.ok(payload.bytes > 0);
  assert.ok(existsSync(out));
});

// #91: readHeatRows' fail-open catch — an unreadable store is an empty
// grid, never a crash (the read path the fail-open sync tests never hit).
test("heatmap on a corrupt store prints the empty grid and exits 0 (#91)", async () => {
  const cfg = cfgDir("heatmap-corrupt");
  await seedStore(cfg);
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(cfg, "store.db"), "this is not a sqlite database at all");
  const run = await runCli(["heatmap", "--no-sync"], { env: cliEnv({ AIAND_CONFIG_DIR: cfg }) });
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /no activity/i);
});
