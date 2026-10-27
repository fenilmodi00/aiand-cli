import assert from "node:assert/strict";
import { join } from "node:path";
import test, { describe } from "node:test";
import { FAKE_API_KEY, runCli, withTestEnv } from "./helpers.mjs";

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
    const { code, stdout } = await runCli(["efficiency", "--json"], { env: cliEnvFor(dir) });
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
    const { code, stdout } = await runCli(["efficiency"], { env: cliEnvFor(dir) });
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
  assert.equal(warned.code, 0, warned.stdout);
  assert.match(warned.stderr, /store sync failed/);
});
