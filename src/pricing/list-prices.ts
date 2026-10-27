import { CliError } from "../cli/errors.js";
import type { PriceOverride } from "../config.js";
import { loadConfig } from "../config.js";
import { estimated, formatLabel } from "../obs/provenance.js";
import {
  type PriceEntry,
  type PriceSnapshot,
  parseSnapshot,
  resolveAlias,
} from "./price-snapshot.js";

/**
 * Vendor-list-price equivalent value (feature catalog B8, ticket #81).
 *
 * `aiand usage --vs-list` recomputes the store's token counts at vendor list
 * prices and sets them beside the gateway-billed cost, so the ai& saving is
 * quantified honestly (spenda's real-metered-cost vs equivalent-API-value
 * presentation): `savings = equivalent - billed`, never the reverse, and the
 * two never blend into one number.
 *
 * Never-guess policy, enforced here:
 *   - exact vendor-id match only (through the snapshot's alias map); a model
 *     with no entry is `unpriced` with its reason — never $0.00, never
 *     interpolated from a lookalike id;
 *   - tiered pricing is exact-only: a request must fall inside exactly one
 *     tier's `[minInput, maxInput)` range or the row is `unpriced` with the
 *     reason (ranges are validated non-overlapping at load);
 *   - savings are shown only where BOTH sides are priced: every request
 *     priced, every request billed, and the billed currency is USD (vendor
 *     prices are USD; FX is out of scope) — otherwise the row is `partial`.
 *
 * Precedence per field: `config set prices.<model>.*` user override, then
 * the active snapshot (`--prices-file`, else the bundled snapshot). Overrides
 * are labeled `estimated(user-override)`; snapshot-derived values
 * `estimated(vendor-list-price <name>@<date>)`.
 */

/** A store row shaped for the comparison. */
export type VsRow = {
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost_value: number | null;
  currency: string | null;
};

type VsStatus = "priced" | "partial" | "unpriced";

type VsListRow = {
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  /** Sum of the gateway-billed cost (any currency), null when the rows carried none. */
  billed: number | null;
  currencies: string[];
  /** The list-price equivalent (USD), null when nothing was priced. */
  equivalent: number | null;
  savings: number | null;
  status: VsStatus;
  /** True when at least one request in the row found an exact price. */
  priced: boolean;
  reason: string | null;
  /** Provenance label of the `equivalent` figure. */
  source: string;
  snapshot_date: string;
};

type VsListTotals = {
  billed: number | null;
  equivalent: number | null;
  savings: number | null;
};

export type VsListResult = {
  rows: VsListRow[];
  totals: VsListTotals;
  snapshotName: string;
  snapshotDate: string;
};

/** Effective rates for one request: the priced triple, per 1M tokens. */
export type EffectivePrice = { input: number; output: number; cacheRead: number };

// ---------------------------------------------------------------------------
// User overrides (`config set prices.<model>.input|.output|.cacheRead`)
// ---------------------------------------------------------------------------

/** `prices` section of config.json, sanitized at load (see src/config.ts). */
export function loadPriceOverrides(): Record<string, PriceOverride> {
  return loadConfig().prices ?? {};
}

/** The override for a model, or null. */
function overrideFor(
  overrides: Record<string, PriceOverride>,
  model: string,
): PriceOverride | null {
  const override = overrides[model];
  if (!override) return null;
  return {
    ...(override.input !== undefined ? { input: override.input } : {}),
    ...(override.output !== undefined ? { output: override.output } : {}),
    ...(override.cacheRead !== undefined ? { cacheRead: override.cacheRead } : {}),
  };
}

// ---------------------------------------------------------------------------
// Price resolution — exact-only, never-guess
// ---------------------------------------------------------------------------

function effectiveFromEntry(
  entry: PriceEntry,
  inputTokens: number,
): EffectivePrice | { unpriced: string } {
  if (entry.tiers === undefined) {
    return {
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead ?? entry.input,
    };
  }
  const tier = entry.tiers.find(
    (t) => inputTokens >= t.minInput && (t.maxInput === null || inputTokens < t.maxInput),
  );
  if (!tier) {
    return {
      unpriced: `input token count ${inputTokens} falls outside every pricing tier`,
    };
  }
  return {
    input: tier.input,
    output: tier.output,
    cacheRead: tier.cacheRead ?? tier.input,
  };
}

/**
 * The effective price for ONE request, or why it is unpriced. Exact vendor-id
 * match only; `cacheRead: null` in the snapshot means "no vendor cache
 * discount published" and the input rate applies (documented in the schema).
 */
export function resolveRequestPrice(
  snapshot: PriceSnapshot,
  overrides: Record<string, PriceOverride>,
  row: VsRow,
): EffectivePrice | { unpriced: string } {
  const inputTokens = row.input_tokens ?? 0;
  const vendorId = resolveAlias(snapshot, row.model);
  const entry = snapshot.models[vendorId];
  const override = overrideFor(overrides, row.model);
  if (!override && !entry) {
    return {
      unpriced: `no list price for ${vendorId} in snapshot ${snapshot.name}@${snapshot.date}`,
    };
  }
  const base = entry === undefined ? null : effectiveFromEntry(entry, inputTokens);
  if (base && "unpriced" in base && !override) return base;
  const input = override?.input ?? (base && "input" in base ? base.input : undefined);
  const output = override?.output ?? (base && "output" in base ? base.output : undefined);
  if (input === undefined || output === undefined) {
    return {
      unpriced:
        `incomplete price for ${vendorId}: ` +
        "set prices.<model>.input and .output (and optionally .cacheRead) or add the model to the snapshot",
    };
  }
  // No cache-read rate anywhere (no override, snapshot `cacheRead: null`):
  // the input rate applies — the documented "no vendor cache discount
  // published" semantics, not a guess.
  const cacheRead = override?.cacheRead ?? (base && "cacheRead" in base ? base.cacheRead : input);
  return { input, output, cacheRead };
}

/** The equivalent USD cost of one request at the given rates. */
function requestEquivalent(row: VsRow, price: EffectivePrice): number {
  const input = row.input_tokens ?? 0;
  const cached = Math.min(row.cached_tokens ?? 0, input);
  const output = row.output_tokens ?? 0;
  const uncachedInput = input - cached;
  return (
    (uncachedInput * price.input + cached * price.cacheRead + output * price.output) / 1_000_000
  );
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/**
 * The pure vs-list computation: group rows by model, price each request
 * exactly, and derive savings only where both sides are priced (see the
 * module comment for every guard).
 */
export function computeVsList(
  rows: readonly VsRow[],
  snapshot: PriceSnapshot,
  overrides: Record<string, PriceOverride> = {},
): VsListResult {
  const overrideUsed = rows.some((row) => overrideFor(overrides, row.model) !== null);
  const snapshotLabel = formatLabel(
    estimated(`vendor-list-price ${snapshot.name}@${snapshot.date} applied to stored tokens`),
  );
  const overrideLabel = formatLabel(estimated("user-override price applied to stored tokens"));

  const byModel = new Map<string, VsRow[]>();
  for (const row of rows) {
    const bucket = byModel.get(row.model) ?? [];
    bucket.push(row);
    byModel.set(row.model, bucket);
  }

  const resultRows: VsListRow[] = [];
  for (const [model, modelRows] of byModel) {
    const currencies = [...new Set(modelRows.map((row) => row.currency ?? ""))].sort();

    let equivalent = 0;
    let billed = 0;
    let billedKnown = true;
    let pricedCount = 0;
    let usdOnly = true;
    let firstUnpricedReason: string | null = null;

    for (const row of modelRows) {
      // Billed is gateway data — it accumulates whether or not the snapshot
      // prices this model. A fully-unpriced model must still show its real
      // billed cost (the plain `usage` report shows it), not $0.000000.
      if (row.cost_value !== null) billed += row.cost_value;
      else billedKnown = false;
      const resolved = resolveRequestPrice(snapshot, overrides, row);
      if ("unpriced" in resolved) {
        if (firstUnpricedReason === null) firstUnpricedReason = resolved.unpriced;
        continue;
      }
      pricedCount += 1;
      equivalent += requestEquivalent(row, resolved);
      if ((row.currency ?? "").toLowerCase() !== "usd") usdOnly = false;
    }

    const requests = modelRows.length;
    const tokens = (pick: (row: VsRow) => number | null): number =>
      modelRows.reduce((sum, row) => sum + (pick(row) ?? 0), 0);

    let status: VsStatus;
    let savings: number | null = null;
    let reason: string | null = null;

    if (pricedCount === 0) {
      status = "unpriced";
      reason = firstUnpricedReason;
    } else if (
      pricedCount === requests &&
      billedKnown &&
      usdOnly &&
      currencies.every((currency) => currency.toLowerCase() === "usd")
    ) {
      status = "priced";
      savings = equivalent - billed;
    } else {
      status = "partial";
      const parts: string[] = [];
      if (pricedCount < requests) {
        parts.push(`${requests - pricedCount} of ${requests} requests unpriced`);
      }
      if (!usdOnly) {
        parts.push(
          `billed in ${currencies.filter((c) => c !== "").join("/") || "unknown currency"}; ` +
            "the equivalent is USD",
        );
      }
      if (!billedKnown) parts.push("some rows carried no gateway cost");
      reason = parts.join("; ") || firstUnpricedReason;
    }

    resultRows.push({
      model,
      requests,
      input_tokens: tokens((row) => row.input_tokens),
      output_tokens: tokens((row) => row.output_tokens),
      cached_tokens: tokens((row) => row.cached_tokens),
      billed: modelRows.every((row) => row.cost_value === null) ? null : billed,
      currencies,
      equivalent: pricedCount === 0 ? null : equivalent,
      savings,
      status,
      priced: pricedCount > 0,
      reason,
      source:
        overrideUsed && overrideFor(overrides, model) !== null ? overrideLabel : snapshotLabel,
      snapshot_date: snapshot.date,
    });
  }

  resultRows.sort((a, b) => a.model.localeCompare(b.model));

  // Totals: savings only accrue from rows where BOTH sides are priced.
  const totals: VsListTotals = { billed: null, equivalent: null, savings: null };
  let billed = 0;
  let equivalent = 0;
  let savings = 0;
  let anyBilled = false;
  let anyEquivalent = false;
  let anySavings = false;
  for (const row of resultRows) {
    if (row.billed !== null) {
      billed += row.billed;
      anyBilled = true;
    }
    if (row.equivalent !== null) {
      equivalent += row.equivalent;
      anyEquivalent = true;
    }
    if (row.savings !== null) {
      savings += row.savings;
      anySavings = true;
    }
  }
  totals.billed = anyBilled ? billed : null;
  totals.equivalent = anyEquivalent ? equivalent : null;
  totals.savings = anySavings ? savings : null;

  return {
    rows: resultRows,
    totals,
    snapshotName: snapshot.name,
    snapshotDate: snapshot.date,
  };
}

/** Never-guess guard for --prices-file: the file must parse and validate. */
export function readSnapshotFile(
  path: string,
  name: string,
  read: (p: string) => string,
): PriceSnapshot {
  let raw: string;
  try {
    raw = read(path);
  } catch (error) {
    throw new CliError(
      `Could not read --prices-file ${path}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new CliError(
      `--prices-file ${path} is not valid JSON: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  return parseSnapshot(document, name);
}
