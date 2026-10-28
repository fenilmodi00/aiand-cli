import { ApiError } from "../cli/errors.js";
import { requestJson, type Session } from "./client.js";

const LOGS_UNAVAILABLE_HINT =
  "Request logs are not served on this gateway. Use `aiand usage` for org totals.";

export const LOG_RANGES = ["15m", "1h", "6h", "24h", "7days", "30days"] as const;
type LogRange = (typeof LOG_RANGES)[number];

/** Largest page the logs endpoint serves in one request. */
export const LOG_PAGE_MAX = 100;

export type LogEntry = {
  id: string;
  model: string;
  api_key: string;
  status_code: number;
  ttft_ms: number | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost: string | null;
  currency: string | null;
  created_at: string;
  /** Wire-dialect request path the gateway served ("/v1/chat/completions", "/v1/messages", "/v1/responses"); null when not served. */
  endpoint: string | null;
};

export type LogPage = {
  data: LogEntry[];
  has_more: boolean;
  next_after: string | null;
  next_after_id: string | null;
};

export type LogQuery = {
  range?: LogRange;
  errorsOnly?: boolean;
  limit?: number;
  after?: string;
  afterId?: string;
};

export async function getLogs(session: Session, query: LogQuery = {}): Promise<LogPage> {
  try {
    return await requestJson<LogPage>(session, {
      path: "/logs",
      query: {
        range: query.range,
        errors: query.errorsOnly ? "true" : undefined,
        limit: query.limit,
        after: query.after,
        after_id: query.afterId,
      },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError(404, "Request logs are not available.", {
        requestId: error.requestId,
        type: error.type,
        hint: LOGS_UNAVAILABLE_HINT,
      });
    }
    throw error;
  }
}

export type PagedLogs = {
  entries: LogEntry[];
  /** True when more rows exist than fit in `entries` (limit hit or page over-delivered). */
  truncated: boolean;
  /** Cursor pair of the last entry served — threads (created_at,id) through the outer sync loop. */
  lastCursor: { createdAt: string; id: string } | null;
};

export async function getLogsPaged(
  session: Session,
  query: LogQuery & { limit: number },
): Promise<PagedLogs> {
  const collected: LogEntry[] = [];
  let after = query.after;
  let afterId = query.afterId;
  let truncated = false;

  for (;;) {
    const page = await getLogs(session, {
      ...query,
      limit: Math.min(LOG_PAGE_MAX, query.limit - collected.length),
      after,
      afterId,
    });
    collected.push(...page.data);
    if (!page.has_more || !page.next_after || !page.next_after_id) break;
    if (collected.length >= query.limit) {
      truncated = true;
      break;
    }
    after = page.next_after;
    afterId = page.next_after_id;
  }

  const last = collected.length > 0 ? collected[collected.length - 1] : undefined;
  return {
    entries: collected.slice(0, query.limit),
    truncated: truncated || collected.length > query.limit,
    lastCursor: last ? { createdAt: last.created_at, id: last.id } : null,
  };
}
