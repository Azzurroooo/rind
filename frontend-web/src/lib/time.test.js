import { describe, expect, it } from "vitest";
import { relativeTime } from "./time.js";

const NOW = Date.parse("2026-09-08T12:00:00Z");

describe("relativeTime — session rail labels", () => {
  it("labels sub-minute recency as 刚刚", () => {
    expect(relativeTime("2026-09-08T11:59:30Z", NOW)).toBe("刚刚");
  });

  it("formats minutes, hours and days", () => {
    expect(relativeTime("2026-09-08T11:35:00Z", NOW)).toBe("25 分钟前");
    expect(relativeTime("2026-09-08T09:00:00Z", NOW)).toBe("3 小时前");
    expect(relativeTime("2026-09-05T12:00:00Z", NOW)).toBe("3 天前");
  });

  it("older entries fall back to a date, adding the year when it differs", () => {
    expect(relativeTime("2026-05-01T08:00:00Z", NOW)).toBe("5月1日");
    expect(relativeTime("2024-05-01T08:00:00Z", NOW)).toBe("2024年5月1日");
  });

  it("unparseable or empty values render nothing", () => {
    expect(relativeTime("", NOW)).toBe("");
    expect(relativeTime("not-a-date", NOW)).toBe("");
  });
});
