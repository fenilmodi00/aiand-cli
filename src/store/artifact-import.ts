/**
 * Harness artifact import (ticket #133, plan §2.3/§5 P3).
 *
 * Opt-in, command-invoked backfill of behavioral markers from the harnesses'
 * own session files into a dedicated store table. Markers only — tool
 * outcomes (name + ok), terminal states, compaction events. No prompt,
 * completion, tool-argument, or file content is ever read into the store
 * (same privacy contract as `envelopes`); a record that cannot be
 * interpreted from markers alone is skipped.
 *
 * Idempotent: every row carries the `dedup_key` (a SHA-256 of structural
 * keys — harness + session + marker identity + timestamp), UNIQUE in DDL, so
 * re-importing the same files inserts zero new rows.
 *
 * Stored numbers stay raw here; the compare surface labels them `heuristic`
 * via `src/obs/provenance.ts` when it reports rates over them (markers are a
 * heuristic read of harness-local files, not gateway-billed data).
 *
 * Usage readers (ticket #150): the same file walks also feed the correlation
 * pass — `claudeUsageRecords()` / `codexUsageRecords()` extract per-request
 * token usage (model, input/output/cached tokens, timestamp) for
 * `src/store/local-usage.ts`. Metadata only: usage objects and timestamps
 * are read, never message or tool content.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
// node:sqlite is platform-gated (absent before Node 22.5) — the lazy
// createRequire bridge below matches src/store/local-usage.ts.
import { createRequire } from "node:module";
import { join } from "node:path";
import { agentHome } from "../fsutil.js";

/** The three harnesses with importable session artifacts. */
export const IMPORT_HARNESSES = ["claude", "codex", "opencode"] as const;
export type ImportHarness = (typeof IMPORT_HARNESSES)[number];

/** One behavioral marker extracted from a harness artifact. */
export type ArtifactMarker = {
  harness: ImportHarness;
  /** Harness-local session id (never a content hash of prompt text). */
  session_id: string;
  /** "tool" (a tool call outcome) | "terminal" | "compaction". */
  kind: "tool" | "terminal" | "compaction";
  /** Tool NAME for kind="tool" (names only, never arguments); else null. */
  tool_name: string | null;
  /** Tool ok/error for kind="tool"; clean/aborted/errored for kind="terminal"; else null. */
  outcome: "ok" | "error" | "clean" | "aborted" | "errored" | null;
  /** In-artifact position for kind="tool" (0-based), for order-dependent walks. */
  seq: number | null;
  /** Marker timestamp (ISO) when the artifact carries one. */
  at: string | null;
  /** SHA-256 of the structural keys — the idempotency key. */
  dedup_key: string;
};

/** Where Claude Code keeps project session JSONL (overridable for tests). */
function claudeProjectsRoot(): string | null {
  const root = process.env.AIAND_CLAUDE_DIR ?? join(agentHome(), ".claude", "projects");
  return existsSync(root) ? root : null;
}

/** Where Codex keeps rollout session files (overridable for tests). */
function codexSessionsRoot(): string | null {
  const root = process.env.AIAND_CODEX_DIR ?? join(agentHome(), ".codex", "sessions");
  return existsSync(root) ? root : null;
}

/** Where OpenCode keeps its SQLite store (overridable for tests). */
function opencodeDbPath(): string | null {
  const explicit = process.env.AIAND_OPENCODE_DB;
  if (explicit !== undefined) return explicit !== "" ? explicit : null;
  const fallback = join(agentHome(), "AppData", "Local", "opencode", "opencode.db");
  return existsSync(fallback) ? fallback : null;
}

const safeReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const dedupKey = (parts: readonly (string | number | null)[]): string =>
  createHash("sha256").update(parts.map(String).join("\u0000")).digest("hex");

/** A tool name is safe to store; anything else (content-bearing) is not. */
function safeToolName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Names are short identifiers; refuse anything that could smuggle content.
  return trimmed !== "" && trimmed.length <= 64 && !/[\n\r{}]/.test(trimmed) ? trimmed : null;
}

function safeTimestamp(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function safeSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Session ids are opaque identifiers, bounded like the hashes we store.
  return trimmed !== "" && trimmed.length <= 128 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Shared artifact walks (markers #133, usage #150) + usage record type
// ---------------------------------------------------------------------------

/** One per-request token usage record extracted from a harness artifact. */
export type ArtifactUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Epoch ms of the record's own timestamp. */
  at: number;
};

/** A finite, non-negative integer-ish token count; anything else → null. */
function finiteToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Every Claude Code session JSONL under the projects root — the one shared
 * walk both the marker reader (#133) and the usage reader (#150) consume.
 * Date-free layout: `<root>/<project>/<session>.jsonl`.
 */
function claudeJsonlFiles(): string[] {
  const root = claudeProjectsRoot();
  if (root === null) return [];
  const files: string[] = [];
  for (const project of safeReaddir(root)) {
    for (const file of safeReaddir(join(root, project))) {
      if (file.endsWith(".jsonl")) files.push(join(root, project, file));
    }
  }
  return files;
}

/**
 * Every Codex rollout JSONL under the sessions root — the one shared walk
 * both marker and usage readers consume. Recurse date-shaped subdirs
 * (`<root>/<year>/<month>/<day>/<file>.jsonl`), capped like the marker walk.
 */
function codexJsonlFiles(): string[] {
  const root = codexSessionsRoot();
  if (root === null) return [];
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const entry of safeReaddir(dir)) {
      const full = join(dir, entry);
      if (entry.endsWith(".jsonl")) files.push(full);
      else if (depth < 4) walk(full, depth + 1); // date-shaped subdirs
    }
  };
  walk(root, 0);
  return files;
}

// ---------------------------------------------------------------------------
// Claude Code: ~/.claude/projects/**/*.jsonl
// ---------------------------------------------------------------------------

type ClaudeLine = {
  sessionId?: unknown;
  timestamp?: unknown;
  message?: {
    stop_reason?: unknown;
    content?: unknown;
  };
  toolUseResult?: unknown;
};

type ToolResultBlock = { type?: unknown; is_error?: unknown };

/**
 * Claude markers from one JSONL file, in file order. `sessionKey` is the
 * dedup identity (the file path) — real Claude files use the session id in
 * `sessionId`, but the file-level key keeps import stable even when the
 * field is absent.
 */
function claudeMarkersFromFile(path: string, sessionKey: string): ArtifactMarker[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const sessionId = safeSessionId(sessionKey) ?? dedupKey([path]).slice(0, 16);
  const markers: ArtifactMarker[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    let parsed: ClaudeLine;
    try {
      parsed = JSON.parse(lines[i] ?? "") as ClaudeLine;
    } catch {
      continue;
    }
    const at = safeTimestamp(parsed.timestamp);
    // Tool outcomes: assistant tool_use blocks pair with user tool_result
    // blocks; is_error is the only outcome field we read.
    const content = parsed.message?.content;
    if (Array.isArray(content)) {
      let toolSeq = 0;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const record = block as Record<string, unknown>;
        const result = record as ToolResultBlock;
        if (record.type === "tool_result") {
          const ok = result.is_error !== true;
          markers.push({
            harness: "claude",
            session_id: sessionId,
            kind: "tool",
            tool_name: null, // Claude puts the name on the tool_use side; outcome-only here
            outcome: ok ? "ok" : "error",
            seq: toolSeq,
            at,
            dedup_key: dedupKey(["claude", sessionId, "tool", toolSeq, at ?? ""]),
          });
          toolSeq += 1;
        }
      }
    }
    // Terminal state: the line's assistant stop_reason, markers only.
    const stopReason = parsed.message?.stop_reason;
    if (typeof stopReason === "string" && stopReason !== "") {
      const terminal =
        stopReason === "stop_sequence" || stopReason === "end_turn"
          ? "clean"
          : stopReason === "max_tokens"
            ? "aborted"
            : null;
      if (terminal !== null) {
        markers.push({
          harness: "claude",
          session_id: sessionId,
          kind: "terminal",
          tool_name: null,
          outcome: terminal,
          seq: null,
          at,
          dedup_key: dedupKey(["claude", sessionId, "terminal", i, stopReason]),
        });
      }
    }
  }
  return markers;
}

function claudeMarkers(): ArtifactMarker[] {
  const markers: ArtifactMarker[] = [];
  for (const path of claudeJsonlFiles()) {
    markers.push(
      ...claudeMarkersFromFile(path, path.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") ?? ""),
    );
  }
  return markers;
}

// ---------------------------------------------------------------------------
// Claude Code usage records (#150): message.usage token counts per line
// ---------------------------------------------------------------------------

type ClaudeUsageLine = {
  timestamp?: unknown;
  message?: {
    model?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    };
  };
};

/**
 * Usage records from one Claude Code JSONL file: per line an assistant
 * `message.model` string and `message.usage` object with finite
 * `input_tokens` / `output_tokens` (`cache_read_input_tokens` missing → 0).
 * Claude's input EXCLUDES cached tokens (the matcher adds cacheRead back).
 * A line without a usable model, usage, or timestamp is skipped; content
 * fields are never read.
 */
function claudeUsageFromFile(path: string): ArtifactUsage[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: ArtifactUsage[] = [];
  for (const line of text.split("\n")) {
    let parsed: ClaudeUsageLine;
    try {
      parsed = JSON.parse(line ?? "") as ClaudeUsageLine;
    } catch {
      continue;
    }
    const { timestamp, message } = parsed;
    const usage = message?.usage;
    if (typeof message?.model !== "string" || message.model === "") continue;
    if (typeof usage !== "object" || usage === null) continue;
    const at = Date.parse(typeof timestamp === "string" ? timestamp : "");
    if (Number.isNaN(at)) continue;
    const input = finiteToken(usage.input_tokens);
    const output = finiteToken(usage.output_tokens);
    if (input === null || output === null) continue;
    const cached = finiteToken(usage.cache_read_input_tokens) ?? 0;
    records.push({ model: message.model, inputTokens: input, outputTokens: output, cachedTokens: cached, at });
  }
  return records;
}

/**
 * Every Claude Code per-request usage record under the projects root, via
 * the shared {@link claudeJsonlFiles} walk (no second traversal). Fail-open:
 * a missing directory or unreadable/corrupt file contributes nothing.
 */
export function claudeUsageRecords(): ArtifactUsage[] {
  const records: ArtifactUsage[] = [];
  for (const path of claudeJsonlFiles()) records.push(...claudeUsageFromFile(path));
  return records;
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/sessions/**/*.jsonl
// ---------------------------------------------------------------------------

type CodexLine = {
  timestamp?: unknown;
  type?: unknown;
  payload?: {
    type?: unknown;
    error?: unknown;
  };
};

/** Codex rollout markers: TurnComplete.error, TurnAborted, compacted. */
function codexMarkersFromFile(path: string): ArtifactMarker[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const sessionId =
    safeSessionId(
      path
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.jsonl$/, "") ?? "",
    ) ?? dedupKey([path]).slice(0, 16);
  const markers: ArtifactMarker[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    let parsed: CodexLine;
    try {
      parsed = JSON.parse(lines[i] ?? "") as CodexLine;
    } catch {
      continue;
    }
    const type = parsed.type ?? parsed.payload?.type;
    const at = safeTimestamp(parsed.timestamp);
    if (type === "compacted") {
      markers.push({
        harness: "codex",
        session_id: sessionId,
        kind: "compaction",
        tool_name: null,
        outcome: null,
        seq: null,
        at,
        dedup_key: dedupKey(["codex", sessionId, "compaction", i]),
      });
      continue;
    }
    if (type === "TurnAborted") {
      markers.push({
        harness: "codex",
        session_id: sessionId,
        kind: "terminal",
        tool_name: null,
        outcome: "aborted",
        seq: null,
        at,
        dedup_key: dedupKey(["codex", sessionId, "terminal", i, "aborted"]),
      });
      continue;
    }
    if (type === "TurnComplete") {
      const hasError = parsed.payload?.error !== undefined && parsed.payload?.error !== null;
      markers.push({
        harness: "codex",
        session_id: sessionId,
        kind: "terminal",
        tool_name: null,
        outcome: hasError ? "errored" : "clean",
        seq: null,
        at,
        dedup_key: dedupKey(["codex", sessionId, "terminal", i, hasError ? "errored" : "clean"]),
      });
    }
  }
  return markers;
}

function codexMarkers(): ArtifactMarker[] {
  const markers: ArtifactMarker[] = [];
  for (const path of codexJsonlFiles()) markers.push(...codexMarkersFromFile(path));
  return markers;
}

// ---------------------------------------------------------------------------
// Codex usage records (#150): rollout token usage per line
// ---------------------------------------------------------------------------

type CodexUsageLine = {
  timestamp?: unknown;
  payload?: {
    type?: unknown;
    model?: unknown;
    created_at?: unknown;
    info?: {
      last_token_usage?: unknown;
      created_at?: unknown;
    } | null;
    usage?: unknown;
  } | null;
  usage?: unknown;
};

type CodexUsageShape = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_read?: unknown;
};

/**
 * Pick one request-scoped usage object for a rollout line:
 * `payload.info.last_token_usage` first, then `payload.usage`, then the
 * top-level `usage`. `total_token_usage` is deliberately never consulted —
 * it is CUMULATIVE across the session and would over-count every request.
 */
function codexLineUsage(parsed: CodexUsageLine): CodexUsageShape | null {
  const candidates = [
    parsed.payload?.info?.last_token_usage,
    parsed.payload?.usage,
    parsed.usage,
  ] as const;
  for (const candidate of candidates) {
    if (typeof candidate === "object" && candidate !== null) return candidate as CodexUsageShape;
  }
  return null;
}

/**
 * Usage records from one Codex rollout file. Rollout usage lines do not
 * carry the model id — it sits on `session_meta` / `turn_context` lines
 * (`payload.model`, current model wins) — so the model is tracked per file
 * and attached to each usage line. OpenAI's `input_tokens` INCLUDES cached
 * tokens, so the record reports `inputTokens = max(0, input_tokens -
 * cachedTokens)` — the matcher's convention (agent input excludes cached).
 * Timestamp: `parsed.timestamp`, then `payload.created_at`, then
 * `payload.info.created_at`; a line with no parseable timestamp, no known
 * model, or non-finite tokens is skipped. Content fields are never read.
 */
function codexUsageFromFile(path: string): ArtifactUsage[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: ArtifactUsage[] = [];
  let model: string | null = null;
  for (const line of text.split("\n")) {
    let parsed: CodexUsageLine;
    try {
      parsed = JSON.parse(line ?? "") as CodexUsageLine;
    } catch {
      continue;
    }
    if (
      (parsed.payload?.type === "session_meta" || parsed.payload?.type === "turn_context") &&
      typeof parsed.payload.model === "string" &&
      parsed.payload.model !== ""
    ) {
      model = parsed.payload.model;
    }
    const usage = codexLineUsage(parsed);
    if (usage === null || model === null) continue;
    const inputRaw = finiteToken(usage.input_tokens);
    const output = finiteToken(usage.output_tokens);
    if (inputRaw === null || output === null) continue;
    const cached =
      finiteToken(usage.cached_input_tokens) ?? finiteToken(usage.cache_read) ?? 0;
    const at = [parsed.timestamp, parsed.payload?.created_at, parsed.payload?.info?.created_at]
      .map((value) => (typeof value === "string" ? Date.parse(value) : Number.NaN))
      .find((ms) => !Number.isNaN(ms));
    if (at === undefined) continue;
    records.push({
      model,
      inputTokens: Math.max(0, inputRaw - cached),
      outputTokens: output,
      cachedTokens: cached,
      at,
    });
  }
  return records;
}

/**
 * Every Codex per-request usage record under the sessions root, via the
 * shared {@link codexJsonlFiles} walk (no second traversal). Fail-open: a
 * missing directory or unreadable/corrupt file contributes nothing.
 */
export function codexUsageRecords(): ArtifactUsage[] {
  const records: ArtifactUsage[] = [];
  for (const path of codexJsonlFiles()) records.push(...codexUsageFromFile(path));
  return records;
}

// ---------------------------------------------------------------------------
// OpenCode: SQLite message/part rows
// ---------------------------------------------------------------------------

type OpencodeToolPart = { type?: unknown; tool?: unknown; state?: { status?: unknown } };
type OpencodeStepPart = { type?: unknown };
type OpencodeReasoningPart = { type?: unknown };

/**
 * OpenCode markers from its SQLite store, read-only. Tool parts carry
 * `state.status` ("error" vs otherwise); compaction shows up as parts of
 * type "compaction". The `message` table's `data` JSON is parsed for part
 * types only — never text fields.
 */
function opencodeMarkers(): ArtifactMarker[] {
  const dbPath = opencodeDbPath();
  if (dbPath === null) return [];
  try {
    // Lazy node:sqlite load (platform-gated), same bridge as local-usage.ts.
    const require_ = createRequire(import.meta.url);
    const { DatabaseSync } = require_("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        options?: { readOnly?: boolean },
      ) => {
        prepare(sql: string): { all(): unknown[] };
        close(): void;
      };
    };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT id, data FROM message ORDER BY time_created")
        .all() as unknown as { id: string; data: string }[];
      const markers: ArtifactMarker[] = [];
      for (const row of rows) {
        const sessionId = safeSessionId(row.id) ?? dedupKey(["opencode", row.id]).slice(0, 16);
        let parsed: { parts?: unknown };
        try {
          parsed = JSON.parse(row.data) as { parts?: unknown };
        } catch {
          continue;
        }
        if (!Array.isArray(parsed.parts)) continue;
        let toolSeq = 0;
        for (let i = 0; i < parsed.parts.length; i += 1) {
          const part = parsed.parts[i] as OpencodeToolPart &
            OpencodeStepPart &
            OpencodeReasoningPart;
          if (typeof part !== "object" || part === null) continue;
          if (part.type === "tool") {
            const status = (part.state as { status?: unknown } | undefined)?.status;
            if (status === "pending" || status === undefined) continue;
            const toolName = safeToolName(part.tool);
            if (toolName === null) continue;
            markers.push({
              harness: "opencode",
              session_id: sessionId,
              kind: "tool",
              tool_name: toolName,
              outcome: status === "error" ? "error" : "ok",
              seq: toolSeq,
              at: null,
              dedup_key: dedupKey(["opencode", sessionId, "tool", toolSeq, toolName]),
            });
            toolSeq += 1;
          } else if (part.type === "compaction") {
            markers.push({
              harness: "opencode",
              session_id: sessionId,
              kind: "compaction",
              tool_name: null,
              outcome: null,
              seq: null,
              at: null,
              dedup_key: dedupKey(["opencode", sessionId, "compaction", i]),
            });
          }
        }
      }
      return markers;
    } finally {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
  } catch {
    // corrupt/locked db, missing node:sqlite — fail open, contribute nothing
    return [];
  }
}

// ---------------------------------------------------------------------------
// Aggregation + persistence
// ---------------------------------------------------------------------------

/** Per-session behavioral rollup computed over stored/imported markers. */
export type SessionBehaviorStats = {
  harness: ImportHarness;
  session_id: string;
  toolCalls: number;
  toolErrors: number;
  compacted: number;
  terminal: "clean" | "aborted" | "errored" | null;
};

export function sessionStats(markers: readonly ArtifactMarker[]): SessionBehaviorStats[] {
  const bySession = new Map<string, ArtifactMarker[]>();
  for (const marker of markers) {
    const key = `${marker.harness}\u0000${marker.session_id}`;
    const bucket = bySession.get(key);
    if (bucket) bucket.push(marker);
    else bySession.set(key, [marker]);
  }
  const stats: SessionBehaviorStats[] = [];
  for (const [key, bucket] of bySession) {
    const [harness, sessionId] = key.split("\u0000") as [ImportHarness, string];
    const tools = bucket.filter((m) => m.kind === "tool");
    const terminals = bucket.filter((m) => m.kind === "terminal");
    // Last terminal marker wins when a session logs several turns.
    const lastTerminal = terminals[terminals.length - 1];
    const terminal = lastTerminal !== undefined ? lastTerminal.outcome : null;
    stats.push({
      harness,
      session_id: sessionId,
      toolCalls: tools.length,
      toolErrors: tools.filter((m) => m.outcome === "error").length,
      compacted: bucket.filter((m) => m.kind === "compaction").length,
      terminal: terminal === "ok" || terminal === "error" ? null : terminal,
    });
  }
  stats.sort((a, b) =>
    a.harness < b.harness ? -1 : a.harness > b.harness ? 1 : a.session_id < b.session_id ? -1 : 1,
  );
  return stats;
}

export type ImportResult = {
  harnesses: readonly ImportHarness[];
  filesRead: number;
  markersRead: number;
  /** New rows written — 0 on a re-import (idempotency). */
  inserted: number;
  /** Distinct sessions now covered per harness. */
  sessions: Readonly<Record<string, number>>;
};

/**
 * Import every requested harness's markers. Nothing is scanned in the
 * background — this runs only when the import command invokes it. Missing
 * directories / stores contribute nothing (fail-open), mirroring
 * `local-usage.ts`.
 */
export async function importArtifacts(
  db: {
    prepare(sql: string): { run(...args: unknown[]): unknown };
  },
  harnesses: readonly ImportHarness[],
  insertTimestamp: string = new Date().toISOString(),
): Promise<ImportResult> {
  const all: ArtifactMarker[] = [];
  let filesRead = 0;
  if (harnesses.includes("claude")) {
    const markers = claudeMarkers();
    filesRead += countClaudeFiles();
    all.push(...markers);
  }
  if (harnesses.includes("codex")) {
    const markers = codexMarkers();
    filesRead += countCodexFiles();
    all.push(...markers);
  }
  if (harnesses.includes("opencode")) all.push(...opencodeMarkers());

  const insert = db.prepare(
    "INSERT OR IGNORE INTO imported_artifacts " +
      "(dedup_key, harness, session_id, kind, tool_name, outcome, seq, at, imported_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  let inserted = 0;
  for (const marker of all) {
    const result = insert.run(
      marker.dedup_key,
      marker.harness,
      marker.session_id,
      marker.kind,
      marker.tool_name,
      marker.outcome,
      marker.seq,
      marker.at,
      insertTimestamp,
    ) as { changes?: number | bigint };
    inserted += typeof result.changes === "number" ? result.changes : 0;
  }

  const sessions: Record<string, number> = {};
  for (const stat of sessionStats(all)) {
    sessions[stat.harness] = (sessions[stat.harness] ?? 0) + 1;
  }
  return {
    harnesses: [...harnesses],
    filesRead,
    markersRead: all.length,
    inserted,
    sessions,
  };
}

let claudeFileCount = 0;
function countClaudeFiles(): number {
  if (claudeFileCount === 0) claudeFileCount = claudeJsonlFiles().length;
  return claudeFileCount;
}

let codexFileCount = 0;
function countCodexFiles(): number {
  if (codexFileCount === 0) codexFileCount = codexJsonlFiles().length;
  return codexFileCount;
}
