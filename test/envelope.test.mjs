import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { withEnv, withTestEnv } from "./helpers.mjs";

// OBS-P3-6 (#78): the adapter envelope — schema round-trip, size bound,
// privacy hashing, the opt-in capture recorder, and the migration-0003 store
// path. Privacy is pinned here: no full path ever reaches the store.

const box = withTestEnv("aiand-envelope-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_ENVELOPE_CAPTURE;
  process.env.NO_COLOR = "1";
});

const {
  ENVELOPE_HEADER,
  ENVELOPE_MAX_BYTES,
  ENVELOPE_SCHEMA_VERSION,
  editTargetToken,
  envelopeFits,
  envelopeHeader,
  envelopeJson,
  hashPath,
  normalizeEnvelope,
  parseEnvelope,
  projectRootId,
} = await import("../dist/agents/envelope.js");
const { ENVELOPE_CAPTURE_CONFIG_KEY, envelopeCaptureEnabled, createEnvelopeRecorder } =
  await import("../dist/agents/envelope-capture.js");
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

  test("header constant matches the gateway ask (#80)", () => {
    assert.equal(ENVELOPE_HEADER, "x-aiand-envelope");
    assert.equal(ENVELOPE_SCHEMA_VERSION, "aiand-envelope/v1");
    const env = normalizeEnvelope({ tools: ["Edit"], editTargets: ["a.ts"] });
    assert.equal(envelopeHeader(env), envelopeJson(env));
  });

  test("parseEnvelope rejects non-envelope JSON", () => {
    assert.equal(parseEnvelope("not json"), null);
    assert.equal(parseEnvelope('{"schema_version":"other/v9"}'), null);
  });
});

// -- capture recorder ----------------------------------------------------------

describe("envelope capture (opt-in, default off)", () => {
  test("capture is disabled by default", () => {
    assert.equal(envelopeCaptureEnabled(), false);
    assert.equal(ENVELOPE_CAPTURE_CONFIG_KEY, "envelopeCapture");
  });

  test("disabled recorder is a silent no-op that records nothing", async () => {
    await withEnv({ AIAND_CONFIG_DIR: box.dir }, async () => {
      const recorder = createEnvelopeRecorder({ agent: "opencode" });
      assert.equal(recorder.enabled, false);
      recorder.tool("Edit");
      recorder.edit("/repo/src/config.ts");
      const result = recorder.flush({ projectRoot: "/repo", gitBranch: "main" });
      assert.deepEqual(result, { recorded: false, reason: "disabled" });
      assert.equal(countEnvelopes(), 0);
    });
  });

  test("AIAND_ENVELOPE_CAPTURE=1 opts in and stores a linked row", async () => {
    await withEnv({ AIAND_ENVELOPE_CAPTURE: "1" }, async () => {
      const recorder = createEnvelopeRecorder({
        agent: "claude",
        model: "zai-org/glm-5.3",
        apiKey: "sk-abcd…1234",
      });
      assert.equal(recorder.enabled, true);
      recorder.tool("Bash");
      recorder.tool("Edit");
      recorder.edit("/repo/src/index.ts");
      const result = recorder.flush({ projectRoot: "/repo", gitBranch: "feat/envelope" });
      assert.equal(result.recorded, true);
      assert.match(result.envelope.edit_targets[0], /^index\.ts#[0-9a-f]{16}$/);

      const opened = openStore(storePath());
      assert.ok(opened.ok);
      const rows = listEnvelopesFromDb(opened.db);
      opened.db.close();
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.agent, "claude");
      assert.equal(row.model, "zai-org/glm-5.3");
      assert.equal(row.api_key, "sk-abcd…1234");
      assert.equal(row.git_branch, "feat/envelope");
      assert.equal(row.envelope.tools.join(","), "Bash,Edit");
    });
  });

  test("config.json envelopeCapture: true opts in; empty turns are not stored", async () => {
    const { writeFileSync } = await import("node:fs");
    const { configPath } = await import("../dist/config.js");
    writeFileSync(configPath(), JSON.stringify({ envelopeCapture: true }));
    await withEnv({ AIAND_ENVELOPE_CAPTURE: "" }, async () => {
      assert.equal(envelopeCaptureEnabled(), true);
      const recorder = createEnvelopeRecorder({ agent: "pi" });
      recorder.tool("Read"); // tools only, no edits — still a valid turn
      const result = recorder.flush({ projectRoot: "/repo", gitBranch: null });
      assert.equal(result.recorded, true);

      const empty = createEnvelopeRecorder({ agent: "pi" });
      assert.deepEqual(empty.flush(), { recorded: false, reason: "empty" });
    });
  });
});

// -- store (migration 0003) ------------------------------------------------------

describe("envelope store (migration 0003)", () => {
  test("fresh store is at version 3 with an empty envelopes table", async () => {
    const { join } = await import("node:path");
    await withEnv({ AIAND_CONFIG_DIR: join(box.dir, "fresh-store") }, async () => {
      assert.equal(STORE_VERSION, 3);
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
