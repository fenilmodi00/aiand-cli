import assert from "node:assert/strict";
import test, { describe } from "node:test";

// OBS-P3-6 (#78): the one-shot/retry rule (feature catalog C5, the flagship
// metric) with the EXACT CodeBurn definition — a retry is the same file
// re-edited after a shell command in between — plus the per-harness/model
// aggregation and the coverage-note rendering.

const {
  efficiencyByHarness,
  efficiencyByModel,
  efficiencyCoverage,
  efficiencyCoverageNote,
  isShellTurn,
  MISSED_CATCH_RULE,
  oneShotRetry,
} = await import("../dist/model-efficiency.js");

const turn = (tools, editTargets = []) => ({ tools, editTargets });
const edit = (target, ...tools) => turn(tools.length > 0 ? tools : ["Edit"], [target]);

describe("one-shot/retry (C5 flagship metric)", () => {
  test("shell tools are recognized by name, deterministically", () => {
    for (const name of ["Bash", "shell", "RunCommand", "terminal", "powershell"]) {
      assert.equal(isShellTurn({ tools: [name], editTargets: [] }), true, name);
    }
    for (const name of ["Edit", "Read", "Grep", "WebFetch"]) {
      assert.equal(isShellTurn({ tools: [name], editTargets: [] }), false, name);
    }
  });

  test("first edit of a file is a one-shot", () => {
    const { stats, outcomes } = oneShotRetry([edit("a.ts")]);
    assert.deepEqual(outcomes, ["one-shot"]);
    assert.equal(stats.value.oneShots, 1);
    assert.equal(stats.value.retries, 0);
    assert.equal(stats.value.oneShotRate, 1);
    assert.equal(stats.value.editTurns, 1);
  });

  test("same file re-edited with NO shell in between: continuation, not a retry", () => {
    const { stats, outcomes } = oneShotRetry([edit("a.ts"), edit("a.ts")]);
    assert.deepEqual(outcomes, ["one-shot", "one-shot"]);
    assert.equal(stats.value.oneShotRate, 1);
  });

  test("the exact rule: same file re-edited AFTER a shell command is a retry", () => {
    const { stats, outcomes } = oneShotRetry([edit("a.ts"), turn(["Bash"]), edit("a.ts")]);
    assert.deepEqual(outcomes, ["one-shot", "retry"]);
    assert.equal(stats.value.oneShots, 1);
    assert.equal(stats.value.retries, 1);
    assert.equal(stats.value.oneShotRate, 0.5);
  });

  test("shell AFTER the second edit does not retroactively make it a retry", () => {
    const { outcomes } = oneShotRetry([edit("a.ts"), edit("a.ts"), turn(["Bash"])]);
    assert.deepEqual(outcomes, ["one-shot", "one-shot"]);
  });

  test("a different file after a shell command is still a one-shot", () => {
    const { outcomes } = oneShotRetry([edit("a.ts"), turn(["Bash"]), edit("b.ts")]);
    assert.deepEqual(outcomes, ["one-shot", "one-shot"]);
  });

  test("shell inside the edit turn itself marks the NEXT edit of that file", () => {
    const { outcomes } = oneShotRetry([edit("a.ts", "Edit", "Bash"), edit("a.ts")]);
    assert.deepEqual(outcomes, ["one-shot", "retry"]);
  });

  test("non-shell turns do not break the chain", () => {
    const { outcomes } = oneShotRetry([edit("a.ts"), turn(["Read"]), turn(["Grep"]), edit("a.ts")]);
    assert.deepEqual(outcomes, ["one-shot", "one-shot"]);
  });

  test("empty sequence: no edit turns, null rate", () => {
    const { stats } = oneShotRetry([]);
    assert.equal(stats.value.editTurns, 0);
    assert.equal(stats.value.oneShotRate, null);
    assert.equal(stats.provenance.kind, "heuristic");
  });

  test("aggregates per harness and per model, sorted by key", () => {
    // rows mirror stored envelope rows (EnvelopeV1 shape: edit_targets)
    const rows = [
      { agent: "opencode", model: "m2", envelope: { tools: ["Edit"], edit_targets: ["a.ts"] } },
      { agent: "opencode", model: "m2", envelope: { tools: ["Bash"], edit_targets: [] } },
      { agent: "opencode", model: "m2", envelope: { tools: ["Edit"], edit_targets: ["a.ts"] } },
      { agent: "claude", model: null, envelope: { tools: ["Edit"], edit_targets: ["b.ts"] } },
    ];
    const byHarness = efficiencyByHarness(rows);
    assert.deepEqual(
      byHarness.map((s) => s.key),
      ["claude", "opencode"],
    );
    const opencode = byHarness[1];
    assert.equal(opencode.envelopes, 3);
    assert.equal(opencode.stats.oneShotRate, 0.5);

    const byModel = efficiencyByModel(rows);
    assert.deepEqual(
      byModel.map((s) => s.key),
      ["m2", "unknown"],
    );
    assert.equal(byModel[0].stats.retries, 1);
  });

  test("coverage note renders the honest n-of-m fraction and the gateway caveat", () => {
    const note = efficiencyCoverageNote(12, 35);
    assert.match(note, /34% coverage/);
    assert.match(note, /12 of 35 requests have envelope data/);
    assert.match(note, /local-capture only/);
    assert.match(note, /tracked gateway ask/);
    assert.match(efficiencyCoverageNote(0, 0), /n\/a/);

    const coverage = efficiencyCoverage(1, 4);
    assert.equal(coverage.value.coverage, 0.25);
    assert.equal(coverage.provenance.kind, "estimated");
  });
});

// #127 (T2): tool-error rate, missed-catch walk, turns-to-success, outcome
// split — layered on the SAME walk as one-shot/retry (one pass, two verdicts).
describe("tool-error / missed-catch / outcome (#127)", () => {
  test("tool-error rate over toolOutcomes; null when zero tool calls", () => {
    const { stats } = oneShotRetry([
      { tools: ["Edit", "Bash"], editTargets: ["a.ts"], toolOutcomes: [{ name: "Edit", ok: true }, { name: "Bash", ok: false }] },
      { tools: ["Read"], editTargets: [], toolOutcomes: [{ name: "Read", ok: true }] },
    ]);
    assert.equal(stats.value.toolErrorRate, 1 / 3);
    // no tool calls at all → null, never 0
    const none = oneShotRetry([{ tools: ["Edit"], editTargets: ["a.ts"], toolOutcomes: [] }]);
    assert.equal(none.stats.value.toolErrorRate, null);
  });

  test("positive missed-catch chain: shell error → re-edit of pre-shell file → second shell error", () => {
    const { stats, missedCatchTurns } = oneShotRetry([
      edit("a.ts"),                                   // edit a.ts
      { tools: ["Bash"], editTargets: [], toolOutcomes: [{ name: "Bash", ok: false }] }, // shell errors
      edit("a.ts"),                                   // re-edit of file edited before the shell error
      { tools: ["Bash"], editTargets: [], toolOutcomes: [{ name: "Bash", ok: false }] }, // errors again → miss
    ]);
    assert.deepEqual(missedCatchTurns, [3]);
    assert.equal(stats.value.missedCatches, 1);
    assert.equal(stats.value.missedCatchRate, 1 / 4);
    assert.equal(stats.provenance.kind, "heuristic");
  });

  test("shell error WITHOUT a re-edit afterwards: no miss", () => {
    const { stats, missedCatchTurns } = oneShotRetry([
      edit("a.ts"),
      { tools: ["Bash"], editTargets: [], toolOutcomes: [{ name: "Bash", ok: false }] },
      { tools: ["Bash"], editTargets: [], toolOutcomes: [{ name: "Bash", ok: false }] },
    ]);
    assert.deepEqual(missedCatchTurns, []);
    assert.equal(stats.value.missedCatches, 0);
  });

  test("re-edit after shell error but NO second failure: no miss", () => {
    const { missedCatchTurns } = oneShotRetry([
      edit("a.ts"),
      { tools: ["Bash"], editTargets: [], toolOutcomes: [{ name: "Bash", ok: false }] },
      edit("a.ts"),
      { tools: ["Bash"], editTargets: [], toolOutcomes: [{ name: "Bash", ok: true }] },
    ]);
    assert.deepEqual(missedCatchTurns, []);
  });

  test("MISSED_CATCH_RULE exposes the deterministic rule string", () => {
    assert.equal(typeof MISSED_CATCH_RULE, "string");
    assert.match(MISSED_CATCH_RULE, /shell error/);
    assert.match(MISSED_CATCH_RULE, /second shell error/);
  });

  test("turns-to-success counts to the first clean terminal; outcome split tallies", () => {
    const { stats } = oneShotRetry([
      { tools: ["Edit"], editTargets: ["a.ts"], terminal: null },
      { tools: ["Bash"], editTargets: [], terminal: "errored" },
      { tools: ["Edit"], editTargets: ["a.ts"], terminal: "clean" },
    ]);
    assert.equal(stats.value.turnsToSuccess, 3); // first clean at turn 3
    assert.deepEqual(stats.value.sessions, { clean: 1, aborted: 0, errored: 1 });
  });

  test("no clean terminal: turnsToSuccess null, split still counted", () => {
    const { stats } = oneShotRetry([
      { tools: ["Edit"], editTargets: ["a.ts"], terminal: "aborted" },
    ]);
    assert.equal(stats.value.turnsToSuccess, null);
    assert.deepEqual(stats.value.sessions, { clean: 0, aborted: 1, errored: 0 });
  });

  test("empty turn list: all new rates null, zero split", () => {
    const { stats } = oneShotRetry([]);
    assert.equal(stats.value.toolErrorRate, null);
    assert.equal(stats.value.missedCatchRate, null);
    assert.equal(stats.value.turnsToSuccess, null);
    assert.deepEqual(stats.value.sessions, { clean: 0, aborted: 0, errored: 0 });
  });

  test("v1 turns (no outcome info): every new rate null plus heuristic provenance, never zeros", () => {
    const { stats } = oneShotRetry([edit("a.ts"), turn(["Bash"]), edit("a.ts")]);
    assert.equal(stats.value.toolErrorRate, null);
    assert.equal(stats.value.missedCatchRate, null);
    assert.equal(stats.value.turnsToSuccess, null);
    assert.deepEqual(stats.value.sessions, { clean: 0, aborted: 0, errored: 0 });
    assert.equal(stats.provenance.kind, "heuristic");
    // legacy verdicts still work
    assert.equal(stats.value.oneShotRate, 0.5);
  });

  test("aggregation carries the new stats per harness", () => {
    const rows = [
      { agent: "v2", envelope: { tools: ["Bash"], edit_targets: [], toolOutcomes: [{ name: "Bash", ok: false }], terminal: "errored" } },
      { agent: "v1", envelope: { tools: ["Bash"], edit_targets: [] } },
    ];
    const byHarness = efficiencyByHarness(rows);
    const v2 = byHarness.find((s) => s.key === "v2");
    const v1 = byHarness.find((s) => s.key === "v1");
    assert.equal(v2.stats.toolErrorRate, 1);
    assert.deepEqual(v2.stats.sessions, { clean: 0, aborted: 0, errored: 1 });
    assert.equal(v1.stats.toolErrorRate, null);
    assert.deepEqual(v1.stats.sessions, { clean: 0, aborted: 0, errored: 0 });
  });
});
