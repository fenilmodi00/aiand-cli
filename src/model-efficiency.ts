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

/** Turn outcome granularity, once capture provides it. */
export type ToolOutcome = { name: string; ok: boolean };
export type TurnTerminal = "clean" | "aborted" | "errored";

/**
 * One turn as the efficiency rules read it. Outcome info is v2-only: absent
 * (v1 envelopes) → every new rate is null plus a coverage note, never zero.
 */
export type EfficiencyTurn = {
  tools: readonly string[];
  editTargets: readonly string[];
  /** Per-tool call outcomes (pinned envelope name `toolOutcomes`); absent on v1 envelopes. */
  toolOutcomes?: readonly ToolOutcome[] | null;
  /** Turn terminal marker (pinned envelope name `terminal`); null/absent on v1 envelopes. */
  terminal?: TurnTerminal | null;
};

const SHELL_TOOL = /bash|shell|terminal|exec|command|powershell|zsh|cmd\b|sh\b|run/;

/** Extract v2 outcome info from a stored envelope record; absent fields → null (v1). */
function turnOutcomeInfo(e: {
  toolOutcomes?: ToolOutcome[] | null;
  terminal?: TurnTerminal | null;
}): Pick<EfficiencyTurn, "toolOutcomes" | "terminal"> {
  return {
    toolOutcomes: Array.isArray(e.toolOutcomes) ? e.toolOutcomes : null,
    terminal: e.terminal ?? null,
  };
}

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
  /** Tool calls that errored / total tool calls; null when zero tool calls or no outcome info (v1). */
  toolErrorRate: number | null;
  /** Turns where the missed-catch rule fired (see MISSED_CATCH_RULE). */
  missedCatches: number;
  /** missedCatches / turns, null when no turns or no outcome info (v1). */
  missedCatchRate: number | null;
  /**
   * Turns until (and including) the first clean-terminal turn; null when no
   * turn terminates clean or terminal info is missing (v1).
   * Success definition: `terminal === "clean"` on a turn — "errored"/"aborted"
   * never count as success; a session with no clean turn has none.
   */
  turnsToSuccess: number | null;
  /** Terminal outcome split; all 0 and rates null when no terminal info (v1). */
  sessions: { clean: number; aborted: number; errored: number };
};

/**
 * Missed-catch v1 rule (ticket #127, deterministic, fixture-pinned): a shell
 * tool ran and ERRORED, a later edit turn re-edits a file already edited
 * before that shell run (the agent returned to the file without an
 * intervening signal the failure was addressed), and a SUBSEQUENT shell run
 * errors again. Layered onto the same walk as the one-shot/retry verdict —
 * one pass, two verdicts. Exposed for labeling/output.
 */
export const MISSED_CATCH_RULE =
  "shell error → re-edit of a file edited before that shell run → second shell error";

/** Shell tool that errored: outcomes carry the error flag, name matches the shell heuristic. */
function erroredShell(turn: EfficiencyTurn): boolean {
  return (
    isShellTurn(turn) &&
    (turn.toolOutcomes ?? []).some((o) => !o.ok && SHELL_TOOL.test(o.name.toLowerCase()))
  );
}

export function oneShotRetry(turns: readonly EfficiencyTurn[]): {
  stats: Labeled<OneShotRetryStats>;
  outcomes: EditOutcome[];
  missedCatchTurns: number[];
} {
  const outcomes: EditOutcome[] = [];
  let oneShots = 0;
  let retries = 0;
  let editTurns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let hasOutcomes = false;
  // Missed-catch walk state: shell errored earlier; files edited before that
  // shell run (candidates for re-edit); a re-edit of such a file is pending.
  let shellErrored = false;
  const editedBeforeShellError = new Set<string>();
  let reEditPending = false;
  const missedCatchTurns: number[] = [];
  // Per file: whether a shell command has run since its last edit.
  const shellSinceEdit = new Map<string, boolean>();

  for (const [index, turn] of turns.entries()) {
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
        // Missed-catch: re-editing a file we edited BEFORE the last errored
        // shell run arms the rule (a subsequent shell error completes it).
        if (shellErrored && editedBeforeShellError.has(target)) reEditPending = true;
        editedBeforeShellError.delete(target);
      }
    }

    // After processing the turn's edits, any shell command in THIS turn marks
    // every previously edited file as "shell ran since last edit".
    if (isShellTurn(turn)) {
      for (const key of shellSinceEdit.keys()) shellSinceEdit.set(key, true);
    }

    // Outcome tally (v2 envelopes only; v1 turns leave everything null).
    const toolOuts = turn.toolOutcomes;
    if (toolOuts !== null && toolOuts !== undefined) {
      hasOutcomes = true;
      toolCalls += toolOuts.length;
      toolErrors += toolOuts.filter((o) => !o.ok).length;
    }

    // Missed-catch completion: an errored shell run after the armed re-edit.
    const shellFailed = erroredShell(turn);
    if (shellFailed) {
      if (reEditPending) {
        missedCatchTurns.push(index);
        reEditPending = false;
      }
      shellErrored = true;
    }
    // Files edited in this turn become "edited before the (next) shell run".
    for (const target of edits) editedBeforeShellError.add(target);
  }

  const total = oneShots + retries;
  // turnsToSuccess: 1-based index of the first turn with terminal "clean" —
  // "success" means the turn ended clean; "errored"/"aborted" never count.
  let turnsToSuccess: number | null = null;
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i]?.terminal === "clean") {
      turnsToSuccess = i + 1;
      break;
    }
  }
  const sessions = { clean: 0, aborted: 0, errored: 0 };
  let hasTerminals = false;
  for (const turn of turns) {
    if (turn.terminal === null || turn.terminal === undefined) continue;
    hasTerminals = true;
    sessions[turn.terminal] += 1;
  }
  return {
    stats: labeled(
      {
        editTurns,
        oneShots,
        retries,
        oneShotRate: total > 0 ? oneShots / total : null,
        toolErrorRate: hasOutcomes && toolCalls > 0 ? toolErrors / toolCalls : null,
        missedCatches: hasOutcomes ? missedCatchTurns.length : 0,
        missedCatchRate:
          hasOutcomes && turns.length > 0 ? missedCatchTurns.length / turns.length : null,
        turnsToSuccess: hasTerminals ? turnsToSuccess : null,
        sessions: hasTerminals ? sessions : { clean: 0, aborted: 0, errored: 0 },
      },
      heuristic("one-shot/retry envelope rule"),
    ),
    outcomes,
    missedCatchTurns,
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
  rows: readonly {
    model: string | null;
    envelope: {
      tools: string[];
      edit_targets: string[];
      toolOutcomes?: ToolOutcome[];
      terminal?: TurnTerminal | null;
    };
  }[],
): EfficiencySlice[] {
  const groups = new Map<string, EfficiencyTurn[]>();
  for (const row of rows) {
    const key = row.model ?? "unknown";
    const list = groups.get(key) ?? [];
    list.push({
      tools: row.envelope.tools,
      editTargets: row.envelope.edit_targets,
      ...turnOutcomeInfo(row.envelope),
    });
    groups.set(key, list);
  }
  return finishAggregate(groups);
}

/** Aggregate the rule per harness id over stored envelope rows. */
export function efficiencyByHarness(
  rows: readonly {
    agent: string;
    envelope: {
      tools: string[];
      edit_targets: string[];
      toolOutcomes?: ToolOutcome[];
      terminal?: TurnTerminal | null;
    };
  }[],
): EfficiencySlice[] {
  const groups = new Map<string, EfficiencyTurn[]>();
  for (const row of rows) {
    const list = groups.get(row.agent) ?? [];
    list.push({
      tools: row.envelope.tools,
      editTargets: row.envelope.edit_targets,
      ...turnOutcomeInfo(row.envelope),
    });
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
