import { openSession } from "../api/client.js";
import { bool, int, oneOf, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import type { Column } from "../cli/output.js";
import { currencySymbol, err, heading, json, num, out, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { bootstrapDelta, type CI95 } from "../obs/evidence.js";
import {
  annotatedPairRow,
  buildPairStats,
  MIN_SAMPLE_SESSIONS,
  type PairSortKey,
  type PairStatsRow,
  sortPairs,
} from "../obs/pair-stats.js";
import { getStoreInfo, noSyncRequested, syncStore } from "../store/index.js";
import { resolveGapMinutes, sessionizationNote } from "../store/sessions.js";
import {
  cohortFromFlags,
  parseWindowFlags,
  readHarnessRows,
  windowEnvelopes,
} from "./harness-stats.js";
import { isValidTimezone } from "./usage-report.js";

/** Behavioral sort keys rank on envelope-derived columns (#130). */
function isBehavioralSort(key: PairSortKey): boolean {
  return key === "tool-err" || key === "one-shot";
}

/**
 * `aiand recommend` (ticket #79, feature catalog C4): rank the (harness,
 * model) pairs on the user's OWN observed traffic — never synthetic — and
 * suggest the one-command wiring change to the cheapest pair. Transparent
 * sorting, no hidden weights: primary cost/session median, tie-break
 * hit-ratio desc then ttft p50 asc; `--sort` re-sorts on any component.
 *
 * Min-sample guard: pairs with fewer than MIN_SAMPLE_SESSIONS sessions are
 * shown in an "insufficient data" block with their sample count and are
 * NEVER ranked — a median over too few sessions is a guess, and this engine
 * does not guess.
 */

const SORT_KEYS: readonly PairSortKey[] = ["cost", "ttft", "hit", "errors", "tool-err", "one-shot"];

/** #148: default session count for the projected-savings arithmetic. */
const DEFAULT_SESSIONS_PER_MONTH = 200;

/**
 * #148: the decision-quality gate on the recommendation itself. Ranking picks
 * a leader on point estimates; `verdict` says whether the evidence actually
 * separates it: "decisive" only when the leader's cost/session CI is disjoint
 * from every rival's AND excludes 0 ($/session is strictly nonzero). An
 * overlapping interval — or no interval at all — means the data cannot yet
 * tell the pairs apart, and the honest answer is "tied".
 */
function decisionVerdict(
  leader: PairStatsRow,
  rivals: readonly PairStatsRow[],
): {
  verdict: "decisive" | "tied";
  costDeltaCI: CI95 | null;
  tiedWith: string[];
} {
  const leaderCi = leader.costPerSession.ci95;
  const tiedWith: string[] = [];
  if (leaderCi === null || leader.costPerSession.p50 === null) {
    return { verdict: "tied", costDeltaCI: null, tiedWith: rivals.map(pairName) };
  }
  for (const rival of rivals) {
    const rivalCi = rival.costPerSession.ci95;
    // Overlap (or a missing interval) means the data cannot separate them.
    if (rivalCi === null || (leaderCi.lo < rivalCi.hi && leaderCi.hi > rivalCi.lo)) {
      tiedWith.push(pairName(rival));
    }
  }
  if (tiedWith.length > 0) {
    return { verdict: "tied", costDeltaCI: null, tiedWith };
  }
  // Disjoint from every rival: the delta CI is leader − runner-up (the weakest
  // separation the ranking claims), resampled from the observed per-session
  // costs. No per-session vectors → no fabricated interval.
  const runnerUp = rivals[0];
  const costDeltaCI = runnerUp
    ? bootstrapDelta(
        sessionCosts(leader),
        sessionCosts(runnerUp),
        "p50",
        { seed: 42 },
      )
    : null;
  const excludesZero = costDeltaCI !== null && (costDeltaCI.lo > 0 || costDeltaCI.hi < 0);
  if (leaderCi.lo <= 0 || !excludesZero) {
    return { verdict: "tied", costDeltaCI, tiedWith };
  }
  return { verdict: "decisive", costDeltaCI, tiedWith: [] };
}

function pairName(row: PairStatsRow): string {
  return `${row.harness}/${row.model}`;
}

/** Priced per-session costs behind a row (the bootstrapDelta inputs). */
function sessionCosts(row: PairStatsRow): number[] {
  return row.samples
    .map((sample) => sample.cost)
    .filter((value): value is number => value !== null);
}

/**
 * #148: projected monthly savings when switching to the leader. Heuristic
 * point estimate × sessions/month, gated: decisive verdict, usd currency,
 * and a delta CI that excludes 0 — otherwise null (no number is printed,
 * rather than a guess). Never crosses currencies.
 */
function expectedMonthlySavings(
  best: PairStatsRow,
  current: PairStatsRow,
  verdict: "decisive" | "tied",
  sessionsPerMonth: number,
): { usdPerMonth: number; ci95: CI95; sessionsPerMonth: number; label: string } | null {
  const currencyUsd = (current.currency ?? "usd").toLowerCase() === "usd";
  const bestCost = best.costPerSession.p50;
  const curCost = current.costPerSession.p50;
  if (verdict !== "decisive" || !currencyUsd || bestCost === null || curCost === null) return null;
  const perSession = curCost - bestCost;
  if (perSession <= 0) return null; // switching would not save money
  // Delta CI on the per-session SAVINGS (current − leader) resampled from the
  // observed per-session costs; both bounds must clear 0 or no claim is made.
  const deltaCi = bootstrapDelta(sessionCosts(current), sessionCosts(best), "p50", { seed: 42 });
  if (deltaCi === null || deltaCi.lo <= 0) return null; // CI includes 0 → no claim
  return {
    usdPerMonth: perSession * sessionsPerMonth,
    ci95: {
      lo: deltaCi.lo * sessionsPerMonth,
      hi: deltaCi.hi * sessionsPerMonth,
    },
    sessionsPerMonth,
    label: "heuristic (median of past traffic × sessions/month, not a guarantee)",
  };
}

export const help = `${style.bold("aiand recommend")} -- the cheapest (harness, model) pair for YOUR workload

Usage
  aiand recommend [--last 30d]
  aiand recommend --sort ttft
  aiand recommend --harness claude
  aiand recommend --json

Options
  --since <iso>       window start (interpreted in --timezone)
  --until <iso>       window end
  --last <window>     30m, 12h, 1d, 7d, 30d (default), 4w
  --range <window>    alias for --last
  --harness <name>    rank one harness's models only
  --cohort <category> rank same-kind-of-work pairs only (classifier category:
                      Coding, Debugging, …) — excluded, not folded (C6)
  --top <n>           keep only the first n ranked rows
  --sort <key>        cost (default) | ttft | hit | errors | tool-err |
                      one-shot — the ranking keys are the component metrics
                      themselves, so re-sorting is just re-reading the same
                      table; behavioral keys rank only pairs with envelope
                      coverage (others sink, as with unpriced rows)
  --timezone <tz>     IANA timezone for --since/--until interpretation
  --session-gap <min> session gap override (default 10, or sessionGapMinutes)
  --sessions-per-month <n>  sessions/month for the projected-savings line
                      (default 200); savings print only when the verdict is
                      decisive AND the delta CI excludes 0 AND currency is usd
  --no-sync           read the local store without syncing (AIAND_NO_SYNC=1)
  --json              machine-readable output

Scoring (transparent, no hidden weights): ranked by cost/session median asc,
tie-break cache hit-ratio desc, then ttft p50 asc. Pairs with fewer than
${MIN_SAMPLE_SESSIONS} sessions land in the "insufficient data" block with their
sample count and are excluded from the ranking. The expected delta is a
median of PAST traffic labeled heuristic — a hint, not a guarantee. The
recommendation itself is evidence-gated: "decisive" only when the leader's
cost/session 95% CI is disjoint from every rival's and excludes 0; otherwise
"tied" and no savings are projected. Only
observed workload is ranked; synthetic sweeps never enter this command.

Apply prints a one-line wiring change; aiand never switches anything itself.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    range: { type: "string" },
    harness: { type: "string" },
    timezone: { type: "string" },
    "session-gap": { type: "string" },
    cohort: { type: "string" },
    top: { type: "string" },
    sort: { type: "string" },
    "sessions-per-month": { type: "string" },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  if (parsed.positionals.length > 0) {
    throw new CliError(`Unknown argument "${parsed.positionals[0]}".`, {
      hint: "Run `aiand recommend --help` to see the subcommands and flags.",
    });
  }

  const timezone = str(parsed, "timezone") ?? "UTC";
  if (!isValidTimezone(timezone)) {
    throw new CliError(`Unknown timezone "${timezone}".`, {
      hint: "Use an IANA name, e.g. Europe/Berlin.",
    });
  }

  const sortKey = oneOf(parsed, "sort", SORT_KEYS, "cost") as PairSortKey;
  const top = int(parsed, "top");
  if (top !== undefined && (top < 1 || !Number.isFinite(top))) {
    throw new CliError(`Invalid --top value: ${top}.`, { hint: "Use a positive number." });
  }
  // #148: sessions/month projection knob — a positive integer, 200 default.
  const sessionsPerMonth = int(parsed, "sessions-per-month") ?? DEFAULT_SESSIONS_PER_MONTH;
  if (sessionsPerMonth < 1 || !Number.isFinite(sessionsPerMonth)) {
    throw new CliError(`Invalid --sessions-per-month value: ${sessionsPerMonth}.`, {
      hint: "Use a positive number.",
    });
  }
  // --range is an alias for --last (same windows).
  if (str(parsed, "range") !== undefined && str(parsed, "last") === undefined) {
    parsed.values.last = str(parsed, "range");
  }

  if (!(bool(parsed, "no-sync") || noSyncRequested())) {
    try {
      const session = await openSession(resolveProfile(str(parsed, "profile")));
      const result = await syncStore(session);
      if (!result.ok)
        err(style.yellow(`store sync failed (${result.code ?? "error"}): ${result.error}`));
    } catch (error) {
      err(
        style.yellow(
          `store sync skipped: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  const { sinceMs, untilMs } = parseWindowFlags(parsed, timezone);
  const rows = readHarnessRows({ sinceMs, untilMs }, { agents: [], models: [] });
  const storeInfo = getStoreInfo();
  const gapMinutes = resolveGapMinutes(
    str(parsed, "session-gap") === undefined
      ? undefined
      : (int(parsed, "session-gap") ?? undefined),
  );

  // #130: behavioral ranking needs the window's envelopes; read fail-open.
  const envelopes = windowEnvelopes(sinceMs, untilMs);
  const stats = buildPairStats(rows, {
    gapMinutes,
    timezone,
    storeWatermark: storeInfo.newestCreatedAt ?? storeInfo.lastSyncAt,
    range: {
      since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
      until: untilMs === null ? null : new Date(untilMs).toISOString(),
    },
    envelopes,
    // #135: --cohort rides the same classifier seam as stats/compare (C6).
    cohort: cohortFromFlags(parsed, rows),
  });

  const harnessFilter = str(parsed, "harness");
  let pairs = stats.pairs;
  if (harnessFilter !== undefined) pairs = pairs.filter((row) => row.harness === harnessFilter);

  // #130: the ranking states its basis — behavioral columns participate only
  // when at least one pair's cell has envelope coverage.
  const basis = pairs.some((row) => row.behavioral)
    ? isBehavioralSort(sortKey)
      ? "behavioral+request"
      : "request (behavioral columns available)"
    : "request-only (no envelope coverage — behavioral columns not ranked on)";

  const eligible = pairs.filter((row) => row.sessions >= MIN_SAMPLE_SESSIONS);
  const insufficient = pairs
    .filter((row) => row.sessions < MIN_SAMPLE_SESSIONS)
    .sort((a, b) => b.sessions - a.sessions || a.harness.localeCompare(b.harness));
  const ranked = sortPairs(eligible, sortKey).slice(0, top ?? eligible.length);

  const totalSessions = pairs.reduce((sum, row) => sum + row.sessions, 0);
  const range = describeRange(sinceMs, untilMs);

  // #148: evidence gate + savings projection (computed once, shared by both
  // renderers). eligible minus leader are the rivals the CI must beat.
  const gate = ranked.length > 0 ? decisionVerdict(ranked[0]!, ranked.slice(1)) : null;
  const currentRow = currentPair(eligible.length > 0 ? eligible : pairs);
  const savings =
    gate !== null
      ? expectedMonthlySavings(
          ranked[0]!,
          currentRow,
          gate.verdict,
          sessionsPerMonth,
        )
      : null;

  if (bool(parsed, "json")) {
    return json({
      provenance: {
        ...stats.provenance,
        minSampleSessions: MIN_SAMPLE_SESSIONS,
        rankedFrom: "observed-workload-only",
        expectedDelta: "heuristic (median of past traffic, not a guarantee)",
        rankedOn: basis,
        sessionsPerMonth,
        expectedMonthlySavings:
          "heuristic (median of past traffic × sessions/month, not a guarantee)",
      },
      ranked: ranked.map(annotatedPairRow),
      insufficient: insufficient.map((row) => ({
        ...annotatedPairRow(row),
        reason: `insufficient data (${row.sessions} session(s) < ${MIN_SAMPLE_SESSIONS})`,
      })),
      verdict: gate?.verdict ?? "insufficient",
      leader:
        ranked.length > 0 ? { harness: ranked[0]!.harness, model: ranked[0]!.model } : null,
      tiedWith: gate?.tiedWith ?? [],
      costDeltaCI: gate?.costDeltaCI ?? null,
      sessionsPerMonth,
      monthlySavingsUsd: savings?.usdPerMonth ?? null,
      monthlySavingsGated: savings === null,
    });
  }

  heading("recommend · your workload");
  out(
    style.dim(
      `based on your own traffic (${totalSessions} session(s), ${range}); ` +
        `medians, not guarantees · ${sessionizationNote(gapMinutes)}`,
    ),
  );
  out(
    style.dim(
      "costs gateway-billed · medians/deltas heuristic · ratios estimated · " +
        "insufficient data below " +
        `${MIN_SAMPLE_SESSIONS} sessions`,
    ),
  );
  out(style.dim(`ranking basis: ${basis}`));
  out();

  if (ranked.length === 0) {
    out(
      style.yellow(
        `no (harness, model) pair has ${MIN_SAMPLE_SESSIONS}+ sessions in range — ` +
          "nothing to rank yet. Use the harness longer, or widen --last.",
      ),
    );
    renderInsufficient(insufficient);
    return;
  }

  const best = ranked[0]!;
  const current = currentPair(eligible.length > 0 ? eligible : pairs);
  renderRanked(ranked);

  out();
  out(
    `Recommended: harness=${best.harness} model=${best.model} ` +
      `(${costLabel(best)}, n=${best.sessions} sessions)`,
  );
  out(`verdict: ${gate!.verdict}`);
  if (gate!.verdict !== "decisive") {
    out(style.yellow("tied — not distinguishable yet"));
  }
  if (current.harness === best.harness && current.model === best.model) {
    out(
      `Current:      harness=${current.harness} model=${current.model} — already the recommended pair`,
    );
  } else {
    out(
      `Current:      harness=${current.harness} model=${current.model} ` +
        `(${costLabel(current)}, n=${current.sessions} sessions)`,
    );
    out(`Expected delta: ${deltaLine(best, current)} (heuristic)`);
    if (gate!.verdict !== "decisive") {
      out(
        style.yellow(
          `Apply: aiand ${best.harness} on --model ${best.model}` +
            " (evidence tied - not decisive)",
        ),
      );
    } else if (best.harness === "unknown") {
      out(
        style.yellow(
          "Apply: (recommended harness attribution is unknown — map the api key first, e.g. re-run the agent through `aiand <agent>`)",
        ),
      );
    } else {
      out(`Apply: aiand ${best.harness} on --model ${best.model}`);
    }
  }
  if (savings !== null) {
    out(
      style.green(
        `projected savings: ≈ $${savings.usdPerMonth.toFixed(2)}/month at ` +
          `${savings.sessionsPerMonth} sessions/month ` +
          "(cost base: envelope cost/session; heuristic — not a guarantee)",
      ),
    );
  }
  out();
  renderInsufficient(insufficient);
}

// ---------------------------------------------------------------------------
// Current pair + deltas
// ---------------------------------------------------------------------------

/**
 * The de-facto current setup: the pair with the most sessions in range
 * (tie: most requests, then names, for determinism).
 */
function currentPair(pairs: readonly PairStatsRow[]): PairStatsRow {
  return [...pairs].sort(
    (a, b) =>
      b.sessions - a.sessions ||
      b.requests - a.requests ||
      a.harness.localeCompare(b.harness) ||
      a.model.localeCompare(b.model),
  )[0]!;
}

function costLabel(row: PairStatsRow): string {
  if (row.costPerSession.p50 === null) return "unpriced";
  return `${currencySymbol(row.currency ?? "usd")}${row.costPerSession.p50.toFixed(4)} med`;
}

function deltaLine(best: PairStatsRow, current: PairStatsRow): string {
  const parts: string[] = [];
  const bestCost = best.costPerSession.p50;
  const curCost = current.costPerSession.p50;
  if (bestCost !== null && curCost !== null && curCost !== 0) {
    const diff = bestCost - curCost;
    const pct = Math.round((diff / curCost) * 100);
    const sign = diff < 0 ? "-" : "+";
    parts.push(
      `${sign}${currencySymbol(current.currency ?? "usd")}${Math.abs(diff).toFixed(2)}/session ` +
        `(${pct}%)`,
    );
  }
  const hitDiff = best.cacheHitRatio - current.cacheHitRatio;
  parts.push(`hit-ratio ${hitDiff >= 0 ? "+" : "-"}${Math.abs(hitDiff).toFixed(2)}`);
  const bestTtft = best.ttft.p50;
  const curTtft = current.ttft.p50;
  if (bestTtft !== null && curTtft !== null) {
    const diff = Math.round(bestTtft - curTtft);
    parts.push(`ttft p50 ${diff >= 0 ? "+" : "-"}${Math.abs(diff)}ms`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function verdictCell(row: PairStatsRow): string {
  return row.verdict === "good"
    ? style.green(row.verdict)
    : row.verdict === "bad"
      ? style.red(row.verdict)
      : style.yellow(row.verdict);
}

function rankedColumns(): Column<PairStatsRow>[] {
  return [
    { header: "rank", value: () => "", align: "right" },
    { header: "harness", value: (r) => r.harness },
    { header: "model", value: (r) => r.model },
    { header: "n", value: (r) => num(r.sessions), align: "right" },
    { header: "cost/sess", value: (r) => costCell(r), align: "right" },
    {
      header: "ttft p50",
      value: (r) => (r.ttft.p50 === null ? "—" : `${r.ttft.p50.toFixed(0)}ms`),
      align: "right",
    },
    { header: "hit", value: (r) => `${(r.cacheHitRatio * 100).toFixed(1)}%`, align: "right" },
    { header: "errors", value: (r) => `${(r.errorRate * 100).toFixed(1)}%`, align: "right" },
    { header: "verdict", value: (r) => verdictCell(r) },
  ];
}

function costCell(row: PairStatsRow): string {
  if (row.costPerSession.p50 === null) return "—";
  const ci = row.costPerSession.ci95;
  // #148: the interval rides the point estimate — a median without its CI is
  // only half the evidence (bracket omitted when too few priced sessions).
  const bracket = ci ? ` [${ci.lo.toFixed(4)}–${ci.hi.toFixed(4)}]` : "";
  return `${currencySymbol(row.currency ?? "usd")}${row.costPerSession.p50.toFixed(4)}${bracket}`;
}

function renderRanked(rows: PairStatsRow[]): void {
  // `table` computes cells per row without an index; number them here.
  let rank = 0;
  table<PairStatsRow>(
    rows,
    rankedColumns().map((column) =>
      column.header === "rank"
        ? { header: "rank", value: () => String(++rank), align: "right" }
        : column,
    ),
  );
  out(
    style.dim(
      "ranked by cost/session median (tie: hit-ratio desc, ttft p50 asc) — re-sort with --sort cost|ttft|hit|errors",
    ),
  );
}

function renderInsufficient(rows: PairStatsRow[]): void {
  if (rows.length === 0) return;
  heading(`insufficient data (fewer than ${MIN_SAMPLE_SESSIONS} sessions — not ranked)`);
  table<PairStatsRow>(rows, [
    { header: "harness", value: (r) => r.harness },
    { header: "model", value: (r) => r.model },
    { header: "n", value: (r) => num(r.sessions), align: "right" },
    { header: "cost/sess", value: (r) => costCell(r), align: "right" },
  ]);
  out();
}

function describeRange(sinceMs: number | null, untilMs: number | null): string {
  if (sinceMs === null && untilMs === null) return "all stored history";
  const since = sinceMs === null ? "beginning" : new Date(sinceMs).toISOString().slice(0, 10);
  const until = untilMs === null ? "now" : new Date(untilMs).toISOString().slice(0, 10);
  return `${since} → ${until}`;
}
