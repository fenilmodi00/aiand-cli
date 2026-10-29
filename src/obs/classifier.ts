import type { EnvelopeV1 } from "../agents/envelope.js";

/**
 * Deterministic task classification (feature catalog C3, ticket #78).
 *
 * The CodeBurn 13-category taxonomy, adapted to the adapter envelope: the
 * classifier is a PURE function of the envelope sequence — same input, same
 * category, always — with ZERO LLM or network calls (both are forbidden by
 * the ticket; the module imports nothing that can reach either).
 *
 * The envelope carries tool NAMES only (never arguments), so rules match on
 * tool-name tokens (case-insensitive substrings) plus the edit-target
 * presence. Harnesses that name tools descriptively (`run_tests`,
 * `git_status`, `plan_mode`) classify richly; a harness that names everything
 * `Bash` falls through to the coarse but still deterministic Coding /
 * Exploration / Conversation buckets. Every fallthrough is a documented rule,
 * never a guess.
 *
 * Classification runs on LOCALLY CAPTURED envelopes only until the gateway
 * forwards them (OBS-GW-1): every payload carries the coverage annotation the
 * efficiency report renders — never presented as complete.
 */

export const TASK_CATEGORIES = [
  "Coding",
  "Debugging",
  "Feature",
  "Refactoring",
  "Testing",
  "Exploration",
  "Planning",
  "Delegation",
  "Git Ops",
  "Build-Deploy",
  "Brainstorming",
  "Conversation",
  "General",
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** The taxonomy member `value` names, or null when it is not a category. */
export function assertCategory(value: string): TaskCategory | null {
  return (TASK_CATEGORIES as readonly string[]).includes(value) ? (value as TaskCategory) : null;
}

/** One classified turn: the shape classification actually reads. */
export type ClassifiedTurn = {
  tools: readonly string[];
  editTargets: readonly string[];
};

/** The 13-category mix over a session, all categories present (sums to n). */
export type TaskMix = {
  /** Primary category: most frequent, taxonomy-order tiebreak (deterministic). */
  primary: TaskCategory;
  counts: Record<TaskCategory, number>;
};

const TEST = /test|spec|vitest|jest|pytest|coverage|assert/;
const GIT = /git|github|gitlab|\bgh\b|commit|merge|rebase|revert|stash|branch/; // descriptive git tools
const BUILD = /build|compil|bundle|deploy|docker|release|publish|install|lint|format/;
const DELEGATE = /delegate|subagent|spawn|dispatch|agent/; // "Agent"/"Task"-style delegation tools
const PLAN = /plan|todo|roadmap|milestone|spec(?!\w)/;
const BRAINSTORM = /brainstorm|ideate|idea/;
const DEBUG = /debug|diagnos|fix|bisect|profil|stack|breakpoint/;
const REFACTOR = /refactor|rename|move|extract|inline/;
const EDIT = /edit|write|patch|apply|insert|replace|create|multiedit|save/;
const NEW_FILE = /write|create|multiedit|save|apply/;

function matchesAny(names: readonly string[], pattern: RegExp): boolean {
  return names.some((name) => pattern.test(name.toLowerCase()));
}

/**
 * Classify ONE turn. The rule order below IS the specification — first match
 * wins, so the same turn always lands in the same category.
 */
export function classifyTurn(turn: ClassifiedTurn): TaskCategory {
  const tools = turn.tools;

  // Turn-level signals first: tests, git, build/deploy, delegation, planning,
  // brainstorming are identifiable from tool names alone.
  if (matchesAny(tools, TEST)) return "Testing";
  if (matchesAny(tools, GIT)) return "Git Ops";
  if (matchesAny(tools, BUILD)) return "Build-Deploy";
  if (matchesAny(tools, DELEGATE)) return "Delegation";
  if (matchesAny(tools, PLAN)) return "Planning";
  if (matchesAny(tools, BRAINSTORM)) return "Brainstorming";

  // Edit turns sub-classify by what accompanied the edit.
  if (turn.editTargets.length > 0 || matchesAny(tools, EDIT)) {
    if (matchesAny(tools, DEBUG)) return "Debugging";
    if (matchesAny(tools, REFACTOR)) return "Refactoring";
    if (turn.editTargets.length >= 2 || matchesAny(tools, NEW_FILE)) return "Feature";
    return "Coding";
  }

  // Read-only turn: exploration.
  if (tools.length > 0) return "Exploration";

  // No tools at all: a conversational turn.
  return "Conversation";
}

/** Classify a turn straight from a stored envelope. */
export function classifyEnvelope(envelope: EnvelopeV1): TaskCategory {
  return classifyTurn({ tools: envelope.tools, editTargets: envelope.edit_targets });
}

/**
 * Classify a session: per-turn categories plus the primary. The primary is
 the most frequent category, ties broken by taxonomy order — a pure,
 order-stable function of the envelope sequence (golden-fixture tested).
 */
export function classifySession(turns: readonly ClassifiedTurn[]): TaskMix {
  const counts = Object.fromEntries(TASK_CATEGORIES.map((c) => [c, 0])) as Record<
    TaskCategory,
    number
  >;
  for (const turn of turns) counts[classifyTurn(turn)] += 1;
  // Zero turns (or an all-zero mix) stays General: best starts at 0, so only
  // a category with at least one turn can win.
  let primary: TaskCategory = "General";
  let best = 0;
  for (const category of TASK_CATEGORIES) {
    const count = counts[category];
    if (count > best) {
      best = count;
      primary = category;
    }
  }
  return { primary, counts };
}

/** The session mix straight from stored envelopes, in store order. */
export function classifyEnvelopes(envelopes: readonly EnvelopeV1[]): TaskMix {
  return classifySession(
    envelopes.map((envelope) => ({ tools: envelope.tools, editTargets: envelope.edit_targets })),
  );
}

/** The annotation every classification payload carries while OBS-GW-1 is open. */
export const CLASSIFICATION_NOTE =
  "local-capture only — classification covers captured envelopes, not all requests";
