import { ApiError, CliError, cancelled } from "../cli/errors.js";
import {
  gatewayNotJsonError,
  HEADERS,
  midStreamAbortError,
  parseJsonResponse,
  request,
  type Session,
} from "./client.js";

export type Message = { role: "system" | "user" | "assistant"; content: string };

export type ChatRequest = {
  model: string;
  messages: Message[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
  stop?: string[];
};

export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

export type ChatMeta = {
  model?: string;
  requestId?: string;
  cost?: string;
  costCurrency?: string;
  inferenceMs?: number;
  reasoningEffort?: string;
  emptyCompletion?: string;
};

function readMeta(response: Response): ChatMeta {
  const get = (name: string): string | undefined => response.headers.get(name) ?? undefined;
  const inferenceMs = get(HEADERS.INFERENCE_MS);
  return {
    model: get(HEADERS.MODEL),
    requestId: get(HEADERS.REQUEST_ID),
    cost: get(HEADERS.COST),
    costCurrency: get(HEADERS.COST_CURRENCY),
    inferenceMs: inferenceMs === undefined ? undefined : Number(inferenceMs),
    reasoningEffort: get(HEADERS.REASONING_EFFORT),
    emptyCompletion: get(HEADERS.EMPTY_COMPLETION),
  };
}

function explainEmptyCompletion(reason: string): string {
  switch (reason) {
    case "reasoning_only":
      return "The model reasoned and then stopped without producing content. If you sent --stop, retry without it.";
    case "truncated":
      return "The token budget ran out inside the model's reasoning. Raise --max-tokens, or pick a model that reasons more briefly.";
    case "empty":
      return "The model produced nothing at all.";
    default:
      return `The response carried no content (${reason}).`;
  }
}

export function describeEmptyResponse(input: {
  meta: ChatMeta;
  finishReason?: string;
  usage?: Usage | null;
}): string {
  if (input.meta.emptyCompletion) return explainEmptyCompletion(input.meta.emptyCompletion);

  const reasoningTokens = input.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (input.finishReason === "length") {
    return reasoningTokens > 0
      ? `The token budget was spent reasoning (${reasoningTokens} reasoning tokens) before any answer was written. Raise --max-tokens, or pick a model that reasons more briefly.`
      : "The response hit the token limit before the model finished. Raise --max-tokens.";
  }
  if (reasoningTokens > 0) {
    return `The model reasoned (${reasoningTokens} tokens) and stopped without writing an answer. If you sent --stop, retry without it.`;
  }
  return "The model returned no content.";
}

const METRICS_HEADER = { [HEADERS.METRICS]: "true" };

export function withModelHint(error: unknown, model: string): unknown {
  if (
    error instanceof ApiError &&
    error.status === 400 &&
    model === "auto" &&
    error.message.includes("'auto' is not supported")
  ) {
    return new ApiError(
      error.status,
      "Automatic model selection is not enabled for this account.",
      {
        requestId: error.requestId,
        type: error.type,
        hint: "Name a model with -m, or set a default: aiand config set model <id>. `aiand models` lists them.",
      },
    );
  }
  return error;
}

export async function createChatCompletion(
  session: Session,
  body: ChatRequest,
  signal?: AbortSignal,
): Promise<{
  text: string;
  reasoning: string;
  finishReason?: string;
  usage: Usage | null;
  meta: ChatMeta;
  raw: unknown;
}> {
  const response = await request(session, {
    method: "POST",
    path: "/v1/chat/completions",
    body: { ...body, stream: false },
    headers: METRICS_HEADER,
    signal,
  });

  const meta = readMeta(response);
  const raw = await parseJsonResponse<{
    choices?: {
      message?: { content?: string | null; reasoning_content?: string | null };
      finish_reason?: string | null;
    }[];
    usage?: Usage;
  }>(response);
  const choice = raw.choices?.[0];

  return {
    text: choice?.message?.content ?? "",
    reasoning: choice?.message?.reasoning_content ?? "",
    finishReason: choice?.finish_reason ?? undefined,
    usage: raw.usage ?? null,
    meta,
    raw,
  };
}

export type StreamChunk = {
  text?: string;
  reasoning?: string;
  usage?: Usage;
  finishReason?: string;
};

export async function streamChatCompletion(
  session: Session,
  body: ChatRequest,
  signal?: AbortSignal,
): Promise<{ meta: ChatMeta; chunks: AsyncGenerator<StreamChunk> }> {
  const response = await request(session, {
    method: "POST",
    path: "/v1/chat/completions",
    body: { ...body, stream: true },
    headers: { ...METRICS_HEADER, Accept: "text/event-stream" },
    signal,
  });

  if (!response.body) {
    throw new CliError("The server returned an empty stream.");
  }
  assertEventStream(response);

  return { meta: readMeta(response), chunks: parseSse(response) };
}

type SseDelta = {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: Usage | null;
};

// A 200 HTML/text body on the stream endpoint is the same gateway failure
// parseJsonResponse reports as 502 — without this the HTML parses as an
// empty SSE stream and surfaces as a misleading "No content.".
function assertEventStream(response: Response): void {
  const contentType = response.headers.get("content-type");
  if (contentType?.toLowerCase().includes("text/event-stream")) return;
  throw gatewayNotJsonError(
    response,
    contentType
      ? `content-type "${contentType}" is not text/event-stream`
      : `missing content-type (expected "text/event-stream")`,
  );
}

async function* parseSse(response: Response): AsyncGenerator<StreamChunk> {
  const body = response.body as ReadableStream<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";
  let sniffed = false;

  try {
    for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });

      // A gateway answering 200 with HTML under an SSE content-type would
      // otherwise parse as an empty stream: the first non-blank byte of a
      // real event stream is never "<". Deferred past leading whitespace so
      // a chunk split cannot hide the "<".
      if (!sniffed) {
        const first = buffer.trimStart().slice(0, 1);
        if (first !== "") {
          sniffed = true;
          if (first === "<") {
            throw gatewayNotJsonError(
              response,
              "the response body looks like HTML, not server-sent events",
            );
          }
        }
      }

      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;

        let event: SseDelta;
        try {
          event = JSON.parse(payload) as SseDelta;
        } catch {
          continue;
        }

        const choice = event.choices?.[0];
        const chunk: StreamChunk = {};
        if (choice?.delta?.content) chunk.text = choice.delta.content;
        if (choice?.delta?.reasoning_content) chunk.reasoning = choice.delta.reasoning_content;
        if (choice?.finish_reason) chunk.finishReason = choice.finish_reason;
        if (event.usage) chunk.usage = event.usage;
        if (Object.keys(chunk).length > 0) yield chunk;
      }
    }
  } catch (cause) {
    // Mid-stream Ctrl-C aborts the body read: map it like fetchOrFail does
    // for the initial fetch so callers see CliError 130, not a raw AbortError.
    if (cause instanceof Error && cause.name === "AbortError") {
      throw cancelled();
    }
    // #104: a gateway that cuts the body mid-stream throws undici's
    // `TypeError: terminated` (or an errno cause) — classify it as a
    // retryable network failure instead of a raw exit-70 crash.
    throw midStreamAbortError(response.url, cause);
  }
}
