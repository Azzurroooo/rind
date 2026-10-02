import { afterEach, expect, it } from "vitest";
import { applyInteractions, interactionTime, rememberInteraction } from "./sessionActivity.js";

afterEach(() => sessionStorage.clear());

it("orders visits and messages by the latest interaction, scoped to this Rind computer", () => {
  const sessions = [{ id: "old", updated_at: "2026-01-01" }, { id: "new", updated_at: "2026-09-01" }];
  rememberInteraction("host-a", "old", Date.parse("2026-09-30"));
  expect(applyInteractions(sessions, "host-a").map(s => s.id)).toEqual(["old", "new"]);
  expect(applyInteractions(sessions, "host-b").map(s => s.id)).toEqual(["new", "old"]);
  expect(interactionTime({ updated_at: "2026-09-30", last_interacted_at: "2026-01-01" })).toBe(Date.parse("2026-09-30"));
  expect(sessions[0].last_interacted_at).toBeUndefined();
});
