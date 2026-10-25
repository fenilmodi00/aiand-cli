import assert from "node:assert/strict";
import test, { describe } from "node:test";

// OBS-P3-6 (#78): project/branch spend attribution (feature catalog B4) —
// gateway-billed request costs joined to the most recent same-key envelope in
// the turn window, with the three-way named-branch / pre-recording /
// no-branch coverage split that is never silently collapsed.

const { ATTRIBUTION_WINDOW_MS, attributeBranchSpend } = await import("../dist/branch-spend.js");

const req = (id, apiKey, createdAt, cost) => ({
  id,
  api_key: apiKey,
  created_at: createdAt,
  cost_value: cost,
});

const env = (apiKey, createdAt, { project = "proj-1", branch = "main" } = {}) => ({
  api_key: apiKey,
  created_at: createdAt,
  project_root_id: project,
  git_branch: branch,
});

describe("branch/project spend attribution (B4)", () => {
  test("attributes request cost to the most recent same-key envelope", () => {
    const result = attributeBranchSpend(
      [req("r1", "sk-1", "2026-10-25T10:05:00Z", 0.5)],
      [env("sk-1", "2026-10-25T10:00:00Z", { branch: "feat/a" })],
    );
    assert.equal(result.value.coverage.namedBranch, 1);
    assert.deepEqual(result.value.byBranch, [{ key: "feat/a", requests: 1, costUsd: 0.5 }]);
    assert.deepEqual(result.value.byProject, [{ key: "proj-1", requests: 1, costUsd: 0.5 }]);
    assert.equal(result.provenance.kind, "estimated");
  });

  test("turn-by-turn: a later envelope re-attributes subsequent requests", () => {
    const result = attributeBranchSpend(
      [req("r1", "sk-1", "2026-10-25T10:05:00Z", 1), req("r2", "sk-1", "2026-10-25T10:20:00Z", 3)],
      [
        env("sk-1", "2026-10-25T10:00:00Z", { branch: "main" }),
        env("sk-1", "2026-10-25T10:15:00Z", { branch: "feat/b" }),
      ],
    );
    assert.deepEqual(result.value.byBranch, [
      { key: "feat/b", requests: 1, costUsd: 3 },
      { key: "main", requests: 1, costUsd: 1 },
    ]);
  });

  test("envelope older than the turn window does not attribute (pre-recording)", () => {
    const result = attributeBranchSpend(
      [req("r1", "sk-1", "2026-10-25T12:00:00Z", 2)],
      [env("sk-1", "2026-10-25T10:00:00Z")],
      ATTRIBUTION_WINDOW_MS,
    );
    assert.equal(result.value.coverage.preRecording, 1);
    assert.equal(result.value.coverage.namedBranch, 0);
    assert.deepEqual(result.value.byBranch, []);
  });

  test("no envelope at all for the key: pre-recording, never dropped silently", () => {
    const result = attributeBranchSpend(
      [req("r1", "sk-2", "2026-10-25T10:00:00Z", 1)],
      [env("sk-1", "2026-10-25T09:59:00Z")],
    );
    assert.equal(result.value.coverage.preRecording, 1);
    assert.equal(result.value.coverage.total, 1);
  });

  test("envelope without a branch (detached/missing): no-branch, project still applies", () => {
    const result = attributeBranchSpend(
      [req("r1", "sk-1", "2026-10-25T10:00:00Z", 2)],
      [env("sk-1", "2026-10-25T09:59:00Z", { branch: null, project: "proj-9" })],
    );
    assert.equal(result.value.coverage.noBranch, 1);
    assert.deepEqual(result.value.byProject, [{ key: "proj-9", requests: 1, costUsd: 2 }]);
    assert.deepEqual(result.value.byBranch, []);
  });

  test("unpriced requests still count in coverage, never in cost sums", () => {
    const result = attributeBranchSpend(
      [
        req("r1", "sk-1", "2026-10-25T10:00:00Z", null),
        req("r2", "sk-1", "2026-10-25T10:01:00Z", 1.5),
      ],
      [env("sk-1", "2026-10-25T09:59:00Z", { branch: "dev" })],
    );
    assert.equal(result.value.coverage.namedBranch, 2);
    assert.deepEqual(result.value.byBranch, [{ key: "dev", requests: 2, costUsd: 1.5 }]);
  });

  test("different keys never cross-attribute", () => {
    const result = attributeBranchSpend(
      [req("r1", "sk-2", "2026-10-25T10:00:00Z", 1)],
      [env("sk-1", "2026-10-25T09:59:59Z")],
    );
    assert.equal(result.value.coverage.preRecording, 1);
  });

  test("boundary: an envelope exactly at the window edge still applies", () => {
    const windowMs = 60_000;
    const result = attributeBranchSpend(
      [req("r1", "sk-1", "2026-10-25T10:01:00Z", 1)],
      [env("sk-1", "2026-10-25T10:00:00Z")],
      windowMs,
    );
    assert.equal(result.value.coverage.namedBranch, 1);
  });
});
