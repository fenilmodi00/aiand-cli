import { CliError } from "../cli/errors.js";
import type { BudgetConfig } from "../config.js";
import { loadConfig, saveConfig } from "../config.js";

/**
 * Budgets + pacing verdicts (feature catalog E4, ticket #74).
 *
 * A budget is a currency-agnostic number in the account's billing currency:
 * `budget.monthly` for the account, optional `budget.harness.<name>` overrides
 * per harness (an unset harness falls back to monthly), and an optional
 * `budget.warn-pct` (default 80) for the one-line stderr warning every
 * cost-showing command prints when monthly spend crosses the threshold.
 *
 * Enforcement is advisory-only by design (CLI warning, never blocking — the
 * CodeBurn `guard allow` escape hatch maps to `--no-warn` / AIAND_NO_WARN=1);
 * live per-key enforcement is NEEDS-GATEWAY and explicitly out of scope here.
 *
 * Persistence: the `budget` section of config.json (see Config.budget), read
 * and written through loadConfig/saveConfig so every budget change is one
 * atomic file write, same as every other stored setting.
 */

/** The config keys under `budget.*` (as typed after `aiand config set`). */
export const BUDGET_SET_KEYS = [
  "budget.monthly",
  "budget.harness.<name>",
  "budget.warn-pct",
] as const;

/** The warn threshold when nothing is configured. */
export const DEFAULT_WARN_PCT = 80;

/**
 * The sanitized in-memory budget: `monthly`/`harness` present only when set,
 * `warnPct` always resolved to a number.
 */
export type ResolvedBudget = {
  monthly: number | null;
  harness: Record<string, number>;
  warnPct: number;
  currency: string | null;
};

export function loadBudget(): ResolvedBudget {
  const budget: BudgetConfig = loadConfig().budget ?? {};
  return {
    monthly: budget.monthly ?? null,
    harness: budget.harness ?? {},
    warnPct: budget.warnPct ?? DEFAULT_WARN_PCT,
    currency: budget.currency ?? null,
  };
}

/** The budget in effect for a harness scope: the override, else monthly. */
export function budgetFor(budget: ResolvedBudget, harness?: string): number | null {
  if (harness !== undefined && budget.harness[harness] !== undefined) {
    return budget.harness[harness] ?? null;
  }
  return budget.monthly;
}

// ---------------------------------------------------------------------------
// Mutation (config set / unset)
// ---------------------------------------------------------------------------

function assertPositive(key: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(`${key} must be a positive number (got "${value}").`);
  }
}

/** Append `harness.<name>` to config.json; returns the merged budget section. */
async function mutateBudget(fn: (budget: BudgetConfig) => BudgetConfig): Promise<BudgetConfig> {
  const config = loadConfig();
  config.budget = fn(config.budget ?? {});
  await saveConfig(config);
  return config.budget;
}

/**
 * Set `budget.monthly`. `currency` is what the store's cost rows say (the
 * caller infers it — mixed currencies never reach here); null when the store
 * had no currency yet, which leaves any previously recorded currency alone
 * rather than erasing it.
 */
export async function setBudgetMonthly(value: number, currency: string | null): Promise<void> {
  assertPositive("budget.monthly", value);
  await mutateBudget((budget) => ({
    ...budget,
    monthly: value,
    currency: currency ?? budget.currency ?? null,
  }));
}

/** Set a per-harness override; an unset harness falls back to budget.monthly. */
export async function setBudgetHarness(name: string, value: number): Promise<void> {
  assertPositive(`budget.harness.${name}`, value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new CliError(`Invalid harness name "${name}".`, {
      hint: "Use letters, digits, dots, dashes, or underscores (max 64 chars).",
    });
  }
  await mutateBudget((budget) => ({
    ...budget,
    harness: { ...(budget.harness ?? {}), [name]: value },
  }));
}

export async function setBudgetWarnPct(value: number): Promise<void> {
  if (!Number.isFinite(value) || value < 1 || value > 100) {
    throw new CliError(`budget.warn-pct must be between 1 and 100 (got "${value}").`);
  }
  await mutateBudget((budget) => ({ ...budget, warnPct: Math.round(value) }));
}

/** The budget keys `aiand config unset` accepts. */
export const BUDGET_UNSET_KEYS = [
  "budget.monthly",
  "budget.warn-pct",
  "budget.harness.<name>",
] as const;

/**
 * Remove one budget key. Unknown keys are a clear user error; removing an
 * already-unset key succeeds quietly (idempotent, like `rm`).
 */
export async function unsetBudgetKey(key: string): Promise<void> {
  if (key === "budget.monthly") {
    await mutateBudget(({ monthly: _monthly, ...rest }) => rest);
    return;
  }
  if (key === "budget.warn-pct") {
    await mutateBudget(({ warnPct: _warnPct, ...rest }) => rest);
    return;
  }
  const harness = /^budget\.harness\.(.+)$/.exec(key);
  if (harness?.[1]) {
    await mutateBudget((budget) => {
      const { [harness[1] as string]: _removed, ...rest } = budget.harness ?? {};
      return { ...budget, harness: rest };
    });
    return;
  }
  throw new CliError(`"${key}" is not an unsettable budget key.`, {
    hint: "Budget keys: budget.monthly, budget.warn-pct, budget.harness.<name>.",
  });
}

// ---------------------------------------------------------------------------
// Pacing verdicts + warning (E4)
// ---------------------------------------------------------------------------

/**
 * A pacing verdict over a budget. The exact states OBS-P2-1 (statusline) and
 * the forecast command consume; `no-budget` and `no-data` exist so a verdict
 * is always nameable, never guessed.
 */
export type PacingVerdict = "on-pace" | "exceeding" | "indeterminate" | "no-data" | "no-budget";

/**
 * The one-line human pacing copy, in CodeBurn's exact shape:
 * `On pace to exceed budget: projected $182.40 by 2026-11-19 (budget $150.00)`.
 * `null` when the state has no budget line (no-data / no-budget render
 * differently).
 */
export function pacingLine(
  verdict: PacingVerdict,
  opts: {
    projected?: number;
    exceedDate?: string | null;
    budget: number;
    currency?: string | null;
  },
): string | null {
  const symbol = currencyPrefix(opts.currency);
  switch (verdict) {
    case "exceeding":
      return (
        `On pace to exceed budget: projected ${symbol}${(opts.projected ?? 0).toFixed(2)} ` +
        `by ${opts.exceedDate ?? "month end"} (budget ${symbol}${opts.budget.toFixed(2)})`
      );
    case "on-pace":
      return (
        `On pace for budget: projected ${symbol}${(opts.projected ?? 0).toFixed(2)} of ` +
        `${symbol}${opts.budget.toFixed(2)} by month end`
      );
    default:
      return null;
  }
}

function currencyPrefix(currency: string | null | undefined): string {
  return currency === "usd" ? "$" : currency ? `${currency} ` : "";
}

/**
 * The 80%-threshold warning line for cost-showing commands, or null when the
 * threshold is not crossed. Exact copy from the ticket:
 * `⚠ 84% of monthly budget used ($126.00 / $150.00)`. The caller decides
 * whether to print it (stderr) — this module stays output-free so the
 * statusline and --json payloads can reuse the decision.
 */
export function warnThresholdLine(
  spend: number,
  budget: number,
  warnPct: number,
  currency?: string | null,
): string | null {
  if (budget <= 0) return null;
  const share = spend / budget;
  if (share * 100 < warnPct) return null;
  const symbol = currencyPrefix(currency);
  const pct = Math.floor(share * 100);
  return `⚠ ${pct}% of monthly budget used (${symbol}${spend.toFixed(2)} / ${symbol}${budget.toFixed(2)})`;
}

/**
 * Whether a cost-showing command should suppress the budget warning: the
 * `--no-warn` flag or `AIAND_NO_WARN=1` — the escape-hatch equivalent of
 * CodeBurn's `guard allow`.
 */
export function warnSuppressed(noWarnFlag?: boolean): boolean {
  if (noWarnFlag) return true;
  const value = process.env.AIAND_NO_WARN;
  return value === "1" || value === "true" || value === "yes";
}
