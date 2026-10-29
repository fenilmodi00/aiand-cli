import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

// -- test harness: one temp home per file; per-test subdirs isolate stores ----
const box = {
  dir: mkdtempSync(join(tmpdir(), "aiand-artifact-import-")),
  cleanup: () => {
    try {
      rmSync(box.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows can hold a sqlite handle briefly; temp dir is cleaned by the OS
    }
  },
};
before(() => {});
after(() => box.cleanup());

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
const storePathOf = (name) => join(cfgDir(name), "store.sqlite");

const { openStore } = await import("../dist/store/index.js");
const { STORE_VERSION } = await import("../dist/store/index.js");
const { IMPORT_HARNESSES, importArtifacts, sessionStats } = await import(
  "../dist/store/artifact-import.js"
);

// -- fixtures ------------------------------------------------------------------

/** Claude JSONL: tool_result.is_error markers + a stop_reason terminal. */
function writeClaudeFixture(dir, sessionId) {
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp: "2026-10-29T10:00:00.000Z",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    }),
    JSON.stringify({
      type: "user",
      sessionId,
      timestamp: "2026-10-29T10:00:01.000Z",
      message: { content: [{ type: "tool_result", is_error: true }] },
    }),
    JSON.stringify({
      type: "user",
      sessionId,
      timestamp: "2026-10-29T10:00:02.000Z",
      message: { content: [{ type: "tool_result", is_error: false }] },
    }),
    // The prompt line — used only to prove it never reaches the store.
    JSON.stringify({
      type: "user",
      sessionId,
      timestamp: "2026-10-29T10:00:03.000Z",
      message: { content: [{ type: "text", text: "SECRET-PROMPT-XYZZY fix the login bug" }] },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp: "2026-10-29T10:00:04.000Z",
      message: { stop_reason: "end_turn" },
    }),
  ];
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** Codex rollout: TurnComplete.error, TurnAborted, compacted. */
function writeCodexFixture(dir, name) {
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: "2026-10-29T11:00:00.000Z", type: "TurnComplete", payload: {} }),
    JSON.stringify({
      timestamp: "2026-10-29T11:01:00.000Z",
      type: "TurnComplete",
      payload: { error: "boom" },
    }),
    JSON.stringify({ timestamp: "2026-10-29T11:02:00.000Z", type: "TurnAborted" }),
    JSON.stringify({ timestamp: "2026-10-29T11:03:00.000Z", type: "compacted" }),
    JSON.stringify({ timestamp: "2026-10-29T11:04:00.000Z", type: "response_item" }),
  ];
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** OpenCode SQLite with tool-state errors and a compaction part. */
async function writeOpencodeFixture(dbPath) {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new (await import("node:sqlite")).DatabaseSync(dbPath);
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, time_created TEXT, data TEXT);");
  const insert = db.prepare("INSERT INTO message (id, time_created, data) VALUES (?, ?, ?)");
  insert.run(
    "ses-1",
    "2026-10-29T12:00:00.000Z",
    JSON.stringify({
      parts: [
        { type: "tool", tool: "bash", state: { status: "error" } },
        { type: "tool", tool: "edit", state: { status: "done" } },
      ],
    }),
  );
  insert.run(
    "ses-2",
    "2026-10-29T12:05:00.000Z",
    JSON.stringify({
      parts: [{ type: "compaction" }],
    }),
  );
  db.close();
  return dbPath;
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

// -- tests ---------------------------------------------------------------------

describe("artifact import (migration 0008, #133)", () => {
  test("fresh store is at version 8 with an empty imported_artifacts table", async () => {
    await withEnv({ AIAND_CONFIG_DIR: cfgDir("fresh") }, async () => {
      assert.equal(STORE_VERSION, 8);
      const opened = openStore(storePathOf("fresh"));
      assert.equal(countRows(opened.db, "imported_artifacts"), 0);
    });
  });

  test("claude markers import: tool outcomes, terminal, per-session stats", async () => {
    const claudeDir = join(box.dir, "claude-home", ".claude", "projects", "proj");
    const sessionId = "claude-ses-1";
    writeClaudeFixture(claudeDir, sessionId);
    await withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("claude"),
        AIAND_CLAUDE_DIR: join(box.dir, "claude-home", ".claude", "projects"),
        AIAND_CODEX_DIR: undefined,
        AIAND_OPENCODE_DB: "",
      },
      async () => {
        const opened = openStore(storePathOf("claude"));
        const result = await importArtifacts(opened.db, ["claude"]);
        assert.equal(result.inserted, 3); // 2 tool + 1 terminal; prompt line has no markers
        assert.equal(result.markersRead, 3);
        assert.equal(result.filesRead, 1);
        assert.deepEqual(result.sessions, { claude: 1 });

        const rows = opened.db
          .prepare("SELECT kind, outcome, seq, at FROM imported_artifacts ORDER BY kind, seq")
          .all();
        const tools = rows.filter((r) => r.kind === "tool");
        assert.deepEqual(
          tools.map((r) => r.outcome),
          ["error", "ok"],
        );
        const terminal = rows.find((r) => r.kind === "terminal");
        assert.equal(terminal.outcome, "clean");

        // Behavioral rollup: 2 tool calls, 1 error, clean terminal.
        const markers = opened.db
          .prepare("SELECT * FROM imported_artifacts")
          .all()
          .map((r) => ({
            harness: r.harness,
            session_id: r.session_id,
            kind: r.kind,
            tool_name: r.tool_name,
            outcome: r.outcome,
            seq: r.seq,
            at: r.at,
            dedup_key: r.dedup_key,
          }));
        const stats = sessionStats(markers);
        assert.equal(stats.length, 1);
        assert.equal(stats[0].toolCalls, 2);
        assert.equal(stats[0].toolErrors, 1);
        assert.equal(stats[0].compacted, 0);
        assert.equal(stats[0].terminal, "clean");
      },
    );
  });

  test("codex markers import: TurnComplete.error, TurnAborted, compacted", async () => {
    const codexDir = join(box.dir, "codex-home", ".codex", "sessions", "2026", "10", "29");
    writeCodexFixture(codexDir, "rollout-1");
    await withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("codex"),
        AIAND_CODEX_DIR: join(box.dir, "codex-home", ".codex", "sessions"),
        AIAND_CLAUDE_DIR: undefined,
        AIAND_OPENCODE_DB: "",
      },
      async () => {
        const opened = openStore(storePathOf("codex"));
        const result = await importArtifacts(opened.db, ["codex"]);
        // response_item contributes nothing.
        assert.equal(result.inserted, 4);
        const rows = opened.db
          .prepare("SELECT kind, outcome FROM imported_artifacts ORDER BY kind, outcome")
          .all();
        const terminals = rows.filter((r) => r.kind === "terminal").map((r) => r.outcome);
        assert.deepEqual(terminals, ["aborted", "clean", "errored"]);
        assert.ok(rows.some((r) => r.kind === "compaction"));
        const stats = sessionStats(
          opened.db
            .prepare("SELECT * FROM imported_artifacts")
            .all()
            .map((r) => ({
              harness: r.harness,
              session_id: r.session_id,
              kind: r.kind,
              tool_name: r.tool_name,
              outcome: r.outcome,
              seq: r.seq,
              at: r.at,
              dedup_key: r.dedup_key,
            })),
        );
        assert.equal(stats[0].compacted, 1);
        assert.equal(stats[0].terminal, "aborted"); // last terminal marker wins
      },
    );
  });

  test("opencode markers import: tool-state errors and compaction parts", async () => {
    const dbPath = join(box.dir, "opencode-home", "opencode.db");
    await writeOpencodeFixture(dbPath);
    await withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("opencode"),
        AIAND_OPENCODE_DB: dbPath,
        AIAND_CLAUDE_DIR: undefined,
        AIAND_CODEX_DIR: undefined,
      },
      async () => {
        const opened = openStore(storePathOf("opencode"));
        const result = await importArtifacts(opened.db, ["opencode"]);
        assert.equal(result.inserted, 3); // 2 tools + 1 compaction
        const rows = opened.db
          .prepare(
            "SELECT tool_name, outcome, kind FROM imported_artifacts ORDER BY session_id, seq",
          )
          .all();
        assert.deepEqual(
          rows.filter((r) => r.kind === "tool").map((r) => [r.tool_name, r.outcome]),
          [
            ["bash", "error"],
            ["edit", "ok"],
          ],
        );
      },
    );
  });

  test("re-importing the same files adds zero rows (idempotency)", async () => {
    const claudeDir = join(box.dir, "idem-home", ".claude", "projects", "proj");
    writeClaudeFixture(claudeDir, "idem-ses-1");
    await withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("idem"),
        AIAND_CLAUDE_DIR: join(box.dir, "idem-home", ".claude", "projects"),
        AIAND_CODEX_DIR: undefined,
        AIAND_OPENCODE_DB: "",
      },
      async () => {
        const opened = openStore(storePathOf("idem"));
        const first = await importArtifacts(opened.db, ["claude"], "2026-01-01T00:00:00.000Z");
        assert.equal(first.inserted, 3);
        const second = await importArtifacts(opened.db, ["claude"], "2026-01-02T00:00:00.000Z");
        assert.equal(second.inserted, 0);
        assert.equal(countRows(opened.db, "imported_artifacts"), 3);
      },
    );
  });

  test("a fixture with no recognizable records imports 0 rows without error", async () => {
    const claudeDir = join(box.dir, "empty-home", ".claude", "projects", "proj");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "empty.jsonl"),
      `${JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "just chat" }] } })}\nnot json at all\n`,
    );
    await withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("empty"),
        AIAND_CLAUDE_DIR: join(box.dir, "empty-home", ".claude", "projects"),
        AIAND_CODEX_DIR: undefined,
        AIAND_OPENCODE_DB: "",
      },
      async () => {
        const opened = openStore(storePathOf("empty"));
        const result = await importArtifacts(opened.db, ["claude"]);
        assert.equal(result.inserted, 0);
        assert.equal(result.markersRead, 0);
        assert.deepEqual(result.sessions, {});
        assert.deepEqual(sessionStats([]), []);
      },
    );
  });

  test("absent harness directories import nothing, fail-open", async () => {
    await withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("absent"),
        AIAND_CLAUDE_DIR: join(box.dir, "nowhere"),
        AIAND_CODEX_DIR: join(box.dir, "nowhere"),
        AIAND_OPENCODE_DB: join(box.dir, "nowhere", "x.db"),
      },
      async () => {
        const opened = openStore(storePathOf("absent"));
        const result = await importArtifacts(opened.db, [...IMPORT_HARNESSES]);
        assert.equal(result.inserted, 0);
        assert.equal(result.markersRead, 0);
      },
    );
  });

  test("opt-in: a store never touched by the command stays empty", async () => {
    await withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("optin"),
        AIAND_CLAUDE_DIR: join(box.dir, "claude-home", ".claude", "projects"),
        AIAND_CODEX_DIR: undefined,
        AIAND_OPENCODE_DB: "",
      },
      async () => {
        // The claude fixture exists on disk, but no import was invoked.
        const opened = openStore(storePathOf("optin"));
        assert.equal(countRows(opened.db, "imported_artifacts"), 0);
      },
    );
  });

  test("privacy pin: no prompt or content text from fixtures reaches the store", async () => {
    const claudeDir = join(box.dir, "privacy-home", ".claude", "projects", "proj");
    writeClaudeFixture(claudeDir, "privacy-ses-1");
    await withEnv(
      {
        AIAND_CONFIG_DIR: cfgDir("privacy"),
        AIAND_CLAUDE_DIR: join(box.dir, "privacy-home", ".claude", "projects"),
        AIAND_CODEX_DIR: undefined,
        AIAND_OPENCODE_DB: "",
      },
      async () => {
        const opened = openStore(storePathOf("privacy"));
        await importArtifacts(opened.db, ["claude"]);
        // Grep every stored string column for the fixture's secret prompt.
        const rows = opened.db
          .prepare(
            "SELECT dedup_key, harness, session_id, kind, tool_name, outcome, at FROM imported_artifacts",
          )
          .all();
        assert.ok(rows.length > 0);
        for (const row of rows) {
          for (const value of Object.values(row)) {
            if (typeof value === "string") {
              assert.ok(!value.includes("SECRET-PROMPT-XYZZY"), `leaked: ${value}`);
              assert.ok(!value.includes("fix the login bug"), `leaked: ${value}`);
            }
          }
        }
        // DDL pin: no free-text column exists beyond names/outcomes/timestamps
        // (check column names only — SQLite's TEXT type keyword is fine).
        const ddl = opened.db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'imported_artifacts'")
          .get().sql;
        const columns = ddl.slice(ddl.indexOf("("), ddl.indexOf(")")).toLowerCase();
        for (const banned of ["prompt", "completion", "content", "argument"]) {
          assert.ok(!columns.includes(banned), `DDL column contains "${banned}"`);
        }
      },
    );
  });
});
