/**
 * #89: the canonical cost-map key for a stored currency. Casefolds so
 * gateway "usd" and ccusage-imported "USD" land in one lane; a missing
 * currency buckets under "" (never mixed into a real code).
 */
export function currencyKey(currency: string | null | undefined): string {
  return (currency ?? "").toLowerCase();
}

/**
 * #99: the rendering-boundary clamp for money amounts. An accumulation like
 * −1.11e-16 (or an exact −0) would render as "$-0.0000"; anything that
 * rounds to zero at the requested decimals renders as plain zero instead.
 * Data is never touched — only the string this returns.
 */
export function formatMoneyFixed(value: number, decimals: number): string {
  const scaled = Math.round(value * 10 ** decimals);
  return (scaled === 0 ? 0 : value).toFixed(decimals);
}
