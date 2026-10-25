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
