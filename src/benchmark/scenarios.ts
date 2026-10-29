import type { BenchScenario } from "./harness-bench.js";

/**
 * A deterministic block of fake source, one section per index. Every
 * scenario fixture is built by repeating fixed strings like this one — no
 * randomness anywhere, so two generations are byte-identical.
 */
function sourceSection(index: number): string {
  return `// section ${index}
export function section${index}(tokens: number): number {
  return Math.floor(tokens / ${index + 1}) * 128;
}
`;
}

/** The cache-policy file the existing scenarios read, verbatim. */
const CACHE_POLICY_FILE = `export function ttlForPrefix(kind: "ephemeral_5m" | "ephemeral_1h"): number {
  return kind === "ephemeral_1h" ? 3600 : 300;
}
export const CACHE_FLOOR_TOKENS = 1024;
export function quantize(tokens: number): number {
  return Math.floor(tokens / 128) * 128;
}`;

/** The long-context variant's file: the policy plus a large stable body. */
const CACHE_POLICY_LONG_FILE = `${CACHE_POLICY_FILE}
${Array.from({ length: 150 }, (_, i) => sourceSection(i + 1)).join("\n")}`;

/** The long-file-read scenario's file: one read that dominates the tokens. */
const LARGE_NOTES_FILE = `export const CACHE_POLICY_NOTES: string[] = [
${Array.from({ length: 400 }, (_, i) => `  "note ${i}: the leading blocks stay stable while the conversation grows",`).join("\n")}
];
${CACHE_POLICY_FILE}`;

/** The tool-heavy scenario's checklist outputs: short, one per tool call. */
const CHECKLIST_RESULTS = Array.from({ length: 8 }, (_, i) => `step ${i + 1}: ok (0 findings)`);

/**
 * The use cases the harness benchmark replays.
 *
 * These are the scenarios CacheLane's recorded benchmark uses, reduced to
 * what the harness benchmark needs: the turns a harness sends and the file
 * it reads. They cover the shapes that matter for cache behavior — a single
 * read, several reads, a test run, an edit, a quote, and multi-turn work
 * where the conversation grows — plus the agent-shaped families: a long
 * refactor with a large stable context, a single very large read, many
 * short tool exchanges, and a scripted tool error followed by its retry.
 */
export const BENCH_SCENARIOS: BenchScenario[] = [
  {
    id: "read-summarize-file",
    title: "Read and summarize a file",
    turns: ["Read src/cache-policy.ts and summarize the TTL behavior in two sentences."],
    file: {
      path: "src/cache-policy.ts",
      content: `export function ttlForPrefix(kind: "ephemeral_5m" | "ephemeral_1h"): number {
  return kind === "ephemeral_1h" ? 3600 : 300;
}
export const CACHE_FLOOR_TOKENS = 1024;
export function quantize(tokens: number): number {
  return Math.floor(tokens / 128) * 128;
}`,
    },
  },
  {
    id: "inspect-multiple-files",
    title: "Inspect several files",
    turns: [
      "Read src/cache-policy.ts and summarize the TTL behavior in two sentences.",
      "Now read src/pruner.ts and explain when a block is pruned.",
    ],
    file: {
      path: "src/cache-policy.ts",
      content: `export function ttlForPrefix(kind: "ephemeral_5m" | "ephemeral_1h"): number {
  return kind === "ephemeral_1h" ? 3600 : 300;
}
export const CACHE_FLOOR_TOKENS = 1024;
export function quantize(tokens: number): number {
  return Math.floor(tokens / 128) * 128;
}
export function isCacheable(tokens: number): boolean {
  return tokens >= CACHE_FLOOR_TOKENS;
}`,
    },
  },
  {
    id: "debug-failing-test",
    title: "Debug a failing test",
    turns: [
      "Read src/cache-policy.ts and summarize the TTL behavior in two sentences.",
      "The test says the one hour prefix never refreshes. Find the edge case.",
    ],
    file: {
      path: "src/cache-policy.ts",
      content: `export function ttlForPrefix(kind: "ephemeral_5m" | "ephemeral_1h"): number {
  return kind === "ephemeral_1h" ? 3600 : 300;
}
// The keepalive worker should avoid refreshing one hour prefixes unless
// the policy explicitly enables it.
export function shouldKeepalive(kind: "ephemeral_5m" | "ephemeral_1h", enabled: boolean): boolean {
  return kind === "ephemeral_5m" || enabled;
}
export const CACHE_FLOOR_TOKENS = 1024;`,
    },
  },
  {
    id: "edit-file-after-context",
    title: "Edit a file after reading it",
    turns: [
      "Read src/cache-policy.ts and summarize the TTL behavior in two sentences.",
      "Change the one hour TTL to 7200 seconds.",
    ],
    file: {
      path: "src/cache-policy.ts",
      content: `export function ttlForPrefix(kind: "ephemeral_5m" | "ephemeral_1h"): number {
  return kind === "ephemeral_1h" ? 3600 : 300;
}
export const CACHE_FLOOR_TOKENS = 1024;
export function quantize(tokens: number): number {
  return Math.floor(tokens / 128) * 128;
}`,
    },
  },
  {
    id: "quote-tool-output",
    title: "Quote a tool output",
    turns: [
      "Read src/cache-policy.ts and summarize the TTL behavior in two sentences.",
      "Quote the exact line that sets the one hour TTL.",
    ],
    file: {
      path: "src/cache-policy.ts",
      content: `export function ttlForPrefix(kind: "ephemeral_5m" | "ephemeral_1h"): number {
  return kind === "ephemeral_1h" ? 3600 : 300;
}
export const CACHE_FLOOR_TOKENS = 1024;
export function quantize(tokens: number): number {
  return Math.floor(tokens / 128) * 128;
}
export function isCacheable(tokens: number): boolean {
  return tokens >= CACHE_FLOOR_TOKENS;
}`,
    },
  },
  {
    id: "multi-turn-refactor",
    title: "Multi-turn refactor (short context)",
    turns: [
      "Read src/cache-policy.ts and summarize the TTL behavior in two sentences.",
      "Find any edge case where the one hour prefix never refreshes.",
      "Write a test that reproduces that edge case.",
      "Refactor ttlForPrefix to fix the edge case while keeping the test green.",
    ],
    file: {
      path: "src/cache-policy.ts",
      content: `export function ttlForPrefix(kind: "ephemeral_5m" | "ephemeral_1h"): number {
  return kind === "ephemeral_1h" ? 3600 : 300;
}
// The keepalive worker should avoid refreshing one hour prefixes unless
// the policy explicitly enables it.
export function shouldKeepalive(kind: "ephemeral_5m" | "ephemeral_1h", enabled: boolean): boolean {
  return kind === "ephemeral_5m" || enabled;
}
export const CACHE_FLOOR_TOKENS = 1024;`,
    },
  },
  {
    id: "multi-turn-refactor-long",
    title: "Multi-turn refactor, long context",
    turns: [
      "Read src/cache-policy.ts and summarize the TTL behavior in two sentences.",
      "Find any edge case where the one hour prefix never refreshes.",
      "Write a test that reproduces that edge case.",
      "Refactor ttlForPrefix to fix the edge case while keeping the test green.",
      "Check every section of the file against the new policy and list mismatches.",
      "Update the module docstring to describe the fixed behavior.",
    ],
    file: {
      path: "src/cache-policy.ts",
      // A large STABLE body: the whole point is that the long prefix keeps
      // hitting the cache as the conversation grows on top of it.
      content: CACHE_POLICY_LONG_FILE,
    },
  },
  {
    id: "long-file-read",
    title: "One very large file read",
    turns: [
      "Read src/cache-notes.ts and summarize the policy notes in three sentences.",
      "Which note number talks about leading blocks?",
    ],
    file: {
      path: "src/cache-notes.ts",
      // The read dominates the tokens: one big stable prefix, then a small
      // conversation on top.
      content: LARGE_NOTES_FILE,
    },
  },
  {
    id: "tool-heavy",
    title: "Many short tool calls interleaved",
    turns: [
      "Read src/cache-policy.ts, then work through the refactor checklist one step at a time.",
      "Keep going through the checklist.",
      "Keep going through the checklist.",
      "Keep going through the checklist.",
      "Keep going through the checklist.",
      "Keep going through the checklist.",
      "Keep going through the checklist.",
      "Keep going through the checklist.",
      "Summarize the checklist results and any findings.",
    ],
    file: {
      path: "src/cache-policy.ts",
      content: CACHE_POLICY_FILE,
    },
    // After the initial read, each turn adds one more short tool exchange:
    // eight in total, alternating call and result, the shape a terminal
    // harness produces most of the time.
    toolResults: CHECKLIST_RESULTS,
  },
  {
    id: "tool-error-retry",
    title: "Tool error followed by a retry",
    turns: [
      "Read src/cache-policy.ts and summarize the TTL behavior in two sentences.",
      "Read src/pruner.ts and check whether it respects the cache floor.",
      "The read failed. Try the same read again.",
      "Now summarize what the pruner does.",
    ],
    file: {
      path: "src/cache-policy.ts",
      content: CACHE_POLICY_FILE,
    },
    // One extra read exchange after the initial file read. The scripted
    // outcome marks that read's call as failed: turn 2 carries the error,
    // turn 3 re-issues it (the retry), turn 4 confirms the result sticks.
    toolResults: ["step 1: read src/pruner.ts"],
    // call_2 is the extra read (call_1 is the initial file read, always ok).
    scriptedOutcomes: [{ toolId: "call_2", ok: false }],
  },
];

export function findBenchScenario(id: string): BenchScenario | undefined {
  return BENCH_SCENARIOS.find((scenario) => scenario.id === id);
}
