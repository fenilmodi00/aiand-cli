import { AGENTS } from "../agents/registry.js";
import { collectBakedKeys, listAgentKeys } from "../api/agent-keys.js";
import {
  buildCacheReport,
  type CacheGroup,
  type CacheReport,
  cacheVerdict,
  type ModelPrice,
} from "../api/cache-report.js";
import { openSession } from "../api/client.js";
import { getLogsPaged, LOG_RANGES } from "../api/logs.js";
import { listModels } from "../api/models.js";
import { bool, int, list, oneOf, parse, str } from "../cli/args.js";
import { currencySymbol, json, num, out, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";

/**
 * The most rows the Gateway serves per page. 30 days at busy usage is tens
 * of thousands of requests; the rollup only needs enough rows to be
 * representative, and pulling the whole history into memory is wasteful.
 */
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

export const help = `${style.bold("aiand cache")} -- cache hit rate and what it saved

Usage
  aiand cache
  aiand cache --range 24h
  aiand cache --by model
  aiand cache --attribute claude=sk-abcd...1234
  aiand cache --json

Options
  --range <window>    15m, 1h, 6h, 24h (default), 7days, 30days
  --by <group>        group by agent (default), model, or key
  --attribute <a=k>   label a key with an agent (repeatable)
  --limit <n>         requests to analyze (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})
  --json              machine-readable output

Every number comes from the Gateway's own per-request reporting. Requests are
attributed to an agent by the API key the CLI baked into that agent's config,
so an agent wired by hand shows as "unknown" rather than being guessed. Use
--attribute to label such a key yourself.`;

type GroupBy = "agent" | "model" | "key";

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    range: { type: "string" },
    by: { type: "string" },
    attribute: { type: "string", multiple: true },
    limit: { type: "string" },
  });
  if (bool(parsed, "help")) return out(help);

  const session = await openSession(resolveProfile(str(parsed, "profile")));
  const range = oneOf(parsed, "range", LOG_RANGES, "24h");
  const by = oneOf(parsed, "by", ["agent", "model", "key"] as const, "agent");
  const limit = Math.min(MAX_LIMIT, Math.max(1, int(parsed, "limit") ?? DEFAULT_LIMIT));

  const { entries, truncated } = await getLogsPaged(session, { range, limit });

  // The local key map: masked key -> agent id. The sweep reads each wired
  // agent's own config, so agents wired before the map existed are still
  // attributed; a key we cannot place stays "unknown".
  const agentByKey: Record<string, string> = {};
  for (const record of listAgentKeys()) agentByKey[record.masked] = record.agent;
  for (const record of await collectBakedKeys(AGENTS)) agentByKey[record.masked] = record.agent;

  // Explicit labels win: the user knows which key belongs to which agent
  // when the CLI cannot work it out (an agent wired by hand).
  for (const label of list(parsed, "attribute")) {
    const pair = label.split("=");
    const agent = pair[0];
    const key = pair[1];
    if (agent && key) agentByKey[key.trim()] = agent.trim();
  }

  // Catalog prices, so the savings are priced at each model's real rates.
  const prices: Record<string, ModelPrice> = {};
  try {
    for (const model of await listModels(session, session.profile.apiUrl)) {
      prices[model.id] = {
        inputPer1m: Number(model.input_per_1m),
        cachedPer1m: Number(model.cached_input_per_1m ?? 0),
        outputPer1m: Number(model.output_per_1m),
      };
    }
  } catch {
    // A catalog failure must not hide the traffic: the report still works,
    // it just cannot price the uncached baseline.
  }

  const report = buildCacheReport({ range, entries, agentByKey, prices });

  if (bool(parsed, "json")) return json(report);

  if (entries.length === 0) {
    out(style.dim(`No requests in the last ${range}.`));
    return;
  }

  printReport(report, by);
  out();
  out(
    style.dim(
      truncated
        ? `analyzed the first ${entries.length} requests in the last ${range} (use --limit for more).`
        : `analyzed ${entries.length} requests in the last ${range}.`,
    ),
  );
}

function printReport(report: CacheReport, by: GroupBy): void {
  const { totals } = report;

  out(style.bold(`Cache · last ${report.range}`));
  out();
  table(
    [
      { label: "requests", value: num(totals.requests) },
      { label: "prompt tokens", value: num(totals.inputTokens) },
      { label: "cached", value: num(totals.cachedTokens) },
      {
        label: "cache miss rate",
        value: `${percent(totals.misses / Math.max(1, totals.requests))} (${num(totals.misses)} turns)`,
      },
      { label: "hit rate", value: percent(report.hitRatio) },
      { label: "spent", value: `${currencySymbol("usd")}${report.totals.costUsd.toFixed(6)}` },
      { label: "saved by cache", value: `${currencySymbol("usd")}${report.savedUsd.toFixed(6)}` },
    ],
    [
      { header: "", value: (r) => style.dim(r.label) },
      { header: "", value: (r) => r.value, align: "right" },
    ],
  );

  const groups = by === "model" ? report.byModel : by === "key" ? report.byKey : report.byAgent;

  out();
  out(style.bold(`By ${by}`));
  out();
  printGroups(groups);

  if (report.unattributedRequests > 0) {
    out();
    out(
      style.dim(
        `${num(report.unattributedRequests)} requests could not be attributed to an agent.`,
      ),
    );
    out(style.dim("Wire an agent with `aiand <agent> on` so the CLI can track it."));
  }
}

function printGroups(groups: CacheGroup[]): void {
  if (groups.length === 0) {
    out(style.dim("No requests."));
    return;
  }
  table<CacheGroup>(groups, [
    { header: "name", value: (g) => g.key },
    { header: "reqs", value: (g) => num(g.requests), align: "right" },
    {
      header: "hit",
      value: (g) => {
        // `input_tokens` includes `cached_tokens`.
        const hit = g.inputTokens > 0 ? g.cachedTokens / g.inputTokens : 0;
        const text = percent(hit);
        const verdict = cacheVerdict(g);
        return verdict === "bad"
          ? style.red(text)
          : verdict === "warn"
            ? style.yellow(text)
            : style.green(text);
      },
      align: "right",
    },
    { header: "misses", value: (g) => num(g.misses), align: "right" },
    {
      header: "cost",
      value: (g) => `${currencySymbol("usd")}${g.costUsd.toFixed(6)}`,
      align: "right",
    },
  ]);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
