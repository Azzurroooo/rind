import { describe, expect, it } from "vitest";
import { groupByTime, timeGroupOf, toDate } from "./timeGroups.js";

const NOW = new Date(2026, 8, 29, 15, 0, 0); // 29 September 2026, local time
const at = (month, day, hour = 12, year = 2026) => new Date(year, month, day, hour).toISOString();

describe("timeGroups — timeGroupOf", () => {
  it("buckets today, yesterday, previous 7 and 30 days", () => {
    expect(timeGroupOf(at(8, 29, 0), NOW).label).toBe("Today");
    expect(timeGroupOf(at(8, 28, 23), NOW).label).toBe("Yesterday");
    expect(timeGroupOf(at(8, 23), NOW).label).toBe("Previous 7 days");
    expect(timeGroupOf(at(8, 5), NOW).label).toBe("Previous 30 days");
  });

  it("uses month names beyond 30 days, with the year for earlier years", () => {
    expect(timeGroupOf(at(6, 14), NOW)).toEqual({ id: "2026-07", label: "July" });
    expect(timeGroupOf(at(11, 2, 12, 2025), NOW)).toEqual({ id: "2025-12", label: "December 2025" });
  });

  it("accepts epoch seconds, milliseconds and rejects garbage", () => {
    const seconds = new Date(2026, 8, 29, 10).getTime() / 1000;
    expect(timeGroupOf(seconds, NOW).label).toBe("Today");
    expect(timeGroupOf(String(seconds), NOW).label).toBe("Today");
    expect(timeGroupOf(seconds * 1000, NOW).label).toBe("Today");
    expect(toDate("not a date")).toBeNull();
    expect(timeGroupOf(undefined, NOW).label).toBe("Older");
  });
});

describe("timeGroups — groupByTime", () => {
  it("keeps item order inside groups and orders groups newest first", () => {
    const items = [
      { id: "a", updated_at: at(8, 29) },
      { id: "old", updated_at: at(3, 1, 12, 2025) },
      { id: "b", updated_at: at(8, 29, 1) },
      { id: "jul", updated_at: at(6, 1) },
      { id: "none" },
      { id: "y", updated_at: at(8, 28) },
    ];
    const groups = groupByTime(items, (item) => item.updated_at, NOW);
    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", "July", "April 2025", "Older"]);
    expect(groups[0].items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for missing input and leaves the input untouched", () => {
    expect(groupByTime(null)).toEqual([]);
    const items = Object.freeze([Object.freeze({ id: "a", updated_at: at(8, 29) })]);
    expect(() => groupByTime(items, undefined, NOW)).not.toThrow();
  });
});
