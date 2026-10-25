import type { Session } from "../api/client.js";
import { listModels, type Model } from "../api/models.js";
import {
  BENCH_TOOL,
  type HarnessDialect,
  type HarnessLayout,
  type HarnessMessage,
} from "./harness-layouts.js";

/**
 * The harness benchmark: replay one use case through each harness layout and
 * measure what the Gateway charged for it.
 *
 * Every number is measured, never modelled. A turn's cached tokens come from
 * the Gateway's own `usage` block, and the cost from its `X-Cost` header, so
 * the comparison reflects the real billing path.
 *
 * The two dialects report the prompt differently and this file has to know
 * it (verified against the Gateway's own cost arithmetic):
 *
 *   - OpenAI (`/v1/chat/completions`): `prompt_tokens` INCLUDES the cached
 *     portion. The uncached part is `prompt_tokens - cached_tokens`.
 *   - Anthropic (`/v1/messages`): `input_tokens` EXCLUDES the cached
 *     portion. The uncached part is `input_tokens`.
 */

type BenchTurn = {
  turn: number;
  /** The whole prompt, cached portion included. */
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  hit: boolean;
};

export type BenchScenario = {
  id: string;
  title: string;
  /** The turns the harness sends, in order. */
  turns: string[];
  /** The file the scenario reads, and what is in it. */
  file: { path: string; content: string };
};

export type BenchResult = {
  harness: string;
  label: string;
  note: string;
  dialect: HarnessDialect;
  model: string;
  turns: BenchTurn[];
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  costUsd: number;
  hitRatio: number;
  /** What the same traffic would cost with no cache, at the model's rates. */
  costIfUncached: number;
  savedUsd: number;
};

export type RunBenchOptions = {
  session: Session;
  scenario: BenchScenario;
  layouts: HarnessLayout[];
  model: string;
  /** The price table, for the uncached baseline. */
  prices: Record<string, ModelPrice>;
  /** Extra fetch, for tests. */
  fetchImpl?: typeof fetch;
  onProgress?: (message: string) => void;
};

export type ModelPrice = {
  inputPer1m: number;
  cachedPer1m: number;
  outputPer1m: number;
};

/**
 * The system block every layout sends. It is the same for every harness and
 * every turn — that is the point: the layouts differ only in what they do
 * with the conversation, never in the leading block.
 */
function benchSystem(salt: string): string {
  const unit = "The quick brown fox jumps over the lazy dog. ";
  return `${salt} ${unit.repeat(300)}`;
}

type Encoded = {
  url: string;
  body: Record<string, unknown>;
  /** Which usage field carries the cached token count. */
  dialect: HarnessDialect;
};

/**
 * Encode a neutral message list into the wire format the harness speaks.
 *
 * The two dialects disagree on more than field names: the Anthropic one
 * carries the system block outside the message list and encodes a tool call
 * as a `tool_use` content block, while the OpenAI one puts the system in
 * `messages[0]` and encodes it as `tool_calls`. Sending the wrong one is a
 * 400 from the Gateway, not a quiet difference.
 */
function encode(
  messages: HarnessMessage[],
  dialect: HarnessDialect,
  model: string,
  baseUrl: string,
): Encoded {
  if (dialect === "anthropic") {
    const system = messages.find((m) => m.role === "system");
    const rest = messages.filter((m) => m.role !== "system");
    const body: Record<string, unknown> = {
      model,
      max_tokens: 4,
      system: system?.role === "system" ? system.text : "",
      messages: rest.map((message) => {
        if (message.role === "user") {
          return { role: "user", content: message.text };
        }
        if (message.role === "assistant") {
          if (message.toolCall) {
            return {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: message.toolCall.id,
                  name: message.toolCall.name,
                  input: message.toolCall.input,
                },
              ],
            };
          }
          return { role: "assistant", content: message.text };
        }
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId,
              content: [{ type: "text", text: message.text }],
            },
          ],
        };
      }),
      tools: [BENCH_TOOL],
    };
    return { url: `${baseUrl}/v1/messages`, body, dialect };
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: 4,
    messages: messages.map((message) => {
      if (message.role === "system") return { role: "system", content: message.text };
      if (message.role === "user") return { role: "user", content: message.text };
      if (message.role === "assistant") {
        if (message.toolCall) {
          return {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: message.toolCall.id,
                type: "function",
                function: {
                  name: message.toolCall.name,
                  arguments: JSON.stringify(message.toolCall.input),
                },
              },
            ],
          };
        }
        return { role: "assistant", content: message.text };
      }
      return { role: "tool", tool_call_id: message.toolCallId, content: message.text };
    }),
    tools: [
      {
        type: "function",
        function: {
          name: BENCH_TOOL.name,
          description: BENCH_TOOL.description,
          parameters: BENCH_TOOL.input_schema,
        },
      },
    ],
  };
  return { url: `${baseUrl}/v1/chat/completions`, body, dialect };
}

async function send(
  session: Session,
  encoded: Encoded,
  fetchImpl: typeof fetch,
): Promise<{ promptTokens: number; cachedTokens: number; outputTokens: number; costUsd: number }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.token}`,
    "Content-Type": "application/json",
    "X-Aiand-Metrics": "true",
  };
  if (encoded.dialect === "anthropic") headers["anthropic-version"] = "2023-06-01";

  const response = await fetchImpl(encoded.url, {
    method: "POST",
    headers,
    body: JSON.stringify(encoded.body),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 160);
    throw new Error(`The gateway rejected the request: HTTP ${response.status}. ${detail}`);
  }
  const body = (await response.json()) as {
    usage?: {
      prompt_tokens?: number;
      input_tokens?: number;
      completion_tokens?: number;
      output_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      cache_read_input_tokens?: number;
    };
  };
  const usage = body.usage ?? {};
  const cached =
    encoded.dialect === "anthropic"
      ? (usage.cache_read_input_tokens ?? 0)
      : (usage.prompt_tokens_details?.cached_tokens ?? 0);
  const uncached =
    encoded.dialect === "anthropic"
      ? (usage.input_tokens ?? 0)
      : (usage.prompt_tokens ?? 0) - cached;
  const output =
    encoded.dialect === "anthropic" ? (usage.output_tokens ?? 0) : (usage.completion_tokens ?? 0);

  return {
    promptTokens: uncached + cached,
    cachedTokens: cached,
    outputTokens: output,
    costUsd: Number(response.headers.get("x-cost") ?? 0),
  };
}

/**
 * Replay one scenario through one layout.
 *
 * The turns are sent in order. A layout that appends (the well-behaved
 * case) keeps the previous request as a prefix of the next one, so the
 * Gateway serves it from cache. A layout that rewrites anything earlier
 * does not, and every turn is billed at the full rate.
 */
async function runLayout(
  options: RunBenchOptions,
  layout: HarnessLayout,
  salt: string,
): Promise<BenchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const system = benchSystem(salt);
  const turns: BenchTurn[] = [];
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  for (let index = 0; index < options.scenario.turns.length; index++) {
    // The FIRST user block is always the first turn's prompt: a harness
    // appends to the conversation, so the leading blocks never change.
    // Later turns appear in `followUps`.
    const followUps = options.scenario.turns.slice(1, index + 1);
    const messages = layout.build({
      turn: index + 1,
      system,
      toolOutput: options.scenario.file.content,
      // The SAME tool call every turn: a harness that reads the file once
      // keeps that call in its history, and the block has to be byte-stable
      // for the request to extend the previous one.
      toolCallId: "call_1",
      prompt: options.scenario.turns[0]!,
      followUps,
    });
    const encoded = encode(messages, layout.dialect, options.model, options.session.profile.apiUrl);
    const result = await send(options.session, encoded, fetchImpl);
    turns.push({
      turn: index + 1,
      promptTokens: result.promptTokens,
      cachedTokens: result.cachedTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      hit: result.cachedTokens > 0,
    });
    inputTokens += result.promptTokens;
    cachedTokens += result.cachedTokens;
    outputTokens += result.outputTokens;
    costUsd += result.costUsd;
  }

  // The uncached baseline: every prompt token at the full input rate, plus
  // the output at the output rate.
  const price = options.prices[options.model];
  const costIfUncached = price
    ? (inputTokens / 1e6) * price.inputPer1m + (outputTokens / 1e6) * price.outputPer1m
    : 0;

  return {
    harness: layout.id,
    label: layout.label,
    note: layout.note,
    dialect: layout.dialect,
    model: options.model,
    turns,
    requests: turns.length,
    inputTokens,
    cachedTokens,
    costUsd,
    hitRatio: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    costIfUncached,
    savedUsd: costIfUncached - costUsd,
  };
}

export async function runHarnessBenchmark(options: RunBenchOptions): Promise<BenchResult[]> {
  // The layouts run in PARALLEL: each has its own cache salt, so they do not
  // interfere, and a comparison should not take the sum of the harnesses'
  // latencies. The order of the results follows the order of the layouts.
  const results = await Promise.all(
    options.layouts.map(async (layout) => {
      options.onProgress?.(`running ${layout.label}…`);
      // A distinct salt per layout: the cache entries of one layout must
      // not be the cache entries of another, or the second layout would
      // inherit a hit.
      const salt = `bench-${layout.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return runLayout(options, layout, salt);
    }),
  );
  return results;
}

/** The catalog prices, for the uncached baseline. */
export async function loadPrices(
  session: Session,
  apiUrl: string,
): Promise<Record<string, ModelPrice>> {
  const prices: Record<string, ModelPrice> = {};
  const models: Model[] = await listModels(session, apiUrl);
  for (const model of models) {
    prices[model.id] = {
      inputPer1m: Number(model.input_per_1m),
      cachedPer1m: Number(model.cached_input_per_1m ?? 0),
      outputPer1m: Number(model.output_per_1m),
    };
  }
  return prices;
}
