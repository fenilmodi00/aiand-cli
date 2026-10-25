/**
 * Provenance labels (feature catalog H3, ticket #68).
 *
 * Every derived number the CLI reports carries one of three labels, applied
 * AT CONSTRUCTION TIME by the code that computes the number (CodeBurn's
 * per-number source discipline), never retroactively:
 *
 *   - `gateway-billed` — the value is (a sum of) a field the Gateway itself
 *     reported, e.g. `cost`, `input_tokens`. We never recompute these.
 *   - `estimated(<source>)` — the value was computed by us from gateway
 *     data; `<source>` names the inputs (e.g. "cached_tokens / input_tokens").
 *   - `heuristic(<name>)` — the value depends on a heuristic, e.g.
 *     time-gap sessionization. The heuristic's name is the handle its own
 *     module documents.
 *
 * This module is the shared vocabulary: other observability payloads
 * (harness stats, sessions, coverage) import `ProvenanceLabel`,
 * `gatewayBilled` / `estimated` / `heuristic` and `labeled` instead of
 * inventing their own wording, so a number's label always means the same
 * thing. `aiand usage --audit` prints the catalog below.
 */

/** The three-tier taxonomy, discriminated so a label always names its source. */
export type ProvenanceLabel =
  | { kind: "gateway-billed"; source: string }
  | { kind: "estimated"; source: string }
  | { kind: "heuristic"; source: string };

/** A value wrapped with its provenance at construction time. */
export type Labeled<T> = { value: T; provenance: ProvenanceLabel };

/** `gateway-billed`: verbatim gateway field (or a plain sum of such fields). */
export function gatewayBilled(source: string): ProvenanceLabel {
  return { kind: "gateway-billed", source };
}

/** `estimated(<source>)`: computed by us from gateway data; source names the inputs. */
export function estimated(source: string): ProvenanceLabel {
  return { kind: "estimated", source };
}

/** `heuristic(<name>)`: depends on a named heuristic (e.g. "time-gap sessions"). */
export function heuristic(name: string): ProvenanceLabel {
  return { kind: "heuristic", source: name };
}

/** Wrap a value with its label — one call at the point the number is built. */
export function labeled<T>(value: T, provenance: ProvenanceLabel): Labeled<T> {
  return { value, provenance };
}

/** The label as it appears in payloads: `gateway-billed` / `estimated(x)` / `heuristic(x)`. */
export function formatLabel(provenance: ProvenanceLabel): string {
  return provenance.kind === "gateway-billed"
    ? "gateway-billed"
    : `${provenance.kind}(${provenance.source})`;
}

/**
 * The human/machine source description: what the number is made of. This is
 * the `<source>` text for every tier — for gateway-billed values it names the
 * gateway field(s), so an audit table reads uniformly.
 */
export function describeProvenance(provenance: ProvenanceLabel): string {
  return provenance.source;
}

// ---------------------------------------------------------------------------
// The provenance catalog — every number the CLI reports
// ---------------------------------------------------------------------------

/** One row of `aiand usage --audit`: a reported field, its label, its inputs. */
export type ProvenanceEntry = {
  /** Which report surfaces the field: "usage", "cache", "sessions", "coverage". */
  report: string;
  /** Dotted path of the field within that report's payload. */
  field: string;
  provenance: ProvenanceLabel;
};

/** The gateway fields observability is built on — never recomputed by us. */
const GATEWAY_FIELD = "gateway /logs row field (verbatim)";

/**
 * Every numeric (or enumerated) field the observability commands report, with
 * the label it must carry. `aiand usage --audit` prints this; new reports
 * register their fields here so the audit stays the single source of truth.
 * Cost fields are always `gateway-billed`: the CLI never recomputes cost from
 * a price table — price-derived numbers are separate fields with their own
 * `estimated(...)` labels.
 */
export const PROVENANCE_CATALOG: readonly ProvenanceEntry[] = [
  // usage (gateway /analytics)
  { report: "usage", field: "requests", provenance: gatewayBilled("gateway /analytics summary") },
  {
    report: "usage",
    field: "input_tokens",
    provenance: gatewayBilled("gateway /analytics summary"),
  },
  {
    report: "usage",
    field: "output_tokens",
    provenance: gatewayBilled("gateway /analytics summary"),
  },
  {
    report: "usage",
    field: "delta vs previous window",
    provenance: estimated("current window minus previous window, same gateway fields"),
  },
  // usage blocks (local-store report, ticket #60)
  {
    report: "usage",
    field: "blocks.requests",
    provenance: estimated("count of gateway /logs rows in the local store"),
  },
  {
    report: "usage",
    field: "blocks.input_tokens",
    provenance: gatewayBilled(`sum of ${GATEWAY_FIELD}: input_tokens (includes cached_tokens)`),
  },
  {
    report: "usage",
    field: "blocks.output_tokens",
    provenance: gatewayBilled(`sum of ${GATEWAY_FIELD}: output_tokens`),
  },
  {
    report: "usage",
    field: "blocks.cached_tokens",
    provenance: gatewayBilled(`sum of ${GATEWAY_FIELD}: cached_tokens`),
  },
  {
    report: "usage",
    field: "blocks.cost",
    provenance: gatewayBilled("sum of the gateway-computed per-request cost; never recomputed"),
  },
  // cache
  {
    report: "cache",
    field: "totals.requests",
    provenance: estimated("count of gateway /logs rows in the window"),
  },
  {
    report: "cache",
    field: "totals.inputTokens",
    provenance: gatewayBilled(`sum of ${GATEWAY_FIELD}: input_tokens (includes cached_tokens)`),
  },
  {
    report: "cache",
    field: "totals.cachedTokens",
    provenance: gatewayBilled(`sum of ${GATEWAY_FIELD}: cached_tokens`),
  },
  {
    report: "cache",
    field: "totals.outputTokens",
    provenance: gatewayBilled(`sum of ${GATEWAY_FIELD}: output_tokens`),
  },
  {
    report: "cache",
    field: "totals.costUsd",
    provenance: gatewayBilled("sum of the gateway-computed per-request cost; never recomputed"),
  },
  {
    report: "cache",
    field: "hitRatio",
    provenance: estimated("cached_tokens / input_tokens over the window's rows"),
  },
  {
    report: "cache",
    field: "costIfUncached",
    provenance: estimated("model-catalog prices applied to the window's token counts"),
  },
  {
    report: "cache",
    field: "savedUsd",
    provenance: estimated("costIfUncached minus the gateway-billed cost"),
  },
  {
    report: "cache",
    field: "unattributed.count",
    provenance: estimated("count of /logs rows whose api_key is absent from agent-keys.json"),
  },
  // sessions
  {
    report: "sessions",
    field: "turns, token/cost rollups",
    provenance: heuristic("time-gap sessionization"),
  },
  // coverage
  {
    report: "coverage",
    field: "lagSeconds",
    provenance: estimated("now minus the newest stored created_at"),
  },
  {
    report: "coverage",
    field: "missingDays",
    provenance: estimated("per-day row presence in the local store over the requested window"),
  },
  // peak/off-peak (ticket #81)
  {
    report: "usage",
    field: "peak.peak/off-peak costs + shares",
    provenance: estimated(
      "peak-window table applied to stored created_at timestamps and gateway costs",
    ),
  },
  {
    report: "usage",
    field: "peak.routed (non-first-party)",
    provenance: estimated(
      "sum of gateway costs of rows whose route metadata is not first-party; window split not applicable",
    ),
  },
  // vs-list (vendor list-price equivalent, ticket #81)
  {
    report: "usage",
    field: "vs-list.billed",
    provenance: gatewayBilled("sum of the gateway-computed per-request cost; never recomputed"),
  },
  {
    report: "usage",
    field: "vs-list.equivalent",
    provenance: estimated(
      "vendor list-price snapshot (<name>@<date>, or user overrides) applied to stored token counts",
    ),
  },
  {
    report: "usage",
    field: "vs-list.savings",
    provenance: estimated(
      "list-price equivalent minus gateway-billed cost; both sides priced only",
    ),
  },
  // forecast (burn-rate v1 + budgets, ticket #74)
  {
    report: "forecast",
    field: "currentSpend",
    provenance: gatewayBilled("sum of the gateway-computed per-request cost from the local store"),
  },
  {
    report: "forecast",
    field: "rate24h, rate7d",
    provenance: heuristic("burn-rate v1"),
  },
  {
    report: "forecast",
    field: "projectedMonthEnd, exceedDate",
    provenance: estimated("current month spend + burn-rate v1 × hours remaining"),
  },
  {
    report: "forecast",
    field: "verdict, pacing",
    provenance: heuristic("burn-rate v1"),
  },
  {
    report: "forecast",
    field: "suggestBudget",
    provenance: heuristic("P90 of monthly totals"),
  },
  // ccusage import (ticket #73) — EXTERNAL rows, default-excluded from
  // gateway totals; ccusage cost is price-table-derived, never billed.
  {
    report: "usage",
    field: "imported.requests, tokens",
    provenance: estimated(
      "imported ccusage report values; ccusage derives them from local harness logs",
    ),
  },
  {
    report: "usage",
    field: "imported.cost",
    provenance: estimated(
      "imported ccusage <import-date>; ccusage price-table-derived, never gateway-billed",
    ),
  },
  {
    report: "usage",
    field: "grand-total.cost (--include-imported)",
    provenance: estimated(
      "sum of gateway-billed cost and ccusage-estimated imported cost; mixed provenance",
    ),
  },
];

/** The audit list `aiand usage --audit --json` prints: label as string + source. */
export type ProvenanceAuditRow = {
  report: string;
  field: string;
  /** `gateway-billed` / `estimated(<source>)` / `heuristic(<source>)`. */
  label: string;
  source: string;
};

export function provenanceAudit(): ProvenanceAuditRow[] {
  return PROVENANCE_CATALOG.map((entry) => ({
    report: entry.report,
    field: entry.field,
    label: formatLabel(entry.provenance),
    source: describeProvenance(entry.provenance),
  }));
}
