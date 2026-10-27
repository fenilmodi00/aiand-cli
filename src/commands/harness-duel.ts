import { createInterface } from "node:readline/promises";
import { agentForMaskedKey } from "../api/agent-keys.js";
import { openSession } from "../api/client.js";
import {
  DEFAULT_PAIR_LAYOUT,
  type DuelMetricRow,
  type DuelPair,
  type DuelPairResult,
  type DuelRun,
  type DuelSource,
  defaultMetricFormat,
  duelMetricRows,
  extractShape,
  fillerText,
  mulberry32,
  pairLabel,
  parsePairs,
  parsePairsChecked,
  resolveBaseline,
  runDuel,
  shapeSourceFooter,
  shapeToScenario,
  truncationNote,
} from "../benchmark/duel.js";
import type { BenchScenario } from "../benchmark/harness-bench.js";
import { HARNESS_LAYOUTS } from "../benchmark/harness-layouts.js";
import { HARNESS_AGENT_ALIASES, historicalTtft, runLatency } from "../benchmark/latency-ab.js";
import { BENCH_SCENARIOS, findBenchScenario } from "../benchmark/scenarios.js";
import { loadSavedSweep } from "../benchmark/sweep-store.js";
import { bool, int, list, oneOf, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, heading, json, out, style } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { writeFileAtomic } from "../fsutil.js";
import { noSyncRequested, syncStore } from "../store/index.js";
import { sessionizeRows } from "../store/sessions.js";
import { parseWindowFlags, readHarnessRows } from "./harness-stats.js";

/**
 * `aiand harness duel` (feature catalog D2) and `aiand harness latency`
 * (D3) — ticket #82. duel replays a recorded session's request SHAPE across
 * (layout, model) pairs; latency compares live TTFT against the store's
 * historical percentiles. No prompt text ever leaves the machine: the store
 * holds none, and every replayed prompt is seeded synthetic filler.
 */

const DUEL_PROVENANCE = {
  cost: "gateway-billed (X-Cost header, duel-run billing)",
  tokens: "gateway-billed (gateway usage block, duel-run)",
  cacheHitRatio: "estimated(cached_tokens / input_tokens, duel-run)",
  ttft: "measured(per-request duration around the gateway round trip)",
  wallTime: "measured(per-pair wall clock)",
};

const DEFAULT_TURNS_CAP = 50;

async function knownModels(): Promise<string[]> {
  const models = new Set<string>();
  for (const row of readHarnessRows({ sinceMs: null, untilMs: null }, { agents: [], models: [] })) {
    if (row.model) models.add(row.model);
  }
  const sweep = loadSavedSweep();
  if (sweep) for (const entry of sweep.sweep) models.add(entry.model);
  return [...models].sort();
}

/** The billed-request safety rail: print the plan, require confirmation on a TTY. */
async function confirmPlan(plan: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new CliError(`Refusing to run ${plan} without confirmation.`, {
      hint: "This runs real billed requests. Pass --yes to skip the prompt in scripts.",
    });
  }
  err(`${plan}. Press Enter to run, Ctrl-C to abort.`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    await rl.question("");
  } finally {
    rl.close();
  }
}

export async function runHarnessDuel(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    session: { type: "string" },
    scenario: { type: "string" },
    pair: { type: "string", multiple: true },
    baseline: { type: "string" },
    seed: { type: "string" },
    "turns-cap": { type: "string" },
    format: { type: "string" },
    save: { type: "string" },
    yes: { type: "boolean", default: false },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(duelHelp());

  const sessionId = str(parsed, "session");
  const scenarioId = str(parsed, "scenario");
  const problems: string[] = [];
  if (sessionId && scenarioId) {
    problems.push("--session and --scenario are mutually exclusive (pick one shape source)");
  } else if (!sessionId && !scenarioId) {
    problems.push(
      "pick exactly one shape source: --session <id> (store sessions) or --scenario <id> (`aiand harness --list-scenarios`)",
    );
  }
  const pairs = parsePairsChecked(list(parsed, "pair"), await knownModels());
  if (pairs.length < 2) {
    problems.push(`at least 2 --pair values are required — got ${pairs.length}`);
  }
  const turnsCapRaw = int(parsed, "turns-cap");
  if (turnsCapRaw !== undefined && turnsCapRaw < 1) {
    problems.push(`--turns-cap must be a positive number — got ${turnsCapRaw}`);
  }
  if (problems.length > 0) {
    throw new CliError(`Invalid arguments:\n${problems.map((p) => `  - ${p}`).join("\n")}`, {
      hint: "Example: aiand harness duel --session <id> --pair harness=claude-code,model=M --pair harness=omp,model=M",
    });
  }
  const seed = int(parsed, "seed") ?? 0;
  const turnsCap = turnsCapRaw ?? DEFAULT_TURNS_CAP;
  const format = oneOf(parsed, "format", ["table", "json", "markdown"], "table");

  const baselineIndex = resolveBaseline(str(parsed, "baseline"), pairs);

  // -- shape source ----------------------------------------------------------
  let scenario: BenchScenario;
  let source: DuelSource;
  if (sessionId !== undefined) {
    if (!(bool(parsed, "no-sync") || noSyncRequested())) await autoSync(parsed);
    const detail = sessionizeRows(sessionRows(), 10).find((s) => s.session_id === sessionId);
    if (!detail) {
      throw new CliError(`No session with id "${sessionId}" in the local store.`, {
        hint: "Session ids come from `aiand sessions --json`; they are derived from the gap heuristic.",
      });
    }
    const shape = extractShape(sessionId, detail.rows, turnsCap);
    scenario = shapeToScenario(shape, seed);
    source = {
      kind: "session",
      id: shape.sessionId,
      turns: shape.turns.length,
      recordedAt: shape.recordedAt,
      truncated: shape.truncated,
    };
  } else {
    // The exact-one guard above guarantees --scenario is set here.
    scenario = findScenarioOrThrow(scenarioId ?? "");
    source = { kind: "scenario", id: scenario.id, turns: scenario.turns.length };
  }

  const turns = scenario.turns.length;
  const plan = `${pairs.length} pairs × ${turns} turns ≈ ${pairs.length * turns} requests`;
  await confirmPlan(plan, bool(parsed, "yes"));

  // Ctrl-C aborts cleanly: the flag stops the next request, and the partial
  // results are still reported, clearly labeled.
  let aborted = false;
  const onInterrupt = (): void => {
    aborted = true;
  };
  process.once("SIGINT", onInterrupt);
  let run: DuelRun;
  try {
    const session = await openSession(resolveProfile(str(parsed, "profile")));
    run = await runDuel({
      session,
      scenario,
      pairs,
      seed,
      source,
      shouldAbort: () => aborted,
      onProgress: (message) => err(style.dim(message)),
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }

  const payload = duelPayload(run, baselineIndex, turnsCap, aborted);
  const savePath = str(parsed, "save");
  if (savePath !== undefined) {
    const text =
      format === "json"
        ? `${JSON.stringify(payload, null, 2)}\n`
        : `${duelMarkdown(run, baselineIndex)}\n`;
    writeFileAtomic(savePath, text);
    err(style.dim(`comparison saved to ${savePath}`));
  }

  if (bool(parsed, "json") || format === "json") return json(payload);
  if (format === "markdown") {
    for (const line of duelMarkdown(run, baselineIndex).split("\n")) out(line);
    return;
  }
  renderDuelTable(run, baselineIndex, aborted);
}

// ---------------------------------------------------------------------------
// `aiand harness latency`
// ---------------------------------------------------------------------------

export async function runHarnessLatency(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    pair: { type: "string", multiple: true },
    turns: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    timezone: { type: "string" },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(latencyHelp());

  const turns = int(parsed, "turns") ?? 10;
  if (turns < 1) {
    throw new CliError(`Invalid --turns value: ${turns}.`, { hint: "Use a positive number." });
  }
  const pairs = parsePairs(list(parsed, "pair"), await knownModels(), 1);
  if (!(bool(parsed, "no-sync") || noSyncRequested())) await autoSync(parsed);

  const timezone = str(parsed, "timezone") ?? "UTC";
  const { sinceMs, untilMs } = parseWindowFlags(parsed, timezone);
  const window = { sinceMs, untilMs };
  const allRows = readHarnessRows(window, { agents: [], models: [] });

  const historical = new Map<string, ReturnType<typeof historicalTtft>>();
  for (const pair of pairs) {
    const agent = HARNESS_AGENT_ALIASES[pair.harness];
    const rows = allRows.filter(
      (row) =>
        row.model === pair.model &&
        agent !== undefined &&
        row.api_key !== null &&
        (agentForMaskedKey(row.api_key) ?? "unknown") === agent,
    );
    historical.set(pairKey(pair), historicalTtft(rows));
  }

  const session = await openSession(resolveProfile(str(parsed, "profile")));
  const live = await runLatency({
    session,
    scenario: latencyScenario(turns),
    pairs,
    onProgress: (message) => err(style.dim(message)),
  });

  const payload = latencyPayload(live, historical, window, timezone);
  if (bool(parsed, "json")) return json(payload);
  renderLatencyTable(live, historical);
}

function pairKey(pair: DuelPair): string {
  return `${pair.harness},${pair.model}`;
}

/** A fixed-shape latency loop scenario: turn 1 real-ish, follow-ups seeded filler. */
function latencyScenario(turns: number): BenchScenario {
  const rng = mulberry32(0);
  return {
    id: "latency-ab",
    title: "Latency A/B loop",
    turns: [
      "Read src/cache-policy.ts and summarize the TTL behavior in two sentences.",
      ...Array.from({ length: Math.max(0, turns - 1) }, () => `Continue: ${fillerText(40, rng)}`),
    ],
    file: {
      path: "src/cache-policy.ts",
      content:
        'export function ttlForPrefix(kind: "ephemeral_5m" | "ephemeral_1h"): number {\n' +
        '  return kind === "ephemeral_1h" ? 3600 : 300;\n' +
        "}",
    },
  };
}

type LatencyWindow = { sinceMs: number | null; untilMs: number | null };

function latencyPayload(
  live: Awaited<ReturnType<typeof runLatency>>,
  historical: Map<string, ReturnType<typeof historicalTtft>>,
  window: LatencyWindow,
  timezone: string,
): unknown {
  return {
    provenance: {
      liveTtft: "measured(per-request duration around the gateway round trip)",
      historicalTtft: "gateway-billed (store ttft_ms rows)",
      window,
      timezone,
      minHistoricalSamples: 5,
    },
    pairs: live.map((result) => {
      const hist = historical.get(pairKey(result.pair)) ?? null;
      return {
        pair: result.pair,
        live: {
          ttft: result.ttft,
          wall: result.wall,
          turns: result.turns,
          partial: result.partial,
        },
        historical:
          hist === null
            ? { status: "insufficient data" as const, minSamples: 5 }
            : { status: "ok" as const, ...hist },
        deltaP50:
          hist !== null && result.ttft.p50 !== null
            ? Number((result.ttft.p50 - hist.p50).toFixed(1))
            : null,
      };
    }),
  };
}

function renderLatencyTable(
  live: Awaited<ReturnType<typeof runLatency>>,
  historical: Map<string, ReturnType<typeof historicalTtft>>,
): void {
  heading("latency A/B · live vs historical");
  out(
    style.dim(
      "  live = measured through the normal gateway path (no proxy needed); historical = store ttft_ms",
    ),
  );
  out();
  for (const result of live) {
    const hist = historical.get(pairKey(result.pair)) ?? null;
    const cell = (value: number | null): string => (value === null ? "—" : `${value.toFixed(0)}ms`);
    const histCell = (value: number | null): string =>
      hist === null ? "insufficient data" : cell(value);
    const delta =
      hist !== null && result.ttft.p50 !== null
        ? `${result.ttft.p50 - hist.p50 >= 0 ? "+" : "−"}${Math.abs(result.ttft.p50 - hist.p50).toFixed(0)}ms`
        : "—";
    heading(`${pairLabel(result.pair)}${result.partial ? style.yellow(" (partial)") : ""}`);
    out(
      `  live p50/p90/p95: ${cell(result.ttft.p50)} / ${cell(result.ttft.p90)} / ${cell(result.ttft.p95)}` +
        `   wall p50/p95: ${cell(result.wall.p50)} / ${cell(result.wall.p95)}` +
        `   n=${result.turns}`,
    );
    out(
      `  historical p50/p90/p95: ${histCell(hist?.p50 ?? null)} / ${histCell(hist?.p90 ?? null)} / ` +
        `${histCell(hist?.p95 ?? null)}   Δ p50 (live − historical): ${delta}` +
        `   n=${hist === null ? 0 : hist.n}`,
    );
    out();
  }
  out(style.dim("labels: live = measured · historical = gateway-billed (store ttft_ms);"));
  out(style.dim("historical shows `insufficient data` under 5 samples — never a thin percentile."));
}

// ---------------------------------------------------------------------------
// Duel rendering
// ---------------------------------------------------------------------------

function duelPayload(
  run: DuelRun,
  baselineIndex: number,
  turnsCap: number,
  aborted: boolean,
): unknown {
  return {
    seed: run.seed,
    turnsCap,
    source: run.source,
    aborted,
    pairs: run.pairs.map((pair: DuelPairResult) => ({
      pair: pair.pair,
      partial: pair.partial,
      requests: pair.requests,
      inputTokens: pair.inputTokens,
      cachedTokens: pair.cachedTokens,
      outputTokens: pair.outputTokens,
      costUsd: Number(pair.costUsd.toFixed(6)),
      hitRatio: Number(pair.hitRatio.toFixed(6)),
      ttft: pair.ttft,
      wallMs: Number(pair.wallMs.toFixed(3)),
      errors: pair.errors,
    })),
    baseline: run.pairs[baselineIndex]?.pair ?? null,
    provenance: DUEL_PROVENANCE,
    note: "shape replay: synthetic filler sized to the recorded growth curve — no prompt text was read or sent",
  };
}

function duelColumns(
  run: DuelRun,
  baselineIndex: number,
  rows: DuelMetricRow[],
): { columns: string[]; aligns: ("left" | "right")[]; body: string[][] } {
  const columns = ["metric"];
  const aligns: ("left" | "right")[] = ["left"];
  run.pairs.forEach((pair, index) => {
    columns.push(`${pairLabel(pair.pair)}${index === baselineIndex ? " (baseline)" : ""}`);
    aligns.push("right");
  });
  run.pairs.forEach((_, index) => {
    if (index !== baselineIndex) {
      columns.push(`Δ ${pairLabel(run.pairs[index]!.pair)}`);
      aligns.push("right");
    }
  });
  const body = rows.map((row) => {
    const line = [row.metric, ...row.cells];
    for (const delta of row.deltas) line.push(delta ?? "—");
    return line;
  });
  return { columns, aligns, body };
}

function renderDuelTable(run: DuelRun, baselineIndex: number, aborted: boolean): void {
  const rows = duelMetricRows(run, baselineIndex, defaultMetricFormat());
  const { columns, aligns, body } = duelColumns(run, baselineIndex, rows);
  out(style.bold("harness duel · shape replay A/B"));
  if (aborted) out(style.yellow("ABORTED — results below are PARTIAL (Ctrl-C)"));
  for (const pair of run.pairs) {
    if (pair.partial) {
      out(
        style.yellow(
          `partial: ${pairLabel(pair.pair)} stopped early (${pair.requests} requests completed)`,
        ),
      );
    }
  }
  out();
  renderAsciiTable(columns, aligns, body);
  out();
  for (const line of [
    `cost: ${DUEL_PROVENANCE.cost}`,
    `tokens: ${DUEL_PROVENANCE.tokens}`,
    `ttft/wall: ${DUEL_PROVENANCE.ttft}`,
    shapeSourceFooter(run),
    truncationNote(run),
    `seed: ${run.seed} (same seed + shape + pairs → identical cost/token tables offline)`,
  ].filter((line) => line !== null)) {
    out(style.dim(line));
  }
}

function duelMarkdown(run: DuelRun, baselineIndex: number): string {
  const rows = duelMetricRows(run, baselineIndex, defaultMetricFormat());
  const { columns, aligns, body } = duelColumns(run, baselineIndex, rows);
  const lines = [
    "### harness duel — shape replay A/B",
    "",
    `| ${columns.join(" | ")} |`,
    `|${aligns.map((a) => (a === "right" ? "---:" : "---")).join("|")}|`,
    ...body.map((line) => `| ${line.join(" | ")} |`),
    "",
    `_${shapeSourceFooter(run)}_`,
  ];
  const note = truncationNote(run);
  if (note) lines.push(`_${note}_`);
  lines.push("", `_seed: ${run.seed} · provenance: cost ${DUEL_PROVENANCE.cost}_`);
  return lines.join("\n");
}

/** Minimal deterministic ASCII table (columns are dynamic, so `table()` does not apply). */
function renderAsciiTable(columns: string[], aligns: ("left" | "right")[], body: string[][]): void {
  const width = columns.map((column, i) =>
    Math.max(column.length, ...body.map((line) => (line[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) =>
        aligns[i] === "right" ? cell.padStart(width[i] ?? 0) : cell.padEnd(width[i] ?? 0),
      )
      .join("  ");
  out(line(columns));
  out(width.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) out(line(row));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function findScenarioOrThrow(id: string): BenchScenario {
  const scenario = findBenchScenario(id);
  if (!scenario) {
    throw new CliError(`Unknown scenario "${id}".`, {
      hint: `Known scenarios: ${BENCH_SCENARIOS.map((s) => s.id).join(", ")}.`,
    });
  }
  return scenario;
}

async function autoSync(parsed: ReturnType<typeof parse>): Promise<void> {
  if (bool(parsed, "no-sync") || noSyncRequested()) return;
  try {
    const session = await openSession(resolveProfile(str(parsed, "profile")));
    const result = await syncStore(session);
    if (!result.ok)
      err(style.yellow(`store sync failed (${result.code ?? "error"}): ${result.error}`));
  } catch (error) {
    err(
      style.yellow(`store sync skipped: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
}

function sessionRows() {
  return readHarnessRows({ sinceMs: null, untilMs: null }, { agents: [], models: [] });
}

function duelHelp(): string {
  return `${style.bold("aiand harness duel")} -- replay a session's request SHAPE across (layout, model) pairs

Usage
  aiand harness duel --session <id> --pair harness=claude-code,model=M --pair harness=omp,model=M
  aiand harness duel --scenario multi-turn-refactor --pair ... --pair ...
  aiand harness duel --session <id> ... --format json --save duel.md

Options
  --session <id>      replay this store session's SHAPE (turns + token growth curve)
  --scenario <id>     replay a synthetic scenario instead (exactly one of the two)
  --pair <spec>       harness=<layout>,model=<model>; repeatable, 2+ required.
                      Valid layouts: ${HARNESS_LAYOUTS.map((l) => l.id).join(", ")}.
                      Omit harness= (--pair model=<model>) to use the default
                      layout "${DEFAULT_PAIR_LAYOUT}".
  --baseline <i|spec> 1-based pair index or harness=X,model=Y (default: the first pair)
  --seed <n>          filler PRNG seed (default 0; printed with the output)
  --turns-cap <n>     cap on replayed turns for huge sessions (default ${DEFAULT_TURNS_CAP});
                      this is the flag that limits replayed turns (there is no --turns)
  --format <fmt>      table (default) | json | markdown
  --save <path>       write the comparison (markdown, or json with --format json)
  --yes               skip the billed-request confirmation (scripts)
  --no-sync           read the local store without syncing (AIAND_NO_SYNC=1)

What is replayed is the request SHAPE — turn count and per-turn prompt-token
growth curve from the local store. Every prompt is seeded synthetic filler;
no prompt text is ever read from the store (it holds none) or leaves this
machine. Costs come from the gateway's own X-Cost billing for the duel run.
Same seed + shape + pairs produce byte-identical cost/token tables with a
deterministic transport — the D4 golden-fixture prerequisite.`;
}

function latencyHelp(): string {
  return `${style.bold("aiand harness latency")} -- live TTFT per (layout, model) vs your history

Usage
  aiand harness latency --pair harness=claude-code,model=M --turns 10
  aiand harness latency --pair ... --last 30d --json

Options
  --pair <spec>       harness=<layout>,model=<model>; repeatable.
                      Valid layouts: ${HARNESS_LAYOUTS.map((l) => l.id).join(", ")}.
                      Omit harness= (--pair model=<model>) to use the default
                      layout "${DEFAULT_PAIR_LAYOUT}".
  --turns <n>         turns per pair (default 10)
  --since <iso>       historical window start (interpreted in --timezone)
  --until <iso>       historical window end
  --last <window>     historical window (default: all stored history)
  --timezone <tz>     IANA timezone for --since/--until
  --no-sync           read the local store without syncing (AIAND_NO_SYNC=1)

Live measurements go through the same gateway path as normal traffic — no
proxy setup needed. Historical percentiles come from the local store's
ttft_ms rows for the same (harness, model); under 5 samples they print
\`insufficient data\` instead of a thin percentile. Live rows are labeled
measured; historical rows are gateway-billed store data.`;
}
