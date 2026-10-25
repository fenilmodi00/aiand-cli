import { currencySymbol, num, style } from "../cli/output.js";
import type { Costs, ReportData } from "../report/data.js";

/**
 * `aiand wrapped` (feature catalog F5, ticket #75): the share-friendly
 * period story, built ONLY from the #76 report data engine — no second
 * aggregation. Fun tone, honest labels: every money figure carries its
 * provenance (gateway-billed vs estimated), sessions are explicitly the
 * time-gap heuristic, and `--no-cost` masks every money line.
 */

export const WRAPPED_FORMATS = ["text", "markdown"] as const;
export type WrappedFormat = (typeof WRAPPED_FORMATS)[number];

export type WrappedStory = {
  /** Inclusive range label, e.g. `2026-09-25 to 2026-10-25`. */
  rangeLabel: string;
  timezone: string;
  requests: number;
  sessions: number;
  tokens: { input: number; output: number; cached: number };
  cost: Costs;
  currencyHandling: "single" | "mixed" | "none";
  currency: string | null;
  topSession: {
    id: string;
    harness: string;
    turns: number;
    cost: number | null;
    currency: string | null;
  } | null;
  topPair: { harness: string; model: string; requests: number } | null;
  busiestDay: { day: string; requests: number; cost: Costs } | null;
  topModel: string | null;
  /** estimated(cache savings vs uncached catalog equivalent); null when unknown. */
  savings: number | null;
  /** dominant cost + savings — "what this would have cost at catalog rates". */
  costIfUncached: number | null;
  provenance: Record<string, string>;
};

/**
 * The story from one `ReportData` (pass `top` large enough that
 * `data.sessions` is every session in the window — the engine's session
 * list arrives cost-ranked).
 */
export function buildWrappedStory(data: ReportData): WrappedStory {
  const totals = data.totals;
  const since =
    data.meta.range.since === null ? "the beginning" : data.meta.range.since.slice(0, 10);
  const until = data.meta.range.until === null ? "now" : data.meta.range.until.slice(0, 10);

  const firstSession = data.sessions[0];
  const topPairRow = [...data.matrix].sort(
    (a, b) =>
      b.requests - a.requests ||
      a.harness.localeCompare(b.harness) ||
      a.model.localeCompare(b.model),
  )[0];
  const busiest = [...data.days].sort(
    (a, b) => b.requests - a.requests || a.day.localeCompare(b.day),
  )[0];
  const dominant = dominantCost(totals.costs);

  return {
    rangeLabel: `${since} to ${until}`,
    timezone: data.meta.timezone,
    requests: totals.requests,
    sessions: data.sessions.length,
    tokens: {
      input: totals.inputTokens,
      output: totals.outputTokens,
      cached: totals.cachedTokens,
    },
    cost: totals.costs,
    currencyHandling: data.meta.currencyHandling,
    currency: data.meta.currency,
    topSession:
      firstSession === undefined
        ? null
        : {
            id: firstSession.session_id,
            harness: firstSession.agent,
            turns: firstSession.turns,
            cost: firstSession.cost,
            currency: firstSession.currency,
          },
    topPair:
      topPairRow === undefined
        ? null
        : {
            harness: topPairRow.harness,
            model: topPairRow.model,
            requests: topPairRow.requests,
          },
    busiestDay:
      busiest === undefined
        ? null
        : { day: busiest.day, requests: busiest.requests, cost: busiest.costs },
    topModel: data.topModels[0]?.key ?? null,
    savings: totals.savings,
    costIfUncached: totals.savings === null || dominant === null ? null : dominant + totals.savings,
    provenance: data.meta.provenance,
  };
}

function dominantCost(costs: Costs): number | null {
  let best: number | null = null;
  for (const value of Object.values(costs)) {
    if (best === null || value > best) best = value;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function money(value: number, currency: string | null): string {
  const symbol = currencySymbol(currency);
  const code = currency === null || currency === "usd" ? "" : `${currency} `;
  return `${code}${symbol}${value.toFixed(2)}`;
}

function costCell(costs: Costs): string {
  const entries = Object.entries(costs);
  if (entries.length === 0) return "not billed";
  if (entries.length === 1) {
    const [code, value] = entries[0]!;
    return money(value, code === "" ? null : code);
  }
  // Mixed: per-currency, never summed — the honest cell.
  return entries.map(([code, value]) => money(value, code === "" ? null : code)).join(" + ");
}

/** Compact token count: 1.2M, 320.5K, 999. */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/**
 * The story as text (pastes cleanly) or markdown (posts cleanly). One
 * string, no trailing newline; `showCost: false` masks every money figure
 * but keeps the story structure.
 */
export function renderWrappedText(
  story: WrappedStory,
  options: { format: WrappedFormat; showCost: boolean },
): string {
  const md = options.format === "markdown";
  const heading = (text: string): string => (md ? `## ${text}` : style.bold(text));
  const bullet = (text: string): string => (md ? `- ${text}` : `  ${text}`);
  const lines: string[] = [];

  if (story.requests === 0) {
    lines.push(`${heading("ai& wrapped")} — ${story.rangeLabel} (${story.timezone})`);
    lines.push("");
    lines.push(
      "No activity in the local store for this window yet — " +
        "run any ai& command to sync, then wrap again.",
    );
    return lines.join("\n");
  }

  lines.push(`${heading("ai& wrapped")} — ${story.rangeLabel} (${story.timezone})`);
  lines.push("");

  lines.push(
    bullet(
      `${num(story.requests)} request${story.requests === 1 ? "" : "s"} across ` +
        `${num(story.sessions)} time-gap session${story.sessions === 1 ? "" : "s"}.`,
    ),
  );
  const cachedShare =
    story.tokens.input > 0 ? Math.round((story.tokens.cached / story.tokens.input) * 100) : 0;
  lines.push(
    bullet(
      `${compactTokens(story.tokens.input)} prompt / ${compactTokens(story.tokens.output)} ` +
        `output tokens — ${cachedShare}% of prompt tokens served from cache.`,
    ),
  );

  if (options.showCost) {
    lines.push(bullet(`Spend: ${costCell(story.cost)}.`));
    if (story.topSession !== null) {
      const sessionCost =
        story.topSession.cost === null
          ? "not billed"
          : money(story.topSession.cost, story.topSession.currency ?? story.currency);
      lines.push(
        bullet(
          `Biggest session: ${story.topSession.id} — ${sessionCost} over ` +
            `${num(story.topSession.turns)} turn${story.topSession.turns === 1 ? "" : "s"} ` +
            `(${story.topSession.harness}).`,
        ),
      );
    }
  }
  if (story.topPair !== null) {
    lines.push(
      bullet(
        `Favorite pairing: ${story.topPair.harness} + ${story.topPair.model} ` +
          `(${num(story.topPair.requests)} request${story.topPair.requests === 1 ? "" : "s"}).`,
      ),
    );
  } else if (story.topModel !== null) {
    lines.push(bullet(`Top model: ${story.topModel}.`));
  }
  if (story.busiestDay !== null) {
    const dayCost =
      options.showCost && Object.keys(story.busiestDay.cost).length > 0
        ? ` (${costCell(story.busiestDay.cost)})`
        : "";
    lines.push(
      bullet(
        `Busiest day: ${story.busiestDay.day} ` +
          `(${num(story.busiestDay.requests)} request${story.busiestDay.requests === 1 ? "" : "s"})` +
          `${dayCost}.`,
      ),
    );
  }
  if (options.showCost && story.savings !== null && story.costIfUncached !== null) {
    lines.push(
      bullet(
        `Cache + catalog prices saved an estimated ${money(story.savings, story.currency)} — ` +
          `the same tokens would have cost about ` +
          `${money(story.costIfUncached, story.currency)} at uncached catalog rates.`,
      ),
    );
  }
  if (options.showCost && story.currencyHandling === "mixed") {
    lines.push(bullet(style.yellow("Mixed currencies — costs shown per currency, never summed.")));
  }

  lines.push("");
  lines.push(
    style.dim(
      `cost: ${story.provenance.cost ?? "gateway-billed"} · savings: ` +
        `${story.provenance.savings ?? "estimated"} · sessions: ` +
        `${story.provenance.sessions ?? "heuristic (time-gap)"}`,
    ),
  );
  return lines.join("\n");
}
