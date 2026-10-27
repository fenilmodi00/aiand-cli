import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { openSession } from "../api/client.js";
import { err } from "../cli/output.js";
import { buildForecastPayload } from "../commands/forecast.js";
import { payload as harnessComparePayload, readHarnessRows } from "../commands/harness-stats.js";
import { readSessionRows, type SessionCommandRow, toView } from "../commands/sessions.js";
import {
  assertWindowOrder,
  type BlockSection,
  buildReport,
  isValidTimezone,
  parseLast,
  parseSince,
  parseUntil,
  SECTION_REGISTRY,
  type SectionName,
  SORT_COLUMNS,
  TIME_UNITS,
  type TimeUnit,
  UNIT_SECTION,
  unitOfSection,
} from "../commands/usage-report.js";
import { loadConfig, resolveProfile } from "../config.js";
import { budgetFor, loadBudget } from "../obs/budget.js";
import { forecast, readForecastRows } from "../obs/forecast.js";
import { buildHarnessStats } from "../obs/harness-stats.js";
import type { SyncOutcome } from "../store/coverage.js";
import { getStoreInfo, noSyncRequested, syncStore } from "../store/index.js";
import {
  resolveGapMinutes,
  type SessionDetail,
  sessionGapMinutes,
  sessionizeRows,
} from "../store/sessions.js";

/**
 * The `aiand mcp` stdio server (feature catalog G3, ticket #70).
 *
 * A hand-rolled MCP host over stdio — zero runtime deps, per repo law. The
 * transport is exactly the MCP stdio contract: newline-delimited JSON-RPC 2.0
 * messages on stdin/stdout, one response per request, nothing else ever
 * written to stdout (diagnostics go to stderr). Methods: `initialize`,
 * `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
 *
 * The four tools are thin wrappers over the CLI's own JSON engines, so every
 * tool result reuses the `--json` payload shape byte-for-byte in schema —
 * usage_report.buildReport (#60), the #62 sessionizer view, the #64 harness
 * compare payload, and the #74 forecast payload (single source of truth, no
 * divergent duplicates). Each tool performs the shared fail-open pre-read
 * store sync (skipped under `--no-sync` / AIAND_NO_SYNC=1); the store is
 * metadata-only by design, so no prompt or completion content can ever leave
 * the machine through this server.
 *
 * Privacy (the CodeBurn posture): harness/project names are pseudonymized
 * (`project-a1b2`, sha256-derived, stable within and across runs) unless
 * `mcp.realProjectNames` is true in config.json
 * (`aiand config set mcp.realProjectNames true`). Session ids are already
 * sha256-derived by the #66 sessionizer; model ids are gateway catalog ids,
 * not project names, and stay verbatim.
 */

// ---------------------------------------------------------------------------
// JSON-RPC over newline-delimited stdio
// ---------------------------------------------------------------------------

/** Protocol versions this server speaks; the client's is echoed when known. */
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

type RpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type RpcResult = { jsonrpc: "2.0"; id: string | number | null; result: unknown };
type RpcError = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
};

const ERR_PARSE = -32700;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;

type McpServerIo = {
  input: NodeJS.ReadableStream;
  output: { write(chunk: string): unknown };
};

export type McpServerOptions = McpServerIo & {
  /** Server version reported in `initialize` (the CLI's VERSION). */
  version: string;
  /** The `--no-sync` flag; AIAND_NO_SYNC=1 is honored as well. */
  noSync?: boolean;
  /** The `--profile` flag (or AIAND_PROFILE), forwarded so unknown profiles warn (#103). */
  profile?: string;
};

/**
 * Run the server until stdin closes. Writes nothing but JSON-RPC responses to
 * `output`; returns cleanly when the input ends (the MCP client went away).
 */
export async function runMcpServer(options: McpServerOptions): Promise<void> {
  // #103: resolve up front so an explicit unknown --profile / AIAND_PROFILE
  // warns once at startup instead of silently serving the default profile.
  resolveProfile(options.profile); // #103
  const context: ServerContext = {
    noSync: options.noSync === true || noSyncRequested(),
    profile: options.profile,
    version: options.version,
  };
  const lines = createInterface({ input: options.input });
  const respond = (message: RpcResult | RpcError): void => {
    options.output.write(`${JSON.stringify(message)}\n`);
  };

  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let message: RpcMessage;
    try {
      message = JSON.parse(trimmed) as RpcMessage;
    } catch {
      respond({
        jsonrpc: "2.0",
        id: null,
        error: { code: ERR_PARSE, message: "Parse error: line is not valid JSON." },
      });
      continue;
    }
    if (typeof message.method !== "string") continue;
    if (message.id === undefined || message.id === null) continue; // notification
    try {
      const result = await handleMessage(message, context);
      respond({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      respond(rpcError(message.id, error));
    }
  }
}

function rpcError(id: string | number | null, error: unknown): RpcError {
  if (error instanceof RpcParamError) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: ERR_INVALID_PARAMS, message: error.message, data: error.data },
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: ERR_METHOD_NOT_FOUND,
      message: error instanceof Error ? error.message : String(error ?? "unknown error"),
    },
  };
}

/** A tool-call argument that fails the tool's documented schema. */
class RpcParamError extends Error {
  data?: unknown;
  constructor(message: string, data?: unknown) {
    super(message);
    this.data = data;
  }
}

async function handleMessage(message: RpcMessage, context: ServerContext): Promise<unknown> {
  switch (message.method) {
    case "initialize": {
      const requested =
        typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : null;
      const protocolVersion =
        requested !== null && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "aiand", title: "ai& observability", version: context.version },
        instructions:
          "Query local gateway usage metadata (spend, tokens, sessions, harness comparison) " +
          "computed from the local request store. Costs are gateway-billed sums per currency " +
          "(costs.usd is in USD units); time windows are ISO timestamps or <n><m|h|d|w> " +
          "relative windows. Harness/project names are pseudonymized unless the user opted in.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    case "tools/call": {
      const name = typeof message.params?.name === "string" ? message.params.name : null;
      const tool = name === null ? undefined : TOOLS.find((entry) => entry.name === name);
      if (!tool) {
        throw new RpcParamError(`Unknown tool: ${name ?? "(missing name)"}.`, {
          known: TOOLS.map((entry) => entry.name),
        });
      }
      const args =
        typeof message.params?.arguments === "object" && message.params.arguments !== null
          ? (message.params.arguments as Record<string, unknown>)
          : {};
      let payload: unknown;
      try {
        payload = await tool.call(args, context);
      } catch (error) {
        if (error instanceof RpcParamError) throw error;
        // A tool-level failure (bad window value, mixed currencies, unknown
        // session id) is a tool ERROR result, not a protocol error — the
        // caller sees the message and can adjust its arguments.
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error ?? "tool failed"),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: false,
      };
    }
    default:
      // Plain Error on purpose: rpcError's fallback is -32601 (method not
      // found); RpcParamError would misreport it as invalid params.
      throw new Error(`Method not found: ${String(message.method)}`);
  }
}

// ---------------------------------------------------------------------------
// Tool plumbing: arguments, the shared sync, pseudonymization
// ---------------------------------------------------------------------------

type ServerContext = { noSync: boolean; profile?: string; version: string };

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>, context: ServerContext) => Promise<unknown>;
};

function argString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RpcParamError(`Parameter "${name}" must be a string.`);
  return value;
}

function argStringList(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value as string[];
  }
  throw new RpcParamError(`Parameter "${name}" must be a string or an array of strings.`);
}

function argBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new RpcParamError(`Parameter "${name}" must be a boolean.`);
  return value;
}

function argEnum<T extends string>(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = argString(args, name);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new RpcParamError(`Parameter "${name}" must be one of: ${allowed.join(", ")}.`, {
      got: value,
    });
  }
  return value as T;
}

/**
 * The shared pre-read incremental sync — the ONLY network this server ever
 * touches, and never under `--no-sync` / AIAND_NO_SYNC=1. Fail-open exactly
 * like every other command: a sign-in or network problem is reported on
 * stderr and the tool serves the local store as-is.
 */
async function syncBeforeRead(context: ServerContext): Promise<SyncOutcome> {
  if (context.noSync) return { skipped: true };
  try {
    const session = await openSession(resolveProfile(context.profile)); // #103
    const result = await syncStore(session);
    if (!result.ok) err(`aiand mcp: store sync failed: ${result.error}`);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "sync failed");
    err(`aiand mcp: store sync skipped: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * A stable pseudonym for a harness/project name: `project-` + 4 hex chars of
 * sha256. Deterministic across runs and tools, so a caller can still group by
 * project — it just cannot read the name back. "unknown" (unattributed keys)
 * is not a name and passes through.
 */
function pseudonymizeName(name: string): string {
  if (name === "unknown") return name;
  const hash = createHash("sha256").update(`aiand-mcp-project:${name}`).digest("hex");
  return `project-${hash.slice(0, 4)}`;
}

/** The pseudonymizer to apply: identity when the user opted into real names. */
function projectLabel(real: boolean): (name: string) => string {
  return real ? (name) => name : pseudonymizeName;
}

function realNamesEnabled(): boolean {
  return loadConfig().mcp?.realProjectNames === true;
}

// ---------------------------------------------------------------------------
// Tool implementations — each reuses the CLI's own JSON payload engine
// ---------------------------------------------------------------------------

/** Shared window arguments (since/until/last/timezone), CLI parse semantics. */
function windowOf(args: Record<string, unknown>): {
  sinceMs: number | null;
  untilMs: number | null;
  timezone: string;
} {
  const timezone = argString(args, "timezone") ?? "UTC";
  if (!isValidTimezone(timezone)) {
    throw new RpcParamError(`Parameter "timezone" is not an IANA timezone: ${timezone}.`);
  }
  const since = argString(args, "since");
  const until = argString(args, "until");
  const last = argString(args, "last");
  const sinceMs = since === undefined ? null : parseSince(since, timezone);
  const untilMs = until === undefined ? null : parseUntil(until, timezone);
  const lastSinceMs = last === undefined ? null : parseLast(last, new Date()).sinceMs;
  assertWindowOrder(sinceMs, untilMs);
  return {
    sinceMs:
      sinceMs !== null && lastSinceMs !== null
        ? Math.max(sinceMs, lastSinceMs)
        : (sinceMs ?? lastSinceMs),
    untilMs,
    timezone,
  };
}

const BLOCK_SECTIONS: readonly BlockSection[] = ["daily", "weekly", "monthly", "sessions"];

const usageStatsTool: ToolDefinition = {
  name: "usage_stats",
  description:
    "Usage and spend for this account, computed from the local request store " +
    "(incrementally synced from the gateway first; the store holds metadata only — no " +
    "prompt or completion content). Returns { meta, sections } — the same document as " +
    "`aiand usage --json`. Money is the gateway-billed cost summed PER CURRENCY under " +
    "`costs` (e.g. costs.usd, in USD units — never summed across currencies). Token " +
    "counts: input_tokens includes cached_tokens (gateway convention). Time: pass `last` " +
    'like "7d"/"4w"/"12h"/"30m", and/or `since`/`until` as ISO timestamps (a bare ' +
    "date means midnight/end-of-day in `timezone`, default UTC). Bucket by `by` = day | " +
    "week | month | session.",
  inputSchema: {
    type: "object",
    properties: {
      by: {
        type: "string",
        enum: [...TIME_UNITS],
        description: "Time unit to bucket by (default day).",
      },
      sections: {
        type: "array",
        items: { type: "string", enum: [...SECTION_REGISTRY] },
        description: "Which sections to return (default [daily, totals]).",
      },
      since: { type: "string", description: "Window start: date or ISO timestamp." },
      until: { type: "string", description: "Window end: date or ISO timestamp." },
      last: { type: "string", description: "Relative window, <count><m|h|d|w>, e.g. 7d." },
      timezone: { type: "string", description: "IANA timezone for boundaries (default UTC)." },
      agent: {
        type: "array",
        items: { type: "string" },
        description: "Harness/agent attribution filter (repeatable).",
      },
      harness: {
        type: "array",
        items: { type: "string" },
        description: "Same attribution as agent.",
      },
      model: {
        type: "array",
        items: { type: "string" },
        description: "Model glob filter (* and ? wildcards).",
      },
      include_imported: {
        type: "boolean",
        description: "Fold imported ccusage rows into a combined grand-total section.",
      },
    },
  },
  call: async (args, context) => {
    const by = argEnum(args, "by", TIME_UNITS) ?? "day";
    const rawSections = argStringList(args, "sections");
    let sections: SectionName[];
    let unit: TimeUnit = by;
    if (rawSections.length > 0) {
      for (const name of rawSections) {
        if (!(SECTION_REGISTRY as readonly string[]).includes(name)) {
          throw new RpcParamError(`Unknown section "${name}".`, { known: SECTION_REGISTRY });
        }
      }
      sections = [...new Set(rawSections)] as SectionName[];
      const block = sections.find((name) => (BLOCK_SECTIONS as readonly string[]).includes(name));
      if (block !== undefined) unit = unitOfSection(block as BlockSection);
    } else {
      sections = [UNIT_SECTION[by], "totals"];
    }
    const sync = await syncBeforeRead(context);
    const { sinceMs, untilMs, timezone } = windowOf(args);
    const report = buildReport({
      unit,
      sections,
      timezone,
      sinceMs,
      untilMs,
      filters: {
        agents: [...argStringList(args, "agent"), ...argStringList(args, "harness")],
        models: argStringList(args, "model"),
      },
      sort: argEnum(args, "sort", SORT_COLUMNS) ?? "period",
      order: argEnum(args, "order", ["asc", "desc"] as const) ?? "asc",
      sync,
      includeImported: argBoolean(args, "include_imported") ?? false,
    });
    const payload = { meta: report.meta, sections: report.sections };
    const label = projectLabel(realNamesEnabled());
    const byAgent = payload.sections["by-agent"];
    if (Array.isArray(byAgent)) {
      payload.sections["by-agent"] = (byAgent as { key: string }[]).map((row) => ({
        ...row,
        key: label(row.key),
      }));
    }
    for (const section of BLOCK_SECTIONS) {
      const blocks = payload.sections[section];
      if (Array.isArray(blocks)) {
        payload.sections[section] = (blocks as { agent?: string }[]).map((block) =>
          block.agent === undefined ? block : { ...block, agent: label(block.agent) },
        );
      }
    }
    return payload;
  },
};

const sessionStatsTool: ToolDefinition = {
  name: "session_stats",
  description:
    "Sessions — conversations grouped from stored gateway requests by the time-gap " +
    "heuristic. With `session_id`: one session's drill-down, the same document as " +
    "`aiand sessions <id> --json` (session summary plus per-request rows). Without it: " +
    "the session list, the same as `aiand sessions --json`. Money is gateway-billed per " +
    "currency under `costs` (USD units); tokens: input includes cached. Time windows " +
    "follow `last` (<n><m|h|d|w>) or `since`/`until` ISO stamps in `timezone` (default " +
    "UTC). Session ids are sha256-derived; changing the session gap changes ids.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description:
          "One session's id (from session_stats' list or `aiand sessions`). Omit to list sessions.",
      },
      since: { type: "string", description: "Window start: date or ISO timestamp." },
      until: { type: "string", description: "Window end: date or ISO timestamp." },
      last: { type: "string", description: "Relative window, <count><m|h|d|w>." },
      timezone: { type: "string", description: "IANA timezone for boundaries (default UTC)." },
    },
  },
  call: async (args, context) => {
    await syncBeforeRead(context);
    const { sinceMs, untilMs } = windowOf(args);
    const rows: SessionCommandRow[] = readSessionRows(
      { sinceMs, untilMs },
      { agents: [], models: [] },
    );
    const gapMinutes = sessionGapMinutes();
    const details = sessionizeRows(rows, gapMinutes) as SessionDetail<SessionCommandRow>[];
    const sessionId = argString(args, "session_id");
    if (sessionId !== undefined) {
      const detail = details.find((session) => session.session_id === sessionId);
      if (!detail) {
        // Tool-level failure, not invalid params: the id is well-formed, it
        // just is not in the store — the wrapper renders it as isError:true
        // with the hint so an agent can relist and retry.
        throw new Error(
          `No session with id "${sessionId}" in the local store. ` +
            "Call session_stats without session_id to list the sessions in range.",
        );
      }
      return {
        sessionization: {
          method: "time-gap",
          gapMinutes,
          confidence: "heuristic",
          override: sessionId,
        },
        session: { ...toView(detail), agent: detail.agent },
        requests: detail.rows.map((row) => ({
          id: row.id,
          timestamp: row.created_at,
          model: row.model,
          tokens: {
            input: row.input_tokens ?? 0,
            output: row.output_tokens ?? 0,
            cached: row.cached_tokens ?? 0,
          },
          cost: row.cost_value,
          currency: row.currency,
          latency_ms: row.latency_ms,
          ttft_ms: row.ttft_ms,
          status: row.status_code,
        })),
      };
    }
    const label = projectLabel(realNamesEnabled());
    return {
      sessionization: { method: "time-gap", gapMinutes, confidence: "heuristic" },
      sessions: details.map((detail) => {
        const view = toView(detail);
        return { ...view, harness: label(view.harness) };
      }),
    };
  },
};

const harnessCompareTool: ToolDefinition = {
  name: "harness_compare",
  description:
    "Per-harness stats over your real workload from the local request store — the same " +
    "document as `aiand harness compare --json`: { provenance, harnesses, excluded }. " +
    "Each row: requests/sessions counts, token counts (gateway-billed; input includes " +
    "cached) and cost in the store's currency (USD units), cost per session p50/p90, " +
    "ttft p50/p95 in milliseconds, cacheHitRatio (0-1), errorRate (0-1), verdict " +
    "good|warn|bad, and the contributing sessions. Mixed-model sessions are excluded and " +
    "counted. Time windows: `last` (<n><m|h|d|w>, e.g. 30d) or `since`/`until` in " +
    "`timezone` (default UTC); default is all stored history.",
  inputSchema: {
    type: "object",
    properties: {
      since: { type: "string", description: "Window start: date or ISO timestamp." },
      until: { type: "string", description: "Window end: date or ISO timestamp." },
      last: { type: "string", description: "Relative window, <count><m|h|d|w>." },
      timezone: { type: "string", description: "IANA timezone for boundaries (default UTC)." },
      agent: {
        type: "array",
        items: { type: "string" },
        description: "Attribution filter (repeatable).",
      },
      model: { type: "array", items: { type: "string" }, description: "Model glob filter." },
      harness: { type: "string", description: "Only this harness." },
      "session-gap": {
        type: "number",
        description: "Session gap override in minutes (default 10).",
      },
    },
  },
  call: async (args, context) => {
    await syncBeforeRead(context);
    const { sinceMs, untilMs, timezone } = windowOf(args);
    const gapRaw = args["session-gap"];
    if (
      gapRaw !== undefined &&
      (typeof gapRaw !== "number" || !Number.isFinite(gapRaw) || gapRaw <= 0)
    ) {
      throw new RpcParamError('Parameter "session-gap" must be a positive number of minutes.');
    }
    const gapMinutes = resolveGapMinutes(
      typeof gapRaw === "number" && Number.isFinite(gapRaw) ? gapRaw : undefined,
    );
    const harnessFilter = argString(args, "harness");
    const rows = readHarnessRows(
      { sinceMs, untilMs },
      {
        agents: argStringList(args, "agent"),
        models: argStringList(args, "model"),
      },
    );
    const info = getStoreInfo();
    const stats = buildHarnessStats(rows, {
      gapMinutes,
      timezone,
      storeWatermark: info.newestCreatedAt ?? info.lastSyncAt,
      range: {
        since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
        until: untilMs === null ? null : new Date(untilMs).toISOString(),
      },
    });
    let harnesses = stats.harnesses;
    if (harnessFilter !== undefined) {
      harnesses = harnesses.filter((row) => row.harness === harnessFilter);
      if (harnesses.length === 0) {
        throw new RpcParamError(`No requests attributed to harness "${harnessFilter}" in range.`, {
          hint: "Call without `harness` to see which harnesses have data.",
        });
      }
    }
    const payload = harnessComparePayload(stats, harnesses) as {
      harnesses: { harness: string; samples: { agent: string }[] }[];
      excluded: { agent: string }[];
    };
    const label = projectLabel(realNamesEnabled());
    for (const row of payload.harnesses) {
      row.harness = label(row.harness);
      row.samples = row.samples.map((sample) => ({ ...sample, agent: label(sample.agent) }));
    }
    payload.excluded = payload.excluded.map((sample) => ({
      ...sample,
      agent: label(sample.agent),
    }));
    return payload;
  },
};

const spendCheckTool: ToolDefinition = {
  name: "spend_check",
  description:
    "Budget burn and pacing so you can budget yourself mid-task — the same document as " +
    "`aiand forecast --json`. current_spend.value is the gateway-billed month-to-date " +
    "spend (USD units when currency is usd); burn_rate_24h/burn_rate_7d/headline_rate " +
    "are USD per hour over trailing windows (null/indeterminate when there is too little " +
    "data — rates are never fabricated); projected_month_end extrapolates to the current " +
    "UTC month end; verdict is on-pace | exceeding | indeterminate | no-data | no-budget; " +
    "budget_remaining is budget minus month-to-date (null without a configured budget). " +
    "Optional `harness` scopes to one harness and uses its budget override.",
  inputSchema: {
    type: "object",
    properties: {
      harness: {
        type: "string",
        description: "Scope to one harness (uses budget.harness.<name> when set).",
      },
    },
  },
  call: async (args, context) => {
    await syncBeforeRead(context);
    const budgetConfig = loadBudget();
    const harness = argString(args, "harness");
    // Mixed currencies throw (CliError) — surfaced as a tool error result, a
    // sum would be a guess.
    const { rows } = readForecastRows({ harness: harness ?? undefined });
    const result = forecast({
      rows,
      budget: budgetFor(budgetConfig, harness ?? undefined),
      currency: budgetConfig.currency,
    });
    const payload = buildForecastPayload(result, harness) as { harness: string | null };
    payload.harness =
      payload.harness === null ? null : projectLabel(realNamesEnabled())(payload.harness);
    return payload;
  },
};

const TOOLS: readonly ToolDefinition[] = [
  usageStatsTool,
  sessionStatsTool,
  harnessCompareTool,
  spendCheckTool,
];
