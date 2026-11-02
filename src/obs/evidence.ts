/**
 * Evidence primitives for harness decision quality (#147): pure, zero-dependency,
 * deterministic confidence intervals. Same inputs (including the seed) →
 * identical output; short inputs → null — a small-n interval is a guess, never
 * fabricated, and nothing here throws.
 */

/** A 95% confidence interval. */
export type CI95 = { lo: number; hi: number };

export type BootstrapOptions = { B?: number; seed?: number };

/** Resample count when the caller doesn't pin one. */
const DEFAULT_B = 2000;

/** Wilson score interval at 95% (z = 1.96), no dependencies. */
export function wilson95(successes: number, trials: number): CI95 | null {
  if (trials <= 0) return null;
  const z = 1.96;
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** mulberry32 seeded PRNG — tiny, fast, deterministic for a given uint32 seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, unsigned — the per-harness bootstrap seed. */
export function seedFromString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Percentile with linear interpolation between closest ranks — the same method
 * harness-stats uses for every p50/p95 (copied, not imported: evidence stays
 * dependency-free and importing harness-stats would be a cycle).
 */
function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = fraction * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low] ?? null;
  const weight = index - low;
  return (sorted[low] ?? 0) * (1 - weight) + (sorted[high] ?? 0) * weight;
}

/** The 2.5th/97.5th percentile of B draws — the percentile-bootstrap interval. */
function ciOfResamples(resamples: readonly number[]): CI95 | null {
  const lo = percentile(resamples, 0.025);
  const hi = percentile(resamples, 0.975);
  return lo === null || hi === null ? null : { lo, hi };
}

/**
 * Percentile bootstrap CI for `percentile(values, fraction)`: B resamples with
 * replacement (values.length draws each), the interval is the 2.5th/97.5th
 * percentile of the resampled statistics. Fewer than 2 values → null (a
 * one-value "interval" is just the point).
 */
export function percentileBootstrap(
  values: readonly number[],
  fraction: number,
  opts: BootstrapOptions = {},
): CI95 | null {
  if (values.length < 2) return null;
  const B = opts.B ?? DEFAULT_B;
  const rand = mulberry32(opts.seed ?? 0);
  const n = values.length;
  const stats: number[] = new Array<number>(B);
  for (let b = 0; b < B; b += 1) {
    const sample: number[] = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      sample[i] = values[Math.floor(rand() * n)]!;
    }
    stats[b] = percentile(sample, fraction) ?? 0;
  }
  return ciOfResamples(stats);
}

/**
 * Percentile bootstrap CI for sum(numerators)/sum(denominators): paired index
 * resampling, so each draw keeps a numerator with its own denominator. A
 * resample whose denominator sums to 0 is skipped (0/0 has no ratio); fewer
 * than 2 usable resamples → null.
 */
export function bootstrapRatio(
  numerators: readonly number[],
  denominators: readonly number[],
  opts: BootstrapOptions = {},
): CI95 | null {
  const n = Math.min(numerators.length, denominators.length);
  if (n < 2) return null;
  const B = opts.B ?? DEFAULT_B;
  const rand = mulberry32(opts.seed ?? 0);
  const ratios: number[] = [];
  for (let b = 0; b < B; b += 1) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      const j = Math.floor(rand() * n);
      num += numerators[j]!;
      den += denominators[j]!;
    }
    if (den > 0) ratios.push(num / den);
  }
  if (ratios.length < 2) return null;
  return ciOfResamples(ratios);
}

/**
 * Percentile bootstrap CI for stat(a) − stat(b): independent resamples of the
 * two samples, the same statistic computed per resample, the interval over
 * the B differences. Either side shorter than 2 values → null.
 */
export function bootstrapDelta(
  a: readonly number[],
  b: readonly number[],
  stat: "mean" | "p50" | "p95",
  opts: BootstrapOptions = {},
): CI95 | null {
  if (a.length < 2 || b.length < 2) return null;
  const B = opts.B ?? DEFAULT_B;
  const rand = mulberry32(opts.seed ?? 0);
  const resampleStat = (values: readonly number[]): number => {
    const sample: number[] = new Array<number>(values.length);
    for (let i = 0; i < values.length; i += 1) {
      sample[i] = values[Math.floor(rand() * values.length)]!;
    }
    if (stat === "mean") return sample.reduce((sum, v) => sum + v, 0) / sample.length;
    return stat === "p50" ? (percentile(sample, 0.5) ?? 0) : (percentile(sample, 0.95) ?? 0);
  };
  const deltas: number[] = new Array<number>(B);
  for (let i = 0; i < B; i += 1) {
    deltas[i] = resampleStat(a) - resampleStat(b);
  }
  return ciOfResamples(deltas);
}

/**
 * Binomial coefficient C(n, k) by the multiplicative loop — exact in doubles
 * for the n <= 1000 range pass@k sees (interleaved divide keeps the running
 * product integral and far from overflow). k > n or k < 0 → 0; never NaN.
 */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const take = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= take; i += 1) {
    result = (result * (n - take + i)) / i;
  }
  return result;
}

/**
 * Task-clustered percentile bootstrap (#152): resample whole task groups with
 * replacement, recompute pooled solve rate and cost/solve per resample, and
 * take 2.5/97.5 percentiles. One `groups[i]` element is `{solves, trials,
 * cost}` for that task's live rows; a resample with zero solves is undefined
 * for both statistics, and fewer than 95% defined resamples → null (the
 * interval would be a guess over a mostly-empty distribution).
 */
export function taskClusteredBootstrap(
  groups: readonly { solves: number; trials: number; cost: number | null }[],
  opts: BootstrapOptions = {},
): { solve: CI95 | null; costPerSolve: CI95 | null } {
  if (groups.length < 2) return { solve: null, costPerSolve: null };
  const B = opts.B ?? DEFAULT_B;
  const rand = mulberry32(opts.seed ?? 0);
  const n = groups.length;
  const solveRates: number[] = [];
  const costs: number[] = [];
  for (let b = 0; b < B; b += 1) {
    let solves = 0;
    let trials = 0;
    let cost = 0;
    for (let i = 0; i < n; i += 1) {
      const g = groups[Math.floor(rand() * n)]!;
      solves += g.solves;
      trials += g.trials;
      cost += g.cost ?? 0;
    }
    if (solves === 0 || trials === 0) continue;
    solveRates.push(solves / trials);
    if (cost > 0) costs.push(cost / solves);
  }
  const enough = B * 0.95;
  return {
    solve: solveRates.length >= enough ? ciOfResamples(solveRates) : null,
    costPerSolve: costs.length >= enough ? ciOfResamples(costs) : null,
  };
}
