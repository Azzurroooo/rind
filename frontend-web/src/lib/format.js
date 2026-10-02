// Small display formatters shared by the composer meter and inspector tabs.

export function formatTokens(value) {
  const number = Number(value) || 0;
  if (number <= 999) return String(Math.round(number));
  return `${(number / 1000).toFixed(number > 99999 ? 0 : 1)}k`;
}

// context_usage_percent arrives as a 0-1 fraction; some runtimes send 0-100.
export function usageFraction(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(1, number > 1 ? number / 100 : number);
}

export function basename(path) {
  const clean = String(path || "").replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || clean;
}

export function messageTime(value) {
  if (value == null || value === "") return null;
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    iso: date.toISOString(),
    label: date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    full: date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }),
  };
}
