import type { Session } from "../api/client.js";
import { CliError } from "../cli/errors.js";
import { percentile } from "../obs/harness-stats.js";
import {
  type BenchResult,
  type BenchScenario,
  type RunBenchOptions,
  runHarnessBenchmark,
} from "./harness-bench.js";
import { findHarnessLayout, HARNESS_LAYOUTS } from "./harness-layouts.js";

/**
 * The personal A/B duel (feature catalog D2, ticket #82).
 *
 * A duel replays a RECORDED SESSION'S REQUEST SHAPE — the turn count and the
 * per-turn prompt-token growth curve from the local store — across
 * (harness layout, model) pairs, and reports cost / TTFT / cache-hit
 * side by side. What is replayed is the SHAPE, never the words: the store
 * holds no prompt text by design (#61), and every prompt in a duel run is
 * seeded synthetic filler sized to the recorded curve. Nothing that was ever
 * typed by a human leaves the machine, because nothing of the kind is ever
 * read.
 *
 * Determinism (the D4 prerequisite): the same shape + pairs + seed produce
 * byte-identical cost/token tables when the transport is deterministic (the
 * recorded-replay pattern from #67). Filler content is a pure function of the
 * seed and the curve, the price/cost fields come straight from the transport
 * responses, and no clock or randomness enters the reported numbers — callers
 * can inject a fixed `now()` so even the timing fields are reproducible in
 * tests. A LIVE gateway run is still inherently nondeterministic (real
 * tokenization, real latency); the seed is printed with every output so a
 * golden run can be named and repeated offline.
 */

/** One (harness layout, model) configuration under comparison. */
export type DuelPair = { harness: string; model: string };

/** The layout used when a --pair omits `harness=`. */
export const DEFAULT_PAIR_LAYOUT = "omp";

export function parsePair(value: string, knownModels: readonly string[]): DuelPair {
  const harness = /^harness=([^,]+),/.exec(value)?.[1] ?? DEFAULT_PAIR_LAYOUT;
  const model = /(?:^|,)model=(.+)$/.exec(value)?.[1];
  if (!model) {
    throw new CliError(`Invalid --pair value "${value}".`, {
      hint: "Use --pair harness=<layout>,model=<model> (or --pair model=<model> for the default layout), e.g. --pair harness=claude-code,model=zai-org/glm-5.3.",
    });
  }
  if (!findHarnessLayout(harness)) {
    throw new CliError(`Unknown harness layout "${harness}" in --pair.`, {
      hint:
        `Valid layouts: ${HARNESS_LAYOUTS.map((l) => l.id).join(", ")}. ` +
        `Or omit harness= (--pair model=<model>) to use the default layout "${DEFAULT_PAIR_LAYOUT}". ` +
        `Known models: ${
          knownModels.length > 0
            ? knownModels.join(", ")
            : "(none known yet — sync the store or run a sweep)"
        }.`,
    });
  }
  if (knownModels.length > 0 && !knownModels.includes(model)) {
    throw new CliError(`Unknown model "${model}" in --pair.`, {
      hint:
        `Known models: ${knownModels.join(", ")}. Pass any model id to run it anyway — ` +
        "remove it from --pair only if it was a typo.",
    });
  }
  return { harness, model };
}

export function parsePairs(
  values: readonly string[],
  knownModels: readonly string[],
  min = 2,
): DuelPair[] {
  if (values.length < min) {
    throw new CliError(`At least ${min} --pair values are required — got ${values.length}.`, {
      hint: "Example: --pair harness=claude-code,model=A --pair harness=omp,model=A",
    });
  }
  return values.map((value) => parsePair(value, knownModels));
}

/** Like parsePairs but without the count requirement (duel counts pairs itself, so it can report every unmet requirement at once). */
export function parsePairsChecked(
  values: readonly string[],
  knownModels: readonly string[],
): DuelPair[] {
  return values.map((value) => parsePair(value, knownModels));
}

/** Resolve `--baseline <1-based index | harness=X,model=Y>` to a pair index. */
export function resolveBaseline(flag: string | undefined, pairs: readonly DuelPair[]): number {
  if (flag === undefined) return 0;
  const index = Number(flag);
  if (Number.isInteger(index) && index >= 1 && index <= pairs.length) return index - 1;
  const match = pairs.findIndex(
    (pair) => pair.harness === flag || `${pair.harness},${pair.model}` === flag,
  );
  if (match >= 0) return match;
  const named = pairs.findIndex((pair) => `harness=${pair.harness},model=${pair.model}` === flag);
  if (named >= 0) return named;
  throw new CliError(`Unknown --baseline "${flag}".`, {
    hint: "Use the 1-based pair index or harness=X,model=Y exactly as passed to --pair.",
  });
}

// ---------------------------------------------------------------------------
// Session shape extraction — metadata only, never content
// ---------------------------------------------------------------------------

/** The minimal store row the shape extractor consumes (verbatim store columns). */
export type ShapeRow = {
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
};

/**
 * The extracted request SHAPE of one recorded session: per-turn cumulative
 * prompt tokens (gateway convention: input INCLUDES cached) and per-turn
 * output tokens. There is no field here a prompt could hide in.
 */
export type SessionShape = {
  sessionId: string;
  /** Per-turn growth curve, in store order (created_at, then insertion). */
  turns: { inputTokens: number; outputTokens: number }[];
  /** True when `--turns-cap` cut the session short. */
  truncated: boolean;
  /** `created_at` of the first turn — when the curve was recorded. */
  recordedAt: string;
};

/**
 * Extract the shape from one session's rows. Rows must already be in
 * conversation order (store order: created_at, id). Deterministic and pure:
 * the same rows always produce the same curve.
 */
export function extractShape(
  sessionId: string,
  rows: readonly ShapeRow[],
  turnsCap: number,
): SessionShape {
  if (rows.length === 0) {
    throw new CliError(`Session "${sessionId}" has no requests to replay.`, {
      hint: "Pick a session with at least one request (`aiand sessions --json`).",
    });
  }
  const capped = rows.slice(0, Math.max(1, turnsCap));
  return {
    sessionId,
    turns: capped.map((row) => ({
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
    })),
    truncated: rows.length > capped.length,
    recordedAt: rows[0]?.created_at ?? "",
  };
}

// ---------------------------------------------------------------------------
// Seeded synthetic filler
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32): same seed → same sequence, everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILLER_WORDS = [
  "cache",
  "prefix",
  "token",
  "layout",
  "gateway",
  "budget",
  "latency",
  "context",
  "stable",
  "append",
];

/**
 * Deterministic filler text sized to roughly `targetTokens` tokens, drawn
 * from a fixed word list by the seeded PRNG. The ~4 characters per token
 * ratio is an APPROXIMATION — a real gateway's tokenizer decides the final
 * count — so a replay matches the recorded curve in shape, not to the exact
 * token. Never guess a cost from it: costs come from the transport's own
 * billing, and the shape footer says the content is synthetic.
 */
export function fillerText(targetTokens: number, rng: () => number): string {
  const targetChars = Math.max(0, Math.round(targetTokens * 4));
  const words: string[] = [];
  let chars = 0;
  while (chars < targetChars) {
    const word = FILLER_WORDS[Math.floor(rng() * FILLER_WORDS.length)] ?? "token";
    words.push(word);
    chars += word.length + 1;
  }
  return words.join(" ");
}

/**
 * Turn a recorded shape into a benchmark scenario: the file read is filler
 * sized to the first turn's cumulative prompt (the initial context), and each
 * follow-up turn is filler sized to that turn's GROWTH (the delta of the
 * cumulative curve). The scenario framework appends follow-ups, so request n
 * carries the curve's first n cumulative sizes, exactly like the session did.
 */
export function shapeToScenario(shape: SessionShape, seed: number): BenchScenario {
  const rng = mulberry32(seed);
  const initial = shape.turns[0]?.inputTokens ?? 0;
  const turns: string[] = ["Read src/session-shape.ts and summarize what it does."];
  for (let i = 1; i < shape.turns.length; i++) {
    const delta = Math.max(0, shape.turns[i]!.inputTokens - shape.turns[i - 1]!.inputTokens);
    const filler = fillerText(delta, rng);
    turns.push(filler.length > 0 ? `Continue: ${filler}` : "Continue.");
  }
  return {
    id: `duel-session-${shape.sessionId}`,
    title: `Duel replay of session ${shape.sessionId}`,
    turns,
    file: { path: "src/session-shape.ts", content: fillerText(initial, rng) || "// empty" },
  };
}

// ---------------------------------------------------------------------------
// The duel run
// ---------------------------------------------------------------------------

/** One measured pair. Every number is measured by the transport, never modelled. */
export type DuelPairResult = {
  pair: DuelPair;
  /** True when the run stopped early (abort or a transport error). */
  partial: boolean;
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  hitRatio: number;
  ttft: { p50: number | null; p95: number | null };
  wallMs: number;
  errors: number;
};

export type DuelSource =
  | { kind: "session"; id: string; turns: number; recordedAt: string; truncated: boolean }
  | { kind: "scenario"; id: string; turns: number };

export type DuelRun = {
  seed: number;
  source: DuelSource;
  pairs: DuelPairResult[];
};

class DuelAborted extends Error {
  constructor() {
    super("duel aborted");
  }
}

export type MeasureTransport = {
  fetchImpl: typeof fetch;
  durations: number[];
  errors: () => number;
  aborted: () => boolean;
  /** Requests that got a response back (ok or not) — the completed count. */
  completed: () => number;
};

/**
 * A transport wrapper that measures per-request duration (the TTFT proxy —
 * the benchmark sends `max_tokens: 4`, so the round trip IS effectively the
 * time to first token), counts error responses, and honors an abort check.
 */
export function measureTransport(
  inner: typeof fetch,
  options: { now?: () => number; shouldAbort?: () => boolean } = {},
): MeasureTransport {
  const now = options.now ?? Date.now;
  const durations: number[] = [];
  let errors = 0;
  let completedCount = 0;
  let aborted = false;
  const fetchImpl: typeof fetch = async (url, init) => {
    if (options.shouldAbort?.()) {
      aborted = true;
      throw new DuelAborted();
    }
    const start = now();
    try {
      const response = await inner(url, init);
      completedCount += 1;
      if (!response.ok) errors += 1;
      return response;
    } finally {
      durations.push(now() - start);
    }
  };
  return {
    fetchImpl,
    durations,
    errors: () => errors,
    aborted: () => aborted,
    completed: () => completedCount,
  };
}

function pairResult(
  pair: DuelPair,
  result: BenchResult | undefined,
  transport: MeasureTransport,
  wallMs: number,
  partial: boolean,
): DuelPairResult {
  const inputTokens = result?.inputTokens ?? 0;
  const cachedTokens = result?.cachedTokens ?? 0;
  return {
    pair,
    partial,
    requests: result?.requests ?? transport.completed(),
    inputTokens,
    cachedTokens,
    outputTokens: result?.turns.reduce((sum, turn) => sum + turn.outputTokens, 0) ?? 0,
    costUsd: result?.costUsd ?? 0,
    hitRatio: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    ttft: {
      p50: percentile(transport.durations, 0.5),
      p95: percentile(transport.durations, 0.95),
    },
    wallMs,
    errors: transport.errors(),
  };
}

export type RunDuelOptions = {
  session: Session;
  /** The scenario to replay: from `--scenario` or built from a session shape. */
  scenario: BenchScenario;
  pairs: readonly DuelPair[];
  /** Printed with every output; the knob that names a reproducible run. */
  seed: number;
  /** What was replayed — carried into the report and the shape footer. */
  source: DuelSource;
  /**
   * Prices for the benchmark's uncached-baseline arithmetic; the duel table
   * itself reports transport-billed cost only, so an empty table is fine.
   */
  prices?: Record<string, never> | RunBenchOptions["prices"];
  /** Injected transport, for tests and the recorded-style offline replay. */
  fetchImpl?: typeof fetch;
  /** Injected clock, for deterministic timing in tests. */
  now?: () => number;
  /** Checked before every request; when it turns true the run stops cleanly. */
  shouldAbort?: () => boolean;
  onProgress?: (message: string) => void;
};

/**
 * Run the duel: pairs ONE AT A TIME (sequential, for clean attribution —
 * v1 has no adaptive racing), each through its own measured transport so a
 * pair's cache or errors cannot touch another's.
 */
export async function runDuel(options: RunDuelOptions): Promise<DuelRun> {
  const pairs: DuelPairResult[] = [];
  for (const pair of options.pairs) {
    const layout = findHarnessLayout(pair.harness);
    if (!layout) {
      throw new CliError(`Unknown harness layout "${pair.harness}".`, {
        hint:
          `Valid layouts: ${HARNESS_LAYOUTS.map((l) => l.id).join(", ")}. ` +
          `Or omit harness= (--pair model=<model>) to use the default layout "${DEFAULT_PAIR_LAYOUT}".`,
      });
    }
    const transport = measureTransport(options.fetchImpl ?? fetch, {
      now: options.now,
      shouldAbort: options.shouldAbort,
    });
    options.onProgress?.(`running ${pair.harness} × ${pair.model}…`);
    const start = (options.now ?? Date.now)();
    let result: BenchResult | undefined;
    let failed = false;
    try {
      const results = await runHarnessBenchmark({
        session: options.session,
        scenario: options.scenario,
        layouts: [layout],
        model: pair.model,
        prices: options.prices ?? {},
        fetchImpl: transport.fetchImpl,
        onProgress: options.onProgress,
      });
      result = results[0];
    } catch (error) {
      if (error instanceof DuelAborted) {
        pairs.push(
          pairResult(pair, undefined, transport, (options.now ?? Date.now)() - start, true),
        );
        break;
      }
      failed = true;
      options.onProgress?.(
        `pair ${pair.harness} × ${pair.model} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const wallMs = (options.now ?? Date.now)() - start;
    if (result || failed) {
      pairs.push(pairResult(pair, result, transport, wallMs, failed || transport.aborted()));
    } else {
      pairs.push(pairResult(pair, undefined, transport, wallMs, true));
    }
  }
  return {
    seed: options.seed,
    source: options.source,
    pairs,
  };
}

// ---------------------------------------------------------------------------
// The comparison report
// ---------------------------------------------------------------------------

/** One side-by-side row: the metric, one cell per pair, deltas vs baseline. */
export type DuelMetricRow = {
  metric: string;
  /** One rendered cell per pair, in pair order. */
  cells: string[];
  /** Rendered delta vs the baseline for every non-baseline pair (null = n/a). */
  deltas: (string | null)[];
};

export type DuelMetricFormat = {
  cost: (value: number) => string;
  tokens: (value: number) => string;
  ratio: (value: number) => string;
  ms: (value: number | null) => string;
  count: (value: number) => string;
};

export function defaultMetricFormat(): DuelMetricFormat {
  const usd = (value: number): string => `$${value.toFixed(6)}`;
  return {
    cost: usd,
    tokens: (value: number): string => String(value),
    ratio: (value: number): string => `${(value * 100).toFixed(1)}%`,
    ms: (value: number | null): string => (value === null ? "—" : `${value.toFixed(0)}ms`),
    count: (value: number): string => String(value),
  };
}

function deltaCell(baseline: number, value: number, render: (v: number) => string): string {
  const diff = value - baseline;
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  const pct = baseline !== 0 ? ` (${((diff / baseline) * 100).toFixed(1)}%)` : "";
  return `${sign}${render(Math.abs(diff))}${pct}`;
}

/**
 * Build the side-by-side metric rows. Deterministic: the same run always
 * renders the same strings.
 */
export function duelMetricRows(
  run: DuelRun,
  baselineIndex: number,
  format: DuelMetricFormat = defaultMetricFormat(),
): DuelMetricRow[] {
  const rows: DuelMetricRow[] = [];
  const baseline = run.pairs[baselineIndex];
  if (!baseline) return rows;
  const cell = (_pair: DuelPairResult, render: (p: DuelPairResult) => string): string[] =>
    run.pairs.map((p) => render(p));
  const deltas = (
    pick: (p: DuelPairResult) => number,
    render: (v: number) => string,
  ): (string | null)[] =>
    run.pairs.map((p, index) =>
      index === baselineIndex ? null : deltaCell(pick(baseline), pick(p), render),
    );

  rows.push({
    metric: "total cost",
    cells: cell(baseline, (p) => format.cost(p.costUsd)),
    deltas: deltas((p) => p.costUsd, format.cost),
  });
  rows.push({
    metric: "cost/turn",
    cells: cell(baseline, (p) => format.cost(p.requests > 0 ? p.costUsd / p.requests : 0)),
    deltas: deltas((p) => (p.requests > 0 ? p.costUsd / p.requests : 0), format.cost),
  });
  rows.push({
    metric: "input tokens",
    cells: cell(baseline, (p) => format.tokens(p.inputTokens)),
    deltas: deltas((p) => p.inputTokens, format.tokens),
  });
  rows.push({
    metric: "output tokens",
    cells: cell(baseline, (p) => format.tokens(p.outputTokens)),
    deltas: deltas((p) => p.outputTokens, format.tokens),
  });
  rows.push({
    metric: "cache-hit ratio",
    cells: cell(baseline, (p) => format.ratio(p.hitRatio)),
    deltas: deltas((p) => p.hitRatio, format.ratio),
  });
  rows.push({
    metric: "TTFT p50",
    cells: cell(baseline, (p) => format.ms(p.ttft.p50)),
    deltas: run.pairs.map((p, index) =>
      index === baselineIndex || baseline.ttft.p50 === null || p.ttft.p50 === null
        ? null
        : deltaCell(baseline.ttft.p50, p.ttft.p50, format.ms),
    ),
  });
  rows.push({
    metric: "TTFT p95",
    cells: cell(baseline, (p) => format.ms(p.ttft.p95)),
    deltas: run.pairs.map((p, index) =>
      index === baselineIndex || baseline.ttft.p95 === null || p.ttft.p95 === null
        ? null
        : deltaCell(baseline.ttft.p95, p.ttft.p95, format.ms),
    ),
  });
  rows.push({
    metric: "wall time",
    cells: cell(baseline, (p) => format.ms(p.wallMs)),
    deltas: deltas((p) => p.wallMs, format.ms),
  });
  rows.push({
    metric: "errors",
    cells: cell(baseline, (p) => format.count(p.errors)),
    deltas: deltas((p) => p.errors, format.count),
  });
  return rows;
}

/** Pair label used as a column header: `harness × model`. */
export function pairLabel(pair: DuelPair): string {
  return `${pair.harness} × ${pair.model}`;
}

/**
 * The footer every duel output carries: what was replayed and the honesty
 * note that the words are synthetic.
 */
export function shapeSourceFooter(run: DuelRun): string {
  if (run.source.kind === "session") {
    return (
      `shape source: session ${run.source.id} (${run.source.turns} turns, growth curve recorded ` +
      `${run.source.recordedAt.slice(0, 10)}); filler content is synthetic — ` +
      "real prompts never left this machine"
    );
  }
  return (
    `shape source: scenario ${run.source.id} (${run.source.turns} turns, fixed fixtures); ` +
    "content is synthetic — real prompts never left this machine"
  );
}

/** The truncation note when `--turns-cap` cut a session short. */
export function truncationNote(run: DuelRun): string | null {
  if (run.source.kind !== "session" || !run.source.truncated) return null;
  return `session truncated to --turns-cap: only the first ${run.source.turns} turns were replayed`;
}
