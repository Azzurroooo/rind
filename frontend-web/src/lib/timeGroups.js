// Session history time groups (spec section 3), adapted from LobeHub's
// getTopicGroupId: Today, Yesterday, Previous 7 days, Previous 30 days, then
// one group per month ("August" this year, "August 2025" before). Rows keep
// the server's order inside a group; groups come out newest first.

const DAY_MS = 86_400_000;
const FIXED = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "Previous 7 days" },
  { id: "month30", label: "Previous 30 days" },
];
const FIXED_ORDER = new Map(FIXED.map((group, index) => [group.id, index]));
const UNDATED = { id: "undated", label: "Older" };

export function toDate(value) {
  if (value == null || value === "") return null;
  const numeric = typeof value === "number" ? value : /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : NaN;
  // Epoch seconds (the runtime's float timestamps) vs milliseconds.
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function timeGroupOf(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return UNDATED;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = date.getTime();
  if (time >= startOfToday) return FIXED[0];
  if (time >= startOfToday - DAY_MS) return FIXED[1];
  if (time >= startOfToday - 7 * DAY_MS) return FIXED[2];
  if (time >= startOfToday - 30 * DAY_MS) return FIXED[3];
  const month = date.toLocaleString("en-US", { month: "long" });
  const label = date.getFullYear() === now.getFullYear() ? month : `${month} ${date.getFullYear()}`;
  return { id: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`, label };
}

// Returns [{ id, label, items }] without mutating `items`.
export function groupByTime(items, getTime = (item) => item?.updated_at, now = new Date()) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const group = timeGroupOf(getTime(item), now);
    const existing = groups.get(group.id);
    groups.set(group.id, existing ? { ...existing, items: [...existing.items, item] } : { ...group, items: [item] });
  }
  return [...groups.values()].sort(compareGroups);
}

function compareGroups(a, b) {
  const rank = (group) => (FIXED_ORDER.has(group.id) ? FIXED_ORDER.get(group.id) : group.id === UNDATED.id ? Infinity : 10);
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  return b.id.localeCompare(a.id); // YYYY-MM, newest month first
}
