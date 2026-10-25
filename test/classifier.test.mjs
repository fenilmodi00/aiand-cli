import assert from "node:assert/strict";
import test, { describe } from "node:test";

// OBS-P3-6 (#78): the 13-category deterministic classifier (feature catalog
// C3). Fixtures cover every category; determinism is pinned (pure function of
// the envelope sequence — zero LLM/network calls; the suite's net-guard makes
// any fetch a hard failure, so a network call here could not pass CI anyway).

const { TASK_CATEGORIES, classifyTurn, classifyEnvelope, classifySession, classifyEnvelopes } =
  await import("../dist/obs/classifier.js");

const T = (...tools) => ({ tools, editTargets: [] });
const E = (targets, ...tools) => ({ tools, editTargets: targets });

// One fixture per category — the golden set.
const FIXTURES = [
  ["Coding", E(["src/config.ts"], "Edit", "Read")],
  ["Debugging", E(["src/bug.ts"], "Edit", "debugger", "Bash")],
  ["Feature", E(["src/new-thing.ts", "src/other.ts"], "Edit", "Write")],
  ["Feature", E(["src/created.ts"], "Write")],
  ["Refactoring", E(["src/a.ts", "src/b.ts"], "rename_symbol")],
  ["Testing", T("run_tests")],
  ["Testing", T("vitest", "Read")],
  ["Exploration", T("Read", "Grep", "Glob")],
  ["Exploration", T("Bash")],
  ["Planning", T("todo_write")],
  ["Delegation", T("subagent_dispatch")],
  ["Git Ops", T("git_commit")],
  ["Build-Deploy", T("npm_build", "Bash")],
  ["Brainstorming", T("brainstorm")],
  ["Conversation", T()],
  ["Conversation", { tools: [], editTargets: [] }],
];

describe("13-category deterministic classifier", () => {
  test("taxonomy has exactly the 13 CodeBurn categories in stable order", () => {
    assert.deepEqual(TASK_CATEGORIES, [
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
    ]);
  });

  for (const [expected, turn] of FIXTURES) {
    test(`fixture: ${expected} (${JSON.stringify(turn.tools).slice(0, 60)})`, () => {
      assert.equal(classifyTurn(turn), expected);
    });
  }

  test("every one of the 13 categories is reachable by a fixture", () => {
    const seen = new Set(FIXTURES.map(([c]) => c));
    for (const category of TASK_CATEGORIES) {
      if (category === "General") continue; // reachable via the session fallback
      assert.ok(seen.has(category), `no fixture for ${category}`);
    }
  });

  test("pure function: same input, same category (and nothing mutates)", () => {
    const turn = E(["src/a.ts"], "Edit", "Bash");
    const frozen = JSON.parse(JSON.stringify(turn));
    assert.equal(classifyTurn(turn), classifyTurn(turn));
    assert.deepEqual(turn, frozen);
  });

  test("rule order is deterministic regardless of insertion history", () => {
    // A turn that could read as both Testing and Git Ops is always Testing
    // (first match wins), whichever way the caller discovered it.
    const turn = T("git_status", "run_tests");
    assert.equal(classifyTurn(turn), "Testing");
    assert.equal(classifyTurn({ tools: [...turn.tools].reverse(), editTargets: [] }), "Testing");
  });

  test("classifySession: primary is the most frequent, ties break by taxonomy order", () => {
    const mix = classifySession([
      T("Read"),
      E(["a.ts"], "Edit"),
      E(["b.ts"], "Edit"),
      T("run_tests"),
    ]);
    assert.equal(mix.primary, "Coding");
    assert.equal(mix.counts.Coding, 2);
    assert.equal(mix.counts.Testing, 1);
    assert.equal(mix.counts.Exploration, 1);
    // sum of counts equals turn count
    assert.equal(
      Object.values(mix.counts).reduce((a, b) => a + b, 0),
      4,
    );
  });

  test("classifySession: empty sequence falls back to General", () => {
    const mix = classifySession([]);
    assert.equal(mix.primary, "General");
    assert.equal(mix.counts.General, 0);
  });

  test("golden determinism: the same session classifies identically, twice", () => {
    const session = [
      T("Read", "Grep"),
      E(["src/feature.ts", "src/feature2.ts"], "Edit"),
      T("Bash"),
      T("run_tests"),
      T("git_commit"),
    ];
    const a = classifySession(session);
    const b = classifySession(JSON.parse(JSON.stringify(session)));
    assert.deepEqual(a, b);
  });

  test("envelope adapters: classifyEnvelope / classifyEnvelopes match turn rules", () => {
    const env = {
      schema_version: "aiand-envelope/v1",
      tools: ["Edit"],
      edit_targets: ["a.ts"],
      project_root_id: null,
      git_branch: "main",
    };
    assert.equal(classifyEnvelope(env), "Coding");
    assert.deepEqual(classifyEnvelopes([env]).counts.Coding, 1);
  });
});
