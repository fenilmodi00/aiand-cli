import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { withEnv, withTestEnv } from "./helpers.mjs";

// Local-usage correlation (#harness-correlate): a gateway row the key+endpoint
// rules label "shared" is refined to the agent whose LOCAL usage record
// (omp/pi session JSONL, opencode.db) uniquely matches it — same model, same
// output tokens, input within tolerance, |Δt| <= 2 min. Precedence: a
// specific base label (claude via /v1/messages, …) is never overridden; a
// weak or ambiguous match falls back, never guesses; missing agent stores
// fail open.

const box = withTestEnv("aiand-local-usage-", () => {
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CONFIG_DIR;
  delete process.env.XDG_DATA_HOME;
  // Every agent store the readers consult lives under HOME; tests point it
  // at a per-test temp dir via withEnv (AIAND_HOME), so the real session
  // history is never read.
  delete process.env.AIAND_HOME;
});

const PINNED_NOW = new Date("2026-10-22T12:00:00.000Z");

/**
 * The masked key held by two CHAT-dialect agents — the collapse-to-shared
 * scenario. (A [claude, omp] key would not do: a /v1/chat/completions row
 * already narrows that pair to omp via ENDPOINT_HARNESSES, before any
 * correlation.)
 */
function seedSharedKey(dir, agents = ["omp", "pi"]) {
  writeFileSync(
    join(dir, "agent-keys.json"),
    JSON.stringify({
      version: 1,
      keys: agents.map((agent, i) => ({
        agent,
        masked: "sk-abcd...1234",
        fingerprint: `f${i}`,
        at: i + 1,
      })),
    }),
  );
}

async function openStoreFor(dir) {
  const store = await import("../dist/store/index.js");
  const opened = await withEnv({ AIAND_CONFIG_DIR: dir }, () => {
    const opened = store.openStore(store.storePath());
    assert.ok(opened.ok, `store open failed: ${opened.reason ?? ""}`);
    return opened;
  });
  return opened.db;
}

async function insertRow(db, row) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO requests (id, model, api_key, endpoint, status_code, ttft_ms, " +
      "latency_ms, input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, " +
      "created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(
    row.id,
    row.model ?? "zai-org/glm-5.3",
    row.api_key ?? "sk-abcd...1234",
    row.endpoint ?? null,
    row.status_code ?? 200,
    row.ttft_ms ?? 100,
    row.latency_ms ?? 500,
    row.input_tokens ?? 1000,
    row.output_tokens ?? 300,
    row.cached_tokens ?? 400,
    row.cost ?? "0.0042",
    row.cost_value ?? 0.0042,
    row.currency ?? "usd",
    row.created_at,
    new Date().toISOString(),
  );
}

async function insertRows(dir, rows) {
  const db = await openStoreFor(dir);
  for (const row of rows) await insertRow(db, row);
  db.close();
}

/**
 * One omp session JSONL under `<home>/.omp/agent/sessions/<cwd>/`. The
 * assistant line mirrors the live schema (pi-mono message lines): usage.input
 * EXCLUDES cacheRead — gateway input = input + cacheRead, gateway cached =
 * cacheRead.
 */
function writeOmpSession(home, cwdDir, lines) {
  const sessions = join(home, ".omp", "agent", "sessions", cwdDir);
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "2026-10-20T09-00-00-000Z_s1.jsonl"), lines.join("\n"));
}

/**
 * omp's live layout also nests session files BELOW the per-cwd dir —
 * `sessions/<cwd>/<session>/<task>.jsonl` holds one file per background
 * task (observed live: 8,063 of 8,364 records nested there). The reader
 * must recurse, or most evidence is invisible.
 */
function writeNestedOmpSession(home, cwdDir, sessionDir, fileName, lines) {
  const sessions = join(home, ".omp", "agent", "sessions", cwdDir, sessionDir);
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, fileName), lines.join("\n"));
}

function ompLine({ ts, model = "zai-org/glm-5.3", input, output, cacheRead = 0 }) {
  return JSON.stringify({
    type: "message",
    id: "m1",
    parentId: "p1",
    timestamp: ts,
    runtime: { version: "18.12.6" },
    message: {
      role: "assistant",
      provider: "aiand",
      model,
      usage: { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead },
    },
  });
}

function storeRow(overrides = {}) {
  return {
    id: "row-1",
    model: "zai-org/glm-5.3",
    api_key: "sk-abcd...1234",
    endpoint: "/v1/chat/completions",
    input_tokens: 1400, // = local input 1200 + cacheRead 200 (gateway INCLUDES cached)
    output_tokens: 300,
    cached_tokens: 200,
    created_at: "2026-10-20T10:00:10.000Z", // gateway rows run ~3-8 s AFTER the agent line
    ...overrides,
  };
}

/** An omp record matching `storeRow()`'s defaults. */
function matchingOmpLine(overrides = {}) {
  return ompLine({
    ts: "2026-10-20T10:00:03.000Z", // 7 s before the gateway row — inside the window
    input: 1200,
    output: 300,
    cacheRead: 200,
    ...overrides,
  });
}

describe("local-usage correlation", () => {
  test("exact token+model+time match refines shared -> omp", async () => {
    const dir = join(box.dir, "refines");
    const home = join(box.dir, "home-refines");
    mkdirSync(dir, { recursive: true });
    seedSharedKey(dir);
    writeOmpSession(home, "--D--proj--", [matchingOmpLine()]);
    await insertRows(dir, [storeRow()]);
    const { buildReportData } = await import("../dist/report/data.js");
    const data = await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    const byHarness = Object.fromEntries(data.byHarness.map((h) => [h.harness, h.requests]));
    assert.equal(byHarness.omp, 1);
    assert.equal(byHarness.shared, undefined);
    // The refinement persisted — the column carries it for later builds.
    const db = await openStoreFor(dir);
    const stored = db.prepare("SELECT attributed_agent FROM requests WHERE id = 'row-1'").get();
    db.close();
    assert.equal(stored.attributed_agent, "omp");
  });

  test("time-out-of-window match stays shared", async () => {
    const dir = join(box.dir, "out-window");
    const home = join(box.dir, "home-window");
    mkdirSync(dir, { recursive: true });
    seedSharedKey(dir);
    // 10 minutes away — outside the ±2 min tolerance, everything else identical.
    writeOmpSession(home, "--D--proj--", [matchingOmpLine({ ts: "2026-10-20T09:50:03.000Z" })]);
    await insertRows(dir, [storeRow()]);
    const { buildReportData } = await import("../dist/report/data.js");
    const data = await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    const byHarness = Object.fromEntries(data.byHarness.map((h) => [h.harness, h.requests]));
    assert.equal(byHarness.shared, 1);
    assert.equal(byHarness.omp, undefined);
  });

  test("a claude-dialect row (/v1/messages) is never overridden", async () => {
    const dir = join(box.dir, "claude-guard");
    const home = join(box.dir, "home-claude");
    mkdirSync(dir, { recursive: true });
    // claude + omp hold the key (so an endpoint-less row would share), the
    // row speaks the Anthropic dialect, and an omp record matches it to the
    // token — the dialect label must still win.
    seedSharedKey(dir, ["claude", "omp"]);
    writeOmpSession(home, "--D--proj--", [matchingOmpLine()]);
    await insertRows(dir, [storeRow({ id: "row-claude", endpoint: "/v1/messages" })]);
    const { buildReportData } = await import("../dist/report/data.js");
    const data = await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    const byHarness = Object.fromEntries(data.byHarness.map((h) => [h.harness, h.requests]));
    assert.equal(byHarness.claude, 1);
    assert.equal(byHarness.omp, undefined);
    // Nothing was persisted for it but its own base label — never the omp
    // record that token-matches it. (Settling the base label into the
    // column is what retires the row from the pending set; render ignores
    // the column on a specific-base row.)
    const db = await openStoreFor(dir);
    const stored = db
      .prepare("SELECT attributed_agent FROM requests WHERE id = 'row-claude'")
      .get();
    db.close();
    assert.equal(stored.attributed_agent, "claude");
  });

  test("missing agent stores fail open (label stays shared)", async () => {
    const dir = join(box.dir, "fail-open");
    const home = join(box.dir, "home-empty");
    mkdirSync(home, { recursive: true }); // no .omp, no .pi, no opencode
    mkdirSync(dir, { recursive: true });
    seedSharedKey(dir);
    await insertRows(dir, [storeRow()]);
    const { buildReportData } = await import("../dist/report/data.js");
    const data = await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    const byHarness = Object.fromEntries(data.byHarness.map((h) => [h.harness, h.requests]));
    assert.equal(byHarness.shared, 1);
  });

  test("late-flushed local evidence heals a row the first pass missed", async () => {
    const dir = join(box.dir, "heal");
    const home = join(box.dir, "home-heal");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    seedSharedKey(dir);
    // First pass: omp's record for this row is still buffered in the agent
    // process — only an OLDER session's record is on disk (the live shape:
    // 10k records existed, the newest rows' did not). The row is attempted,
    // misses, and stays NULL: the cursor settles past it, but the NULL row
    // keeps the gate true and re-attempts on the next pass.
    writeOmpSession(home, "--D--old--", [
      ompLine({ ts: "2026-10-20T09:00:03.000Z", input: 999, output: 999 }),
    ]);
    await insertRows(dir, [storeRow()]);
    const { buildReportData } = await import("../dist/report/data.js");
    await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    const { DatabaseSync } = await import("node:sqlite");
    const dbSealed = new DatabaseSync(join(dir, "store.db"));
    const sealed = dbSealed
      .prepare("SELECT attributed_agent FROM requests WHERE id = 'row-1'")
      .get();
    const cursor = dbSealed
      .prepare("SELECT value FROM sync_meta WHERE key = 'correlation_cursor_ms'")
      .get();
    dbSealed.close();
    assert.equal(sealed?.attributed_agent, null);
    assert.ok(cursor, "first pass must settle the cursor past the row");

    // omp flushes its session JSONL seconds later. A later report run must
    // re-attempt the still-NULL row and heal it — never leave it shared
    // behind the cursor.
    writeOmpSession(home, "--D--proj--", [matchingOmpLine()]);
    const data = await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    const byHarness = Object.fromEntries(data.byHarness.map((h) => [h.harness, h.requests]));
    assert.equal(byHarness.omp, 1);
    assert.equal(byHarness.shared, undefined);
    // and the healing is durable
    const dbHealed = new DatabaseSync(join(dir, "store.db"));
    const healed = dbHealed
      .prepare("SELECT attributed_agent FROM requests WHERE id = 'row-1'")
      .get();
    dbHealed.close();
    assert.equal(healed?.attributed_agent, "omp");
  });

  test("records in omp's nested session layout still refine", async () => {
    const dir = join(box.dir, "nested");
    const home = join(box.dir, "home-nested");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    seedSharedKey(dir);
    // omp writes one JSONL per background task BELOW the per-cwd dir —
    // sessions/<cwd>/<session>/<task>.jsonl (live: 8,063 of 8,364 records
    // nested). A reader that stops at one subdir level never sees them
    // and the rows stay shared forever.
    writeNestedOmpSession(home, "--D--proj--", "2026-10-20T09-30-00-000Z_task", "T6Run.jsonl", [
      matchingOmpLine(),
    ]);
    await insertRows(dir, [storeRow()]);
    const { buildReportData } = await import("../dist/report/data.js");
    const data = await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    const byHarness = Object.fromEntries(data.byHarness.map((h) => [h.harness, h.requests]));
    assert.equal(byHarness.omp, 1);
    assert.equal(byHarness.shared, undefined);
  });

  test("ambiguous double-match does not refine", async () => {
    const dir = join(box.dir, "ambiguous");
    const home = join(box.dir, "home-ambiguous");
    mkdirSync(dir, { recursive: true });
    seedSharedKey(dir);
    // omp AND pi each hold an identical record for the same request — the
    // evidence cannot pick one, so the row keeps its honest shared label.
    const ompSessions = join(home, ".omp", "agent", "sessions", "--D--proj--");
    mkdirSync(ompSessions, { recursive: true });
    writeFileSync(join(ompSessions, "s1.jsonl"), matchingOmpLine());
    const piSessions = join(home, ".pi", "agent", "sessions", "--D--proj--");
    mkdirSync(piSessions, { recursive: true });
    writeFileSync(join(piSessions, "s1.jsonl"), matchingOmpLine());
    await insertRows(dir, [storeRow()]);
    const { buildReportData } = await import("../dist/report/data.js");
    const data = await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    const byHarness = Object.fromEntries(data.byHarness.map((h) => [h.harness, h.requests]));
    assert.equal(byHarness.shared, 1);
    assert.equal(byHarness.omp, undefined);
    assert.equal(byHarness.pi, undefined);
  });

  test("sessionize bakes the refined label into the session agent", async () => {
    const dir = join(box.dir, "sessions");
    const home = join(box.dir, "home-sessions");
    mkdirSync(dir, { recursive: true });
    seedSharedKey(dir);
    writeOmpSession(home, "--D--proj--", [matchingOmpLine()]);
    await insertRows(dir, [storeRow()]);
    const { listSessions } = await import("../dist/store/sessions.js");
    const listed = await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () => listSessions());
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].agent, "omp");
  });

  test("a windowed first pass does not strand older rows behind the cursor", async () => {
    const dir = join(box.dir, "windowed");
    const home = join(box.dir, "home-windowed");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    seedSharedKey(dir);
    // row-1 is OLD and matches an omp line; row-2 is the store's NEWEST row
    // and matches a second omp line. A first pass over a window that covers
    // ONLY row-2 must not advance the cursor past the unseen row-1 — that
    // would strand it behind the cost gate forever.
    writeOmpSession(home, "--D--proj--", [
      matchingOmpLine(), // matches row-1 at 2026-10-20T10:00
      ompLine({ ts: "2026-10-21T10:00:03.000Z", input: 1200, output: 300, cacheRead: 200 }),
    ]);
    await insertRows(dir, [
      storeRow({ id: "row-1", created_at: "2026-10-20T10:00:10.000Z" }),
      storeRow({ id: "row-2", created_at: "2026-10-21T10:00:10.000Z" }),
    ]);
    const { buildReportData } = await import("../dist/report/data.js");
    // Window covers row-2 only.
    await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-21T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dir, "store.db"));
    const row1 = db.prepare("SELECT attributed_agent FROM requests WHERE id = 'row-1'").get();
    db.close();
    // row-2 refined; row-1 untouched (outside the window) — not stranded.
    assert.equal(row1?.attributed_agent, null);
    const { correlationsPending } = await import("../dist/store/local-usage.js");
    const { openStore } = await import("../dist/store/index.js");
    const pending = await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, async () => {
      const opened = openStore(join(dir, "store.db"));
      try {
        return correlationsPending(opened.db);
      } finally {
        opened.db.close();
      }
    });
    // row-1 still awaits a full pass: pending stays true.
    assert.equal(pending, true);
    // A later full-window pass refines row-1 and then settles the cursor.
    await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    const db2 = new DatabaseSync(join(dir, "store.db"));
    const refined = db2.prepare("SELECT attributed_agent FROM requests WHERE id = 'row-1'").get();
    db2.close();
    assert.equal(refined?.attributed_agent, "omp");
  });

  test("meta carries the correlation caveat", async () => {
    const dir = join(box.dir, "meta");
    const home = join(box.dir, "home-meta");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    seedSharedKey(dir);
    await insertRows(dir, [storeRow()]);
    const { buildReportData } = await import("../dist/report/data.js");
    const data = await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: [],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    assert.match(data.meta.correlationNote, /local usage records/);
  });

  test("base-label rows settle into the column, so the gate reaches false", async () => {
    const dir = join(box.dir, "gate-base");
    const home = join(box.dir, "home-gate-base");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    // claude + omp hold the key: the /v1/messages rows resolve to claude by
    // the base rule alone and never need a local record.
    seedSharedKey(dir, ["claude", "omp"]);
    writeOmpSession(home, "--D--proj--", [matchingOmpLine()]);
    await insertRows(dir, [
      storeRow({ id: "row-claude", endpoint: "/v1/messages" }),
      // A NULL-token row the base rule still labels specifically.
      storeRow({
        id: "row-claude-empty",
        endpoint: "/v1/messages",
        input_tokens: null,
        output_tokens: null,
        cached_tokens: null,
      }),
      storeRow({ id: "row-omp" }),
    ]);
    const { correlationsPending } = await import("../dist/store/local-usage.js");
    // Before any pass the cursor has not moved: gate is true.
    const dbBefore = await openStoreFor(dir);
    assert.equal(correlationsPending(dbBefore), true);
    dbBefore.close();

    const { buildReportData } = await import("../dist/report/data.js");
    const data = await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      }),
    );
    // Render is unchanged: the specific base label wins whether or not the
    // column carries it.
    const byHarness = Object.fromEntries(data.byHarness.map((h) => [h.harness, h.requests]));
    assert.equal(byHarness.claude, 2);
    assert.equal(byHarness.omp, 1);
    // The pass settled every row: base labels and the omp match are durable.
    const db = await openStoreFor(dir);
    const stored = db
      .prepare("SELECT id, attributed_agent FROM requests ORDER BY id")
      .all()
      .reduce((acc, r) => acc.set(r.id, r.attributed_agent), new Map());
    const pending = correlationsPending(db);
    db.close();
    assert.equal(stored.get("row-claude"), "claude");
    assert.equal(stored.get("row-claude-empty"), "claude");
    assert.equal(stored.get("row-omp"), "omp");
    // Nothing unresolved remains: a later build must not re-parse the
    // agents' session files at all (the gate is the parse guard).
    assert.equal(pending, false);
  });

  test("a genuinely unresolved row keeps the gate true until late evidence heals it", async () => {
    const dir = join(box.dir, "gate-heal");
    const home = join(box.dir, "home-gate-heal");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    seedSharedKey(dir);
    // First pass: the row's record is still buffered — only an OLDER
    // session's record is on disk, so the row is attempted and missed.
    writeOmpSession(home, "--D--old--", [
      ompLine({ ts: "2026-10-20T09:00:03.000Z", input: 999, output: 999 }),
    ]);
    await insertRows(dir, [storeRow()]);
    const { correlationsPending } = await import("../dist/store/local-usage.js");
    const { buildReportData } = await import("../dist/report/data.js");
    const report = () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: ["by-harness"],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      });
    const pendingUnder = async () =>
      withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, async () => {
        const { openStore } = await import("../dist/store/index.js");
        const opened = openStore(join(dir, "store.db"));
        try {
          return correlationsPending(opened.db);
        } finally {
          opened.db.close();
        }
      });

    await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () => report());
    // The pass missed the row (NULL column, tokens present): gate stays true
    // — the row must keep counting as pending, not be sealed shared.
    assert.equal(await pendingUnder(), true);

    // The record lands. The gate is still true (nothing consumed it yet),
    // and the next pass heals the row, after which the gate reaches false.
    writeOmpSession(home, "--D--proj--", [matchingOmpLine()]);
    assert.equal(await pendingUnder(), true);
    const data = await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () => report());
    const byHarness = Object.fromEntries(data.byHarness.map((h) => [h.harness, h.requests]));
    assert.equal(byHarness.omp, 1);
    assert.equal(byHarness.shared, undefined);
    assert.equal(await pendingUnder(), false);
  });

  test("a heal re-bakes the materialized sessions table (fingerprint seam)", async () => {
    const dir = join(box.dir, "fingerprint");
    const home = join(box.dir, "home-fingerprint");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    seedSharedKey(dir);
    writeOmpSession(home, "--D--old--", [
      ompLine({ ts: "2026-10-20T09:00:03.000Z", input: 999, output: 999 }),
    ]);
    await insertRows(dir, [storeRow()]);
    const { buildReportData } = await import("../dist/report/data.js");
    const report = () =>
      buildReportData({
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections: [],
        top: 20,
        sync: { skipped: true },
        now: PINNED_NOW,
      });
    const { listSessions } = await import("../dist/store/sessions.js");
    const list = async () =>
      withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () => listSessions());

    // First pass misses the row: the table bakes with zero refined rows and
    // the agent stays shared.
    await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () => report());
    assert.equal((await list()).sessions[0].agent, "shared");

    // Evidence lands and a report build heals the row — the refined-row
    // count changes, which must invalidate the fingerprint so the next
    // listSessions re-bakes the table instead of serving the stale bake.
    writeOmpSession(home, "--D--proj--", [matchingOmpLine()]);
    await withEnv({ AIAND_CONFIG_DIR: dir, AIAND_HOME: home }, () => report());
    const listed = await list();
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].agent, "omp");
  });

  test("pure matcher: same-agent double record still refines; ratio guard holds", async () => {
    const { matchRequest, TIME_TOLERANCE_MS, INPUT_TOLERANCE_RATIO } = await import(
      "../dist/store/local-usage.js"
    );
    const at = Date.parse("2026-10-20T10:00:03.000Z");
    const record = {
      agent: "omp",
      model: "m",
      at,
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 200,
    };
    const row = { output: 300, input: 1400, cached: 200, at: at + 7000 };
    // same agent twice — the agent is the same either way
    assert.deepEqual(matchRequest(row, [record, { ...record, at: at + 1000 }]), {
      kind: "refined",
      agent: "omp",
    });
    // two agents — ambiguous
    assert.deepEqual(matchRequest(row, [record, { ...record, agent: "pi" }]), {
      kind: "ambiguous",
    });
    // output mismatch — none
    assert.equal(matchRequest({ ...row, output: 301 }, [record]).kind, "none");
    // input outside the 5% ratio — none
    const far = { ...row, input: Math.round(1400 * (1 + INPUT_TOLERANCE_RATIO) + 10) };
    assert.equal(matchRequest(far, [record]).kind, "none");
    // time outside ±2 min — none
    assert.equal(matchRequest({ ...row, at: at + TIME_TOLERANCE_MS + 1 }, [record]).kind, "none");
  });
});
