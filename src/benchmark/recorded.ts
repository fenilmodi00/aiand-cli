import type { Session } from "../api/client.js";
import { formatLabel, simulated } from "../obs/provenance.js";
import { type ModelPrice, runHarnessBenchmark } from "./harness-bench.js";
import { HARNESS_LAYOUTS } from "./harness-layouts.js";
import { BENCH_SCENARIOS } from "./scenarios.js";

/** The provenance label for every scripted behavioral number in the report. */
export const TOOL_OUTCOMES_PROVENANCE = simulated("scripted tool outcomes");

/**
 * The recorded benchmark: an OFFLINE replay of the scenario pack through a
 * deterministic prefix-cache simulator, costed against a PINNED price table.
 *
 * This is the regression gate behind `npm run benchmark:recorded` (issue #67,
 * feature catalog D4). Nothing here touches the network, the live pricing
 * catalog, or a real gateway: the fixtures from `scenarios.ts` are encoded
 * through the same request pipeline the live harness benchmark uses
 * (`harness-bench.ts`), but the transport is a block-exact prefix-cache
 * simulation, and every cost figure is computed from token shapes at the
 * pinned prices below.
 *
 * Metric definitions (CacheLane's BENCHMARK.md, reused verbatim):
 *
 *   - baseline_cost_units  — cost if every token were uncached, at pinned
 *     prices (prompt at the input rate, output at the output rate).
 *   - effective_cost_units — cost actually incurred given cache behavior
 *     (uncached prompt at the input rate, cached prompt at the cached rate,
 *     output at the output rate).
 *   - cache_hit_ratio      — cached tokens / input tokens (input includes
 *     the cached portion, per gateway convention).
 *   - savings_ratio        — 1 − effective_cost_units / baseline_cost_units.
 *
 * A change in pricing math, reconciler arithmetic, or aggregation output
 * changes these numbers and fails the golden comparison in CI.
 */

/** The model id the pinned table prices. Nothing real answers to this id. */
export const PINNED_MODEL = "pinned/bench-model";

/**
 * The pinned price table: the ONLY prices the recorded replay costs with.
 * Deliberately not read from the live catalog — if the catalog moves, the
 * goldens must not, and if someone changes this table, the golden diff goes
 * red on purpose.
 */
export const PINNED_PRICES: Record<string, ModelPrice> = {
  [PINNED_MODEL]: { inputPer1m: 1, cachedPer1m: 0.25, outputPer1m: 4 },
};

/** One scenario × layout row of the recorded report. */
export type RecordedRow = {
  scenario: string;
  layout: string;
  dialect: string;
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Scripted tool calls that failed, per the scenario's scriptedOutcomes. */
  toolErrors: number;
  /** Error-then-retry chains the scripted outcomes produced. */
  retries: number;
  baseline_cost_units: number;
  effective_cost_units: number;
  cache_hit_ratio: number;
  savings_ratio: number;
};

/** The full recorded report — metrics and metadata only, never fixture text. */
export type RecordedReport = {
  version: 1;
  model: string;
  prices: ModelPrice;
  /** Every row is a simulation: fixture-pinned, never an observation. */
  provenance: { toolOutcomes: string };
  rows: RecordedRow[];
};

/** Fixed decimal precision for every float in the report. */
const DECIMALS = 6;

function fixed(value: number): number {
  return Number(value.toFixed(DECIMALS));
}

/**
 * A block-exact prefix-cache simulator.
 *
 * A request hits to the extent a previously-sent request is a block-exact
 * prefix of it (per-message equality, the same rule the fake gateways in the
 * bench tests use); each dialect reports usage in its own shape, which
 * `harness-bench.ts` already normalizes. Fixed inputs, fixed cache rules —
 * two replays see the same tokens.
 */
function recordedTransport(): typeof fetch {
  const entries: string[][] = [];

  return async (url, init) => {
    const body = JSON.parse(String(init?.body));
    const anthropic = String(url).includes("/v1/messages");
    const messages = anthropic
      ? [JSON.stringify(body.system), ...body.messages.map(JSON.stringify)]
      : body.messages.map(JSON.stringify);

    let matched = 0;
    for (const entry of entries) {
      if (entry.length > messages.length) continue;
      const isPrefix = entry.every((line, i) => line === messages[i]);
      if (isPrefix) matched = Math.max(matched, entry.length);
    }
    entries.push(messages);

    const promptTokens = messages.length * 64;
    const cachedTokens = Math.floor((matched * 64) / 128) * 128;
    const usage = anthropic
      ? {
          input_tokens: promptTokens - cachedTokens,
          output_tokens: 8,
          cache_read_input_tokens: cachedTokens,
        }
      : {
          prompt_tokens: promptTokens,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: cachedTokens },
        };
    // The X-Cost header is deliberately zero: the recorded replay NEVER
    // trusts a gateway-reported cost, it recomputes from tokens at the
    // pinned prices.
    return new Response(JSON.stringify({ usage }), {
      status: 200,
      headers: { "X-Cost": "0", "Content-Type": "application/json" },
    });
  };
}

/** A fake session: the replay never opens a real one. */
const RECORDED_SESSION: Session = {
  profile: {
    name: "recorded",
    apiUrl: "https://gateway.invalid",
    authUrl: "",
    model: undefined,
  },
  token: "recorded",
  credential: null,
};

/** Cost every token at the input rate, plus output at the output rate. */
function baselineCost(inputTokens: number, outputTokens: number, price: ModelPrice): number {
  return (inputTokens / 1e6) * price.inputPer1m + (outputTokens / 1e6) * price.outputPer1m;
}

/** Cost actually incurred: cached prompt at the cached rate. */
function effectiveCost(
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
  price: ModelPrice,
): number {
  const uncached = inputTokens - cachedTokens;
  return (
    (uncached / 1e6) * price.inputPer1m +
    (cachedTokens / 1e6) * price.cachedPer1m +
    (outputTokens / 1e6) * price.outputPer1m
  );
}

export type RunRecordedOptions = {
  /** Subset of scenario ids, defaults to the whole pack. */
  scenarios?: string[];
  /** Price table override, for drift demonstrations. Defaults to PINNED_PRICES. */
  prices?: Record<string, ModelPrice>;
  /** Subset of layout ids, defaults to every layout. */
  layouts?: string[];
};

/**
 * Replay the scenario pack offline and report the four CacheLane metrics per
 * scenario × layout. Two consecutive runs produce byte-identical reports:
 * the fixtures are fixed strings, the transport is deterministic, and every
 * float is pinned to six decimal places.
 */
export async function runRecordedBenchmark(
  options: RunRecordedOptions = {},
): Promise<RecordedReport> {
  const prices = options.prices ?? PINNED_PRICES;
  const model = PINNED_MODEL;
  const price = prices[model];
  if (!price) {
    throw new Error(`the pinned price table has no entry for ${model}`);
  }
  const chosen = options.scenarios
    ? BENCH_SCENARIOS.filter((scenario) => options.scenarios!.includes(scenario.id))
    : BENCH_SCENARIOS;
  const layouts = options.layouts
    ? HARNESS_LAYOUTS.filter((layout) => options.layouts!.includes(layout.id))
    : HARNESS_LAYOUTS;

  const rows: RecordedRow[] = [];
  for (const scenario of chosen) {
    // One transport per scenario: each layout's salt is unique, so their
    // prefixes never collide, and the results come back in layout order.
    const results = await runHarnessBenchmark({
      session: RECORDED_SESSION,
      scenario,
      layouts,
      model,
      prices,
      fetchImpl: recordedTransport(),
    });
    for (const result of results) {
      // BenchResult carries output tokens per turn only.
      const outputTokens = result.turns.reduce((sum, turn) => sum + turn.outputTokens, 0);
      const baseline = baselineCost(result.inputTokens, outputTokens, price);
      const effective = effectiveCost(result.inputTokens, result.cachedTokens, outputTokens, price);
      rows.push({
        scenario: result.scenario,
        layout: result.harness,
        dialect: result.dialect,
        requests: result.requests,
        inputTokens: result.inputTokens,
        cachedTokens: result.cachedTokens,
        outputTokens,
        toolErrors: result.toolErrors,
        retries: result.retries,
        baseline_cost_units: fixed(baseline),
        effective_cost_units: fixed(effective),
        cache_hit_ratio: fixed(result.cachedTokens / result.inputTokens),
        savings_ratio: fixed(1 - effective / baseline),
      });
    }
  }

  return {
    version: 1,
    model,
    prices: { ...price },
    provenance: { toolOutcomes: formatLabel(TOOL_OUTCOMES_PROVENANCE) },
    rows,
  };
}

/**
 * Compare a fresh replay against the committed golden, field by field.
 * Returns a list of concise diffs (empty when they match).
 */
export function diffReports(actual: RecordedReport, golden: RecordedReport): string[] {
  const diffs: string[] = [];
  if (actual.model !== golden.model) {
    diffs.push(`model: golden ${golden.model} vs actual ${actual.model}`);
  }
  if (JSON.stringify(actual.prices) !== JSON.stringify(golden.prices)) {
    diffs.push(
      `prices: golden ${JSON.stringify(golden.prices)} vs actual ${JSON.stringify(actual.prices)}`,
    );
  }
  if (JSON.stringify(actual.provenance) !== JSON.stringify(golden.provenance)) {
    diffs.push(
      `provenance: golden ${JSON.stringify(golden.provenance)} vs actual ${JSON.stringify(actual.provenance)}`,
    );
  }
  const key = (row: { scenario: string; layout: string }) => `${row.scenario} x ${row.layout}`;
  const goldenRows = new Map(golden.rows.map((row) => [key(row), row]));
  const actualRows = new Map(actual.rows.map((row) => [key(row), row]));

  for (const [id, row] of actualRows) {
    const expected = goldenRows.get(id);
    if (!expected) {
      diffs.push(`${id}: row missing from the golden file`);
      continue;
    }
    for (const field of Object.keys(row) as (keyof RecordedRow)[]) {
      if (JSON.stringify(row[field]) !== JSON.stringify(expected[field])) {
        diffs.push(
          `${id}.${field}: golden ${JSON.stringify(expected[field])} vs actual ${JSON.stringify(row[field])}`,
        );
      }
    }
  }
  for (const id of goldenRows.keys()) {
    if (!actualRows.has(id)) {
      diffs.push(`${id}: row no longer reported`);
    }
  }
  return diffs;
}
