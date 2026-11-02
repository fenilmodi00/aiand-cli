import assert from "node:assert/strict";
import { join } from "node:path";
import test, { describe } from "node:test";
import { FAKE_API_KEY, runCli, withEnv, withTestEnv } from "./helpers.mjs";

// OBS-P3-6 (#78): `aiand efficiency` — the CLI surface of the envelope-derived
// metrics. The report must print the coverage note and the "local-capture
// only" caveat in every section, and the --json payload must carry the
// notes a machine reader needs.

const box = withTestEnv("aiand-efficiency-cli-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
});

const { normalizeEnvelope } = await import("../dist/agents/envelope.js");
const { insertEnvelope } = await import("../dist/store/envelopes.js");
const { openStore, storePath } = await import("../dist/store/index.js");

// Seed a store with 4 request rows and 3 captured envelopes (75% coverage):
// edit a.ts, then a shell command, then a.ts again — the exact CodeBurn retry
// shape (one one-shot, one retry) — on a named branch.
function seedStore(dir) {
  const previous = process.env.AIAND_CONFIG_DIR;
  process.env.AIAND_CONFIG_DIR = dir;
  try {
    const opened = openStore(storePath());
    assert.ok(opened.ok);
    const db = opened.db;
    const insert = db.prepare(
      "INSERT INTO requests (id, model, api_key, status_code, input_tokens, output_tokens, " +
        "cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const requests = [
      ["r1", "2026-10-25T10:00:00.000Z", 0.1],
      ["r2", "2026-10-25T10:01:00.000Z", 0.2],
      ["r3", "2026-10-25T10:02:00.000Z", 0.3],
      ["r4", "2026-10-25T10:03:00.000Z", 0.4],
    ];
    for (const [id, createdAt, cost] of requests) {
      insert.run(
        id,
        "zai-org/glm-5.3",
        "sk-abcd…1234",
        200,
        100,
        50,
        0,
        String(cost),
        cost,
        "USD",
        createdAt,
        createdAt,
      );
    }
    const env = (id, createdAt, tools, targets, branch) =>
      insertEnvelope(db, {
        id,
        agent: "opencode",
        model: "zai-org/glm-5.3",
        apiKey: "sk-abcd…1234",
        createdAt,
        envelope: normalizeEnvelope({
          tools,
          editTargets: targets,
          projectRoot: "/repo",
          gitBranch: branch,
        }),
      });
    env("e1", "2026-10-25T10:00:30.000Z", ["Edit"], ["/repo/src/a.ts"], "feat/envelope");
    env("e2", "2026-10-25T10:01:30.000Z", ["Bash"], [], "feat/envelope");
    env("e3", "2026-10-25T10:02:30.000Z", ["Edit"], ["/repo/src/a.ts"], "feat/envelope");
    db.close();
  } finally {
    process.env.AIAND_CONFIG_DIR = previous;
  }
}

function cliEnvFor(dir) {
  return {
    ...process.env,
    AIAND_CONFIG_DIR: dir,
    AIAND_HOME: join(box.dir, "home"),
    AIAND_API_KEY: FAKE_API_KEY,
    AIAND_NO_SYNC: "1",
  };
}

describe("aiand efficiency", () => {
  test("--json payload: one-shot/retry, task mix, attribution, coverage notes", async () => {
    const dir = join(box.dir, "json");
    seedStore(dir);
    // Pinned fixture dates: widen the window so the 7-day default cannot age
    // the seeded rows out of view.
    const { code, stdout } = await runCli(["efficiency", "--last", "30d", "--json"], {
      env: cliEnvFor(dir),
    });
    assert.equal(code, 0);
    const payload = JSON.parse(stdout);

    // coverage honesty: 3 of 4 requests carry envelopes
    assert.equal(payload.coverage.envelopeRows, 3);
    assert.equal(payload.coverage.requestRows, 4);
    assert.equal(payload.coverage.coverage, 0.75);
    assert.match(payload.coverageNote, /75% coverage/);
    assert.match(payload.coverageNote, /3 of 4 requests have envelope data/);
    assert.match(payload.coverageNote, /local-capture only/);

    // one-shot/retry: edit a.ts, shell, a.ts again — the exact retry rule
    assert.equal(payload.oneShotRetry.overall.oneShots, 1);
    assert.equal(payload.oneShotRetry.overall.retries, 1);
    assert.equal(payload.oneShotRetry.overall.oneShotRate, 0.5);
    assert.deepEqual(
      payload.oneShotRetry.byHarness.map((s) => s.key),
      ["opencode"],
    );
    assert.equal(payload.oneShotRetry.byHarness[0].stats.retries, 1);

    // task mix: Coding (edit) + Exploration (shell) + Coding (edit)
    assert.equal(payload.taskMix.primary, "Coding");
    assert.equal(payload.taskMix.counts.Coding, 2);
    assert.equal(payload.taskMix.counts.Exploration, 1);

    // attribution: r1 predates the first envelope (pre-recording); r2-r4
    // carry the named branch — the split is visible, not collapsed
    assert.equal(payload.attribution.coverage.namedBranch, 3);
    assert.equal(payload.attribution.coverage.preRecording, 1);
    assert.equal(payload.attribution.coverage.total, 4);
    assert.equal(payload.attribution.byBranch.length, 1);
    assert.equal(payload.attribution.byBranch[0].key, "feat/envelope");
    assert.equal(payload.attribution.byBranch[0].requests, 3);
    assert.ok(Math.abs(payload.attribution.byBranch[0].costUsd - 0.9) < 1e-9);
    assert.ok(payload.notes.classification.includes("local-capture only"));
    assert.ok(payload.notes.attribution.includes("local-capture only"));
  });

  test("human output renders all sections with the coverage note", async () => {
    const dir = join(box.dir, "human");
    seedStore(dir);
    const { code, stdout } = await runCli(["efficiency", "--last", "30d"], {
      env: cliEnvFor(dir),
    });
    assert.equal(code, 0);
    assert.match(stdout, /One-shot \/ retry/);
    assert.match(stdout, /50% one-shot/);
    assert.match(stdout, /retry = same file re-edited after a shell command in between/);
    assert.match(stdout, /Task mix/);
    assert.match(stdout, /primary: Coding/);
    assert.match(stdout, /Spend by branch/);
    assert.match(stdout, /feat\/envelope/);
    assert.match(stdout, /Attribution coverage/);
    assert.match(stdout, /named-branch 3 {2}pre-recording 1 {2}no-branch 0/);
    assert.match(stdout, /local-capture only, 75% coverage/);
  });

  test("empty store: zeroes with honest coverage, no crash", async () => {
    const dir = join(box.dir, "empty");
    const { code, stdout } = await runCli(["efficiency"], { env: cliEnvFor(dir) });
    assert.equal(code, 0);
    assert.match(stdout, /0 of 0 requests have envelope data|n\/a/);
    assert.match(stdout, /no branch-attributed cost/);
  });

  test("--since/--until without a pair is a user error", async () => {
    const dir = join(box.dir, "flagpair");
    const { code, stderr } = await runCli(["efficiency", "--since", "2026-10-01"], {
      env: cliEnvFor(dir),
    });
    assert.equal(code, 1);
    assert.match(stderr, /--since and --until must be passed together/);
  });

  test("help is reachable", async () => {
    const { code, stdout } = await runCli(["efficiency", "--help"], { env: cliEnvFor(box.dir) });
    assert.equal(code, 0);
    assert.match(stdout, /aiand efficiency/);
  });

  test("a stray positional is a usage error", async () => {
    const { code, stderr } = await runCli(["efficiency", "nope"], { env: cliEnvFor(box.dir) });
    assert.equal(code, 1);
    assert.match(stderr, /Unknown argument "nope"/);
  });
});

// #91: the --last window path and the fail-open sync warning arm.
test("efficiency --last window and failed-sync warning", async () => {
  const dir = join(box.dir, "last-sync");
  seedStore(dir);
  // --last resolves a window without a --since/--until pair.
  const last = await runCli(["efficiency", "--last", "30d", "--json"], { env: cliEnvFor(dir) });
  assert.equal(last.code, 0, last.stdout);
  const payload = JSON.parse(last.stdout);
  assert.ok(payload.coverage.requestRows >= 4, "rows inside the 30d window counted");

  // Env key against a dead gateway: sync fails open, the warning names the
  // code, and the report still renders.
  const warned = await runCli(["efficiency", "--json"], {
    env: {
      ...cliEnvFor(dir),
      AIAND_NO_SYNC: "",
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: "http://127.0.0.1:9",
    },
  });
  assert.equal(warned.code, 0, warned.stderr);
  assert.match(warned.stderr, /store sync failed/);
});

// #146: imported markers as a second behavioral source in `efficiency`.
// ---------------------------------------------------------------------------

/** Seed imported markers for a harness with no envelopes (import-only). */
function seedImported(db, rows) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO imported_artifacts " +
      "(dedup_key, harness, session_id, kind, tool_name, outcome, seq, at, imported_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) {
    insert.run(
      r.dedup_key,
      r.harness,
      r.session_id,
      r.kind,
      r.tool_name ?? null,
      r.outcome ?? null,
      r.seq ?? null,
      r.at ?? null,
      r.imported_at ?? "2026-10-25T00:00:00.000Z",
    );
  }
}

describe("aiand efficiency — imported markers (#146)", () => {
  test("import-only harness appears by-harness with tool errors; overall combines without double counting", async () => {
    const dir = join(box.dir, "imported");
    seedStore(dir); // opencode envelopes (3 turns — below the envelope gate)
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const opened = openStore(storePath());
      assert.ok(opened.ok);
      // codex: import-only harness — 4 tool calls, 1 error, 2 clean terminals.
      seedImported(opened.db, [
        {
          dedup_key: "x1",
          harness: "codex",
          session_id: "s1",
          kind: "tool",
          outcome: "ok",
          seq: 0,
          at: "2026-10-25T09:00:00.000Z",
        },
        {
          dedup_key: "x2",
          harness: "codex",
          session_id: "s1",
          kind: "tool",
          outcome: "error",
          seq: 1,
          at: "2026-10-25T09:01:00.000Z",
        },
        {
          dedup_key: "x3",
          harness: "codex",
          session_id: "s1",
          kind: "tool",
          outcome: "ok",
          seq: 2,
          at: "2026-10-25T09:02:00.000Z",
        },
        {
          dedup_key: "x4",
          harness: "codex",
          session_id: "s1",
          kind: "tool",
          outcome: "ok",
          seq: 3,
          at: "2026-10-25T09:03:00.000Z",
        },
        {
          dedup_key: "x5",
          harness: "codex",
          session_id: "s1",
          kind: "terminal",
          outcome: "clean",
          at: "2026-10-25T09:04:00.000Z",
        },
        {
          dedup_key: "x6",
          harness: "codex",
          session_id: "s2",
          kind: "terminal",
          outcome: "clean",
          at: "2026-10-25T09:10:00.000Z",
        },
        { dedup_key: "x7", harness: "codex", session_id: "s2", kind: "compaction", at: null },
      ]);
      opened.db.close();
    });
    const { code, stdout } = await runCli(
      ["efficiency", "--since", "2026-10-01", "--until", "2026-11-30", "--json"],
      {
        env: cliEnvFor(dir),
      },
    );
    assert.equal(code, 0, stdout);
    const payload = JSON.parse(stdout);

    // By-harness: codex (imported) joins opencode (envelope), sorted by key.
    assert.deepEqual(
      payload.oneShotRetry.byHarness.map((s) => s.key),
      ["codex", "opencode"],
    );
    const codex = payload.oneShotRetry.byHarness[0].stats;
    assert.equal(codex.oneShotRate, null, "import-only one-shot stays null");
    assert.ok(Math.abs(codex.toolErrorRate - 0.25) < 1e-9);
    assert.deepEqual(codex.sessions, { clean: 2, aborted: 0, errored: 0 });

    // Overall: envelope behavioral (v1 envelopes → null toolErrorRate, no
    // terminals) falls through to imported: 1/4 errors, 2 clean terminals.
    assert.ok(Math.abs(payload.behavioral.toolErrorRate - 0.25) < 1e-9);
    assert.equal(payload.behavioral.sessions.clean, 2);
    // Overall one-shot stays envelope-only (1/2 from the v1 walk).
    assert.equal(payload.behavioral.oneShotRate, 0.5);

    // Coverage: split reported, never summed.
    assert.deepEqual(payload.importedCoverage, { sessions: 2, harnesses: 1 });

    // By-model is unchanged: envelope-only, no codex row.
    assert.deepEqual(
      payload.oneShotRetry.byModel.map((s) => s.key),
      ["zai-org/glm-5.3"],
    );
  });

  test("envelope slice with >= 5 turns wins over imported for the same harness", async () => {
    const dir = join(box.dir, "imported-both");
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const opened = openStore(storePath());
      assert.ok(opened.ok);
      const insert = opened.db.prepare(
        "INSERT INTO requests (id, model, api_key, status_code, input_tokens, output_tokens, " +
          "cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (let i = 0; i < 5; i += 1) {
        insert.run(
          `rb${i}`,
          "zai-org/glm-5.3",
          "sk-abcd…1234",
          200,
          100,
          50,
          0,
          "0.1",
          0.1,
          "USD",
          `2026-10-25T10:0${i}:00.000Z`,
          `2026-10-25T10:0${i}:00.000Z`,
        );
        insertEnvelope(opened.db, {
          id: `eb${i}`,
          agent: "claude",
          model: "zai-org/glm-5.3",
          apiKey: "sk-abcd…1234",
          createdAt: `2026-10-25T10:0${i}:30.000Z`,
          envelope: normalizeEnvelope({
            tools: ["Bash", "Edit"],
            editTargets: ["/repo/src/a.ts"],
            toolOutcomes: [
              { name: "Bash", ok: true },
              { name: "Edit", ok: false },
            ],
            terminal: "clean",
            projectRoot: "/repo",
          }),
        });
      }
      // Same harness imported: must NOT change claude's slice.
      seedImported(opened.db, [
        {
          dedup_key: "ib1",
          harness: "claude",
          session_id: "z",
          kind: "tool",
          outcome: "error",
          seq: 0,
          at: "2026-10-25T11:00:00.000Z",
        },
      ]);
      opened.db.close();
    });
    const { code, stdout } = await runCli(
      ["efficiency", "--since", "2026-10-01", "--until", "2026-11-30", "--json"],
      {
        env: cliEnvFor(dir),
      },
    );
    assert.equal(code, 0, stdout);
    const payload = JSON.parse(stdout);
    const claude = payload.oneShotRetry.byHarness.find((s) => s.key === "claude");
    // Envelope slice: 5 turns, each with 2 tool outcomes (1 error each).
    assert.equal(claude.envelopes, 5);
    assert.ok(Math.abs(claude.stats.toolErrorRate - 0.5) < 1e-9, "envelope rate, not imported");
    assert.deepEqual(claude.stats.sessions, { clean: 5, aborted: 0, errored: 0 });
    // Overall: envelope covers → its rates stand (0.5 tool errors), imported
    // error adds nothing.
    assert.ok(Math.abs(payload.behavioral.toolErrorRate - 0.5) < 1e-9);
  });

  test("human output carries the imported-markers line and the backfill instruction", async () => {
    const dir = join(box.dir, "imported-human");
    seedStore(dir);
    await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
      const opened = openStore(storePath());
      assert.ok(opened.ok);
      seedImported(opened.db, [
        {
          dedup_key: "h1",
          harness: "codex",
          session_id: "s1",
          kind: "tool",
          outcome: "error",
          seq: 0,
          at: "2026-10-25T09:00:00.000Z",
        },
      ]);
      opened.db.close();
    });
    const { code, stdout } = await runCli(
      ["efficiency", "--since", "2026-10-01", "--until", "2026-11-30"],
      {
        env: cliEnvFor(dir),
      },
    );
    assert.equal(code, 0, stdout);
    assert.match(stdout, /imported markers: 1 session\(s\) across 1 harness\(es\)/);
    assert.match(stdout, /tool errors 100% \(imported markers\)/);
  });

  test("no imported markers: the human line instructs the backfill", async () => {
    const dir = join(box.dir, "imported-empty");
    seedStore(dir);
    const { code, stdout } = await runCli(
      ["efficiency", "--since", "2026-10-01", "--until", "2026-11-30"],
      {
        env: cliEnvFor(dir),
      },
    );
    assert.equal(code, 0, stdout);
    assert.match(
      stdout,
      /imported markers: none in this window — backfill with `aiand harness import`/,
    );
  });
});
