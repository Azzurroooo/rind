import { expect, it } from "vitest";
import { toDate } from "./sessionTime.js";

it("accepts ISO, epoch seconds and milliseconds and rejects invalid dates", () => {
  const iso = "2026-09-30T10:00:00.000Z";
  const ms = Date.parse(iso);
  for (const value of [iso, ms, ms / 1000, String(ms / 1000)]) expect(toDate(value).toISOString()).toBe(iso);
  for (const value of ["", null, undefined, "invalid"]) expect(toDate(value)).toBeNull();
});
