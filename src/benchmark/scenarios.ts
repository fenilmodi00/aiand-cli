import type { BenchScenario } from "./harness-bench.js";

/**
 * The use cases the harness benchmark replays.
 *
 * These are the scenarios CacheLane's recorded benchmark uses, reduced to
 * what the harness benchmark needs: the turns a harness sends and the file
 * it reads. They cover the shapes that matter for cache behavior — a single
 * read, several reads, a test run, an edit, a quote, and multi-turn work
 * where the conversation grows.
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
    title: "Multi-turn refactor",
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
];

export function findBenchScenario(id: string): BenchScenario | undefined {
  return BENCH_SCENARIOS.find((scenario) => scenario.id === id);
}
