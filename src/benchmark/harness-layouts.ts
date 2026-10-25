/**
 * Harness request layouts.
 *
 * A harness is not a prompt — it is a *request shape*. The Gateway's cache is
 * a prefix cache, so what decides whether a harness gets a cache hit is how
 * it lays out the blocks it sends:
 *
 *   - a stable leading section (system, tools) that never changes,
 *   - a growing conversation appended at the tail,
 *   - and no rewriting of anything that was sent before.
 *
 * A harness that rebuilds its system block each turn, or that compacts its
 * history into a new summary, breaks that prefix and pays full price on
 * every request.
 *
 * Each layout also declares its **dialect** — the wire format the harness
 * really speaks. The two dialects differ in more than field names: the
 * OpenAI dialect reports `prompt_tokens` (which INCLUDES the cached
 * portion), the Anthropic dialect reports `input_tokens` (which EXCLUDES
 * it), and they carry tool calls differently. Measuring a harness means
 * sending what that harness sends.
 *
 * Measured against the live Gateway (2026-10-21, deepseek-ai/deepseek-v4-flash):
 *   claude-code shape -> 0, 5632, 5760, 5760 cached
 *   omp shape         -> 0, 5632, 5632, 5632 cached
 */

/** The wire format a harness speaks. */
export type HarnessDialect = "anthropic" | "openai";

type HarnessToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/** A neutral message, before it is encoded for a dialect. */
export type HarnessMessage =
  | { role: "system"; text: string }
  | { role: "user"; text: string }
  | { role: "assistant"; text: string | null; toolCall?: HarnessToolCall }
  | { role: "toolResult"; toolCallId: string; text: string };

type HarnessTurnInput = {
  turn: number;
  /** The stable leading block, identical for every turn. */
  system: string;
  /** The tool result the harness sends after the file read. */
  toolOutput: string;
  /** The tool call the harness emits to trigger the read. */
  toolCallId: string;
  /** The user turn text. */
  prompt: string;
  /** The follow-up turns, one per completed turn after the first. */
  followUps: string[];
};

export type HarnessLayout = {
  id: string;
  label: string;
  /** The wire format this harness speaks. */
  dialect: HarnessDialect;
  /** One-line description of what the layout does to the leading blocks. */
  note: string;
  /**
   * Build the message array for a turn. `turn` is 1-based; the layout must
   * return a growing conversation for a well-behaved harness.
   */
  build: (input: HarnessTurnInput) => HarnessMessage[];
};

/** The tool schema every layout sends, in the Anthropic dialect's shape. */
export const BENCH_TOOL = {
  name: "Read",
  description: "Read a file from the workspace",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

const readToolCall = (id: string, path: string): HarnessToolCall => ({
  id,
  name: "Read",
  input: { path },
});

/**
 * The layouts under test.
 *
 * `claude-code` and `omp` are the two real harnesses, each in the dialect
 * it actually speaks. The rest isolate one way a prefix can break, on the
 * Claude Code shape so the comparison against it is like-for-like.
 */
export const HARNESS_LAYOUTS: HarnessLayout[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    dialect: "anthropic",
    note: "Anthropic dialect, stable system + tools, append-only transcript",
    build: ({ system, toolOutput, toolCallId, prompt, followUps }) => {
      const messages: HarnessMessage[] = [
        { role: "system", text: system },
        { role: "user", text: prompt },
        {
          role: "assistant",
          text: null,
          toolCall: readToolCall(toolCallId, "src/workspace.ts"),
        },
        { role: "toolResult", toolCallId, text: toolOutput },
      ];
      for (let i = 0; i < followUps.length; i++) {
        messages.push({ role: "assistant", text: `read complete (step ${i + 1})` });
        messages.push({ role: "user", text: followUps[i]! });
      }
      return messages;
    },
  },
  {
    id: "omp",
    label: "Oh My Pi",
    dialect: "openai",
    note: "OpenAI dialect, stable system + tools, append-only transcript",
    build: ({ system, toolOutput, toolCallId, prompt, followUps }) => {
      // OMP's own logs confirm the shape: a non-message prefix (system and
      // instructions), a tool-schema prefix, then a growing message list.
      const messages: HarnessMessage[] = [
        { role: "system", text: system },
        { role: "user", text: prompt },
        {
          role: "assistant",
          text: null,
          toolCall: readToolCall(toolCallId, "src/workspace.ts"),
        },
        { role: "toolResult", toolCallId, text: toolOutput },
      ];
      for (let i = 0; i < followUps.length; i++) {
        messages.push({ role: "assistant", text: `read complete (step ${i + 1})` });
        messages.push({ role: "user", text: followUps[i]! });
      }
      return messages;
    },
  },
  {
    id: "rebuilt-system",
    label: "Rebuilt system block",
    dialect: "anthropic",
    note: "the system block is rebuilt every turn (model + turn counter)",
    build: ({ turn, system, toolOutput, toolCallId, prompt, followUps }) => {
      const messages: HarnessMessage[] = [
        // The system block changes with the turn, so the leading prefix the
        // Gateway cached no longer matches.
        { role: "system", text: `${system}\nmodel=bench turn=${turn}` },
        { role: "user", text: prompt },
        {
          role: "assistant",
          text: null,
          toolCall: readToolCall(toolCallId, "src/workspace.ts"),
        },
        { role: "toolResult", toolCallId, text: toolOutput },
      ];
      for (let i = 0; i < followUps.length; i++) {
        messages.push({ role: "assistant", text: `read complete (step ${i + 1})` });
        messages.push({ role: "user", text: followUps[i]! });
      }
      return messages;
    },
  },
  {
    id: "compacting",
    label: "Compacting client",
    dialect: "anthropic",
    note: "history replaced by a fresh summary each turn",
    build: ({ turn, system, toolOutput, toolCallId, prompt }) => {
      // A compaction rewrites the conversation into a new summary, so the
      // request is never an extension of the previous one.
      return [
        { role: "system", text: system },
        { role: "user", text: prompt },
        {
          role: "assistant",
          text: null,
          toolCall: readToolCall(toolCallId, "src/workspace.ts"),
        },
        { role: "toolResult", toolCallId, text: toolOutput },
        { role: "assistant", text: `summary of the session so far (turn ${turn})` },
      ];
    },
  },
  {
    id: "reordered",
    label: "Moving reorder",
    dialect: "anthropic",
    note: "blocks reordered by volatility — the order shifts as the conversation grows",
    build: ({ system, toolOutput, toolCallId, prompt, followUps }) => {
      // Reordering is only harmful when the ORDER ITSELF changes. A client
      // that reorders the same way every turn still extends its previous
      // request and still hits the cache. What breaks it is a reordering
      // driven by block volatility: as the conversation grows, blocks move
      // between classes, so the leading blocks differ from the last
      // request's. This is the shape CacheLane's orchestrator produced.
      const history: HarnessMessage[] = [
        { role: "system", text: system },
        { role: "user", text: prompt },
        {
          role: "assistant",
          text: null,
          toolCall: readToolCall(toolCallId, "src/workspace.ts"),
        },
        { role: "toolResult", toolCallId, text: toolOutput },
      ];
      for (let i = 0; i < followUps.length; i++) {
        history.push({ role: "assistant", text: `read complete (step ${i + 1})` });
        history.push({ role: "user", text: followUps[i]! });
      }
      // The newest exchange moves to the front as the conversation grows.
      const newest = history.length > 4 ? history.splice(history.length - 2, 2) : [];
      return [...newest, ...history];
    },
  },
  {
    id: "reordered-stable",
    label: "Consistent reorder",
    dialect: "anthropic",
    note: "reordered the same way every turn — the order never shifts",
    build: ({ system, toolOutput, toolCallId, prompt, followUps }) => {
      // The control for the layout above: a stable reorder still extends the
      // previous request, so it still hits the cache. Reordering per se is
      // not the problem; a MOVING reorder is.
      const history: HarnessMessage[] = [
        { role: "system", text: system },
        { role: "toolResult", toolCallId, text: toolOutput },
        { role: "user", text: prompt },
        {
          role: "assistant",
          text: null,
          toolCall: readToolCall(toolCallId, "src/workspace.ts"),
        },
      ];
      for (let i = 0; i < followUps.length; i++) {
        history.push({ role: "user", text: followUps[i]! });
        history.push({ role: "assistant", text: `read complete (step ${i + 1})` });
      }
      return history;
    },
  },
];

export function findHarnessLayout(id: string): HarnessLayout | undefined {
  return HARNESS_LAYOUTS.find((layout) => layout.id === id);
}
