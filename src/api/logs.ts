import { ApiError } from "../cli/errors.js";
import { requestJson, type Session } from "./client.js";

const LOGS_UNAVAILABLE_HINT =
  "Request logs are not served on this gateway. Use `aiand usage` for org totals.";

export const LOG_RANGES = ["15m", "1h", "6h", "24h", "7days", "30days"] as const;
export type LogRange = (typeof LOG_RANGES)[number];

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

export async function getLogsPaged(
  session: Session,
  query: LogQuery & { limit: number }
): Promise<LogEntry[]> {
  const collected: LogEntry[] = [];
  let after = query.after;
  let afterId = query.afterId;

  while (collected.length < query.limit) {
    const page = await getLogs(session, {
      ...query,
      limit: Math.min(100, query.limit - collected.length),
      after,
      afterId,
    });
    collected.push(...page.data);
    if (!page.has_more || !page.next_after || !page.next_after_id) break;
    after = page.next_after;
    afterId = page.next_after_id;
  }

  return collected;
}
