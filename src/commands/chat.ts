import { createInterface } from "node:readline/promises";
import { openSession } from "../api/client.js";
import {
  type ChatRequest,
  type Message,
  streamChatCompletion,
  type Usage,
  withModelHint,
} from "../api/inference.js";
import { modelLabel } from "../api/models.js";
import { bool, float, int, parse, str } from "../cli/args.js";
import { CANCELLED_MESSAGE, CliError, EXIT } from "../cli/errors.js";
import { err, out, safeLine, sanitizeForTerminal, streamWriter, style } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { inferenceModel } from "./run.js";

export const help = `${style.bold("aiand chat")} -- interactive conversation

Usage
  aiand chat [options]

Options
  -m, --model <id>           model to call (default: catalog preferred)
      --system <text>        system prompt for the session
      --max-tokens <n>
      --temperature <n>
      --reasoning-effort <l>
      --show-reasoning       stream reasoning tokens

Omitting -m resolves a concrete catalog model (profile model when still listed,
else the curated preferred default). Pass -m auto to let ai& choose per request
when your account supports it. Escape and control sequences in the model's
replies are removed before they reach the terminal.

In-session commands
  /model <id>     switch model for the next turn
  /system <text>  replace the system prompt and reset the transcript
  /clear          forget the transcript, keep the settings
  /tokens         show tokens used so far
  /help           list these commands
  /exit           leave (Ctrl-D also works)`;

/** A usage count from the gateway, which the session totals add up and print: 0 unless a finite number. */
function tokenCount(value: unknown): number {
  const n = Number(value);
  return value === null || value === undefined || !Number.isFinite(n) ? 0 : n;
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    model: { type: "string", short: "m" },
    system: { type: "string" },
    "max-tokens": { type: "string" },
    temperature: { type: "string" },
    "reasoning-effort": { type: "string" },
    "show-reasoning": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  if (!process.stdin.isTTY) {
    throw new CliError("`aiand chat` needs an interactive terminal.", {
      hint: "For piped input use `aiand run` instead.",
    });
  }

  const profile = resolveProfile(str(parsed, "profile"));
  const session = await openSession(profile);

  let model = await inferenceModel(str(parsed, "model"), profile);
  let system = str(parsed, "system");
  const showReasoning = bool(parsed, "show-reasoning");
  const maxTokens = int(parsed, "max-tokens");
  const temperature = float(parsed, "temperature");
  const effort = str(parsed, "reasoning-effort");

  let transcript: Message[] = [];
  const totals = { input: 0, output: 0 };

  out(
    style.dim(
      `ai& chat -- model ${modelLabel(safeLine(model))}. /help for commands, /exit to leave.`,
    ),
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => style.cyan("> ");

  try {
    for (;;) {
      let line: string;
      try {
        line = (await rl.question(prompt())).trim();
      } catch {
        break;
      }
      if (!line) continue;

      if (line.startsWith("/")) {
        const [command, ...rest] = line.slice(1).split(" ");
        const argument = rest.join(" ").trim();

        if (command === "exit" || command === "quit") break;
        if (command === "help") {
          out(help);
          continue;
        }
        if (command === "clear") {
          transcript = [];
          out(style.dim("Transcript cleared."));
          continue;
        }
        if (command === "tokens") {
          out(style.dim(`${totals.input} in / ${totals.output} out this session.`));
          continue;
        }
        if (command === "model") {
          if (!argument) {
            out(style.dim(`Model is ${modelLabel(safeLine(model))}.`));
            continue;
          }
          model = argument;
          out(style.dim(`Model set to ${modelLabel(safeLine(model))}.`));
          continue;
        }
        if (command === "system") {
          system = argument || undefined;
          transcript = [];
          out(
            style.dim(system ? "System prompt set; transcript cleared." : "System prompt cleared."),
          );
          continue;
        }
        out(style.yellow(`Unknown command /${safeLine(command ?? "")}. Try /help.`));
        continue;
      }

      transcript.push({ role: "user", content: line });

      const body: ChatRequest = {
        model,
        messages: system ? [{ role: "system", content: system }, ...transcript] : [...transcript],
      };
      if (maxTokens !== undefined) body.max_tokens = maxTokens;
      if (temperature !== undefined) body.temperature = temperature;
      if (effort) body.reasoning_effort = effort;

      const controller = new AbortController();
      const onInterrupt = () => controller.abort();
      process.on("SIGINT", onInterrupt);

      let answer = "";
      let usage: Usage | null = null;
      const answerOut = streamWriter(process.stdout);
      const reasoningOut = streamWriter(process.stderr);
      try {
        const { meta, chunks } = await streamChatCompletion(session, body, controller.signal);
        for await (const chunk of chunks) {
          if (chunk.reasoning && showReasoning) reasoningOut.write(chunk.reasoning, style.dim);
          if (chunk.text) {
            reasoningOut.endLine();
            answer += chunk.text;
            answerOut.write(chunk.text);
          }
          if (chunk.usage) usage = chunk.usage;
        }
        reasoningOut.endLine();
        answerOut.endLine();

        if (usage) {
          totals.input += tokenCount(usage.prompt_tokens);
          totals.output += tokenCount(usage.completion_tokens);
        }
        if (meta.model && meta.model !== model) {
          err(style.dim(`(${modelLabel(safeLine(meta.model))})`));
        }
      } catch (e) {
        const failure = withModelHint(e, model);
        if (failure instanceof CliError && failure.exitCode === EXIT.INTERRUPTED) {
          // Ctrl-C mid-turn cancels the turn, not the session.
          reasoningOut.endLine();
          answerOut.endLine();
          err(style.dim(CANCELLED_MESSAGE));
          transcript.pop();
          continue;
        }
        const message = failure instanceof Error ? failure.message : String(failure);
        err(style.red(sanitizeForTerminal(message)));
        if (failure instanceof CliError && failure.hint) {
          err(style.dim(sanitizeForTerminal(failure.hint)));
        }
        transcript.pop();
        continue;
      } finally {
        process.removeListener("SIGINT", onInterrupt);
      }

      if (answer) {
        transcript.push({ role: "assistant", content: answer });
      } else {
        err(style.yellow("The model returned no content."));
        transcript.pop();
      }
    }
  } finally {
    rl.close();
  }

  out(style.dim(`Bye. ${totals.input} in / ${totals.output} out this session.`));
}
