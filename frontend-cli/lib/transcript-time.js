// Transcript time helpers shared by the TUI transcript blocks. All inputs are
// ISO timestamps from runtime events or persisted session messages; invalid or
// missing values degrade to empty strings so callers can omit decorations.

export function formatClock(value) {
  const date = parseDate(value);
  if (!date) {
    return "";
  }
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function dayKey(value) {
  const date = parseDate(value);
  if (!date) {
    return "";
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function formatDayLabel(value, now = new Date()) {
  const date = parseDate(value);
  if (!date) {
    return "";
  }
  const options = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) {
    options.year = "numeric";
  }
  return date.toLocaleDateString("en-US", options);
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}
