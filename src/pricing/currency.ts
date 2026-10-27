/**
 * #89: the canonical cost-map key for a stored currency. Casefolds so
 * gateway "usd" and ccusage-imported "USD" land in one lane; a missing
 * currency buckets under "" (never mixed into a real code).
 */
export function currencyKey(currency: string | null | undefined): string {
  return (currency ?? "").toLowerCase();
}
