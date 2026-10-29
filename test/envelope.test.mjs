import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { withEnv, withTestEnv } from "./helpers.mjs";

// OBS-P3-6 (#78): the adapter envelope — schema round-trip, size bound,
// privacy hashing, and the migration-0004 store path. Privacy is pinned
// here: no full path ever reaches the store.

const box = withTestEnv("aiand-envelope-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.NO_COLOR = "1";
});

const {
  ENVELOPE_MAX_BYTES,
  ENVELOPE_SCHEMA_VERSION,
  editTargetToken,
  envelopeFits,
  envelopeJson,
  hashPath,
  normalizeEnvelope,
  parseEnvelope,
  projectRootId,
} = await import("../dist/agents/envelope.js");
const { STORE_VERSION } = await import("../dist/store/index.js");
const { insertEnvelope, listEnvelopes, listEnvelopesFromDb, countEnvelopes, countEnvelopesInDb } =
  await import("../dist/store/envelopes.js");
const { openStore, storePath } = await import("../dist/store/index.js");

// -- schema -------------------------------------------------------------------

describe("envelope schema (aiand-envelope/v1)", () => {
  test("normalizes a turn observation into the versioned shape", () => {
    const env = normalizeEnvelope({
      tools: ["Read", "Edit", "Read"],
      editTargets: ["/repo/src/config.ts"],
      projectRoot: "/repo",
      gitBranch: "main",
    });
    assert.equal(env.schema_version, "aiand-envelope/v1");
    assert.deepEqual(env.tools, ["Read", "Edit"]);
    assert.equal(env.edit_targets.length, 1);
    // hashed basename form: basename#hash16 — never the full path
    const target = env.edit_targets[0];
    assert.match(target, /^config\.ts#[0-9a-f]{16}$/);
    assert.ok(!target.includes("/repo"));
    assert.equal(env.project_root_id, projectRootId("/repo"));
    assert.match(env.project_root_id, /^[0-9a-f]{16}$/);
    assert.equal(env.git_branch, "main");
  });

  test("round-trips through JSON (normalize -> json -> parse)", () => {
    const env = normalizeEnvelope({
      tools: ["Bash", "Edit"],
      editTargets: ["src/a.ts", "src/b.ts"],
      projectRoot: "/repo",
      gitBranch: "feat/x",
    });
    const parsed = parseEnvelope(envelopeJson(env));
    assert.deepEqual(parsed, env);
    assert.equal(envelopeFits(env), true);
  });

  test("drops unknown fields and is idempotent on normalized input", () => {
    const env = normalizeEnvelope({ tools: ["Edit"], editTargets: ["a.ts"] });
    const withExtra = JSON.parse(JSON.stringify(env));
    withExtra.prompt = "secret prompt text";
    withExtra.completion = "secret completion";
    const reparsed = parseEnvelope(JSON.stringify(withExtra));
    assert.ok(reparsed);
    assert.equal("prompt" in reparsed, false);
    assert.equal("completion" in reparsed, false);
    assert.deepEqual(normalizeEnvelope(reparsed), env);
  });

  test("edit targets stay hashed: no path separators survive", () => {
    for (const p of ["/repo/deep/nested/file.ts", "C:\\repo\\deep\\file.ts"]) {
      const token = editTargetToken(p);
      assert.ok(!token.includes("/") && !token.includes("\\"));
      assert.match(token, /^file\.ts#[0-9a-f]{16}$/);
    }
    // the same path always hashes identically (stable id for retry detection)
    assert.equal(editTargetToken("/repo/a.ts"), editTargetToken("/repo/a.ts"));
    // different paths to the same basename hash differently
    assert.notEqual(editTargetToken("/repo1/a.ts"), editTargetToken("/repo2/a.ts"));
  });

  test("hashPath and projectRootId are stable pseudonymous ids", () => {
    assert.equal(hashPath("/repo"), hashPath("/repo"));
    assert.notEqual(hashPath("/repo"), hashPath("/repo2"));
    assert.equal(projectRootId("/repo").length, 16);
  });

  test("size bound: a giant turn is truncated deterministically under 2 KiB", () => {
    const many = Array.from({ length: 200 }, (_, i) => `tool-number-${i}`);
    const env = normalizeEnvelope({
      tools: many,
      editTargets: Array.from({ length: 100 }, (_, i) => `/repo/src/file${i}.ts`),
    });
    assert.ok(envelopeFits(env));
    assert.ok(Buffer.byteLength(envelopeJson(env), "utf8") <= ENVELOPE_MAX_BYTES);
    assert.ok(env.tools.length <= 32);
    assert.ok(env.edit_targets.length <= 16);
    // deterministic: same input, same truncation
    const again = normalizeEnvelope({
      tools: many,
      editTargets: Array.from({ length: 100 }, (_, i) => `/repo/src/file${i}.ts`),
    });
    assert.deepEqual(env, again);
  });

  test("schema version is the v1 contract", () => {
    assert.equal(ENVELOPE_SCHEMA_VERSION, "aiand-envelope/v1");
  });

  test("parseEnvelope rejects non-envelope JSON", () => {
    assert.equal(parseEnvelope("not json"), null);
    assert.equal(parseEnvelope('{"schema_version":"other/v9"}'), null);
  });
});

// -- store (migration 0004; renumbered at merge, was 0003 pre-#73) ------------------------------------------------------

describe("envelope store (migration 0004)", () => {
  test("fresh store is at version 8 with an empty envelopes table", async () => {
    const { join } = await import("node:path");
    await withEnv({ AIAND_CONFIG_DIR: join(box.dir, "fresh-store") }, async () => {
      // 8 = migration 0008 (imported_artifacts, #133); 7 = migration 0007
      // (envelopes.tool_outcomes/terminal, #126); 6 =
      // migration 0006 (requests.attributed_agent); 5 = migration 0005
      // (requests.endpoint); envelopes landed at 4 (#78).
      assert.equal(STORE_VERSION, 8);
      assert.equal(countEnvelopes(), 0);
    });
  });

  test("insert + read round-trip in (created_at, id) order", async () => {
    const { join } = await import("node:path");
    await withEnv({ AIAND_CONFIG_DIR: join(box.dir, "roundtrip") }, async () => {
      const opened = openStore(storePath());
      assert.ok(opened.ok);
      const env = normalizeEnvelope({
        tools: ["Edit"],
        editTargets: ["/repo/src/a.ts"],
        projectRoot: "/repo",
        gitBranch: "main",
      });
      insertEnvelope(opened.db, {
        envelope: env,
        agent: "opencode",
        createdAt: "2026-10-25T10:00:00.000Z",
        id: "env-1",
        apiKey: "sk-abcd…1234",
      });
      insertEnvelope(opened.db, {
        envelope: env,
        agent: "opencode",
        createdAt: "2026-10-25T09:00:00.000Z",
        id: "env-0",
        apiKey: "sk-abcd…1234",
      });
      const rows = listEnvelopes();
      opened.db.close();
      assert.deepEqual(
        rows.map((r) => r.id),
        ["env-0", "env-1"],
      );
      assert.deepEqual(rows[0].envelope, env);
    });
  });

  test("privacy pin: the envelopes table never stores a full path or content", async () => {
    const { join } = await import("node:path");
    await withEnv({ AIAND_CONFIG_DIR: join(box.dir, "privacy") }, async () => {
      const opened = openStore(storePath());
      assert.ok(opened.ok);
      const dump = opened.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='envelopes'")
        .get();
      assert.equal(countEnvelopesInDb(opened.db), 0);
      opened.db.close();
      const sql = String(dump.sql).toLowerCase();
      for (const forbidden of ["prompt", "completion", "content", "path_text", "file_path"]) {
        assert.ok(!sql.includes(forbidden), `envelopes schema must not have a ${forbidden} column`);
      }
    });
  });
});

// -- tool outcomes + terminal (T1, #126) ---------------------------------------

describe("envelope toolOutcomes + terminal (ticket #126)", () => {
  test("old-shape v1 rows (no new columns populated) load as unknown, never ok/error", async () => {
    const { join } = await import("node:path");
    await withEnv({ AIAND_CONFIG_DIR: join(box.dir, "outcomes-legacy") }, async () => {
      const opened = openStore(storePath());
      assert.ok(opened.ok);
      // hand-write a pre-0007-shaped envelope JSON (no toolOutcomes/terminal)
      opened.db
        .prepare(
          "INSERT INTO envelopes (id, schema_version, agent, model, api_key, session_id, " +
            "request_id, created_at, tools, edit_targets, project_root_id, git_branch, " +
            "captured_at, tool_outcomes, terminal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "env-old",
          ENVELOPE_SCHEMA_VERSION,
          "opencode",
          null,
          null,
          null,
          null,
          "2026-10-25T10:00:00.000Z",
          JSON.stringify(["Read"]),
          JSON.stringify([]),
          null,
          "main",
          "2026-10-25T10:00:00.000Z",
          null,
          null,
        );
      const rows = listEnvelopesFromDb(opened.db);
      opened.db.close();
      assert.equal(rows.length, 1);
      const env = rows[0].envelope;
      assert.ok(env);
      assert.deepEqual(env.tools, ["Read"]);
      assert.equal(env.toolOutcomes, undefined);
      assert.equal(env.terminal, undefined);
      // and it still parses through the v1 path
      assert.deepEqual(parseEnvelope(envelopeJson(env)), env);
    });
  });
});
