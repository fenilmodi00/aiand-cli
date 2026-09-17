import { parse, bool, float, int, str } from "../cli/args.js";
import { err, json, out, style } from "../cli/output.js";
import { readStdin } from "../cli/stdin.js";
import { CliError } from "../cli/errors.js";
import { resolveProfile } from "../config.js";
import { resolveEffectiveModel } from "../agents/catalog.js";
import { openSession, type Session } from "../api/client.js";
import {
  createChatCompletion,
  describeEmptyResponse,
  streamChatCompletion,
  withModelHint,
  type ChatMeta,
  type ChatRequest,
  type Message,
  type Usage,
} from "../api/inference.js";

export const help = `${style.bold("aiand run")} -- send one prompt and print the answer

Usage
  aiand run "explain this stack trace"
  cat main.ts | aiand run "review this file"
  aiand run --model auto --system "be terse" "why is the sky blue?"

Options
  -m, --model <id>           model to call (default: catalog preferred)
      --system <text>        system prompt
      --max-tokens <n>
      --temperature <n>
      --top-p <n>
      --reasoning-effort <l> one of the model's published levels
      --stop <text>          stop sequence (repeatable)
      --show-reasoning       stream reasoning tokens to stderr
      --no-stream            wait for the whole response
      --json                 print the raw API response
  -q, --quiet                suppress the stats footer

Piped stdin is appended to the prompt, so you can pass a file as context.
Omitting -m resolves a concrete catalog model (profile model when still listed,
else the curated preferred default). Pass -m auto to let ai& choose per request
when your account supports it; the choice is reported in the footer.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    model: { type: "string", short: "m" },
    system: { type: "string" },
    "max-tokens": { type: "string" },
    temperature: { type: "string" },
    "top-p": { type: "string" },
    "reasoning-effort": { type: "string" },
    stop: { type: "string", multiple: true },
    "show-reasoning": { type: "boolean", default: false },
    "no-stream": { type: "boolean", default: false },
    quiet: { type: "boolean", short: "q", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const profile = resolveProfile(str(parsed, "profile"));
  const prompt = await buildPrompt(parsed.positionals);
  const session = await openSession(profile);

  const messages: Message[] = [];
  const system = str(parsed, "system");
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const requested = str(parsed, "model");
  let model: string;
  try {
    model = await resolveEffectiveModel(requested, profile.apiUrl, profile.model);
  } catch (error) {
    if (requested) throw error;
    // Cold catalog + no network used to fail the prompt before send.
    // Unspecified model falls back to gateway `auto`.
    model = "auto";
  }

  const body: ChatRequest = {
    model,
    messages,
  };
  const maxTokens = int(parsed, "max-tokens");
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  const temperature = float(parsed, "temperature");
  if (temperature !== undefined) body.temperature = temperature;
  const topP = float(parsed, "top-p");
  if (topP !== undefined) body.top_p = topP;
  const effort = str(parsed, "reasoning-effort");
  if (effort) body.reasoning_effort = effort;
  const stop = parsed.values.stop as string[] | undefined;
  if (stop?.length) body.stop = stop;

  const wantsJson = bool(parsed, "json");
  const stream = !wantsJson && !bool(parsed, "no-stream");
  const quiet = bool(parsed, "quiet") || wantsJson;

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);

  try {
    if (stream) {
      await runStreaming(session, body, controller.signal, {
        showReasoning: bool(parsed, "show-reasoning"),
        quiet,
      });
    } else {
      const result = await createChatCompletion(session, body, controller.signal);
      if (wantsJson) return json(result.raw);

      if (result.reasoning && bool(parsed, "show-reasoning")) {
        err(style.dim(`thinking: ${result.reasoning}`));
      }
      if (result.text) {
        out(result.text);
      } else {
        err(
          style.yellow("No content. ") +
            describeEmptyResponse({
              meta: result.meta,
              finishReason: result.finishReason,
              usage: result.usage,
            })
        );
      }
      if (!quiet) err(statsLine(result.meta, result.usage));
    }
  } catch (error) {
    throw withModelHint(error, body.model);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

async function runStreaming(
  session: Session,
  body: ChatRequest,
  signal: AbortSignal,
  options: { showReasoning: boolean; quiet: boolean }
): Promise<void> {
  const { meta, chunks } = await streamChatCompletion(session, body, signal);

  let usage: Usage | null = null;
  let text = "";
  let finishReason: string | undefined;
  let reasoningOpen = false;

  for await (const chunk of chunks) {
    if (chunk.reasoning && options.showReasoning) {
      if (!reasoningOpen) {
        process.stderr.write(style.dim("thinking: "));
        reasoningOpen = true;
      }
      process.stderr.write(style.dim(chunk.reasoning));
    }
    if (chunk.text) {
      if (reasoningOpen) {
        process.stderr.write("\n");
        reasoningOpen = false;
      }
      text += chunk.text;
      process.stdout.write(chunk.text);
    }
    if (chunk.finishReason) finishReason = chunk.finishReason;
    if (chunk.usage) usage = chunk.usage;
  }

  if (reasoningOpen) process.stderr.write("\n");
  if (text && !text.endsWith("\n")) process.stdout.write("\n");

  if (!text) {
    err(style.yellow("No content. ") + describeEmptyResponse({ meta, finishReason, usage }));
  }

  if (!options.quiet) err(statsLine(meta, usage));
}

function statsLine(meta: ChatMeta, usage: Usage | null): string {
  const parts: string[] = [];
  if (meta.model) parts.push(meta.model);
  if (usage) {
    const cached = usage.prompt_tokens_details?.cached_tokens;
    parts.push(
      `${usage.prompt_tokens ?? 0} in / ${usage.completion_tokens ?? 0} out` +
        (cached ? ` (${cached} cached)` : "")
    );
  }
  if (meta.cost) {
    parts.push(`${meta.cost} ${(meta.costCurrency ?? "").toUpperCase()}`.trim());
  }
  if (meta.inferenceMs !== undefined && !Number.isNaN(meta.inferenceMs)) {
    parts.push(`${meta.inferenceMs}ms`);
  }
  if (meta.reasoningEffort) parts.push(`effort=${meta.reasoningEffort}`);
  if (meta.requestId) parts.push(meta.requestId);
  return style.dim(parts.join("  ·  "));
}

async function buildPrompt(positionals: string[]): Promise<string> {
  const inline = positionals.join(" ").trim();
  const piped = await readStdin();

  if (inline && piped) return `${inline}\n\n${piped}`;
  const prompt = inline || piped;
  if (!prompt) {
    throw new CliError("No prompt given.", {
      hint: 'Pass one as an argument -- aiand run "your question" -- or pipe it on stdin.',
    });
  }
  return prompt;
}
