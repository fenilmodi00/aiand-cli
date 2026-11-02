import type { DatabaseSync } from "node:sqlite";
import type { EnvelopeV1 } from "../agents/envelope.js";
import { openSession } from "../api/client.js";
import { ATTRIBUTION_NOTE, attributeBranchSpend } from "../branch-spend.js";
import { bool, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { currencySymbol, err, heading, json, num, out, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import {
  type EfficiencySlice,
  efficiencyByHarness,
  efficiencyByModel,
  efficiencyCoverage,
  efficiencyCoverageNote,
  MISSED_CATCH_RULE,
  type OneShotRetryStats,
  oneShotRetry,
} from "../model-efficiency.js";
import { CLASSIFICATION_NOTE, classifyEnvelopes, TASK_CATEGORIES } from "../obs/classifier.js";
import { listEnvelopesFromDb } from "../store/envelopes.js";
import {
  type ImportedArtifactRow,
  listImportedArtifactsFromDb,
} from "../store/imported-artifacts.js";
import {
  createdSince,
  createdUntilExcl,
  noSyncRequested,
  openStore,
  storePath,
  syncStore,
} from "../store/index.js";
import { assertWindowOrder, parseLast, parseSince, parseUntil } from "./usage-report.js";

/**
 * `aiand efficiency` (feature catalog C3/C5/B4, ticket #78): the
 * envelope-derived report — one-shot/retry rate per harness and model, the
 * 13-category task mix, and per-project / per-branch spend attribution.
 *
 * All three run on LOCALLY CAPTURED envelopes only until the gateway forwards
 * them (OBS-GW-1): the report prints the coverage fraction ("N of M requests
 * have envelope data") and a "local-capture only" note in every section —
 * never implying completeness.
 */

export const help = `${style.bold("aiand efficiency")} -- one-shot/retry, task mix, and project/branch spend

Usage
  aiand efficiency
  aiand efficiency --last 7d --json

Options
  --since <date>      window start (2026-10-01 or an ISO timestamp)
  --until <date>      window end (a bare date means end-of-day)
  --last <n><unit>    relative window: m|h|d|w, e.g. --last 7d
  --json              machine-readable output
  --no-sync           skip the pre-read store sync and read the local store as-is

One-shot/retry follows the CodeBurn definition: a retry is the same file
re-edited after a shell command ran in between. Task classification is
deterministic (13 categories, zero LLM calls). Everything here is derived
from locally captured adapter envelopes (opt-in; see
docs/observability/adapter-envelope.md) — coverage is reported per section.`;

type Window = { sinceMs: number | null; untilMs: number | null };

// ---------------------------------------------------------------------------
// Imported behavioral markers as a second source (#146)
// ---------------------------------------------------------------------------

/** One behavioral slice built from one harness's imported markers. */
function importedSlice(key: string, markers: readonly ImportedArtifactRow[]): EfficiencySlice {
  const sessions = new Map<string, ImportedArtifactRow[]>();
  for (const marker of markers) {
    const bucket = sessions.get(marker.session_id);
    if (bucket) bucket.push(marker);
    else sessions.set(marker.session_id, [marker]);
  }
  let toolCalls = 0;
  let toolErrors = 0;
  const split = { clean: 0, aborted: 0, errored: 0 };
  let terminals = 0;
  for (const bucket of sessions.values()) {
    // Rows arrive ordered (harness, session_id, seq, at); last terminal wins.
    const lastTerminal = [...bucket].reverse().find((m) => m.kind === "terminal");
    const outcome = lastTerminal?.outcome;
    if (outcome === "clean" || outcome === "aborted" || outcome === "errored") {
      terminals += 1;
      split[outcome] += 1;
    }
    for (const marker of bucket) {
      if (marker.kind === "tool") {
        toolCalls += 1;
        if (marker.outcome === "error") toolErrors += 1;
      }
    }
  }
  return {
    key,
    envelopes: markers.length,
    stats: {
      editTurns: 0,
      oneShots: 0,
      retries: 0,
      oneShotRate: null,
      toolErrorRate: toolCalls > 0 ? toolErrors / toolCalls : null,
      missedCatches: 0,
      missedCatchRate: null,
      turnsToSuccess: null,
      sessions: terminals > 0 ? split : { clean: 0, aborted: 0, errored: 0 },
    },
  };
}

type ImportedRollup = {
  toolCalls: number;
  toolErrors: number;
  compactions: number;
  terminalCount: number;
  sessions: { clean: number; aborted: number; errored: number };
};

/** Combine every imported marker in the window into one overall rollup. */
function combineImported(markers: readonly ImportedArtifactRow[]): ImportedRollup {
  let toolCalls = 0;
  let toolErrors = 0;
  let compactions = 0;
  const sessions = { clean: 0, aborted: 0, errored: 0 };
  // Last terminal per session, then summed across sessions.
  const bySession = new Map<string, string | null>();
  for (const marker of markers) {
    if (marker.kind === "tool") {
      toolCalls += 1;
      if (marker.outcome === "error") toolErrors += 1;
    } else if (marker.kind === "compaction") {
      compactions += 1;
    } else if (marker.kind === "terminal") {
      bySession.set(marker.session_id, marker.outcome);
    }
  }
  let terminalCount = 0;
  for (const outcome of bySession.values()) {
    if (outcome === "clean" || outcome === "aborted" || outcome === "errored") {
      terminalCount += 1;
      sessions[outcome] += 1;
    }
  }
  return { toolCalls, toolErrors, compactions, terminalCount, sessions };
}

function resolveWindow(parsed: ReturnType<typeof parse>, now: Date): Window {
  const since = str(parsed, "since");
  const until = str(parsed, "until");
  if (since !== undefined && until !== undefined) {
    const sinceMs = parseSince(since, "UTC");
    const untilMs = parseUntil(until, "UTC");
    assertWindowOrder(sinceMs, untilMs);
    return { sinceMs, untilMs };
  }
  if (since !== undefined || until !== undefined) {
    throw new CliError("--since and --until must be passed together.", {
      hint: "Example: aiand efficiency --since 2026-10-01 --until 2026-10-25",
    });
  }
  const last = str(parsed, "last");
  if (last !== undefined) return { sinceMs: parseLast(last, now).sinceMs, untilMs: null };
  // Default: the last 7 days.
  return { sinceMs: now.getTime() - 7 * 24 * 3_600_000, untilMs: null };
}

type EfficiencyPayload = {
  window: Window;
  coverage: ReturnType<typeof efficiencyCoverage>["value"];
  coverageNote: string;
  oneShotRetry: {
    overall: OneShotRetryStats;
    byHarness: EfficiencySlice[];
    byModel: EfficiencySlice[];
  };
  /** #127: tool-error / missed-catch / turns-to-success / outcome split. */
  behavioral: OneShotRetryStats;
  /** #127: the missed-catch rule string, for labeling the heuristic number. */
  missedCatchRule: string;
  taskMix: ReturnType<typeof classifyEnvelopes>;
  attribution: ReturnType<typeof attributeBranchSpend>["value"];
  /** #146: imported-marker coverage, reported separately from envelopes. */
  importedCoverage: { sessions: number; harnesses: number };
};

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    since: { type: "string" },
    until: { type: "string" },
    last: { type: "string" },
    json: { type: "boolean", default: false },
    "no-sync": { type: "boolean", default: false },
    profile: { type: "string" },
  });
  if (bool(parsed, "help")) return out(help);

  if (parsed.positionals.length > 0) {
    throw new CliError(`Unknown argument "${parsed.positionals[0]}".`, {
      hint: "Run `aiand efficiency --help` to see the subcommands and flags.",
    });
  }

  // #103: resolve up front so the warning fires even on --no-sync.
  resolveProfile(str(parsed, "profile"));
  const window = resolveWindow(parsed, new Date());
  const sinceIso = window.sinceMs !== null ? new Date(window.sinceMs).toISOString() : undefined;
  const untilIso = window.untilMs !== null ? new Date(window.untilMs).toISOString() : undefined;

  if (!bool(parsed, "no-sync") && !noSyncRequested()) {
    const session = await openSession(resolveProfile(str(parsed, "profile"))); // #103
    const result = await syncStore(session); // #85
    if (!result.ok)
      err(style.yellow(`store sync failed (${result.code ?? "error"}): ${result.error}`));
  }

  const opened = openStore(storePath());
  if (!opened.ok) {
    throw new CliError("The local request store is not available.", {
      hint: opened.reason,
      exitCode: 1,
    });
  }

  let payload: EfficiencyPayload;
  try {
    const requests = windowRequests(opened.db, sinceIso, untilIso);
    const envelopes = listEnvelopesFromDb(opened.db, { since: sinceIso, until: untilIso });

    const effTurns = envelopes.map((row) => ({
      agent: row.agent,
      model: row.model,
      envelope:
        row.envelope ??
        ({
          schema_version: "aiand-envelope/v1",
          tools: [],
          edit_targets: [],
          project_root_id: null,
          git_branch: null,
        } as const),
    }));
    const envelopeV1s: EnvelopeV1[] = effTurns.map((t) => t.envelope);
    const overallStats = oneShotRetry(
      envelopeV1s.map((e) => ({
        tools: e.tools,
        editTargets: e.edit_targets,
        // #127: pinned v2 outcome fields — null on v1 envelopes → null rates.
        toolOutcomes: e.toolOutcomes ?? null,
        terminal: e.terminal ?? null,
      })),
    );
    const overall: ReturnType<typeof oneShotRetry>["stats"] = overallStats.stats;
    const byHarness = efficiencyByHarness(effTurns);
    const byModel = efficiencyByModel(effTurns);

    // #146: imported markers as a second behavioral source. Read from the
    // SAME db handle (fail-open reader), windowed on COALESCE(at,
    // imported_at). Per harness: the envelope slice wins when it carries >=
    // MIN_ENVELOPE_TURNS turns; otherwise the imported markers supply the
    // harness's tool-error rate, terminal split, and compactions. The two
    // sources are never summed for one harness.
    const importedMarkers = listImportedArtifactsFromDb(opened.db, {
      since: sinceIso,
      until: untilIso,
    });
    const importedByHarness = new Map<string, ImportedArtifactRow[]>();
    for (const marker of importedMarkers) {
      const bucket = importedByHarness.get(marker.harness);
      if (bucket) bucket.push(marker);
      else importedByHarness.set(marker.harness, [marker]);
    }
    const MIN_ENVELOPE_TURNS = 5;
    const envelopeSlices = new Map(byHarness.map((slice) => [slice.key, slice]));
    const harnessKeys = [
      ...new Set([...envelopeSlices.keys(), ...importedByHarness.keys()]),
    ].sort();
    const byHarnessMerged: EfficiencySlice[] = harnessKeys.map((key) => {
      const envelopeSlice = envelopeSlices.get(key);
      if (envelopeSlice && envelopeSlice.envelopes >= MIN_ENVELOPE_TURNS) return envelopeSlice;
      const imported = importedByHarness.get(key) ?? [];
      return imported.length > 0 ? importedSlice(key, imported) : envelopeSlice!;
    });
    // Overall behavioral: combine the CHOSEN harnesses' counts (tool
    // calls/errors, terminal split, compactions) — one number per source of
    // truth, no double counting. oneShotRate stays envelope-only: imported
    // markers have no edit targets, so the envelope walk keeps its own rate.
    const overallImported = combineImported(importedMarkers);
    const behavioral: OneShotRetryStats = {
      ...overall.value,
      toolErrorRate:
        overall.value.toolErrorRate !== null
          ? overall.value.toolErrorRate
          : overallImported.toolCalls > 0
            ? overallImported.toolErrors / overallImported.toolCalls
            : null,
      sessions:
        overall.value.sessions.clean +
          overall.value.sessions.aborted +
          overall.value.sessions.errored >
          0 || overallImported.terminalCount === 0
          ? overall.value.sessions
          : overallImported.sessions,
    };
    const importedCoverage = {
      sessions: new Set(importedMarkers.map((m) => `${m.harness}\u0000${m.session_id}`)).size,
      harnesses: importedByHarness.size,
    };
    const mix = classifyEnvelopes(envelopeV1s);
    const attribution = attributeBranchSpend(requests, envelopes);
    const coverage = efficiencyCoverage(envelopes.length, requests.length);

    payload = {
      window,
      coverage: coverage.value,
      coverageNote: efficiencyCoverageNote(envelopes.length, requests.length),
      oneShotRetry: { overall: overall.value, byHarness: byHarnessMerged, byModel },
      behavioral,
      missedCatchRule: MISSED_CATCH_RULE,
      taskMix: mix,
      attribution: attribution.value,
      importedCoverage,
    };
  } finally {
    try {
      opened.db.close();
    } catch {
      // already closed
    }
  }

  if (bool(parsed, "json")) {
    return json({
      window: payload.window,
      coverage: payload.coverage,
      coverageNote: payload.coverageNote,
      oneShotRetry: payload.oneShotRetry,
      behavioral: {
        ...payload.behavioral,
        missedCatchRule: payload.missedCatchRule,
        provenance: "heuristic(one-shot/retry envelope rule)",
        coverage: payload.coverageNote,
      },
      taskMix: payload.taskMix,
      attribution: payload.attribution,
      importedCoverage: payload.importedCoverage,
      notes: { classification: CLASSIFICATION_NOTE, attribution: ATTRIBUTION_NOTE },
    });
  }

  render(payload);
}

function windowRequests(
  db: DatabaseSync,
  sinceIso: string | undefined,
  untilIso: string | undefined,
): { id: string; api_key: string | null; created_at: string; cost_value: number | null }[] {
  const conditions: string[] = [];
  const params: string[] = [];
  if (sinceIso !== undefined) {
    conditions.push(createdSince());
    params.push(sinceIso);
  }
  if (untilIso !== undefined) {
    conditions.push(createdUntilExcl());
    params.push(untilIso);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT id, api_key, created_at, cost_value FROM requests ${where} ORDER BY created_at, id`,
    )
    .all(...params) as {
    id: string;
    api_key: string | null;
    created_at: string;
    cost_value: number | null;
  }[];
}

function percent(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

function cost(value: number | null): string {
  if (value === null) return "—";
  return `${currencySymbol("USD")}${num(value)}`;
}

function render(payload: EfficiencyPayload): void {
  const { oneShotRetry: efficiency, taskMix, attribution } = payload;

  heading("Efficiency");
  out(style.dim("(adapter envelopes, aiand-envelope/v1)"));
  out("");
  out(style.dim(payload.coverageNote));
  out("");

  heading("One-shot / retry");
  const stats = efficiency.overall;
  out(
    `  overall: ${percent(stats.oneShotRate)} one-shot ` +
      `(${stats.oneShots} one-shot, ${stats.retries} retry across ${stats.editTurns} edit turns)`,
  );
  out(style.dim("  retry = same file re-edited after a shell command in between"));
  renderSlices("by harness", efficiency.byHarness);
  renderSlices("by model", efficiency.byModel);
  out("");

  // #127: behavioral columns — heuristic over locally captured envelopes only.
  const b = payload.behavioral;
  heading("Behavioral (tool errors, missed catches, outcomes)");
  out(`  tool errors: ${percent(b.toolErrorRate)} (heuristic: envelope toolOutcomes)`);
  out(`  missed catches: ${percent(b.missedCatchRate)} (${b.missedCatches} turn(s))`);
  out(style.dim(`  rule: ${payload.missedCatchRule}`));
  out(
    `  turns to success: ${b.turnsToSuccess ?? "n/a"}  ` +
      `outcomes: clean ${b.sessions.clean}, aborted ${b.sessions.aborted}, errored ${b.sessions.errored}`,
  );
  // #146: the imported-marker side, reported separately from envelopes.
  const imported = payload.importedCoverage;
  out(
    imported.sessions === 0
      ? style.dim("  imported markers: none in this window — backfill with `aiand harness import`")
      : `  imported markers: ${imported.sessions} session(s) across ${imported.harnesses} harness(es) ` +
          "(opt-in backfill of the harnesses' own session files; tool errors, terminals, compactions)",
  );
  out("");

  heading("Task mix");
  out(`  primary: ${taskMix.primary}`);
  for (const category of TASK_CATEGORIES) {
    const count = taskMix.counts[category];
    if (count > 0) out(`  ${category.padEnd(14)} ${count}`);
  }
  out(style.dim(`  ${CLASSIFICATION_NOTE}`));
  out("");

  heading("Spend by branch");
  if (attribution.byBranch.length === 0) {
    out("  no branch-attributed cost in this window");
  } else {
    table(attribution.byBranch, [
      { header: "branch", value: (g) => g.key },
      { header: "requests", value: (g) => String(g.requests), align: "right" },
      { header: "cost", value: (g) => cost(g.costUsd), align: "right" },
    ]);
  }
  out("");
  heading("Spend by project");
  if (attribution.byProject.length === 0) {
    out("  no project-attributed cost in this window");
  } else {
    table(attribution.byProject, [
      { header: "project_root_id", value: (g) => g.key },
      { header: "requests", value: (g) => String(g.requests), align: "right" },
      { header: "cost", value: (g) => cost(g.costUsd), align: "right" },
    ]);
  }
  const split = attribution.coverage;
  out("");
  heading("Attribution coverage");
  out(
    `  named-branch ${split.namedBranch}  pre-recording ${split.preRecording}  ` +
      `no-branch ${split.noBranch}  (of ${split.total} requests)`,
  );
  out(style.dim(`  ${ATTRIBUTION_NOTE}`));
}

type SliceRow = {
  key: string;
  envelopes: number;
  stats: {
    oneShotRate: number | null;
    oneShots: number;
    retries: number;
    editTurns: number;
    /** #146: shown for imported-marker slices (one-shot stays n/a there). */
    toolErrorRate?: number | null;
  };
};

function renderSlices(label: string, slices: SliceRow[]): void {
  if (slices.length === 0) return;
  out(`  ${label}:`);
  for (const slice of slices) {
    const stats = slice.stats;
    const oneShot =
      ` ${percent(stats.oneShotRate)} one-shot ` +
      `(${stats.oneShots}/${stats.oneShots + stats.retries} edits)`;
    // #146: an imported-marker slice has no edit targets — its one-shot
    // rate is honestly n/a; the tool-error rate is what it does carry.
    const toolErr =
      stats.oneShotRate === null && stats.toolErrorRate != null
        ? ` · tool errors ${percent(stats.toolErrorRate)} (imported markers)`
        : "";
    out(`    ${slice.key.padEnd(24)}${oneShot}${toolErr}`);
  }
}
