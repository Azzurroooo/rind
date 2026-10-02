/** Genuine event/persistence time, formatted locally without inventing history. */
export function messageTime(value?: string | number) {
  if (value == null || value === "") return null
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value)
  if (!Number.isFinite(date.getTime())) return null
  return {
    iso: date.toISOString(),
    label: date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    full: date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }),
  }
}
