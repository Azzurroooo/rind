export function toDate(value) {
  if (value == null || value === "") return null;
  const numeric = typeof value === "number" ? value : /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : NaN;
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
