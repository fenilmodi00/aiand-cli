import { existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SHARED_AGENT } from "../api/agent-keys.js";
import { agentHome } from "../fsutil.js";

/**
 * Local-usage correlation (harness attribution refinement).
 *
 * The gateway's /logs rows carry only a masked `api_key` + wire-dialect
 * `endpoint`, so chat-family agents sharing one baked key collapse to
 * "shared" (`SHARED_AGENT`). But the agents themselves keep rich LOCAL
 * per-request usage records — the same precedent ccusage attributes Claude
 * Code from: the agent wrote the record, so it is per-request ground truth.
 *
 * A gateway row and a local record match when the model ids are equal, the
 * output token counts are equal, `input_tokens` agrees within
 * {@link INPUT_TOLERANCE_RATIO}, and the timestamps are within
 * {@link TIME_TOLERANCE_MS}. A match must be UNIQUE — two different agents'
 * records agreeing is evidence against, and the row keeps its honest
 * "shared" label (never-guess).
 *
 * Token semantics, verified live on this machine (174 gateway-store rows
 * joined to omp `aiand` records, exact on every pair):
 *
 *   gateway.input_tokens  = agent input + agent cacheRead
 *   gateway.cached_tokens = agent cacheRead
 *   gateway.created_at    = agent timestamp + ~3-8 s (gateway wire time)
 *
 * i.e. the agents' `usage.input` EXCLUDES cacheRead while the store's
 * `input_tokens` INCLUDES `cached_tokens` (0001-init contract), and the
 * gateway row is consistently the LATER timestamp.
 *
 * Precedence: correlation only ever refines rows the current rule labels
 * `shared` (or `unknown`) — a specific key/dialect label (claude, codex,
 * …) is never overridden, and refinement never overrides a recorded
 * non-shared mapping either. All reads and writes fail open: a missing or
 * unreadable agent store degrades to no records, never a throw.
 */

/** One local per-request usage record, agent-agnostic. */
export type LocalUsageRecord = {
  /** Agent short id as the registry spells it: "omp", "pi", "opencode". */
  agent: string;
  model: string;
  /** Epoch ms of the agent's own record timestamp. */
  at: number;
  /** The agent's prompt-token count, EXCLUDING cached tokens. */
  inputTokens: number;
  outputTokens: number;
  /** The agent's cache-read token count (0 when the agent reports none). */
  cachedTokens: number;
};

/** One stored request row as the correlator reads it. */
export type UsageRequestRow = {
  id: string;
  model: string;
  api_key: string | null;
  endpoint: string | null;
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
};

/** Max |Δt| between a gateway row and a local record, ms. */
export const TIME_TOLERANCE_MS = 2 * 60 * 1000;

/**
 * `input_tokens` relative tolerance. The agent's input excludes cached
 * tokens and the gateway's includes them (added back by the matcher), so an
 * exact comparison would be right only with zero clock skew; the ratio
 * absorbs skew and rounding without loosening the match into guessing.
 */
export const INPUT_TOLERANCE_RATIO = 0.05;

/** The standing caveat paired with any correlation coverage report. */
export const CORRELATION_NOTE = "harness refinement also reads the agents' own local usage records";

// ---------------------------------------------------------------------------
// Readers — one per agent's local store, all fail-open
// ---------------------------------------------------------------------------

/**
 * Where omp keeps session history, mirroring src/agents/omp/launch.ts
 * `ompSessionsDir` (agent dir's `sessions/`; the linux/darwin XDG migration
 * when `config init-xdg` moved it). Windows keeps the agent dir.
 */
function ompSessionsRoot(): string {
  if (process.env.PI_CODING_AGENT_DIR) {
    return join(process.env.PI_CODING_AGENT_DIR, "sessions");
  }
  const agentDir = join(agentHome(), process.env.PI_CONFIG_DIR ?? ".omp", "agent");
  if (process.platform === "linux" || process.platform === "darwin") {
    const xdg = process.env.XDG_DATA_HOME || join(agentHome(), ".local", "share");
    const migrated = join(xdg, "omp");
    if (existsSync(migrated)) return join(migrated, "sessions");
  }
  return join(agentDir, "sessions");
}

/**
 * Where pi keeps session history, mirroring src/agents/pi/adapter.ts
 * `piSessionDir` (global settings `sessionDir` when set, else the per-cwd
 * default under the agent dir). The correlator has no single cwd, so a
 * project-level `.pi/settings.json` override cannot apply.
 */
function piSessionsRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(agentHome(), ".pi", "agent");
  let sessionDir = join(agentDir, "sessions");
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      sessionDir?: unknown;
    };
    if (typeof settings.sessionDir === "string" && settings.sessionDir !== "") {
      sessionDir = settings.sessionDir.replace(/^~(?=$|[/\\])/, agentHome());
    }
  } catch {
    // missing/unreadable settings — the default dir stands
  }
  return sessionDir;
}

/** The opencode SQLite store path (XDG data dir; win32 keeps %LOCALAPPDATA%). */
function opencodeDbPath(): string | null {
  const xdg = process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "opencode", "opencode.db")
    : null;
  const fallback =
    process.platform === "win32"
      ? join(agentHome(), "AppData", "Local", "opencode", "opencode.db")
      : join(agentHome(), ".local", "share", "opencode", "opencode.db");
  if (xdg !== null && existsSync(xdg)) return xdg;
  return existsSync(fallback) ? fallback : null;
}

/**
 * Every omp/pi (pi-mono) assistant record: session files are append-only
 * JSONL whose message lines carry
 * `{"type":"message","timestamp":…,"message":{"role":"assistant",
 * "provider":…,"model":…,"usage":{"input","output","cacheRead",…}}}`.
 * Both flat `<dir>/<uuid>.jsonl` files and per-cwd subdirectories are
 * accepted; files are read newest-first so freshest evidence iterates first.
 */
function chatJsonlRecords(sessionsDir: string, agent: string): LocalUsageRecord[] {
  const files = chatSessionFiles(sessionsDir);
  const records: LocalUsageRecord[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"provider":"aiand"')) continue;
      const record = parseChatLine(line, agent);
      if (record !== null) records.push(record);
    }
  }
  return records;
}

function chatSessionFiles(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return [];
  const files: { path: string; mtime: number }[] = [];
  // omp nests arbitrarily deep: sessions/<cwd>/<session>.jsonl, but also
  // sessions/<cwd>/<session>/<task>.jsonl (and one level deeper still) —
  // the per-cwd dir holds one session file per background task. A flat or
  // single-level walk misses the majority of live records (observed: 8,063
  // of 8,364 flash records were nested), silently starving the correlator.
  // Recurse, newest-first; the sessions dir is agent-owned and small.
  const walk = (dir: string): void => {
    for (const name of safeReaddir(dir)) {
      const full = join(dir, name);
      let stat: Stats;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith(".jsonl")) files.push({ path: full, mtime: stat.mtimeMs });
    }
  };
  walk(sessionsDir);
  return files.sort((a, b) => b.mtime - a.mtime).map((file) => file.path);
}

type ChatLine = {
  timestamp?: unknown;
  message?: {
    role?: unknown;
    provider?: unknown;
    model?: unknown;
    usage?: { input?: unknown; output?: unknown; cacheRead?: unknown };
  };
};

function parseChatLine(line: string, agent: string): LocalUsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const { timestamp, message } = parsed as ChatLine;
  const usage = message?.usage;
  if (
    message?.role !== "assistant" ||
    message.provider !== "aiand" ||
    typeof message.model !== "string" ||
    typeof timestamp !== "string" ||
    typeof usage !== "object" ||
    usage === null
  ) {
    return null;
  }
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return null;
  const input = typeof usage.input === "number" && Number.isFinite(usage.input) ? usage.input : 0;
  const output =
    typeof usage.output === "number" && Number.isFinite(usage.output) ? usage.output : 0;
  const cached =
    typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0;
  return {
    agent,
    model: message.model,
    at,
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
  };
}

/**
 * OpenCode assistant rows from its SQLite store (`message.data` JSON with
 * `role`, `modelID`, `tokens.{input,output,cache.read}`). node:sqlite is
 * loaded through the same lazy CJS bridge as src/store/index.ts; its absence
 * (Node < 22.5) degrades to no records.
 */
function opencodeRecords(): LocalUsageRecord[] {
  const dbPath = opencodeDbPath();
  if (dbPath === null) return [];
  try {
    const require_ = createRequire(import.meta.url);
    const { DatabaseSync: OpencodeDatabase } = require_("node:sqlite") as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;
    };
    const db = new OpencodeDatabase(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT time_created, data FROM message ORDER BY time_created")
        .all() as unknown as { time_created: string | number; data: string }[];
      const records: LocalUsageRecord[] = [];
      for (const row of rows) {
        const record = parseOpencodeRow(row);
        if (record !== null) records.push(record);
      }
      return records;
    } finally {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
  } catch {
    // corrupt/locked db, missing node:sqlite — fail open
    return [];
  }
}

type OpencodeMessage = {
  role?: unknown;
  modelID?: unknown;
  tokens?: { input?: unknown; output?: unknown; cache?: { read?: unknown } };
};

function parseOpencodeRow(row: {
  time_created: string | number;
  data: string;
}): LocalUsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    return null;
  }
  const message = parsed as OpencodeMessage;
  const tokens = message.tokens;
  if (message.role !== "assistant" || typeof tokens !== "object" || tokens === null) return null;
  const at = toMs(row.time_created);
  if (at === null) return null;
  const input =
    typeof tokens.input === "number" && Number.isFinite(tokens.input) ? tokens.input : 0;
  const output =
    typeof tokens.output === "number" && Number.isFinite(tokens.output) ? tokens.output : 0;
  const cached =
    typeof tokens.cache?.read === "number" && Number.isFinite(tokens.cache.read)
      ? tokens.cache.read
      : 0;
  return {
    agent: "opencode",
    model: typeof message.modelID === "string" ? message.modelID : "",
    at,
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
  };
}

function toMs(value: string | number): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return value > 1e12 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Every local record from every consulted agent's store. A source with no
 * local directory (the agent never ran here) contributes nothing.
 */
export function collectLocalUsageRecords(): LocalUsageRecord[] {
  return [
    ...chatJsonlRecords(ompSessionsRoot(), "omp"),
    ...chatJsonlRecords(piSessionsRoot(), "pi"),
    ...opencodeRecords(),
  ];
}

// ---------------------------------------------------------------------------
// Matching + refinement
// ---------------------------------------------------------------------------

export type RowRefinement =
  | { kind: "refined"; agent: string }
  | { kind: "ambiguous" }
  | { kind: "none" };

/**
 * The unique-match refinement for one gateway row against one model's
 * candidate records, or why none applies. A candidate agrees on output
 * exactly, on (input + cacheRead) within {@link INPUT_TOLERANCE_RATIO}, and
 * within {@link TIME_TOLERANCE_MS} of the row's timestamp. Zero agreeing
 * candidates → `none`; two agreeing candidates from DIFFERENT agents →
 * `ambiguous` (two records of the SAME agent — a retried stream re-logged —
 * still refine: the agent is the same either way).
 */
export function matchRequest(
  row: { output: number; input: number; cached: number; at: number },
  candidates: readonly LocalUsageRecord[],
): RowRefinement {
  let winner: LocalUsageRecord | null = null;
  for (const record of candidates) {
    if (record.outputTokens !== row.output) continue;
    if (!inputWithin(record.inputTokens + record.cachedTokens, row.input)) continue;
    if (Math.abs(record.at - row.at) > TIME_TOLERANCE_MS) continue;
    if (winner !== null && winner.agent !== record.agent) return { kind: "ambiguous" };
    winner = record;
  }
  return winner === null ? { kind: "none" } : { kind: "refined", agent: winner.agent };
}

function inputWithin(localInput: number, gatewayInput: number): boolean {
  if (localInput === gatewayInput) return true;
  const larger = Math.max(localInput, gatewayInput);
  return larger === 0 || Math.abs(localInput - gatewayInput) / larger <= INPUT_TOLERANCE_RATIO;
}

/**
 * Correlate every row and persist the refinement into
 * `requests.attributed_agent` (migration 0006), returning the per-row labels
 * plus what changed. Idempotent: a row is written only when its persisted
 * value differs, so repeated passes are no-ops.
 *
 * Cost gate: the cursor still bounds REFINED rows — a row that matched (or
 * was never eligible: specific base label, null tokens) keeps its durable
 * label and is not re-attempted. But a row the pass ATTEMPTED and could not
 * resolve (no record yet, or ambiguous) stays re-eligible forever: agents
 * buffer their session writes, so the record for a request often lands on
 * disk seconds AFTER the first pass ran (observed live: omp's JSONL flush
 * sealed 1174 rows behind the cursor as "shared" while every one of them
 * had a matching record). A later pass heals such rows when the evidence
 * arrives — ccusage re-reads local records on every run for the same
 * reason; an attempt-once cursor makes attribution one flush-race away
 * from permanently wrong. The cursor still advances: it bounds work per
 * pass, not the lifetime of an unresolved row.
 *
 * # ponytail: full-table re-attempt each pass, O(rows × candidates) with the
 * (model, output) index — fine at personal-store scale (10^4 rows). Move
 * the unresolved set into a table if multi-month stores feel it.
 */
export function refreshCorrelations(
  db: DatabaseSync,
  requests: readonly UsageRequestRow[],
  records: readonly LocalUsageRecord[],
  baseLabel: (row: UsageRequestRow) => string,
): { labels: Map<string, string>; changed: number; ambiguous: number } {
  const labels = new Map<string, string>();
  for (const row of requests) labels.set(row.id, baseLabel(row));
  let changed = 0;
  let ambiguous = 0;

  const cursorRaw = correlationCursor(db);
  const cursor = cursorRaw === null ? 0 : Number(cursorRaw);
  // Re-eligible: fresh rows, plus stale rows that were ATTEMPTED before and
  // left unresolved. A persisted refinement settles a row for good; a
  // specific base label never needed one.
  const fresh = requests.filter((row) => {
    const at = Date.parse(row.created_at);
    if (Number.isNaN(at)) return true;
    if (at > cursor) return true;
    const base = labels.get(row.id) ?? "";
    return (
      (base === SHARED_AGENT || base === "unknown") &&
      row.output_tokens !== null &&
      row.input_tokens !== null
    );
  });
  if (fresh.length === 0 || records.length === 0) return { labels, changed, ambiguous };

  // Index records by (model, output): the matcher's two exact gates. One
  // probe touches only the records that can agree, not every record of the
  // model — the difference between a fast and a quadratic full-table pass.
  const byModelOutput = new Map<string, LocalUsageRecord[]>();
  for (const record of records) {
    const key = `${record.model}\u0000${record.outputTokens}`;
    const bucket = byModelOutput.get(key) ?? [];
    bucket.push(record);
    byModelOutput.set(key, bucket);
  }

  try {
    const update = db.prepare("UPDATE requests SET attributed_agent = ? WHERE id = ?");
    const existing = attributedAgents(
      db,
      fresh.map((row) => row.id),
    );
    db.exec("BEGIN");
    let maxAt = cursor;
    const batchNewest = fresh.reduce((max, row) => {
      const at = Date.parse(row.created_at);
      return Number.isNaN(at) ? max : Math.max(max, at);
    }, Number.NEGATIVE_INFINITY);
    for (const row of fresh) {
      const at = Date.parse(row.created_at);
      if (!Number.isNaN(at) && at > maxAt) maxAt = at;
      const base = labels.get(row.id) ?? "";
      if (base !== SHARED_AGENT && base !== "unknown") continue;
      if (row.output_tokens === null || row.input_tokens === null || Number.isNaN(at)) {
        continue;
      }
      const bucket = byModelOutput.get(`${row.model}\u0000${row.output_tokens}`) ?? [];
      const match = matchRequest(
        {
          output: row.output_tokens,
          input: row.input_tokens,
          cached: row.cached_tokens ?? 0,
          at,
        },
        bucket,
      );
      if (match.kind === "ambiguous") {
        ambiguous += 1;
        continue;
      }
      if (match.kind !== "refined") continue;
      labels.set(row.id, match.agent);
      if (existing.get(row.id) !== match.agent) {
        update.run(match.agent, row.id);
        changed += 1;
      }
    }
    // Cursor safety (unchanged): advance only when the batch leaves no
    // UNATTEMPTED row at or below its newest one — a windowed pass must not
    // strand rows it never saw behind the gate. Unresolved rows stay
    // re-eligible by construction, so they cost the cursor nothing.
    const allCreatedAt = db.prepare("SELECT created_at FROM requests").all() as unknown as {
      created_at?: unknown;
    }[];
    const unattemptedBelow =
      allCreatedAt.filter((r) => {
        const at = typeof r.created_at === "string" ? Date.parse(r.created_at) : Number.NaN;
        return !Number.isNaN(at) && at > cursor && at <= batchNewest;
      }).length - fresh.length;
    if (unattemptedBelow <= 0) metaSet(db, CURSOR_KEY, String(maxAt));
    db.exec("COMMIT");
  } catch {
    // The write is best-effort: a locked store keeps its old column values
    // and cursor, the returned labels stay authoritative for this build.
    try {
      db.exec("ROLLBACK");
    } catch {
      // not in a transaction
    }
  }
  return { labels, changed, ambiguous };
}

const CURSOR_KEY = "correlation_cursor_ms";

function correlationCursor(db: DatabaseSync): string | null {
  try {
    const row = db.prepare("SELECT value FROM sync_meta WHERE key = ?").get(CURSOR_KEY) as
      | { value?: unknown }
      | undefined;
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    return null;
  }
}

function metaSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO sync_meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * Whether a correlation pass can do work — the cheap gate callers check
 * before parsing local records at all. True when any row postdates the
 * cursor (new traffic), or when any shared/unknown row with token data sits
 * at-or-below it still unresolved: agents buffer their session writes, so
 * a row the last pass missed is healed by a later pass once its record
 * lands (see refreshCorrelations). Fail-open false.
 */
export function correlationsPending(db: DatabaseSync): boolean {
  try {
    const newest = db.prepare("SELECT MAX(created_at) AS t FROM requests").get() as
      | { t?: unknown }
      | undefined;
    const at = typeof newest?.t === "string" ? Date.parse(newest.t) : Number.NaN;
    if (Number.isNaN(at)) return true;
    if (at > Number(correlationCursor(db) ?? "0")) return true;
    const unresolved = db
      .prepare(
        "SELECT COUNT(*) AS n FROM requests WHERE attributed_agent IS NULL " +
          "AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL",
      )
      .get() as { n?: unknown };
    return Number(unresolved?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * The durable refinement for a batch of request ids, read back from the
 * store. Fail-open: a pre-0006 store or locked db yields no refinements.
 */
export function attributedAgents(db: DatabaseSync, ids: readonly string[]): Map<string, string> {
  const refined = new Map<string, string>();
  if (ids.length === 0) return refined;
  try {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id, attributed_agent FROM requests WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as { id: string; attributed_agent: string | null }[];
    for (const row of rows) {
      if (row.attributed_agent !== null) refined.set(row.id, row.attributed_agent);
    }
  } catch {
    // no such column or locked db — no refinements
  }
  return refined;
}
