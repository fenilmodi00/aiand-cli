import { estimated, type Labeled, labeled } from "./obs/provenance.js";

/**
 * Project/branch spend attribution (feature catalog B4, ticket #78).
 *
 * Attributes the gateway-billed cost of stored request rows to the project
 * root and git branch recorded in locally captured envelopes: each request
 * row joins the MOST RECENT envelope with the same masked `api_key` whose
 * `created_at` is at or before the request, within a join window (turn-by-turn
 * attribution, after CodeBurn's `branch-spend.ts`). Cost is the gateway's own
 * `cost_value` — never recomputed here.
 *
 * The three-way coverage split, never silently collapsed:
 *
 *   - `named-branch` — a captured envelope recorded the branch; the request
 *     is attributed to it (and to the envelope's project root).
 *   - `pre-recording` — no envelope exists for the request's key at or
 *     before the request inside the join window: the turn happened before
 *     capture started (or capture is off).
 *   - `no-branch` — an envelope matched but recorded no branch (detached
 *     HEAD, outside a repo); project attribution still applies.
 *
 * Attribution runs on LOCALLY CAPTURED envelopes only until the gateway
 * forwards them (OBS-GW-1); the report renders the split so the unattributed
 * share is always visible.
 */

/** One stored request row as attribution reads it. */
export type SpendRequestRow = {
  id: string;
  api_key: string | null;
  created_at: string;
  /** Parsed gateway cost; the only cost source, never recomputed. */
  cost_value: number | null;
};

/** One stored envelope row as attribution reads it. */
export type SpendEnvelopeRow = {
  api_key: string | null;
  created_at: string;
  project_root_id: string | null;
  git_branch: string | null;
};

/** Max age of a still-applicable envelope, ms (the "current turn" window). */
export const ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000;

type AttributionGroup = {
  key: string;
  requests: number;
  costUsd: number | null;
};

export type BranchAttribution = {
  /** Per-branch totals for requests that carry a named branch. */
  byBranch: AttributionGroup[];
  /** Per-project totals (pseudonymous `project_root_id`s), all attributed rows. */
  byProject: AttributionGroup[];
  /** The three-way split over ALL request rows in scope. */
  coverage: {
    namedBranch: number;
    preRecording: number;
    noBranch: number;
    total: number;
  };
};

/**
 * Attribute every request row. Requests with no parseable cost still count in
 * the coverage split (requests are events; cost sums only priced ones).
 */
export function attributeBranchSpend(
  requests: readonly SpendRequestRow[],
  envelopes: readonly SpendEnvelopeRow[],
  windowMs: number = ATTRIBUTION_WINDOW_MS,
): Labeled<BranchAttribution> {
  // Envelopes per api_key, in store order (already (created_at, id)-sorted).
  const byKey = new Map<string, SpendEnvelopeRow[]>();
  for (const envelope of envelopes) {
    if (envelope.api_key === null) continue;
    const list = byKey.get(envelope.api_key) ?? [];
    list.push(envelope);
    byKey.set(envelope.api_key, list);
  }

  const branchTotals = new Map<string, { requests: number; cost: number | null }>();
  const projectTotals = new Map<string, { requests: number; cost: number | null }>();
  const coverage = { namedBranch: 0, preRecording: 0, noBranch: 0, total: 0 };

  for (const request of requests) {
    coverage.total += 1;
    const createdAt = Date.parse(request.created_at);
    const key = request.api_key;
    // Most recent envelope for this key at or before the request, inside the
    // window. Linear scan per key is fine at local-store sizes.
    let match: SpendEnvelopeRow | null = null;
    if (key !== null) {
      for (const envelope of byKey.get(key) ?? []) {
        const at = Date.parse(envelope.created_at);
        if (Number.isNaN(at) || at > createdAt || createdAt - at > windowMs) continue;
        if (match === null || Date.parse(match.created_at) < at) match = envelope;
      }
    }

    if (match === null) {
      coverage.preRecording += 1;
      continue;
    }

    // Project attribution applies whenever an envelope matched.
    if (match.project_root_id !== null) {
      add(projectTotals, match.project_root_id, request.cost_value);
    }

    if (match.git_branch === null) {
      coverage.noBranch += 1;
    } else {
      coverage.namedBranch += 1;
      add(branchTotals, match.git_branch, request.cost_value);
    }
  }

  return labeled(
    {
      byBranch: groups(branchTotals),
      byProject: groups(projectTotals),
      coverage,
    },
    estimated(
      "gateway-billed request costs joined to locally captured envelopes " +
        "(same masked api_key, most recent within the turn window)",
    ),
  );
}

function add(
  totals: Map<string, { requests: number; cost: number | null }>,
  key: string,
  cost: number | null,
): void {
  const entry = totals.get(key) ?? { requests: 0, cost: null };
  entry.requests += 1;
  if (typeof cost === "number" && Number.isFinite(cost)) {
    entry.cost = (entry.cost ?? 0) + cost;
  }
  totals.set(key, entry);
}

function groups(
  totals: Map<string, { requests: number; cost: number | null }>,
): AttributionGroup[] {
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, requests: value.requests, costUsd: value.cost }));
}

/**
 * The standing caveat for attribution payloads while the gateway cannot
 * forward envelopes (OBS-GW-1).
 */
export const ATTRIBUTION_NOTE =
  "local-capture only — branch/project attribution covers requests whose turn was captured";
