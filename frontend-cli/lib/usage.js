const TOTAL_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

export function usageTotals(seed = null) {
  const totals = { samplings: 0 };
  for (const key of TOTAL_KEYS) {
    totals[key] = 0;
  }
  if (seed && typeof seed === "object") {
    for (const key of [...TOTAL_KEYS, "samplings"]) {
      const value = Number(seed[key]);
      if (Number.isFinite(value) && value > 0) {
        totals[key] = value;
      }
    }
  }
  return totals;
}

export function accumulateUsage(totals, stats) {
  if (!totals || !stats || typeof stats !== "object") {
    return totals;
  }
  for (const key of TOTAL_KEYS) {
    const value = Number(stats[key]);
    if (Number.isFinite(value) && value > 0) {
      totals[key] += value;
    }
  }
  totals.samplings += 1;
  return totals;
}
