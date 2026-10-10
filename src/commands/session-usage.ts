import type { Session } from "../api/client.js";
import { getLogs, LOG_PAGE_MAX } from "../api/logs.js";
import { currencySymbol, num } from "../cli/output.js";

export type SessionUsageEntry = {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost: number;
  currency: string | null;
};

export type SessionUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
  currency: string | null;
};

export function sumSessionUsage(entries: SessionUsageEntry[]): SessionUsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cost = 0;
  let currency: string | null = null;
  for (const entry of entries) {
    inputTokens += entry.input_tokens ?? 0;
    outputTokens += entry.output_tokens ?? 0;
    cachedTokens += entry.cached_tokens ?? 0;
    const parsed = Number(entry.cost);
    if (Number.isFinite(parsed)) cost += parsed;
    currency ??= entry.currency;
  }
  return { inputTokens, outputTokens, cachedTokens, cost, currency };
}

export function sessionUsageFooter(totals: SessionUsageTotals): string | null {
  if (totals.inputTokens + totals.outputTokens === 0) return null;
  const { currency } = totals;
  // Unknown currency codes print bare (currencySymbol's documented behavior).
  const symbol = currency ? currencySymbol(currency) : "$";
  const suffix = currency && currency !== "usd" ? ` (${currency})` : "";
  const cached = totals.cachedTokens > 0 ? ` · ${num(totals.cachedTokens)} cached` : "";
  return `aiand ▸ session: ${num(totals.inputTokens)} in / ${num(totals.outputTokens)} out${cached} · ${symbol}${totals.cost.toFixed(4)}${suffix}`;
}

// Overall bound on the post-exit usage fetch: the footer may never delay exit.
const USAGE_FOOTER_TIMEOUT_MS = 1500;

/**
 * Totals for one session's launch, from the logs API: entries at or after
 * `startMs` (client-side — the API has no since-filter), one bounded page,
 * null on any failure so the footer can never break or delay the exit. The
 * fetch itself aborts at USAGE_FOOTER_TIMEOUT_MS, so a hung gateway bounds
 * the exit instead of racing a timer (the abort destroys the socket, which
 * would otherwise keep the event loop alive past the race).
 * ponytail: single 1h/100-row window — sessions longer than that undercount;
 * paginate only if that ever matters. Logs are org-scoped, so concurrent
 * sessions on the same account are summed into one session's footer.
 */
export async function fetchSessionUsage(
  session: Session,
  startMs: number,
): Promise<SessionUsageTotals | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_FOOTER_TIMEOUT_MS);
  timer.unref();
  try {
    const page = await getLogs(session, {
      range: "1h",
      limit: LOG_PAGE_MAX,
      signal: controller.signal,
    });
    const entries = page.data
      .filter((entry) => Date.parse(entry.created_at) >= startMs)
      .map((entry) => ({
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        cached_tokens: entry.cached_tokens,
        cost: Number(entry.cost),
        currency: entry.currency,
      }));
    return sumSessionUsage(entries);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
