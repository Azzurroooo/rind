// Sidebar history groups (spec section 3): Today, Yesterday, Previous 7 days,
// Previous 30 days, then month names. Calendar days are local to the viewer.

export type TimeGroup<T> = { key: string; label: string; items: T[] }

const dayMs = 86_400_000

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function timeGroupFor(iso: string, now: Date = new Date()): { key: string; label: string } {
  const date = new Date(iso)
  if (!iso || Number.isNaN(date.getTime())) return { key: "older", label: "Older" }
  // Math.round absorbs the one-hour skew of a daylight saving change.
  const days = Math.round((startOfDay(now) - startOfDay(date)) / dayMs)
  if (days <= 0) return { key: "today", label: "Today" }
  if (days === 1) return { key: "yesterday", label: "Yesterday" }
  if (days <= 7) return { key: "7d", label: "Previous 7 days" }
  if (days <= 30) return { key: "30d", label: "Previous 30 days" }
  const month = date.toLocaleString("en-US", { month: "long" })
  const label = date.getFullYear() === now.getFullYear() ? month : `${month} ${date.getFullYear()}`
  return { key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`, label }
}

/** Groups items in their given order; callers sort newest first. */
export function groupByTime<T>(items: readonly T[], when: (item: T) => string, now: Date = new Date()): TimeGroup<T>[] {
  return items.reduce<TimeGroup<T>[]>((groups, item) => {
    const { key, label } = timeGroupFor(when(item), now)
    const index = groups.findIndex((group) => group.key === key)
    if (index < 0) return [...groups, { key, label, items: [item] }]
    return groups.map((group, position) => position === index ? { ...group, items: [...group.items, item] } : group)
  }, [])
}
