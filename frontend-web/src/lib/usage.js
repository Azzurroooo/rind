// The runtime ledger's input includes cache reads. Use window totals, never
// average individual request percentages (requests have different sizes).
export function cacheHitRate(input, cached) {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0 || typeof cached !== "number" || !Number.isFinite(cached) || cached < 0 || cached > input) return null;
  return cached / input;
}
