import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { cliEnv, runCli, withTestEnv } from "./helpers.mjs";

/**
 * Observability-lane branch coverage (#cov-obs): behavioral edge paths in
 * obs/harness-stats, obs/pair-stats, commands/efficiency, store/envelopes,
 * and store/artifact-import that the module suites leave uncovered — empty
 * windows, degenerate single-harness paths, null-sinking sorts, fail-open
 * readers, and v1/v2 envelope boundaries. Behavior assertions only: every
 * test pins observable output of the built dist modules.
 */

const box = withTestEnv("aiand-obs-coverage-", () => {});

const effBox = {
  dir: mkdtempSync(join(tmpdir(), "aiand-obs-coverage-eff-")),
  cleanup: () => {
    try {
      rmSync(effBox.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // win32 sqlite handle; OS temp cleaner wins
    }
  },
};
after(() => effBox.cleanup());

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

const cfgDir = (name) => join(box.dir, name);

const { buildHarnessStats, compareWinners, MIN_BEHAVIORAL_TURNS } = await import(
  "../dist/obs/harness-stats.js"
);
const { buildPairStats, sortPairs } = await import("../dist/obs/pair-stats.js");
const { insertEnvelope, listEnvelopesFromDb, countEnvelopesInDb } = await import(
  "../dist/store/envelopes.js"
);
const { openStore } = await import("../dist/store/index.js");
const { normalizeEnvelope } = await import("../dist/agents/envelope.js");
const { importArtifacts, sessionStats } = await import("../dist/store/artifact-import.js");
// artifact-import caches per-module file counts (claudeFileCount etc.); a
// cache-busted import gives the missing-dir tests a fresh module state.
// ponytail: file-count caches (claudeFileCount/codexFileCount) are module-scope; tests avoid asserting filesRead instead of cache-busting imports.

// -- shared fixtures ------------------------------------------------------------

const baseTime = Date.parse("2026-10-20T10:00:00.000Z");
const iso = (offsetMs) => new Date(baseTime + offsetMs).toISOString();

function row(overrides) {
  return {
    id: "r1",
    session_id: "s1",
    model: "zai-org/glm-5.3",
    api_key: "sk-test-claude...aaaa",
    created_at: iso(0),
    endpoint: "/v1/messages",
    input_tokens: 1000,
    output_tokens: 100,
    cached_tokens: 500,
    cost_value: 0.01,
    cost: "0.01",
    currency: "usd",
    status_code: 200,
    ttft_ms: 300,
    ...overrides,
  };
}

/** N envelope turns for one agent/model; toolOutcomes ok=false on turn 0. */
function envelopeTurns(agent, model, n, { outcomes = true } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    agent,
    model,
    envelope: {
      tools: ["Edit"],
      edit_targets: ["a.ts#deadbeefdeadbeef"],
      ...(outcomes && i === 0 ? { toolOutcomes: [{ name: "Bash", ok: false }] } : {}),
      terminal: "clean",
    },
  }));
}

// -- harness-stats ---------------------------------------------------------------

describe("harness-stats degenerate windows (#cov-obs)", () => {
  test("empty window: no harnesses, null coverage ratio, null excluded spend", () => {
    const stats = buildHarnessStats([]);
    assert.deepEqual(stats.harnesses, []);
    assert.deepEqual(stats.excluded, []);
    assert.equal(stats.behavioralCoverage.covered, 0);
    assert.equal(stats.behavioralCoverage.total, 0);
    assert.equal(stats.behavioralCoverage.ratio, null);
    assert.equal(stats.excludedMixed.sessions, 0);
    assert.equal(stats.excludedMixed.cost, null);
    assert.equal(stats.excludedMixed.currency, null);
  });

  test("below MIN_BEHAVIORAL_TURNS turns: the behavioral cell stays uncovered", () => {
    const turns = envelopeTurns("unknown", "zai-org/glm-5.3", MIN_BEHAVIORAL_TURNS - 1);
    const stats = buildHarnessStats([row({})], { envelopes: turns });
    const behavioral = stats.harnesses[0].behavioral;
    assert.equal(behavioral.oneShotRate, null);
    assert.equal(behavioral.toolErrorRate, null);
    assert.equal(behavioral.envelopeTurns, 0);
    // Coverage counts the honest zero, not the null cell.
    assert.deepEqual(stats.behavioralCoverage, { covered: 0, total: 1, ratio: 0 });
  });

  test("at the threshold: the cell walks the T2 rule and retries complement one-shots", () => {
    const turns = envelopeTurns("unknown", "zai-org/glm-5.3", MIN_BEHAVIORAL_TURNS);
    const stats = buildHarnessStats([row({})], { envelopes: turns });
    const behavioral = stats.harnesses[0].behavioral;
    assert.equal(behavioral.envelopeTurns, MIN_BEHAVIORAL_TURNS);
    // 1 of 5 turns carried a failed tool outcome (the same-turn turn's outcome).
    assert.equal(behavioral.toolErrorRate, 1);
    assert.equal(behavioral.missedCatchRate, 0);
    assert.equal(behavioral.oneShotRate, 1);
    assert.equal(behavioral.retryRate, 0);
    assert.equal(behavioral.turnsToSuccess, 1);
    assert.deepEqual(behavioral.sessions, { clean: 5, aborted: 0, errored: 0 });
    // Coverage counts the covered harness's turns over total requests.
    assert.equal(stats.behavioralCoverage.covered, MIN_BEHAVIORAL_TURNS);
    assert.equal(stats.behavioralCoverage.ratio, MIN_BEHAVIORAL_TURNS);
  });

  test("mixed-model sessions are excluded AND their spend is reconciled", () => {
    const rows = [
      row({ id: "1", model: "a" }),
      row({ id: "2", model: "b", cost_value: null, created_at: iso(60_000) }),
      row({ id: "3", model: "b", ttft_ms: null, created_at: iso(120_000) }),
    ];
    const stats = buildHarnessStats(rows);
    assert.equal(stats.excluded.length, 1);
    assert.equal(stats.provenance.excludedMixed, 1);
    assert.deepEqual(stats.excluded[0].models.sort(), ["a", "b"]);
    assert.equal(stats.excludedMixed.requests, 3);
    // Only priced rows sum; token sums include cached in input.
    assert.equal(stats.excludedMixed.cost, 0.02);
    assert.equal(stats.excludedMixed.currency, "usd");
    assert.deepEqual(stats.harnesses, []);
  });

  test("single-session degenerate path: no ttft, no cache, all-error row", () => {
    const stats = buildHarnessStats([row({ cached_tokens: 0, status_code: 500, ttft_ms: null })]);
    const harness = stats.harnesses[0];
    assert.equal(harness.requests, 1);
    assert.equal(harness.cacheHitRatio, 0);
    assert.equal(harness.errorRate, 1);
    assert.equal(harness.ttft.p50, null);
    assert.equal(harness.verdict, "warn");
    assert.equal(harness.sessions, 1);
    assert.ok(stats.provenance.labels.cost.length > 0);
  });
});

describe("compareWinners boundaries (#cov-obs)", () => {
  const covered = (harness, overrides = {}) => ({
    harness,
    costPerSession: { p50: 0.5 },
    errorRate: 0.1,
    cacheHitRatio: 0.4,
    ttft: { p50: 100 },
    behavioral: { toolErrorRate: 0.2, oneShotRate: 0.3, missedCatchRate: 0.1, turnsToSuccess: 2 },
    ...overrides,
  });

  test("no rows: every winner is null", () => {
    const winners = compareWinners([]);
    for (const value of Object.values(winners)) assert.equal(value, null);
  });

  test("null values cannot win; ties keep the first harness deterministically", () => {
    const a = covered("a", { costPerSession: { p50: null }, ttft: { p50: null } });
    const b = covered("b");
    const winners = compareWinners([a, b]);
    assert.equal(winners.costPerSessionP50, "b");
    assert.equal(winners.ttftP50, "b");
    assert.equal(winners.errorRate, "a");
    assert.equal(winners.cacheHitRatio, "a");
    assert.equal(winners.toolErrorRate, "a");
    assert.equal(winners.oneShotRate, "a");
    assert.equal(winners.missedCatchRate, "a");
    assert.equal(winners.turnsToSuccess, "a");
  });

  test("a null behavioral cell (undefined) never competes against a covered one", () => {
    const uncovered = covered("u", { behavioral: undefined });
    const winners = compareWinners([uncovered, covered("c")]);
    assert.equal(winners.toolErrorRate, "c");
    assert.equal(winners.oneShotRate, "c");
  });
});

// -- pair-stats ------------------------------------------------------------------

describe("pair-stats coverage gating and sort order (#cov-obs)", () => {
  test("behavioral rides the pair's (agent, model) cell; uncovered cells are undefined", () => {
    const turns = [
      ...envelopeTurns("unknown", "m1", MIN_BEHAVIORAL_TURNS),
      ...envelopeTurns("unknown", "m2", MIN_BEHAVIORAL_TURNS - 1),
    ];
    const pair = buildPairStats([row({ model: "m1" })], { envelopes: turns });
    const m1 = pair.pairs.find((p) => p.model === "m1");
    assert.ok(m1.behavioral, "covered cell has behavioral columns");
    assert.equal(m1.behavioral.envelopeTurns, MIN_BEHAVIORAL_TURNS);
    assert.equal(m1.behavioral.toolErrorRate, 1);
    assert.equal(m1.behavioral.oneShotRate, 1);
    assert.equal(m1.behavioral.retryRate, 0);

    // A second pair under the threshold gets no behavioral key at all.
    const pair2 = buildPairStats([row({ model: "m2" })], { envelopes: turns });
    const m2 = pair2.pairs.find((p) => p.model === "m2");
    assert.equal(m2.behavioral, undefined);
  });

  test("mixed-model sessions split per model into separate pair rows", () => {
    const pair = buildPairStats([
      row({ id: "1", model: "a" }),
      row({ id: "2", model: "b", created_at: iso(60_000) }),
    ]);
    assert.deepEqual(pair.pairs.map((p) => `${p.harness}:${p.model}`).sort(), [
      "unknown:a",
      "unknown:b",
    ]);
    for (const p of pair.pairs) {
      assert.equal(p.sessions, 1);
      assert.equal(p.costTotal, 0.01);
      assert.deepEqual(
        p.samples[0].models,
        [p.model === "unknown:a" ? "a" : "b"].map(() => p.model.slice(-1)),
      );
    }
  });

  test("sortPairs sinks null behavioral values regardless of direction", () => {
    const mk = (harness, behavioral) => ({
      harness,
      model: "m",
      costPerSession: { p50: 0.5 },
      errorRate: 0.1,
      cacheHitRatio: 0.4,
      ttft: { p50: 100 },
      sessions: 1,
      behavioral,
    });
    const nulled = mk("a", { toolErrorRate: null, oneShotRate: null });
    const hi = mk("b", { toolErrorRate: 0.2, oneShotRate: 0.3 });
    const lo = mk("c", { toolErrorRate: 0.2, oneShotRate: 0.3 });
    // tool-err: lower is better; both non-null rows tie, null sinks.
    assert.deepEqual(
      sortPairs([nulled, hi, lo], "tool-err").map((r) => r.harness),
      ["b", "c", "a"],
    );
    // one-shot: higher is better; null still sinks.
    assert.deepEqual(
      sortPairs([nulled, hi, lo], "one-shot").map((r) => r.harness),
      ["b", "c", "a"],
    );
    // explicit asc keeps the null at the bottom too.
    assert.deepEqual(
      sortPairs([nulled, hi, lo], "one-shot", "asc").map((r) => r.harness),
      ["b", "c", "a"],
    );
  });

  test("sortPairs orders non-behavioral keys by their natural better-first", () => {
    const mk = (harness, costP50, ttftP50, hit) => ({
      harness,
      model: "m",
      costPerSession: { p50: costP50 },
      errorRate: 0.1,
      cacheHitRatio: hit,
      ttft: { p50: ttftP50 },
      sessions: 1,
    });
    const a = mk("a", 0.5, 100, 0.4);
    const b = mk("b", 0.1, 200, 0.9);
    assert.deepEqual(
      sortPairs([a, b], "cost").map((r) => r.harness),
      ["b", "a"],
    );
    assert.deepEqual(
      sortPairs([a, b], "cost", "desc").map((r) => r.harness),
      ["a", "b"],
    );
    assert.deepEqual(
      sortPairs([a, b], "ttft").map((r) => r.harness),
      ["a", "b"],
    );
    assert.deepEqual(
      sortPairs([a, b], "hit").map((r) => r.harness),
      ["b", "a"],
    );
  });

  test("sortPairs: errors key, all-null ties break by model/sessions, labels self-describe", async () => {
    const { pairStatsLabels } = await import("../dist/obs/pair-stats.js");
    const mk = (harness, model, sessions, errorRate) => ({
      harness,
      model,
      costPerSession: { p50: 0.5 },
      errorRate,
      cacheHitRatio: 0.4,
      ttft: { p50: 100 },
      sessions,
    });
    const a = mk("a", "m1", 2, 0.1);
    const b = mk("b", "m2", 1, 0.2);
    assert.deepEqual(
      sortPairs([a, b], "errors").map((r) => r.harness),
      ["a", "b"],
    );
    // Both rows null for the key → deterministic tie by harness, model, sessions.
    const n1 = mk("x", "m2", 2, undefined);
    const n2 = mk("x", "m1", 1, undefined);
    n1.errorRate = null;
    n2.errorRate = null;
    assert.deepEqual(
      sortPairs([n1, n2], "one-shot").map((r) => r.model),
      ["m1", "m2"],
    );
    const labels = pairStatsLabels();
    assert.equal(labels["pair-stats.cost"].kind, "gateway-billed");
    assert.equal(labels["pair-stats.behavioral"].kind, "heuristic");
  });
});

// -- envelopes store ---------------------------------------------------------------

describe("envelopes store edge rows (#cov-obs)", () => {
  function freshDb(name) {
    const dir = cfgDir(name);
    mkdirSync(dir, { recursive: true });
    return openStore(join(dir, "store.db")).db;
  }

  test("insert with every optional field absent reads back nulls and v1 defaults", () => {
    const db = freshDb("env-min");
    const v1 = {
      schema_version: "aiand-envelope/v1",
      tools: ["Edit"],
      edit_targets: [],
      project_root_id: null,
      git_branch: null,
    };
    const id = insertEnvelope(db, { envelope: v1, agent: "claude" });
    assert.ok(id.length > 0);
    const rows = listEnvelopesFromDb(db);
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.model, null);
    assert.equal(r.api_key, null);
    assert.equal(r.session_id, null);
    assert.equal(r.request_id, null);
    // v2 outcome fields absent on v1 → absent (unknown), never zero-valued.
    assert.equal(r.envelope.toolOutcomes, undefined);
    assert.equal(r.envelope.terminal, undefined);
  });

  test("malformed stored columns fail open: tools fall back to [], outcomes dropped", () => {
    const db = freshDb("env-malformed");
    const v1 = {
      schema_version: "aiand-envelope/v1",
      tools: [],
      edit_targets: [],
      project_root_id: null,
      git_branch: null,
    };
    insertEnvelope(db, { envelope: v1, agent: "codex", createdAt: iso(0) });
    // Raw rows a future/foreign writer could produce: broken JSON, junk outcomes.
    const raw =
      "INSERT INTO envelopes (id, schema_version, agent, model, api_key, session_id, " +
      "request_id, created_at, tools, edit_targets, project_root_id, git_branch, " +
      "captured_at, tool_outcomes, terminal) VALUES (?, 'aiand-envelope/v1', 'claude', " +
      "NULL, NULL, NULL, NULL, ?, ?, '[]', NULL, NULL, ?, ?, NULL)";
    db.prepare(raw).run("bad-tools", iso(60_000), "not json", iso(60_000));
    // tool_outcomes that is not even parseable JSON → the parse catch, not the shape filter.
    db.prepare(raw).run("broken-outcomes", iso(90_000), "[]", iso(90_000), "{broken");
    // terminal column set to a non-string: the terminal branch still runs,
    // but parseEnvelope normalizes it to null ("unknown"), never a guessed state.
    db.prepare(raw).run("terminal-junk", iso(150_000), "[]", "null");
    db.prepare(
      "UPDATE envelopes SET tool_outcomes = NULL, terminal = '123' WHERE id = 'terminal-junk'",
    ).run();
    const rows = listEnvelopesFromDb(db);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[1].envelope.tools, []);
    assert.equal(rows[2].envelope.toolOutcomes, undefined);
    assert.equal(rows[3].envelope.terminal, null);
    assert.equal(countEnvelopesInDb(db), 4);
  });

  test("readers swallow an already-closed handle in their finally blocks", async () => {
    const throwing = {
      prepare() {
        return { all: () => [], get: () => ({ n: 0 }) };
      },
      close() {
        throw new Error("already closed");
      },
    };
    assert.deepEqual(listEnvelopesFromDb(throwing), []);
    assert.equal(countEnvelopesInDb(throwing), 0);
  });

  test("listEnvelopes/countEnvelopes read the default store and count rows", () => {
    return withEnv({ AIAND_CONFIG_DIR: cfgDir("env-list") }, async () => {
      mkdirSync(cfgDir("env-list"), { recursive: true });
      const db = openStore(join(cfgDir("env-list"), "store.db")).db;
      const v1 = {
        schema_version: "aiand-envelope/v1",
        tools: ["Bash"],
        edit_targets: [],
        project_root_id: null,
        git_branch: null,
      };
      insertEnvelope(db, { envelope: v1, agent: "claude", createdAt: iso(0) });
      db.close();
      const { listEnvelopes, countEnvelopes } = await import("../dist/store/envelopes.js");
      assert.equal(listEnvelopes().length, 1);
      assert.equal(countEnvelopes(), 1);
      assert.equal(listEnvelopes({ since: iso(60_000) }).length, 0);
      assert.equal(listEnvelopes({ until: iso(-60_000) }).length, 0);
    });
  });

  test("v2 round-trip caps tool outcomes at 32 and preserves the terminal state", () => {
    const db = freshDb("env-cap");
    const outcomes = Array.from({ length: 40 }, (_, i) => ({ name: `T${i}`, ok: true }));
    const env = normalizeEnvelope({
      tools: ["Edit"],
      edit_targets: ["a.ts#deadbeefdeadbeef"],
      toolOutcomes: outcomes,
      terminal: "clean",
      project_root_id: null,
      git_branch: null,
    });
    insertEnvelope(db, { envelope: env, agent: "claude" });
    const r = listEnvelopesFromDb(db)[0];
    assert.equal(r.envelope.toolOutcomes.length, 32);
    assert.equal(r.envelope.toolOutcomes[31].name, "T31");
    assert.equal(r.envelope.terminal, "clean");
    assert.equal(r.schema_version, "aiand-envelope/v1");
  });
});

// -- artifact-import ---------------------------------------------------------------

describe("artifact-import reader edges (#cov-obs)", () => {
  test("malformed JSONL line is skipped; unknown stop_reason contributes nothing", () => {
    const root = join(box.dir, "edge-home", ".claude", "projects", "p");
    mkdirSync(root, { recursive: true });
    const lines = [
      "{broken json",
      JSON.stringify({
        type: "assistant",
        sessionId: "edge-ses-1",
        timestamp: "2026-10-29T10:00:00.000Z",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      }),
      JSON.stringify({
        type: "user",
        sessionId: "edge-ses-1",
        timestamp: "2026-10-29T10:00:01.000Z",
        message: { content: [{ type: "tool_result", is_error: true }] },
      }),
      // Unknown stop_reason → no terminal marker (markers only, never guessed).
      JSON.stringify({
        type: "assistant",
        sessionId: "edge-ses-1",
        message: { stop_reason: "weird_reason" },
      }),
      // Known stop_reason max_tokens → aborted.
      JSON.stringify({
        type: "assistant",
        sessionId: "edge-ses-1",
        message: { stop_reason: "max_tokens" },
      }),
    ];
    writeFileSync(join(root, "edge-ses-1.jsonl"), `${lines.join("\n")}\n`);
    // Empty file: parsed as one empty line, contributes nothing.
    writeFileSync(join(root, "empty.jsonl"), "");
    return withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("edge"),
        AIAND_CLAUDE_DIR: join(box.dir, "edge-home", ".claude", "projects"),
        AIAND_CODEX_DIR: undefined,
        AIAND_OPENCODE_DB: "",
      },
      async () => {
        const db = openStore(join(cfgDir("edge"), "store.db")).db;
        const result = await importArtifacts(db, ["claude"]);
        // 1 tool marker + 1 aborted terminal; the broken line, the unknown
        // stop_reason, and the trailing empty line contribute nothing.
        assert.equal(result.markersRead, 2);
        assert.equal(result.inserted, 2);
        const outcomes = db
          .prepare("SELECT outcome FROM imported_artifacts ORDER BY kind, seq")
          .all()
          .map((r) => r.outcome);
        assert.deepEqual(outcomes, ["aborted", "error"]);
        const stats = sessionStats(
          db
            .prepare("SELECT * FROM imported_artifacts")
            .all()
            .map((r) => ({
              harness: r.harness,
              session_id: r.session_id,
              kind: r.kind,
              tool_name: r.tool_name,
              outcome: r.outcome,
            })),
        );
        assert.equal(stats[0].terminal, "aborted");
        assert.equal(stats[0].toolErrors, 1);
      },
    );
  });

  test("unreadable artifacts fail open: file-as-dir, jsonl-as-dir, broken rows", () => {
    const claudeRoot = join(box.dir, "edge2-home", ".claude", "projects");
    // A project entry whose .jsonl "file" is itself a directory: readFileSync fails.
    mkdirSync(join(claudeRoot, "p", "dir.jsonl"), { recursive: true });
    // Codex: a nested .jsonl directory entry too.
    const codexRoot = join(box.dir, "edge2-home", ".codex", "sessions");
    mkdirSync(join(codexRoot, "2026", "dir.jsonl"), { recursive: true });
    return withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("edge2"),
        AIAND_CLAUDE_DIR: claudeRoot,
        AIAND_CODEX_DIR: codexRoot,
        AIAND_OPENCODE_DB: "",
      },
      async () => {
        const db = openStore(join(cfgDir("edge2"), "store.db")).db;
        const result = await importArtifacts(db, ["claude", "codex"]);
        assert.equal(result.markersRead, 0);
        assert.equal(result.inserted, 0);
        assert.deepEqual(result.sessions, {});
      },
    );
  });

  test("a root that is a file: safeReaddir's catch contributes nothing", () => {
    const fileAsDir = join(box.dir, "claude-file-as-dir");
    writeFileSync(fileAsDir, "not a directory");
    return withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("edge2b"),
        AIAND_CLAUDE_DIR: fileAsDir,
        AIAND_CODEX_DIR: fileAsDir,
        AIAND_OPENCODE_DB: "",
      },
      async () => {
        const db = openStore(join(cfgDir("edge2b"), "store.db")).db;
        const result = await importArtifacts(db, ["claude", "codex"], "2026-01-02T00:00:00.000Z");
        assert.equal(result.markersRead, 0);
        assert.equal(result.inserted, 0);
      },
    );
  });

  test("opencode: broken message rows fail open; absent env falls back to the default path", () => {
    const dbPath = join(box.dir, "edge3-home", "opencode.db");
    return withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("edge3"),
        AIAND_CLAUDE_DIR: join(box.dir, "edge3-noclaude"),
        AIAND_CODEX_DIR: join(box.dir, "edge3-nocodex"),
        AIAND_OPENCODE_DB: dbPath,
      },
      async () => {
        mkdirSync(join(dbPath, ".."), { recursive: true });
        const { DatabaseSync } = await import("node:sqlite");
        const ocd = new DatabaseSync(dbPath);
        ocd.exec("CREATE TABLE message (id TEXT PRIMARY KEY, time_created TEXT, data TEXT);");
        const ins = ocd.prepare("INSERT INTO message (id, time_created, data) VALUES (?, ?, ?)");
        ins.run("ses-bad", "2026-10-29T12:00:00.000Z", "{broken json");
        ins.run("ses-noparts", "2026-10-29T12:01:00.000Z", JSON.stringify({ nope: 1 }));
        ocd.close();
        const db = openStore(join(cfgDir("edge3"), "store.db")).db;
        const result = await importArtifacts(db, ["opencode"]);
        // The broken JSON row is skipped; the parts-less row contributes nothing.
        assert.equal(result.markersRead, 0);
        assert.equal(result.inserted, 0);
        assert.deepEqual(result.sessions, {});
        // With AIAND_OPENCODE_DB unset, the default AppData fallback is probed.
        delete process.env.AIAND_OPENCODE_DB;
        const result2 = await importArtifacts(db, ["opencode"]);
        assert.equal(result2.markersRead, 0);
      },
    );
  });

  test("absent harness directories fail open across all three readers", () => {
    return withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("missing-dirs"),
        AIAND_CLAUDE_DIR: join(box.dir, "nope-claude"),
        AIAND_CODEX_DIR: join(box.dir, "nope-codex"),
        AIAND_OPENCODE_DB: "",
      },
      async () => {
        const db = openStore(join(cfgDir("missing-dirs"), "store.db")).db;
        const result = await importArtifacts(db, ["claude", "codex", "opencode"]);
        // claudeFileCount/codexFileCount are cached at module scope, so only
        // assert the fail-open marker behavior, not the cached file count.
        assert.equal(result.markersRead, 0);
        assert.equal(result.inserted, 0);
        assert.deepEqual(result.sessions, {});
      },
    );
  });

  test("dedup: re-import after file changes only adds genuinely new markers", () => {
    const root = join(box.dir, "dedup-home", ".claude", "projects", "p");
    mkdirSync(root, { recursive: true });
    const file = join(root, "dedup-ses-1.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({
        type: "assistant",
        sessionId: "dedup-ses-1",
        timestamp: "2026-10-29T10:00:00.000Z",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      })}\n${JSON.stringify({
        type: "user",
        sessionId: "dedup-ses-1",
        timestamp: "2026-10-29T10:00:01.000Z",
        message: { content: [{ type: "tool_result", is_error: false }] },
      })}\n`,
    );
    return withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("dedup"),
        AIAND_CLAUDE_DIR: join(box.dir, "dedup-home", ".claude", "projects"),
        AIAND_CODEX_DIR: undefined,
        AIAND_OPENCODE_DB: "",
      },
      async () => {
        const db = openStore(join(cfgDir("dedup"), "store.db")).db;
        const first = await importArtifacts(db, ["claude"], "2026-01-01T00:00:00.000Z");
        assert.equal(first.inserted, 1);
        const second = await importArtifacts(db, ["claude"], "2026-01-02T00:00:00.000Z");
        assert.equal(second.inserted, 0);
        assert.equal(second.markersRead, 1);
        // A new marker (append a terminal) inserts exactly the new row.
        writeFileSync(
          file,
          `${JSON.stringify({
            type: "assistant",
            sessionId: "dedup-ses-1",
            message: { stop_reason: "end_turn" },
          })}\n`,
          { flag: "a" },
        );
        const third = await importArtifacts(db, ["claude"], "2026-01-03T00:00:00.000Z");
        assert.equal(third.inserted, 1);
        assert.equal(third.markersRead, 2);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM imported_artifacts").get().n, 2);
      },
    );
  });

  test("codex unknown line types contribute nothing; compaction is counted", () => {
    const root = join(box.dir, "codex-edge-home", ".codex", "sessions");
    mkdirSync(join(root, "2026", "10"), { recursive: true });
    writeFileSync(
      join(root, "2026", "10", "roll.jsonl"),
      `${[
        JSON.stringify({ type: "turn_foo" }),
        JSON.stringify({ timestamp: "2026-10-29T11:00:00.000Z", type: "compacted" }),
        JSON.stringify({
          timestamp: "2026-10-29T11:01:00.000Z",
          type: "TurnComplete",
          payload: { error: "boom" },
        }),
        "not json",
      ].join("\n")}\n`,
    );
    return withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("codex-edge"),
        AIAND_CLAUDE_DIR: undefined,
        AIAND_CODEX_DIR: root,
        AIAND_OPENCODE_DB: "",
      },
      async () => {
        const db = openStore(join(cfgDir("codex-edge"), "store.db")).db;
        const result = await importArtifacts(db, ["codex"]);
        assert.equal(result.markersRead, 2);
        const kinds = db
          .prepare("SELECT kind, outcome FROM imported_artifacts ORDER BY kind")
          .all();
        assert.deepEqual(
          kinds.map((r) => ({ kind: r.kind, outcome: r.outcome })),
          [
            { kind: "compaction", outcome: null },
            { kind: "terminal", outcome: "errored" },
          ],
        );
        const stats = sessionStats(
          db
            .prepare("SELECT * FROM imported_artifacts")
            .all()
            .map((r) => ({
              harness: r.harness,
              session_id: r.session_id,
              kind: r.kind,
              tool_name: r.tool_name,
              outcome: r.outcome,
            })),
        );
        assert.equal(stats[0].compacted, 1);
        assert.equal(stats[0].terminal, "errored");
        assert.equal(stats[0].toolCalls, 0);
      },
    );
  });
});

// -- efficiency command -----------------------------------------------------------

describe("aiand efficiency edge windows (#cov-obs)", () => {
  function effEnv(dir) {
    return cliEnv({
      AIAND_CONFIG_DIR: join(effBox.dir, dir),
      AIAND_HOME: join(effBox.dir, "home"),
      AIAND_API_KEY: "sk-test-not-real",
      AIAND_NO_SYNC: "1",
    });
  }

  test("an unreadable store fails open with an honest error", async () => {
    const dir = join(effBox.dir, "bad-store");
    mkdirSync(dir, { recursive: true });
    // Not a SQLite file: openStore quarantines and recreates, so efficiency
    // serves an honest empty window rather than crashing.
    writeFileSync(join(dir, "store.db"), "definitely not a sqlite database".repeat(50));
    const { code, stdout } = await runCli(["efficiency", "--no-sync", "--json"], {
      env: effEnv("bad-store"),
    });
    assert.equal(code, 0, stdout);
    const payload = JSON.parse(stdout);
    assert.match(payload.coverageNote, /n\/a|0 of 0|local-capture only/);
    assert.equal(payload.oneShotRetry.overall.editTurns, 0);
  });

  test("--since + --until window: bounded query and honest coverage note", async () => {
    const dir = join(effBox.dir, "window");
    mkdirSync(dir, { recursive: true });
    const db = openStore(join(dir, "store.db")).db;
    const v1 = {
      schema_version: "aiand-envelope/v1",
      tools: ["Edit"],
      edit_targets: [],
      project_root_id: null,
      git_branch: null,
    };
    insertEnvelope(db, { envelope: v1, agent: "opencode", createdAt: "2026-10-25T10:00:00.000Z" });
    db.close();
    const { code, stdout } = await runCli(
      ["efficiency", "--no-sync", "--since", "2026-10-01", "--until", "2026-10-31", "--json"],
      { env: effEnv("window") },
    );
    assert.equal(code, 0, stdout);
    const payload = JSON.parse(stdout);
    assert.deepEqual(payload.window, {
      sinceMs: Date.parse("2026-10-01T00:00:00.000Z"),
      untilMs: Date.parse("2026-10-31T23:59:59.999Z"),
    });
    // 1 envelope, 0 priced requests in the window → 100% coverage of 0 requests.
    assert.match(payload.coverageNote, /local-capture only/);
  });

  test("an unopenable store surfaces the honest CLI error", async () => {
    const dir = join(effBox.dir, "store-is-dir");
    // store.db exists as a DIRECTORY: openStore cannot open it and the command
    // reports the failure with a hint instead of pretending the window is empty.
    mkdirSync(join(dir, "store.db"), { recursive: true });
    const { code, stderr } = await runCli(["efficiency", "--no-sync"], {
      env: effEnv(join("store-is-dir")),
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /local request store is not available/i);
  });
});
