import { estimated, heuristic, type Labeled, labeled } from "./obs/provenance.js";

/**
 * One-shot/retry efficiency (feature catalog C5, ticket #78) — the
 * model-efficiency headline.
 *
 * The EXACT CodeBurn definition, pinned by fixtures: a **retry** is the same
 * file re-edited after a shell command ran in between. Concretely, walking
 * the envelope sequence in order: when a file is edited, then a shell tool
 * runs, then the SAME file is edited again — the later edit is a retry.
 * Editing the same file again with NO shell command in between is a
 * continuation of the first edit, not a retry. A file edited for the first
 * time is a one-shot.
 *
 * Files are identified by their edit-target token (`<basename>#<hash16>` or
 * bare name — whatever the envelope recorded), so comparison needs no paths.
 * Shell tools are recognized by name pattern (bash/shell/terminal/exec/…);
 * the pattern list is explicit and deterministic.
 *
/**
 * Every number is `heuristic("one-shot/retry envelope rule")` — the rule
 * reads only LOCALLY CAPTURED envelopes, and callers must render the
 * coverage note (`efficiencyCoverageNote`) next to it.
 */

/** One turn as the efficiency rule reads it. */
export type EfficiencyTurn = {
  tools: readonly string[];
  editTargets: readonly string[];
};

const SHELL_TOOL = /bash|shell|terminal|exec|command|powershell|zsh|cmd\b|sh\b|run/;

export function isShellTurn(turn: EfficiencyTurn): boolean {
  return turn.tools.some((tool) => SHELL_TOOL.test(tool.toLowerCase()));
}

/** The rule's verdict for one edit event. */
export type EditOutcome = "one-shot" | "retry";

export type OneShotRetryStats = {
  /** Turns that edited at least one file. */
  editTurns: number;
  /** Edit events judged one-shot (first edit of that file, or continuation). */
  oneShots: number;
  /** Edit events judged a retry (same file re-edited after a shell command). */
  retries: number;
  /** oneShots / (oneShots + retries), null when no edit events exist. */
  oneShotRate: number | null;
};

/**
 * Walk the envelope sequence in order and score every edit event. Returns the
 * per-event outcomes alongside the aggregate — callers can show which files
 * retried without re-walking the rule.
 */
export function oneShotRetry(turns: readonly EfficiencyTurn[]): {
  stats: Labeled<OneShotRetryStats>;
  outcomes: EditOutcome[];
} {
  const outcomes: EditOutcome[] = [];
  let oneShots = 0;
  let retries = 0;
  let editTurns = 0;
  // Per file: whether a shell command has run since its last edit.
  const shellSinceEdit = new Map<string, boolean>();

  for (const turn of turns) {
    const edits = [...new Set(turn.editTargets)];
    if (edits.length > 0) {
      editTurns += 1;
      for (const target of edits) {
        const isRetry = shellSinceEdit.get(target) ?? false;
        if (isRetry) {
          retries += 1;
          outcomes.push("retry");
        } else {
          oneShots += 1;
          outcomes.push("one-shot");
        }
        shellSinceEdit.set(target, false);
      }
    }

    // After processing the turn's edits, any shell command in THIS turn marks
    // every previously edited file as "shell ran since last edit".
    if (isShellTurn(turn)) {
      for (const key of shellSinceEdit.keys()) shellSinceEdit.set(key, true);
    }
  }

  const total = oneShots + retries;
  return {
    stats: labeled(
      {
        editTurns,
        oneShots,
        retries,
        oneShotRate: total > 0 ? oneShots / total : null,
      },
      heuristic("one-shot/retry envelope rule"),
    ),
    outcomes,
  };
}

/** Aggregated one-shot/retry stats for one harness (or model) slice. */
export type EfficiencySlice = {
  key: string;
  envelopes: number;
  stats: OneShotRetryStats;
};

/** Aggregate the rule per model id over stored envelope rows. */
export function efficiencyByModel(
  rows: readonly { model: string | null; envelope: { tools: string[]; edit_targets: string[] } }[],
): EfficiencySlice[] {
  const groups = new Map<string, EfficiencyTurn[]>();
  for (const row of rows) {
    const key = row.model ?? "unknown";
    const list = groups.get(key) ?? [];
    list.push({ tools: row.envelope.tools, editTargets: row.envelope.edit_targets });
    groups.set(key, list);
  }
  return finishAggregate(groups);
}

/** Aggregate the rule per harness id over stored envelope rows. */
export function efficiencyByHarness(
  rows: readonly { agent: string; envelope: { tools: string[]; edit_targets: string[] } }[],
): EfficiencySlice[] {
  const groups = new Map<string, EfficiencyTurn[]>();
  for (const row of rows) {
    const list = groups.get(row.agent) ?? [];
    list.push({ tools: row.envelope.tools, editTargets: row.envelope.edit_targets });
    groups.set(row.agent, list);
  }
  return finishAggregate(groups);
}

function finishAggregate(groups: Map<string, EfficiencyTurn[]>): EfficiencySlice[] {
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, turns]) => ({
      key,
      envelopes: turns.length,
      stats: oneShotRetry(turns).stats.value,
    }));
}

/**
 * The coverage line every envelope-derived report must render: what fraction
 * of the window's requests carry envelope data, and the standing
 * "local-capture only" caveat while the gateway cannot forward envelopes
 * (OBS-GW-1). Never implies completeness.
 */
export function efficiencyCoverage(
  envelopeRows: number,
  requestRows: number,
): Labeled<{ envelopeRows: number; requestRows: number; coverage: number | null }> {
  return labeled(
    {
      envelopeRows,
      requestRows,
      coverage: requestRows > 0 ? envelopeRows / requestRows : null,
    },
    estimated("captured envelope rows / stored request rows in the window"),
  );
}

export function efficiencyCoverageNote(envelopeRows: number, requestRows: number): string {
  const coverage = requestRows > 0 ? `${Math.round((envelopeRows / requestRows) * 100)}%` : "n/a";
  return (
    `local-capture only, ${coverage} coverage (${envelopeRows} of ${requestRows} requests ` +
    "have envelope data) — server-side envelope forwarding is a tracked gateway ask"
  );
}
