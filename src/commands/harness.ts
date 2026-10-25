import { openSession } from "../api/client.js";
import { type BenchResult, loadPrices, runHarnessBenchmark } from "../benchmark/harness-bench.js";
import { findHarnessLayout, HARNESS_LAYOUTS } from "../benchmark/harness-layouts.js";
import { BENCH_SCENARIOS, findBenchScenario } from "../benchmark/scenarios.js";
import { bool, list, parse, str } from "../cli/args.js";
import { currencySymbol, err, json, num, out, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";

export const help = `${style.bold("aiand harness")} -- compare harnesses on cache behavior

Usage
  aiand harness
  aiand harness --scenario multi-turn-refactor
  aiand harness --harness claude-code
  aiand harness --model zai-org/glm-5.3
  aiand harness --sweep-models
  aiand harness --json

Options
  --scenario <id>     use case to replay (default: multi-turn-refactor)
  --harness <id>      only this layout (repeatable; default: all of them)
  --model <id>        model to test against (default: the profile's)
  --sweep-models      run every layout against every model in the catalog
  --json              machine-readable output

Harnesses
${HARNESS_LAYOUTS.map((l) => `  ${l.id.padEnd(18)} ${l.dialect.padEnd(9)} ${l.note}`).join("\n")}

Each harness is a request SHAPE, not a prompt, and each speaks its own wire
dialect: Claude Code posts to /v1/messages (Anthropic), Oh My Pi posts to
/v1/chat/completions (OpenAI). A harness that keeps its leading blocks stable
and appends to the conversation gets a cache hit; one that rebuilds its
system block, compacts its history, or reorders its blocks as the
conversation grows breaks the prefix and pays full price on every turn.

Scenarios
${BENCH_SCENARIOS.map((s) => `  ${s.id.padEnd(28)} ${s.title}`).join("\n")}`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    scenario: { type: "string" },
    harness: { type: "string", multiple: true },
    model: { type: "string" },
    "sweep-models": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const scenarioId = str(parsed, "scenario") ?? "multi-turn-refactor";
  const scenario = findBenchScenario(scenarioId);
  if (!scenario) {
    throw new Error(
      `Unknown scenario "${scenarioId}". Known: ${BENCH_SCENARIOS.map((s) => s.id).join(", ")}.`,
    );
  }

  const harnessIds = list(parsed, "harness");
  const layouts = harnessIds.length
    ? harnessIds.map((id) => findHarnessLayout(id)).filter((layout) => layout !== undefined)
    : HARNESS_LAYOUTS;
  if (layouts.length === 0) {
    const known = HARNESS_LAYOUTS.map((l) => l.id).join(", ");
    const wanted = harnessIds.join(", ");
    throw new Error(`Unknown harness "${wanted}". Known: ${known}.`);
  }

  const session = await openSession(resolveProfile(str(parsed, "profile")));
  const prices = await loadPrices(session, session.profile.apiUrl);

  // The model sweep: every layout against every model in the catalog. The
  // cache rules are the same for every model, but the PRICES are not, so
  // the same layout costs a different amount on a different model.
  if (bool(parsed, "sweep-models")) {
    const models = Object.keys(prices).filter((id) => id !== undefined);
    const all = await Promise.all(
      models.map(async (model) => {
        err(style.dim(`model ${model}…`));
        const results = await runHarnessBenchmark({
          session,
          scenario,
          layouts,
          model,
          prices,
        });
        return { model, results };
      }),
    );
    if (bool(parsed, "json")) return json({ scenario: scenario.id, sweep: all });
    printSweep(all, scenario.title);
    return;
  }

  const model = str(parsed, "model") ?? session.profile.model ?? "zai-org/glm-5.3";
  const results = await runHarnessBenchmark({
    session,
    scenario,
    layouts,
    model,
    prices,
    onProgress: (message) => err(style.dim(message)),
  });

  if (bool(parsed, "json")) return json({ scenario: scenario.id, model, results });

  printResults(results, scenario.title, model);
}

function printSweep(sweep: { model: string; results: BenchResult[] }[], title: string): void {
  out(style.bold(`${title} · every model`));
  out();
  for (const { model, results } of sweep) {
    out(style.bold(model));
    out();
    table<BenchResult>(results, [
      { header: "harness", value: (r) => r.label },
      { header: "dialect", value: (r) => style.dim(r.dialect) },
      { header: "hit", value: (r) => `${(r.hitRatio * 100).toFixed(1)}%`, align: "right" },
      {
        header: "cost",
        value: (r) => `${currencySymbol("usd")}${r.costUsd.toFixed(6)}`,
        align: "right",
      },
      {
        header: "saved",
        value: (r) => {
          const saved = Math.abs(r.savedUsd) < 0.0000005 ? 0 : r.savedUsd;
          return `${currencySymbol("usd")}${saved.toFixed(6)}`;
        },
        align: "right",
      },
    ]);
    out();
  }
}

function printResults(results: BenchResult[], scenarioTitle: string, model: string): void {
  out(style.bold(`${scenarioTitle} · ${model}`));
  out();

  table<BenchResult>(results, [
    { header: "harness", value: (r) => r.label },
    { header: "dialect", value: (r) => style.dim(r.dialect) },
    { header: "turns", value: (r) => num(r.requests), align: "right" },
    {
      header: "hit",
      value: (r) => `${(r.hitRatio * 100).toFixed(1)}%`,
      align: "right",
    },
    { header: "cached", value: (r) => num(r.cachedTokens), align: "right" },
    {
      header: "cost",
      value: (r) => `${currencySymbol("usd")}${r.costUsd.toFixed(6)}`,
      align: "right",
    },
    {
      header: "saved",
      value: (r) => {
        // A rounding artifact can push a real zero to "-0.000000".
        const saved = Math.abs(r.savedUsd) < 0.0000005 ? 0 : r.savedUsd;
        return `${currencySymbol("usd")}${saved.toFixed(6)}`;
      },
      align: "right",
    },
  ]);

  out();
  for (const result of results) {
    const perTurn = result.turns.map((t) => (t.hit ? `${t.cachedTokens}` : "miss")).join(", ");
    out(style.dim(`${result.label.padEnd(18)} ${result.note}`));
    out(style.dim(`${" ".repeat(18)} cached per turn: ${perTurn}`));
  }
}
