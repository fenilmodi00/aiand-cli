import { EOL } from "node:os";
import type { Session } from "../api/client.js";
import { getLogs, LOG_PAGE_MAX } from "../api/logs.js";
import { currencySymbol, num, style } from "../cli/output.js";

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

/**
 * TTY exit receipt, TogetherLink-style: dim header naming the agent and
 * duration, then a value row over a dim label row. Four cells (spent / in /
 * cached / out) at width >= 34, the two costliest two (spent / out) below.
 * Null when there is nothing to show (caller keeps its one-liner path).
 */
export function sessionReceipt(
  totals: SessionUsageTotals,
  agentLabel: string,
  durationMs: number,
  width: number,
): string | null {
  if (totals.inputTokens + totals.outputTokens === 0) return null;
  const symbol = totals.currency ? currencySymbol(totals.currency) || "$" : "$";
  const suffix = totals.currency && totals.currency !== "usd" ? ` (${totals.currency})` : "";
  const cells =
    width >= 34
      ? [
          money(totals.cost, symbol, suffix),
          compact(totals.inputTokens),
          compact(totals.cachedTokens),
          compact(totals.outputTokens),
        ]
      : [money(totals.cost, symbol, suffix), compact(totals.outputTokens)];
  const labels = width >= 34 ? ["spent", "in", "cached", "out"] : ["spent", "out"];
  const cellWidth = Math.min(12, Math.floor((width - 2) / 4));
  const valueRow =
    style.bold(cells[0]!) +
    " " +
    cells
      .slice(1)
      .map((c) => pad(c, cellWidth))
      .join(" ");
  const labelRow =
    pad("spent", cellWidth) +
    " " +
    labels
      .slice(1)
      .map((l) => pad(l, cellWidth))
      .join(" ");
  return [
    "",
    style.dim(`Session receipt · ${agentLabel} · ${duration(durationMs)}`),
    valueRow,
    labelRow,
  ].join(EOL);
}

function pad(s: string, to: number): string {
  return s.length >= to ? s : " ".repeat(to - s.length) + s;
}

function compact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}

function money(cost: number, symbol: string, suffix: string): string {
  if (!Number.isFinite(cost)) return `${symbol}—`;
  if (cost > 0 && cost < 0.01) return `${symbol}${cost.toFixed(4)}`;
  return `${symbol}${cost.toFixed(2)}${suffix}`;
}

function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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
